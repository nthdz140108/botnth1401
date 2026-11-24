//! Account Profile, Avatars, Privacy Settings, Mute & Pinned Conversations APIs (14 active methods).

use std::io::Cursor;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::header::USER_AGENT;
use image::ImageReader;
use mybot_types::{ExecutionLane, ThreadType, ZALO_API_TYPE, ZALO_API_VERSION, ZaloId};
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};

use crate::crypto::encode_aes_cbc;
use crate::error::{ZaloApiError, redact_endpoint};
use crate::session::{ZaloSession, parse_and_decrypt_zalo_envelope};

impl ZaloSession {
    /// Local helper `getOwnId` (`getOwnId.js`).
    pub fn get_own_id(&self) -> Result<ZaloId, ZaloApiError> {
        Ok(self.require_keys()?.uid)
    }

    /// Local helper `getCookie` (`getCookie.js`).
    pub fn get_cookie(&self) -> String {
        self.cookie_header_for_zalo()
    }

    /// `fetchAccountInfo` (`account-info.js`): `GET /api/social/profile/me-v2`.
    pub async fn fetch_account_info(&self) -> Result<Value, ZaloApiError> {
        let params = json!({ "avatar_size": 240, "imei": self.imei });
        self.get_encrypted("profile", "/api/social/profile/me-v2", &params, &[])
            .await
    }

