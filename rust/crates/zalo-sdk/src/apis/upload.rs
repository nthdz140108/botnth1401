//! Streaming Multi-Chunk Attachment & Thumbnail Upload (`uploadAttachment.js` & `uploadThumbnail.js`).
//!
//! Improvements over V3 Node.js:
//! - Streams each 3 MiB chunk directly from disk (`tokio::fs::File` seek + bounded buffer) rather than
//!   pre-allocating every chunk `FormData` into RAM simultaneously!
//! - Preserves single-layer 3x chunk retry, 60s `oneshot` WS `file_done` / `voice_aac_success` deadline,
//!   `/ThanhHung.aac` >9MB audio trick, and `Heavy` lane rate-limiting.

use std::io::Cursor;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::header::USER_AGENT;
use image::ImageReader;
use md5::{Digest, Md5};
use mybot_types::{ExecutionLane, ThreadType, ZALO_API_TYPE, ZALO_API_VERSION, ZaloId};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::crypto::encode_aes_cbc;
use crate::error::{ZaloApiError, redact_endpoint};
use crate::session::{ZaloSession, parse_and_decrypt_zalo_envelope};

const MAX_VOICE_DIRECT_BYTES: u64 = 9_000_000;
const MAX_CHUNK_HTTP_ATTEMPTS: usize = 3;
const DEFAULT_UPLOAD_CALLBACK_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedAttachment {
    pub file_type: String,
    pub file_name: String,
    pub total_size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub photo_id: Option<String>,
    pub file_id: Option<String>,
    pub client_file_id: u64,
    pub normal_url: Option<String>,
    pub hd_url: Option<String>,
    pub thumb_url: Option<String>,
    pub file_url: Option<String>,
    pub checksum: Option<String>,
}

