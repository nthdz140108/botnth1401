//! Messaging, Rich Media, Stickers, Links, Reactions, Recall & Voice Call APIs (25 active methods).
//!
//! Preserves:
//! - Full **5-stage quote fallback** (`original -> no-quote -> no-style -> no-mentions -> plain`).
//! - 6-attempt retry loops on `delete_message` & `z_delete_message`.
//! - `zpw_type = 24` quirk on two-step `send_call_voice`.
//! - Validated `thumbUrl` (blocks `"null"` / `"undefined"`) on `send_video`.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mybot_types::{
    ExecutionLane, MentionSpan, QuotedMessage, ThreadType, ZALO_API_VERSION, ZaloId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::error::ZaloApiError;
use crate::session::ZaloSession;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OutboundMessage {
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<MentionSpan>,
    #[serde(default)]
    pub quote: Option<QuotedMessage>,
    #[serde(default)]
    pub style: Option<Value>,
    #[serde(default)]
    pub attachments: Vec<PathBuf>,
    #[serde(default)]
    pub ttl_ms: u64,
    #[serde(default = "default_true")]
    pub link_on: bool,
}

fn default_true() -> bool {
    true
}

impl From<&str> for OutboundMessage {
    fn from(value: &str) -> Self {
        Self {
            text: value.to_string(),
            link_on: true,
            ..Default::default()
        }
    }
}