    /// `updateProfile` (`updateProfile.js`): `POST /api/social/profile/update`.
    pub async fn update_profile(
        &self,
        display_name: &str,
        dob_yyyy_mm_dd: &str,
        gender: u8,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "profile": serde_json::to_string(&json!({
                "name": display_name,
                "dob": dob_yyyy_mm_dd,
                "gender": gender,
            }))?,
            "biz": serde_json::to_string(&json!({}))?,
            "language": self.language,
        });
        self.post_encrypted("profile", "/api/social/profile/update", &params, &[])
            .await
    }

    /// `changeAccountSetting` (`changeAccountSettings.js`): `POST /api/social/profile/update`.
    pub async fn change_account_setting(
        &self,
        display_name: &str,
        dob_yyyy_mm_dd: &str,
        gender: u8,
        biz: &Value,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "profile": serde_json::to_string(&json!({
                "name": display_name,
                "dob": dob_yyyy_mm_dd,
                "gender": gender,
            }))?,
            "biz": serde_json::to_string(biz)?,
            "language": self.language,
        });
        self.post_encrypted("profile", "/api/social/profile/update", &params, &[])
            .await
    }

    /// `changeAccountAvatar` (`changeAccountAvatar.js`): `POST /api/profile/upavatar`.
    pub async fn change_account_avatar(&self, avatar_bytes: &[u8]) -> Result<Value, ZaloApiError> {
        let keys = self.require_keys()?;
        let file_base = self.service_endpoint("file")?;
        let (w, h) = ImageReader::new(Cursor::new(avatar_bytes))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
            .unwrap_or((640, 640));

        self.limiter
            .execute(ExecutionLane::Heavy, || async {
                let params = json!({
                    "avatarSize": 120,
                    "clientId": format!("p{}{}", keys.uid, epoch_ms()),
                    "language": self.language,
                    "metaData": serde_json::to_string(&json!({
                        "origin": { "width": w, "height": h },
                        "processed": { "width": w, "height": h, "size": avatar_bytes.len() }
                    }))?,
                });
                let encrypted = encode_aes_cbc(&keys.secret_key, &serde_json::to_string(&params)?)?;
                let endpoint = format!("{}/api/profile/upavatar", file_base.trim_end_matches('/'));
                let url = Self::make_zalo_url(
                    &endpoint,
                    ZALO_API_VERSION,
                    ZALO_API_TYPE,
                    &[("params", encrypted.as_str())],
                )?;

                let part = Part::bytes(avatar_bytes.to_vec())
                    .file_name("blob")
                    .mime_str("image/jpeg")
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
                parse_and_decrypt_zalo_envelope(&keys.secret_key, &text, Some(status))
            })
            .await
    }

    /// `getAvatarList` (`getavatarlist.js`): `GET /api/social/avatar-list`.
    pub async fn get_avatar_list(&self, page: u32, count: u32) -> Result<Value, ZaloApiError> {
        let params = json!({
            "page": page.max(1),
            "albumId": "0",
            "count": count.clamp(1, 100),
            "imei": self.imei,
        });
        self.get_encrypted("profile", "/api/social/avatar-list", &params, &[])
            .await
    }

    /// `reuseAvatar` (`setoldavatar.js`): `GET /api/social/reuse-avatar`.
    pub async fn reuse_avatar(&self, photo_id: &str) -> Result<Value, ZaloApiError> {
        let params = json!({
            "photoId": photo_id,
            "isPostSocial": 0,
            "imei": self.imei,
        });
        self.get_encrypted("profile", "/api/social/reuse-avatar", &params, &[])
            .await
    }

    /// `deleteAvatar` (`deleteavatar.js`): `GET /api/social/del-avatars`.
    pub async fn delete_avatar(&self, photo_ids: &[String]) -> Result<Value, ZaloApiError> {
        let items: Vec<Value> = photo_ids
            .iter()
            .map(|id| json!({ "albumId": "0", "photoId": id }))
            .collect();
        let params = json!({
            "delPhotos": serde_json::to_string(&items)?,
            "imei": self.imei,
        });
        self.get_encrypted("profile", "/api/social/del-avatars", &params, &[])
            .await
    }

    /// `getSettings` (`getSettings.js`): `GET /api/setting/me`.
    pub async fn get_settings(&self) -> Result<Value, ZaloApiError> {
        self.get_encrypted("profile", "/api/setting/me", &json!({}), &[])
            .await
    }

    /// `updateSettings` (`updateSettings.js`): `GET /api/setting/update`.
    pub async fn update_settings(&self, setting_type: &str, status: i32) -> Result<Value, ZaloApiError> {
        let params = json!({ setting_type: status });
        self.get_encrypted("profile", "/api/setting/update", &params, &[])
            .await
    }

    /// `updateLang` (`setlangaccount.js`): `GET /api/social/profile/updatelang`.
    pub async fn update_lang(&self, lang: &str) -> Result<Value, ZaloApiError> {
        let params = json!({ "language": lang.to_uppercase() });
        self.get_encrypted("profile", "/api/social/profile/updatelang", &params, &[])
            .await
    }

    /// `setMute` (`setmute.js`): `GET /api/social/profile/setmute`.
    pub async fn set_mute(
        &self,
        thread_id: &ZaloId,
        thread_type: ThreadType,
        duration_secs: i64,
        mute_enable: bool,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "toid": thread_id.as_str(),
            "duration": duration_secs,
            "action": if mute_enable { 1 } else { 3 },
            "startTime": (epoch_ms() / 1000),
            "muteType": if thread_type.is_group() { 2 } else { 1 },
            "imei": self.imei,
        });
        self.get_encrypted("profile", "/api/social/profile/setmute", &params, &[])
            .await
    }

    /// `setMuteGroup` (`setMuteGroup.js`): `POST /api/social/profile/setmute`.
    pub async fn set_mute_group(
        &self,
        group_id: &ZaloId,
        duration_secs: i64,
        mute_enable: bool,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "toid": group_id.as_str(),
            "duration": duration_secs,
            "action": if mute_enable { 1 } else { 3 },
            "startTime": (epoch_ms() / 1000),
            "muteType": 2,
            "imei": self.imei,
        });
        self.post_encrypted("profile", "/api/social/profile/setmute", &params, &[])
            .await
    }

    /// `setPinnedConversations` (`setPinnedConversations.js`): `POST /api/pinconvers/updatev2`.
    pub async fn set_pinned_conversations(
        &self,
        thread_ids: &[ZaloId],
        thread_type: ThreadType,
        pin: bool,
    ) -> Result<Value, ZaloApiError> {
        let prefix = if thread_type.is_group() { "g" } else { "u" };
        let convs: Vec<String> = thread_ids.iter().map(|id| format!("{prefix}{id}")).collect();
        let params = json!({
            "actionType": if pin { 1 } else { 2 },
            "conversations": convs,
        });
        self.post_encrypted("conversation", "/api/pinconvers/updatev2", &params, &[])
            .await
    }
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