impl ZaloSession {
    /// Uploads one or more local files (`image`, `video`, `aac`, `others`) using bounded streaming chunks.
    pub async fn upload_attachment(
        &self,
        file_paths: &[impl AsRef<Path>],
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Vec<UploadedAttachment>, ZaloApiError> {
        if file_paths.is_empty() {
            return Err(ZaloApiError::InvalidParam("empty file_paths".into()));
        }
        let keys = self.require_keys()?;
        let file_base = self.service_endpoint("file")?;
        let chunk_size = keys.sharefile.chunk_size_bytes.max(64 * 1024);

        let mut results = Vec::with_capacity(file_paths.len());
        for path_ref in file_paths {
            let path = path_ref.as_ref();
            let uploaded = self
                .limiter
                .execute(ExecutionLane::Heavy, || {
                    self.upload_single_file(path, thread_id, thread_type, &keys.secret_key, &file_base, chunk_size)
                })
                .await?;
            results.push(uploaded);
        }
        Ok(results)
    }

    /// Uploads a raw image buffer or file as a PNG thumbnail (`uploadThumbnail.js` / `upthumb`).
    pub async fn upload_thumbnail_bytes(
        &self,
        image_bytes: &[u8],
        thread_type: ThreadType,
    ) -> Result<String, ZaloApiError> {
        let keys = self.require_keys()?;
        let file_base = self.service_endpoint("file")?;
        let png_bytes = ensure_png_bytes(image_bytes)?;
        let scope = if thread_type.is_group() { "group" } else { "message" };
        let endpoint = format!("{}/api/{scope}/upthumb", file_base.trim_end_matches('/'));

        self.limiter
            .execute(ExecutionLane::Heavy, || async {
                let params = json!({
                    "clientId": epoch_ms(),
                    "imei": self.imei,
                });
                let encrypted = encode_aes_cbc(&keys.secret_key, &serde_json::to_string(&params)?)?;
                let url = Self::make_zalo_url(
                    &endpoint,
                    ZALO_API_VERSION,
                    ZALO_API_TYPE,
                    &[("params", encrypted.as_str())],
                )?;

                let part = Part::bytes(png_bytes.clone())
                    .file_name("blob")
                    .mime_str("image/png")
                    .map_err(|e| ZaloApiError::InvalidParam(e.to_string()))?;
                let form = Form::new().part("fileContent", part);

                let resp = self
                    .http
                    .post(url)
                    .header(USER_AGENT, &self.user_agent)
                    .multipart(form)
                    .timeout(Duration::from_secs(20))
                    .send()
                    .await
                    .map_err(|e| ZaloApiError::HttpTransport {
                        endpoint: redact_endpoint(&endpoint),
                        status: e.status().map(|s| s.as_u16()),
                        retryable: true,
                        message: e.to_string(),
                    })?;

                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                let data = parse_and_decrypt_zalo_envelope(&keys.secret_key, &text, Some(status))?;
                let url_str = data
                    .get("url")
                    .or_else(|| data.get("hdUrl"))
                    .or_else(|| data.get("normalUrl"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                Ok(url_str)
            })
            .await
    }

    async fn upload_single_file(
        &self,
        path: &Path,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        secret_key: &str,
        file_service_base: &str,
        chunk_size: usize,
    ) -> Result<UploadedAttachment, ZaloApiError> {
        let meta = tokio::fs::metadata(path).await?;
        let total_size = meta.len();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment.bin")
            .to_string();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let mut voice_oversize_suffix: Option<&'static str> = None;
        let file_type = match ext.as_str() {
            "jpg" | "jpeg" | "png" => "image",
            "mp3" | "aac" | "m4a" => {
                if total_size > MAX_VOICE_DIRECT_BYTES {
                    voice_oversize_suffix = Some("ThanhHung.aac");
                    "others"
                } else {
                    "aac"
                }
            }
            "mp4" => "video",
            _ => "others",
        };

        let (width, height) = if file_type == "image" {
            probe_image_dimensions(path).await.unwrap_or((800, 600))
        } else {
            (0, 0)
        };

        let total_chunks = total_size.max(1).div_ceil(chunk_size as u64) as usize;
        let client_id = epoch_ms();
        let is_group = thread_type.is_group();
        let route_suffix = match file_type {
            "image" => "photo_original/upload",
            "aac" => "voice/upload",
            _ => "asyncfile/upload",
        };
        let chunk_endpoint = format!(
            "{}/api/{}/{}",
            file_service_base.trim_end_matches('/'),
            if is_group { "group" } else { "message" },
            route_suffix
        );
        let query_type = if is_group { "11" } else { "2" };

        let mut file = tokio::fs::File::open(path).await?;
        let mut md5_hasher = Md5::new();
        let mut last_resp_data = Value::Null;
        let mut ws_callback_rx = None;
        let mut callback_file_id = String::new();

        for chunk_idx in 0..total_chunks {
            let chunk_id = chunk_idx + 1;
            let offset = (chunk_idx * chunk_size) as u64;
            let current_len = ((total_size.saturating_sub(offset)) as usize).min(chunk_size);
            let mut buf = vec![0u8; current_len];
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            file.read_exact(&mut buf).await?;
            md5_hasher.update(&buf);

            let mut params = json!({
                "imei": self.imei,
                "isE2EE": 0,
                "jxl": 0,
                "chunkId": chunk_id,
                "clientId": client_id,
                "fileName": file_name,
                "totalChunk": total_chunks,
                "totalSize": total_size,
                "fileType": file_type,
            });
            if is_group {
                params["grid"] = json!(thread_id.as_str());
            } else {
                params["toid"] = json!(thread_id.as_str());
            }

            let encrypted = encode_aes_cbc(secret_key, &serde_json::to_string(&params)?)?;
            let url = Self::make_zalo_url(
                &chunk_endpoint,
                ZALO_API_VERSION,
                ZALO_API_TYPE,
                &[("type", query_type), ("params", encrypted.as_str())],
            )?;

            let mut chunk_res = None;
            let mut last_err = None;
            for attempt in 1..=MAX_CHUNK_HTTP_ATTEMPTS {
                let part = Part::bytes(buf.clone())
                    .file_name(file_name.clone())
                    .mime_str("application/octet-stream")
                    .map_err(|e| ZaloApiError::InvalidParam(e.to_string()))?;
                let form = Form::new().part("chunkContent", part);

                match self
                    .http
                    .post(url.clone())
                    .header(USER_AGENT, &self.user_agent)
                    .multipart(form)
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let text = resp.text().await.unwrap_or_default();
                        match parse_and_decrypt_zalo_envelope(secret_key, &text, Some(status)) {
                            Ok(val) => {
                                chunk_res = Some(val);
                                break;
                            }
                            Err(api_err) => {
                                self.prophylactic_upload
                                    .store(true, std::sync::atomic::Ordering::Relaxed);
                                if !api_err.is_retryable() || attempt == MAX_CHUNK_HTTP_ATTEMPTS {
                                    return Err(api_err);
                                }
                                last_err = Some(api_err);
                            }
                        }
                    }
                    Err(e) => {
                        let err = ZaloApiError::HttpTransport {
                            endpoint: redact_endpoint(&chunk_endpoint),
                            status: e.status().map(|s| s.as_u16()),
                            retryable: true,
                            message: e.to_string(),
                        };
                        if attempt == MAX_CHUNK_HTTP_ATTEMPTS {
                            return Err(err);
                        }
                        last_err = Some(err);
                    }
                }
                tokio::time::sleep(Duration::from_millis(500 * (1u64 << (attempt - 1)))).await;
            }

            let val = match chunk_res {
                Some(v) => v,
                None => return Err(last_err.unwrap_or_else(|| ZaloApiError::InvalidParam("chunk failed".into()))),
            };

            if let Some(fid) = val
                .get("fileId")
                .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                .filter(|id| !id.is_empty() && id.as_str() != "-1")
                && ws_callback_rx.is_none()
            {
                callback_file_id = fid.to_string();
                ws_callback_rx = Some(self.register_upload_callback(callback_file_id.clone()));
            }
            last_resp_data = val;
        }

        let checksum = hex::encode(md5_hasher.finalize());

        if let Some(rx) = ws_callback_rx {
            let direct_url = last_resp_data
                .get("fileUrl")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);

            let mut final_file_url = if let Some(u) = direct_url {
                self.upload_callbacks.remove(&callback_file_id);
                u
            } else {
                let done = tokio::time::timeout(
                    Duration::from_millis(DEFAULT_UPLOAD_CALLBACK_TIMEOUT_MS),
                    rx,
                )
                .await
                .map_err(|_| {
                    self.upload_callbacks.remove(&callback_file_id);
                    ZaloApiError::UploadCallbackTimeout {
                        file_id: callback_file_id.clone(),
                        timeout_ms: DEFAULT_UPLOAD_CALLBACK_TIMEOUT_MS,
                    }
                })?
                .map_err(|_| ZaloApiError::UploadCallbackTimeout {
                    file_id: callback_file_id.clone(),
                    timeout_ms: DEFAULT_UPLOAD_CALLBACK_TIMEOUT_MS,
                })?;
                done.file_url
            };

            if let Some(suffix) = voice_oversize_suffix {
                final_file_url = format!("{}/{suffix}", final_file_url.trim_end_matches('/'));
            }

            return Ok(UploadedAttachment {
                file_type: file_type.to_string(),
                file_name,
                total_size,
                width: None,
                height: None,
                photo_id: None,
                file_id: Some(callback_file_id),
                client_file_id: client_id,
                normal_url: None,
                hd_url: None,
                thumb_url: None,
                file_url: Some(final_file_url),
                checksum: Some(checksum),
            });
        }

        Ok(UploadedAttachment {
            file_type: file_type.to_string(),
            file_name,
            total_size,
            width: if width > 0 { Some(width) } else { None },
            height: if height > 0 { Some(height) } else { None },
            photo_id: last_resp_data
                .get("photoId")
                .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                .map(|id| id.to_string()),
            file_id: None,
            client_file_id: client_id,
            normal_url: last_resp_data
                .get("normalUrl")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            hd_url: last_resp_data
                .get("hdUrl")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            thumb_url: last_resp_data
                .get("thumbUrl")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            file_url: last_resp_data
                .get("fileUrl")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            checksum: Some(checksum),
        })
    }
}

async fn probe_image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

fn ensure_png_bytes(raw: &[u8]) -> Result<Vec<u8>, ZaloApiError> {
    if raw.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(raw.to_vec());
    }
    let img = image::load_from_memory(raw)
        .map_err(|e| ZaloApiError::InvalidParam(format!("thumbnail decode failed: {e}")))?;
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| ZaloApiError::InvalidParam(format!("thumbnail PNG encode failed: {e}")))?;
    Ok(out)
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