impl From<String> for OutboundMessage {
    fn from(value: String) -> Self {
        Self {
            text: value,
            link_on: true,
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoSendRequest {
    pub video_url: String,
    pub thumbnail_url: Option<String>,
    pub caption: String,
    pub mentions: Vec<MentionSpan>,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub file_size: u64,
    pub ttl_ms: u64,
    pub video_already_uploaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomStickerRequest {
    pub static_img_url: String,
    pub anim_webp_url: String,
    pub width: u32,
    pub height: u32,
    pub ttl_ms: u64,
    pub is_ai: bool,
    pub quote_cli_msg_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionBatchTarget {
    pub msg_id: ZaloId,
    pub cli_msg_id: ZaloId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionBatchOp {
    pub icon: String,
    pub targets: Vec<ReactionBatchTarget>,
}

impl ZaloSession {
    /// Core `sendMessage` with 5-stage quote/style/mention degradation fallback (`sendMessage.js:467-563`).
    pub async fn send_message(
        &self,
        msg: impl Into<OutboundMessage>,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        let mut outbound = msg.into();
        if outbound.text.is_empty() && outbound.attachments.is_empty() {
            return Err(ZaloApiError::InvalidParam("missing message text and attachments".into()));
        }

        let mut text_receipt = Value::Null;
        let mut attach_receipts = Vec::new();

        if !outbound.attachments.is_empty() {
            let single_image = outbound.attachments.len() == 1
                && outbound.attachments[0]
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp"));

            if (!single_image && !outbound.text.is_empty())
                || (!outbound.text.is_empty() && outbound.quote.is_some())
            {
                text_receipt = self
                    .send_text_with_5_stage_fallback(&outbound, thread_id, thread_type)
                    .await?;
                outbound.text.clear();
                outbound.mentions.clear();
            }

            let uploaded = self
                .upload_attachment(&outbound.attachments, thread_id, thread_type)
                .await?;
            let is_multi = uploaded.len() > 1;
            let layout_id = epoch_ms();
            for (idx, att) in uploaded.iter().enumerate() {
                let receipt = self
                    .limiter
                    .execute(ExecutionLane::FastText, || async {
                        let scope = if thread_type.is_group() { "group" } else { "message" };
                        let (sub_path, mut params) = if att.file_type == "image" {
                            let normal = att.normal_url.clone().unwrap_or_default();
                            let mut p = json!({
                                "photoId": att.photo_id.clone().unwrap_or_default(),
                                "clientId": (epoch_ms() + idx as u64).to_string(),
                                "desc": outbound.text,
                                "width": att.width.unwrap_or(800),
                                "height": att.height.unwrap_or(600),
                                "rawUrl": normal,
                                "hdUrl": att.hd_url.clone().unwrap_or_else(|| normal.clone()),
                                "thumbUrl": att.thumb_url.clone().unwrap_or_else(|| normal.clone()),
                                "hdSize": att.total_size.to_string(),
                                "zsource": -1,
                                "ttl": outbound.ttl_ms,
                                "jcp": "{\"convertible\":\"jxl\"}",
                            });
                            if thread_type.is_group() {
                                p["grid"] = json!(thread_id.as_str());
                                p["oriUrl"] = json!(normal);
                            } else {
                                p["toid"] = json!(thread_id.as_str());
                                p["normalUrl"] = json!(normal);
                            }
                            if is_multi {
                                p["groupLayoutId"] = json!(layout_id);
                                p["isGroupLayout"] = json!(1);
                                p["idInGroup"] = json!(uploaded.len() - 1 - idx);
                                p["totalItemInGroup"] = json!(uploaded.len());
                            }
                            (format!("/api/{scope}/photo_original/send"), p)
                        } else {
                            let ext = att
                                .file_name
                                .rsplit('.')
                                .next()
                                .unwrap_or_default()
                                .to_string();
                            let mut p = json!({
                                "fileId": att.file_id.clone().unwrap_or_default(),
                                "checksum": att.checksum.clone().unwrap_or_default(),
                                "checksumSha": "",
                                "extention": ext,
                                "totalSize": att.total_size,
                                "fileName": att.file_name,
                                "clientId": att.client_file_id,
                                "fType": 1,
                                "fileCount": 0,
                                "fdata": "{}",
                                "fileUrl": att.file_url.clone().unwrap_or_default(),
                                "zsource": -1,
                                "ttl": outbound.ttl_ms,
                            });
                            if thread_type.is_group() {
                                p["grid"] = json!(thread_id.as_str());
                            } else {
                                p["toid"] = json!(thread_id.as_str());
                            }
                            (format!("/api/{scope}/asyncfile/msg"), p)
                        };
                        if !outbound.mentions.is_empty() && thread_type.is_group() && single_image {
                            params["mentionInfo"] = json!(serialize_mentions(&outbound.mentions)?);
                        }
                        self.post_encrypted("file", &sub_path, &params, &[("nretry", "0")]).await
                    })
                    .await?;
                attach_receipts.push(receipt);
            }
            outbound.text.clear();
        }

        if !outbound.text.is_empty() {
            let links = extract_links(&outbound.text);
            if outbound.link_on && links.len() == 1 {
                match self
                    .send_link(&outbound.text, &links[0], thread_id, thread_type, outbound.ttl_ms)
                    .await
                {
                    Ok(link_res) => {
                        return Ok(json!({
                            "message": null,
                            "attachment": attach_receipts,
                            "link": link_res,
                        }));
                    }
                    Err(_) => {
                        text_receipt = self
                            .send_text_with_5_stage_fallback(&outbound, thread_id, thread_type)
                            .await?;
                    }
                }
            } else {
                text_receipt = self
                    .send_text_with_5_stage_fallback(&outbound, thread_id, thread_type)
                    .await?;
            }
        }

        Ok(json!({
            "message": text_receipt,
            "attachment": attach_receipts,
            "link": null,
        }))
    }

    async fn send_text_with_5_stage_fallback(
        &self,
        msg: &OutboundMessage,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        let stages = [
            (msg.quote.as_ref(), msg.mentions.as_slice(), msg.style.as_ref()),
            (None, msg.mentions.as_slice(), msg.style.as_ref()),
            (None, msg.mentions.as_slice(), None),
            (None, &[][..], None),
            (None, &[][..], None),
        ];

        let mut last_err = None;
        for (stage_idx, (q_opt, m_slice, s_opt)) in stages.into_iter().enumerate() {
            // Skip duplicate stage tries if nothing changed from previous failed stage
            if stage_idx == 1 && msg.quote.is_none() {
                continue;
            }
            if stage_idx == 2 && msg.style.is_none() {
                continue;
            }
            if stage_idx == 3 && msg.mentions.is_empty() {
                continue;
            }
            if stage_idx == 4 && last_err.is_none() {
                break;
            }

            let res = self
                .limiter
                .execute(ExecutionLane::FastText, || {
                    self.send_single_text_attempt(
                        &msg.text,
                        q_opt,
                        m_slice,
                        s_opt,
                        msg.ttl_ms,
                        thread_id,
                        thread_type,
                    )
                })
                .await;

            match res {
                Ok(val) => return Ok(val),
                Err(err) => {
                    tracing::warn!(
                        bot = %self.bot_key,
                        stage = stage_idx,
                        thread = %thread_id,
                        error = %err,
                        "sendMessage fallback stage failed"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| ZaloApiError::InvalidParam("sendMessage failed".into())))
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_single_text_attempt(
        &self,
        text: &str,
        quote: Option<&QuotedMessage>,
        mentions: &[MentionSpan],
        style: Option<&Value>,
        ttl_ms: u64,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        let is_group = thread_type.is_group();
        let client_id = epoch_ms();
        let has_mentions = is_group && !mentions.is_empty();

        let mut params = if let Some(q) = quote {
            let mut p = json!({
                "message": text,
                "clientId": client_id,
                "qmsgOwner": q.owner_id.as_str(),
                "qmsgId": q.global_msg_id.as_str(),
                "qmsgCliId": q.cli_msg_id.as_str(),
                "qmsgType": q.cli_msg_type,
                "qmsgTs": q.ts,
                "qmsg": q.msg,
                "qmsgTTL": q.ttl,
                "ttl": ttl_ms,
            });
            if is_group {
                p["grid"] = json!(thread_id.as_str());
                p["visibility"] = json!(0);
                if let Some(ref att) = q.attach {
                    p["qmsgAttach"] = match att {
                        Value::String(s) => json!(s),
                        other => json!(serde_json::to_string(other)?),
                    };
                }
            } else {
                p["toid"] = json!(thread_id.as_str());
                p["imei"] = json!(self.imei);
            }
            p
        } else {
            let mut p = json!({
                "message": text,
                "clientId": client_id,
                "ttl": ttl_ms,
            });
            if is_group {
                p["grid"] = json!(thread_id.as_str());
                p["visibility"] = json!(0);
            } else {
                p["toid"] = json!(thread_id.as_str());
                p["imei"] = json!(self.imei);
            }
            p
        };

        if has_mentions {
            params["mentionInfo"] = json!(serialize_mentions_checked(text, mentions)?);
        }
        if let Some(st) = style {
            params["textProperties"] = match st {
                Value::String(s) => json!(s),
                other => json!(serde_json::to_string(other)?),
            };
        }

        let (service_key, path) = if is_group {
            let action = if quote.is_some() {
                "quote"
            } else if has_mentions {
                "mention"
            } else {
                "sendmsg"
            };
            ("group", format!("/api/group/{action}"))
        } else {
            let action = if quote.is_some() { "quote" } else { "sms" };
            ("chat", format!("/api/message/{action}"))
        };

        let mut data = self
            .post_encrypted(service_key, &path, &params, &[("nretry", "0")])
            .await?;
        if let Some(obj) = data.as_object_mut() {
            obj.entry("clientId").or_insert_with(|| json!(client_id.to_string()));
            obj.entry("cliMsgId").or_insert_with(|| json!(client_id.to_string()));
        }
        Ok(data)
    }

    /// Direct 1-on-1 SMS message (`sendMessagePrivate.js`).
    pub async fn send_private(&self, text: &str, user_id: &ZaloId, ttl_ms: u64) -> Result<Value, ZaloApiError> {
        let out = OutboundMessage {
            text: text.to_string(),
            ttl_ms,
            link_on: false,
            ..Default::default()
        };
        self.send_text_with_5_stage_fallback(&out, user_id, ThreadType::User).await
    }

    /// Sends video message via `/api/{message,group}/forward` (`sendVideo.js`).
    pub async fn send_video(
        &self,
        req: &VideoSendRequest,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        let video_url = req.video_url.trim();
        if video_url.is_empty() {
            return Err(ZaloApiError::InvalidParam("missing video_url".into()));
        }
        let thumb_clean = req
            .thumbnail_url
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty() && !t.eq_ignore_ascii_case("null") && !t.eq_ignore_ascii_case("undefined"));
        if req.video_already_uploaded && thumb_clean.is_none() {
            return Err(ZaloApiError::InvalidParam("missing valid video thumbnail".into()));
        }
        let thumb_str = thumb_clean
            .map(ToOwned::to_owned)
            .or_else(|| fallback_jpg_thumb(video_url))
            .unwrap_or_default();

        self.limiter
            .execute(ExecutionLane::Heavy, || async {
                let msg_info = json!({
                    "videoUrl": video_url,
                    "thumbUrl": thumb_str,
                    "duration": req.duration_ms,
                    "width": if req.width > 0 { req.width } else { 1280 },
                    "height": if req.height > 0 { req.height } else { 720 },
                    "fileSize": req.file_size,
                    "properties": {
                        "color": -1,
                        "size": -1,
                        "type": 1003,
                        "subType": 0,
                        "ext": { "sSrcType": -1, "sSrcStr": "", "msg_warning_type": 0 }
                    },
                    "title": req.caption,
                });
                let mut params = json!({
                    "clientId": epoch_ms().saturating_mul(600),
                    "ttl": req.ttl_ms,
                    "zsource": 704,
                    "msgType": 5,
                    "msgInfo": serde_json::to_string(&msg_info)?,
                    "imei": self.imei,
                });
                if thread_type.is_group() && !req.mentions.is_empty() {
                    params["mentionInfo"] = json!(serialize_mentions(&req.mentions)?);
                }
                let path = if thread_type.is_group() {
                    params["visibility"] = json!(0);
                    params["grid"] = json!(thread_id.as_str());
                    "/api/group/forward"
                } else {
                    params["toId"] = json!(thread_id.as_str());
                    "/api/message/forward"
                };
                self.post_encrypted("file", path, &params, &[("nretry", "0")]).await
            })
            .await
    }

    /// Sends voice message (`msgType = 3`, `sendVoice.js`).
    pub async fn send_voice(
        &self,
        voice_url: &str,
        file_size_hint: Option<u64>,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        let size = match file_size_hint {
            Some(s) if s > 0 => s,
            _ => match self.http.head(voice_url).timeout(Duration::from_secs(8)).send().await {
                Ok(r) => r
                    .headers()
                    .get(http::header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                Err(_) => 0,
            },
        };

        self.limiter
            .execute(ExecutionLane::Heavy, || async {
                let msg_info = json!({
                    "voiceUrl": voice_url,
                    "m4aUrl": voice_url,
                    "fileSize": size,
                });
                let mut params = json!({
                    "ttl": ttl_ms,
                    "zsource": -1,
                    "msgType": 3,
                    "clientId": epoch_ms().saturating_mul(600),
                    "msgInfo": serde_json::to_string(&msg_info)?,
                    "imei": self.imei,
                });
                let path = if thread_type.is_group() {
                    params["visibility"] = json!(0);
                    params["grid"] = json!(thread_id.as_str());
                    "/api/group/forward"
                } else {
                    params["toId"] = json!(thread_id.as_str());
                    "/api/message/forward"
                };
                self.post_encrypted("file", path, &params, &[("nretry", "0")]).await
            })
            .await
    }

    /// Sends pre-hosted image URL (`sendImage.js`).
    #[allow(clippy::too_many_arguments)]
    pub async fn send_image(
        &self,
        image_url: &str,
        thumb_url: Option<&str>,
        width: u32,
        height: u32,
        caption: &str,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::FastText, || async {
                let scope = if thread_type.is_group() { "group" } else { "message" };
                let mut params = json!({
                    "photoId": (epoch_ms() / 1000).to_string(),
                    "clientId": epoch_ms().to_string(),
                    "desc": caption,
                    "width": width.max(1),
                    "height": height.max(1),
                    "rawUrl": image_url,
                    "hdUrl": image_url,
                    "thumbUrl": thumb_url.unwrap_or(image_url),
                    "zsource": -1,
                    "ttl": ttl_ms,
                });
                if thread_type.is_group() {
                    params["grid"] = json!(thread_id.as_str());
                    params["oriUrl"] = json!(image_url);
                } else {
                    params["toid"] = json!(thread_id.as_str());
                    params["normalUrl"] = json!(image_url);
                }
                self.post_encrypted(
                    "file",
                    &format!("/api/{scope}/photo_original/send"),
                    &params,
                    &[("nretry", "0")],
                )
                .await
            })
            .await
    }

    /// Uploads and sends 1 local image (`zSendLocalImage.js`).
    pub async fn z_send_local_image(
        &self,
        path: PathBuf,
        caption: &str,
        mentions: Vec<MentionSpan>,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        self.send_message(
            OutboundMessage {
                text: caption.to_string(),
                mentions,
                attachments: vec![path],
                ttl_ms,
                link_on: false,
                ..Default::default()
            },
            thread_id,
            thread_type,
        )
        .await
    }

    /// Uploads and sends multiple local images in a single album layout (`zSendLocalImages.js`).
    pub async fn z_send_local_images(
        &self,
        paths: Vec<PathBuf>,
        caption: &str,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        self.send_message(
            OutboundMessage {
                text: caption.to_string(),
                attachments: paths,
                ttl_ms,
                link_on: false,
                ..Default::default()
            },
            thread_id,
            thread_type,
        )
        .await
    }

    /// Sends a hosted file URL (`sendFile.js`).
    #[allow(clippy::too_many_arguments)]
    pub async fn send_file(
        &self,
        file_url: &str,
        file_name: &str,
        file_size: u64,
        checksum_md5: &str,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::FastText, || async {
                let scope = if thread_type.is_group() { "group" } else { "message" };
                let ext = file_name.rsplit('.').next().unwrap_or_default();
                let mut params = json!({
                    "fileId": epoch_ms().to_string(),
                    "checksum": checksum_md5,
                    "checksumSha": "",
                    "extention": ext,
                    "totalSize": file_size,
                    "fileName": file_name,
                    "clientId": epoch_ms(),
                    "fType": 1,
                    "fileCount": 0,
                    "fdata": "{}",
                    "fileUrl": file_url,
                    "zsource": -1,
                    "ttl": ttl_ms,
                });
                if thread_type.is_group() {
                    params["grid"] = json!(thread_id.as_str());
                } else {
                    params["toid"] = json!(thread_id.as_str());
                }
                self.post_encrypted(
                    "file",
                    &format!("/api/{scope}/asyncfile/msg"),
                    &params,
                    &[("nretry", "0")],
                )
                .await
            })
            .await
    }

    /// Sends an animated GIF URL (`sendGif.js`).
    #[allow(clippy::too_many_arguments)]
    pub async fn send_gif(
        &self,
        gif_url: &str,
        thumb_url: &str,
        width: u32,
        height: u32,
        total_size: u64,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::FastText, || async {
                let scope = if thread_type.is_group() { "group" } else { "message" };
                let mut params = json!({
                    "clientId": epoch_ms().to_string(),
                    "href": gif_url,
                    "thumb": thumb_url,
                    "width": width.max(100),
                    "height": height.max(100),
                    "totalSize": total_size,
                    "ttl": ttl_ms,
                    "type": 1,
                });
                if thread_type.is_group() {
                    params["grid"] = json!(thread_id.as_str());
                    params["visibility"] = json!(0);
                } else {
                    params["toid"] = json!(thread_id.as_str());
                }
                self.post_encrypted("file", &format!("/api/{scope}/gif"), &params, &[("type", "1")])
                    .await
            })
            .await
    }

    /// Sends native Zalo sticker (`sendSticker.js`).
    pub async fn send_sticker(
        &self,
        sticker_id: u64,
        cate_id: u64,
        sticker_type: u32,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::FastText, || async {
                let mut params = json!({
                    "stickerId": sticker_id,
                    "cateId": cate_id,
                    "type": sticker_type,
                    "clientId": epoch_ms(),
                    "zsource": 101,
                });
                if thread_type.is_group() {
                    params["grid"] = json!(thread_id.as_str());
                    self.post_encrypted("group", "/api/group/sticker", &params, &[("nretry", "0")])
                        .await
                } else {
                    params["toid"] = json!(thread_id.as_str());
                    params["imei"] = json!(self.imei);
                    self.post_encrypted("chat", "/api/message/sticker", &params, &[("nretry", "0")])
                        .await
                }
            })
            .await
    }

    /// Sends custom WebP/PNG URL as sticker (`sendCustomerSticker.js` 1:1 parity).
    pub async fn send_custom_sticker(
        &self,
        sticker_url: &str,
        width: u32,
        height: u32,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        let req = CustomStickerRequest {
            static_img_url: sticker_url.to_string(),
            anim_webp_url: sticker_url.to_string(),
            width,
            height,
            ttl_ms,
            is_ai: false,
            quote_cli_msg_id: None,
        };
        self.send_custom_sticker_v3(&req, thread_id, thread_type).await
    }

    /// Full `sendCustomerSticker.js` protocol supporting separate static PNG + animated WebP URLs, AI sticker badge, and quote reference.
    pub async fn send_custom_sticker_v3(
        &self,
        req: &CustomStickerRequest,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        if req.static_img_url.trim().is_empty() || req.anim_webp_url.trim().is_empty() {
            return Err(ZaloApiError::InvalidParam(
                "missing static_img_url or anim_webp_url".into(),
            ));
        }
        let width = if req.width > 0 { req.width } else { 498 };
        let height = if req.height > 0 { req.height } else { 332 };
        let ext_str = serde_json::to_string(&json!({
            "sSrcStr": if req.is_ai { "" } else { "@STICKER" },
            "sSrcType": if req.is_ai { -1 } else { 0 },
        }))?;
        let properties_str = serde_json::to_string(&json!({
            "subType": 0,
            "color": -1,
            "size": -1,
            "type": 3,
            "ext": ext_str,
        }))?;
        let webp_str = serde_json::to_string(&json!({
            "width": width,
            "height": height,
            "url": req.anim_webp_url,
        }))?;

        self.limiter
            .execute(ExecutionLane::FastText, || async {
                let scope = if thread_type.is_group() { "group" } else { "message" };
                let now = epoch_ms();
                let mut params = json!({
                    "clientId": now.saturating_mul(600),
                    "title": "",
                    "oriUrl": req.static_img_url,
                    "thumbUrl": req.static_img_url,
                    "hdUrl": req.static_img_url,
                    "width": width,
                    "height": height,
                    "properties": properties_str,
                    "contentId": now,
                    "thumb_height": height,
                    "thumb_width": width,
                    "webp": webp_str,
                    "zsource": -1,
                    "ttl": req.ttl_ms,
                });
                if req.is_ai {
                    params["pStickerType"] = json!(1);
                }
                if let Some(ref q_cli) = req.quote_cli_msg_id
                    && !q_cli.is_empty()
                {
                    params["refMessage"] = json!(q_cli);
                }
                if thread_type.is_group() {
                    params["visibility"] = json!(0);
                    params["grid"] = json!(thread_id.as_str());
                } else {
                    params["toId"] = json!(thread_id.as_str());
                }
                self.post_encrypted(
                    "file",
                    &format!("/api/{scope}/photo_url"),
                    &params,
                    &[("nretry", "0")],
                )
                .await
            })
            .await
    }

    /// Searches sticker IDs by keyword (`getStickers.js`).
    pub async fn get_stickers(&self, keyword: &str) -> Result<Value, ZaloApiError> {
        let params = json!({
            "keyword": keyword,
            "gif": 1,
            "guggy": 0,
            "imei": self.imei,
        });
        self.get_encrypted("sticker", "/api/message/sticker", &params, &[]).await
    }

    /// Fetches detail URLs for a list of sticker IDs (`getStickersDetail.js`).
    pub async fn get_stickers_detail(&self, sticker_ids: &[u64]) -> Result<Vec<Value>, ZaloApiError> {
        let mut out = Vec::with_capacity(sticker_ids.len());
        for &sid in sticker_ids {
            let params = json!({ "sid": sid });
            let detail = self
                .get_encrypted("sticker", "/api/message/sticker", &params, &[])
                .await?;
            out.push(detail);
        }
        Ok(out)
    }

    /// Parses OpenGraph preview metadata from URL (`parseLink.js`).
    pub async fn parse_link(&self, link_url: &str) -> Result<Value, ZaloApiError> {
        let params = json!({
            "link": link_url,
            "version": 1,
            "imei": self.imei,
        });
        self.post_encrypted("file", "/api/message/parselink", &params, &[]).await
    }

    /// Sends rich link preview card (`sendLink.js`).
    pub async fn send_link(
        &self,
        message_text: &str,
        link_url: &str,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        let parsed = self.parse_link(link_url).await.unwrap_or_else(|_| json!({}));
        let data_node = parsed.get("data").unwrap_or(&parsed);
        let mut params = json!({
            "msg": message_text,
            "href": link_url,
            "src": data_node.get("src").and_then(|v| v.as_str()).unwrap_or(link_url),
            "title": data_node.get("title").and_then(|v| v.as_str()).unwrap_or_default(),
            "desc": data_node.get("desc").and_then(|v| v.as_str()).unwrap_or_default(),
            "thumb": data_node.get("thumb").and_then(|v| v.as_str()).unwrap_or_default(),
            "type": 2,
            "clientId": epoch_ms(),
            "ttl": ttl_ms,
        });
        if thread_type.is_group() {
            params["grid"] = json!(thread_id.as_str());
            self.post_encrypted("group", "/api/group/sendlink", &params, &[("nretry", "0")])
                .await
        } else {
            params["toId"] = json!(thread_id.as_str());
            params["imei"] = json!(self.imei);
            self.post_encrypted("chat", "/api/message/link", &params, &[("nretry", "0")])
                .await
        }
    }

    /// Sends contact vCard (`sendBusinessCard.js`).
    pub async fn send_business_card(
        &self,
        contact_uid: &ZaloId,
        phone: Option<&str>,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        let qr_info = self.get_qr_link(std::slice::from_ref(contact_uid)).await.unwrap_or_else(|_| json!({}));
        let qr_url = qr_info
            .get(contact_uid.as_str())
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        self.limiter
            .execute(ExecutionLane::FastText, || async {
                let msg_info = json!({
                    "contactUid": contact_uid.as_str(),
                    "qrCodeUrl": qr_url,
                    "phone": phone.unwrap_or_default(),
                });
                let mut params = json!({
                    "ttl": ttl_ms,
                    "msgType": 6,
                    "clientId": epoch_ms(),
                    "msgInfo": serde_json::to_string(&msg_info)?,
                    "imei": self.imei,
                });
                let path = if thread_type.is_group() {
                    params["visibility"] = json!(0);
                    params["grid"] = json!(thread_id.as_str());
                    "/api/group/forward"
                } else {
                    params["toId"] = json!(thread_id.as_str());
                    "/api/message/forward"
                };
                self.post_encrypted("file", path, &params, &[("nretry", "0")]).await
            })
            .await
    }

    /// Sends VietQR bank transfer card (`sendBankCard.js`).
    pub async fn send_bank_card(
        &self,
        bin_bank: u32,
        num_acc_bank: &str,
        name_acc_bank: &str,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::Broadcast, || async {
                let params = json!({
                    "binBank": bin_bank,
                    "numAccBank": num_acc_bank,
                    "nameAccBank": name_acc_bank.to_uppercase(),
                    "cliMsgId": epoch_ms().to_string(),
                    "tsMsg": epoch_ms(),
                    "destUid": thread_id.as_str(),
                    "destType": thread_type.as_u8(),
                });
                self.post_encrypted("zimsg", "/api/transfer/card", &params, &[]).await
            })
            .await
    }

    /// Creates & assigns a Zalo To-Do task (`sendToDo.js`).
    pub async fn send_todo(
        &self,
        content: &str,
        assignees: &[ZaloId],
        due_date_ts: i64,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::Broadcast, || async {
                let assignee_strs: Vec<&str> = assignees.iter().map(ZaloId::as_str).collect();
                let params = json!({
                    "assignees": serde_json::to_string(&assignee_strs)?,
                    "dueDate": due_date_ts,
                    "content": content,
                    "description": "",
                    "extra": serde_json::to_string(&json!({
                        "msgId": epoch_ms(),
                        "toUid": thread_id.as_str(),
                        "isGroup": thread_type.is_group(),
                    }))?,
                    "dateDefaultType": 0,
                    "status": -1,
                    "watchers": "[]",
                    "schedule": null,
                    "src": 5,
                    "imei": self.imei,
                });
                self.post_encrypted("boards", "/api/board/personal/todo/create", &params, &[])
                    .await
            })
            .await
    }

    /// Multi-target message forward (`sendMessageForward.js`).
    pub async fn send_message_forward(
        &self,
        msg_info: &Value,
        target_ids: &[ZaloId],
        thread_type: ThreadType,
        ttl_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::Broadcast, || async {
                let ids: Vec<&str> = target_ids.iter().map(ZaloId::as_str).collect();
                let mut params = json!({
                    "ttl": ttl_ms,
                    "msgType": 1,
                    "clientId": epoch_ms().to_string(),
                    "msgInfo": serde_json::to_string(msg_info)?,
                    "imei": self.imei,
                });
                let path = if thread_type.is_group() {
                    params["grids"] = json!(ids);
                    params["visibility"] = json!(0);
                    "/api/group/mforward"
                } else {
                    params["toIds"] = json!(ids);
                    "/api/message/mforward"
                };
                self.post_encrypted("file", path, &params, &[("nretry", "0")]).await
            })
            .await
    }

    /// Adds or clears message reaction (`addReaction.js` 1:1 parity).
    pub async fn add_reaction(
        &self,
        icon: &str,
        msg_id: &ZaloId,
        cli_msg_id: &ZaloId,
        _msg_type_code: u32,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        let op = ReactionBatchOp {
            icon: icon.to_string(),
            targets: vec![ReactionBatchTarget {
                msg_id: msg_id.clone(),
                cli_msg_id: cli_msg_id.clone(),
            }],
        };
        self.add_reaction_batch(&[op], thread_id, thread_type).await
    }

    /// Packs multiple reaction operations (e.g. `UNDO` + `CLOCK` countdown frames) into a single `react_list` HTTP POST (`addReaction.js:39-92`).
    pub async fn add_reaction_batch(
        &self,
        operations: &[ReactionBatchOp],
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        if operations.is_empty() {
            return Err(ZaloApiError::InvalidParam("no reactions to apply".into()));
        }
        let msg_type_int = i64::from(thread_type.as_u8());
        let base_client_id = epoch_ms();
        let mut react_list = Vec::with_capacity(operations.len());
        for (idx, op) in operations.iter().enumerate() {
            let (r_icon, r_type) = reaction_lookup(&op.icon);
            let mut r_msg = Vec::with_capacity(op.targets.len().min(50));
            for target in op.targets.iter().take(50) {
                let raw_g = if target.msg_id.is_empty() {
                    target.cli_msg_id.as_str()
                } else {
                    target.msg_id.as_str()
                };
                let raw_c = if target.cli_msg_id.is_empty() {
                    raw_g
                } else {
                    target.cli_msg_id.as_str()
                };
                let Ok(g_id) = raw_g.parse::<i64>() else { continue };
                let c_id = raw_c.parse::<i64>().unwrap_or(g_id);
                r_msg.push(json!({
                    "gMsgID": g_id,
                    "cMsgID": c_id,
                    "msgType": msg_type_int,
                }));
            }
            if r_msg.is_empty() {
                continue;
            }
            let message_json = serde_json::to_string(&json!({
                "rMsg": r_msg,
                "rIcon": r_icon,
                "rType": r_type,
                "source": 6,
            }))?;
            react_list.push(json!({
                "message": message_json,
                "clientId": base_client_id + idx as u64,
            }));
        }
        if react_list.is_empty() {
            return Err(ZaloApiError::InvalidParam(
                "no numeric msgId/cliMsgId targets for add_reaction".into(),
            ));
        }

        self.limiter
            .execute(ExecutionLane::Control, || async {
                if thread_type.is_group() {
                    let params = json!({
                        "react_list": react_list,
                        "grid": thread_id.as_str(),
                    });
                    self.post_encrypted("reaction", "/api/group/reaction", &params, &[])
                        .await
                } else {
                    let params = json!({
                        "react_list": react_list,
                        "toid": thread_id.as_str(),
                    });
                    self.post_encrypted("reaction", "/api/message/reaction", &params, &[])
                        .await
                }
            })
            .await
    }

    /// Recalls own sent message (`undoMessage.js`).
    pub async fn undo_message(
        &self,
        msg_id: &ZaloId,
        cli_msg_id: &ZaloId,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::Control, || async {
                let mut params = json!({
                    "msgId": msg_id.as_str(),
                    "cliMsgIdUndo": epoch_ms(),
                    "clientId": cli_msg_id.as_str(),
                });
                if thread_type.is_group() {
                    params["grid"] = json!(thread_id.as_str());
                    params["visibility"] = json!(0);
                    params["imei"] = json!(self.imei);
                    self.post_encrypted("group", "/api/group/undomsg", &params, &[("nretry", "0")])
                        .await
                } else {
                    params["toid"] = json!(thread_id.as_str());
                    self.post_encrypted("chat", "/api/message/undo", &params, &[("nretry", "0")])
                        .await
                }
            })
            .await
    }

    /// Deletes a message (`only_me = false` for group admin moderation) with 6-attempt retry (`deleteMessage.js:26-40`).
    pub async fn delete_message(
        &self,
        msg_id: &ZaloId,
        cli_msg_id: &ZaloId,
        sender_uid: &ZaloId,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        only_me: bool,
    ) -> Result<Value, ZaloApiError> {
        self.limiter
            .execute(ExecutionLane::Control, || async {
                let effective_cli = if cli_msg_id.is_empty() {
                    msg_id.as_str()
                } else {
                    cli_msg_id.as_str()
                };
                let mut params = json!({
                    "cliMsgId": epoch_ms().saturating_mul(600),
                    "msgs": [{
                        "cliMsgId": effective_cli,
                        "globalMsgId": msg_id.as_str(),
                        "ownerId": sender_uid.as_str(),
                        "destId": thread_id.as_str(),
                    }],
                    "onlyMe": if only_me { 1 } else { 0 },
                });
                let (svc, path) = if thread_type.is_group() {
                    params["grid"] = json!(thread_id.as_str());
                    ("group", "/api/group/deletemsg")
                } else {
                    params["toid"] = json!(thread_id.as_str());
                    params["imei"] = json!(self.imei);
                    ("chat", "/api/message/delete")
                };

                let mut last_err = None;
                for attempt in 0..6 {
                    match self.post_encrypted(svc, path, &params, &[("nretry", "0")]).await {
                        Ok(v) => return Ok(v),
                        Err(e) => {
                            last_err = Some(e);
                            if attempt < 5 {
                                tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
                            }
                        }
                    }
                }
                Err(last_err.unwrap())
            })
            .await
    }

    /// Alias of `delete_message` matching `zDeleteMessage.js` capability.
    pub async fn z_delete_message(
        &self,
        msg_id: &ZaloId,
        cli_msg_id: &ZaloId,
        sender_uid: &ZaloId,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        only_me: bool,
    ) -> Result<Value, ZaloApiError> {
        self.delete_message(msg_id, cli_msg_id, sender_uid, thread_id, thread_type, only_me)
            .await
    }

    /// Fetches cloud recent message history (`getRecentMessage.js`).
    pub async fn get_recent_messages(
        &self,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        global_msg_id: Option<&ZaloId>,
        count: u32,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "threadId": thread_id.as_str(),
            "type": thread_type.as_u8(),
            "globalId": global_msg_id.map(ZaloId::as_str).unwrap_or("10000000000000000"),
            "count": count.clamp(1, 50),
            "imei": self.imei,
        });
        self.post_encrypted("group_cloud_message", "/api/cm/getrecentv2", &params, &[])
            .await
    }

    /// Two-step voice call ring (`sendCallVoice.js`, preserving `zpw_type = 24`!).
    pub async fn send_call_voice(&self, callee_id: &ZaloId) -> Result<Value, ZaloApiError> {
        let call_id = (epoch_ms() % 1_000_000_000) as u32;
        let step1 = json!({
            "calleeId": callee_id.as_str(),
            "callId": call_id,
            "codec": "0\n",
            "typeRequest": 1,
            "imei": self.imei,
        });
        let r1 = self
            .post_encrypted_custom_ver(
                "voice_call",
                "/api/voicecall/requestcall",
                &step1,
                ZALO_API_VERSION,
                24,
                &[],
            )
            .await?;

        let sess_json = r1
            .get("data")
            .cloned()
            .unwrap_or_else(|| r1.clone());
        let step2 = json!({
            "calleeId": callee_id.as_str(),
            "callId": call_id,
            "codec": "0\n",
            "subType": 3,
            "rtcpAddress": sess_json.get("rtcpIP").and_then(|v| v.as_str()).unwrap_or_default(),
            "rtpAddress": sess_json.get("rtpIP").and_then(|v| v.as_str()).unwrap_or_default(),
            "imei": self.imei,
        });
        self.post_encrypted_custom_ver(
            "voice_call",
            "/api/voicecall/request",
            &step2,
            ZALO_API_VERSION,
            24,
            &[],
        )
        .await
    }

    /// Probes external URL `HEAD` to check whether `Content-Type` starts with `image/` (`checkImage.js`).
    pub async fn check_image(&self, url: &str) -> bool {
        let Ok(resp) = self.http.head(url).timeout(Duration::from_secs(6)).send().await else {
            return false;
        };
        resp.headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.to_ascii_lowercase().starts_with("image/"))
    }
}

fn serialize_mentions(mentions: &[MentionSpan]) -> Result<String, ZaloApiError> {
    let arr: Vec<Value> = mentions
        .iter()
        .filter(|m| !m.uid.is_empty() && m.len > 0)
        .map(|m| {
            json!({
                "pos": m.pos,
                "uid": m.uid.as_str(),
                "len": m.len,
                "type": if m.uid.as_str() == "-1" { 1 } else { m.mention_type },
            })
        })
        .collect();
    Ok(serde_json::to_string(&arr)?)
}

fn serialize_mentions_checked(text: &str, mentions: &[MentionSpan]) -> Result<String, ZaloApiError> {
    let total_utf16 = mybot_types::utf16_len(text);
    let mut total_mention_len = 0usize;
    let mut arr = Vec::with_capacity(mentions.len());
    for m in mentions {
        if m.uid.is_empty() || m.len == 0 {
            continue;
        }
        total_mention_len = total_mention_len.saturating_add(m.len);
        arr.push(json!({
            "pos": m.pos,
            "uid": m.uid.as_str(),
            "len": m.len,
            "type": if m.uid.as_str() == "-1" { 1 } else { m.mention_type },
        }));
    }
    if total_mention_len > total_utf16 {
        return Err(ZaloApiError::InvalidParam(
            "Invalid mentions: total mention characters exceed UTF-16 message length".into(),
        ));
    }
    Ok(serde_json::to_string(&arr)?)
}

fn fallback_jpg_thumb(video_url: &str) -> Option<String> {
    let mut u = Url::parse(video_url).ok()?;
    let path = u.path().to_string();
    let dot_idx = path.rfind('.')?;
    let slash_idx = path.rfind('/').unwrap_or(0);
    if dot_idx <= slash_idx {
        return None;
    }
    let new_path = format!("{}.jpg", &path[..dot_idx]);
    u.set_path(&new_path);
    Some(u.to_string())
}

pub fn extract_links(content: &str) -> Vec<String> {
    content
        .split_whitespace()
        .filter_map(|token| {
            let trimmed = token.trim_start_matches('@').trim_end_matches('/');
            if (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
                && Url::parse(trimmed).is_ok()
            {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Complete 42-entry `ReactionMap` (`src/api-zalo/models/Reaction.js`) accepting both symbolic keys (`"thanks"`, `"CLOCK"`, `"UNDO"`, `"HEART"`, `"LIKE"`) and raw icon strings (`"/-thanks"`, `"🕑"`, `"/-heart"`).
pub fn reaction_lookup(icon: &str) -> (&'static str, i32) {
    match icon.trim() {
        "UNDO" | "" => ("", -1),
        "HAHA" | ":>" | "/:haha" => (":>", 0),
        "--b" => ("--b", 1),
        "KHOC" | ":-(( " | ":-((  " | ":-((   " | ":-((    " | ":-((" | "/:-(( " | "/:cry" => (":-((", 2),
        "LIKE" | "/-strong" | "/:like" | "👍" => ("/-strong", 3),
        "DISLIKE" | "/-weak" => ("/-weak", 4),
        "HEART" | "/-heart" | "/:heart" | "❤️" | "❤" => ("/-heart", 5),
        "SMILE" | ":d" => (":d", 6),
        "CUOIRANUOCMAT" | ":')" => (":')", 7),
        "MISS" | ":-*" => (":-*", 8),
        "HANHPHUC" | ":3" => (":3", 9),
        "SEELOVE" | ":b" => (":b", 10),
        "THING" | ";d" => (";d", 11),
        "SO" | ":~" => (":~", 12),
        "CUOIBITMIENG" | ";p" => (";p", 13),
        "CHUMO" | ":*" => (":*", 14),
        "LOLANG" | ";o" => (";o", 15),
        "RUNGNUOCMAT" | ":((" => (":((", 16),
        "CUOINHE" | ":)" => (":)", 17),
        "LELUOI" | ":p" => (":p", 18),
        "NGAINGUNG" | ":$" => (":$", 19),
        "GIAN" | ":-h" | "/:angry" => (":-h", 20),
        "CUOIGIAN" | "x-)" => ("x-)", 21),
        "COOLNGAU" | "8-)" => ("8-)", 22),
        "SUNGSUONG" | ";-d" => (";-d", 23),
        "DOI" | ":q" => (":q", 24),
        "BUON" | ":(" => (":(", 25),
        "CUOIHIEM" | "b-)" => ("b-)", 26),
        "THACMAC" | ";?" => (";?", 27),
        "NGAI" | ":|" => (":|", 28),
        "BUADAU" | ";xx" => (";xx", 29),
        "BUONSAU" | ":--|" => (":--|", 30),
        "THEM" | ";g" => (";g", 31),
        "WOW" | ":o" | "/:wow" => (":o", 32),
        "NGU" | ":z" => (":z", 33),
        "CLOCK" | "🕑" => ("🕑", 55),
        "TIEUTAN" | ";!" => (";!", 56),
        "TIASET" | "/-li" => ("/-li", 67),
        "OK" | "/-ok" => ("/-ok", 68),
        "NONE" => ("", 75),
        "HOAHONG" | "/-rose" => ("/-rose", 100),
        "thanks" | "THANKS" | "/-thanks" => ("/-thanks", 111),
        _ => ("", 75),
    }
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
