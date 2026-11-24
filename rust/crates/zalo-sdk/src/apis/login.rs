//! Pre-login session bootstrap (`src/api-zalo/apis/login.js` parity).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::header::USER_AGENT;
use mybot_types::{ZALO_API_TYPE, ZALO_API_VERSION};
use serde_json::{Value, json};
use url::Url;

use crate::crypto::{ParamsEncryptor, get_sign_key};
use crate::error::ZaloApiError;
use crate::session::{SessionKeys, ZaloSession, build_login_session_keys};

const DEFAULT_WPA_LOGIN_BASE: &str = "https://wpa.chat.zalo.me";

impl ZaloSession {
    /// Executes `getLoginInfo` + `getServerInfo` and populates `self.keys` in-place.
    pub async fn login_with_wpa_base(&self, wpa_base: &str) -> Result<SessionKeys, ZaloApiError> {
        let login_info = self.fetch_login_info(wpa_base).await?;
        let server_info = self.fetch_server_info(wpa_base).await?;
        let keys = build_login_session_keys(
            &login_info,
            &server_info,
            self.allow_test_host.as_deref(),
        )?;
        self.apply_session_keys(keys.clone())?;
        Ok(keys)
    }

    pub async fn login(&self) -> Result<SessionKeys, ZaloApiError> {
        self.login_with_wpa_base(DEFAULT_WPA_LOGIN_BASE).await
    }

    pub async fn fetch_login_info(&self, wpa_base: &str) -> Result<Value, ZaloApiError> {
        let now_ms = epoch_ms() as i64;
        let encryptor = ParamsEncryptor::new(ZALO_API_TYPE, &self.imei, now_ms)?;
        let raw_data = json!({
            "computer_name": "Web",
            "imei": self.imei,
            "language": self.language,
            "ts": now_ms,
        });
        let encrypted_params = encryptor.encrypt_params_b64(&serde_json::to_string(&raw_data)?)?;

        let type_str = ZALO_API_TYPE.to_string();
        let ver_str = ZALO_API_VERSION.to_string();
        let sign_key = get_sign_key(
            "getlogininfo",
            [
                ("zcid", encryptor.zcid.as_str()),
                ("zcid_ext", encryptor.zcid_ext.as_str()),
                ("enc_ver", encryptor.enc_ver),
                ("params", encrypted_params.as_str()),
                ("type", type_str.as_str()),
                ("client_version", ver_str.as_str()),
            ],
        );

        let mut url = Url::parse(&format!(
            "{}/api/login/getLoginInfo",
            wpa_base.trim_end_matches('/')
        ))
        .map_err(|e| ZaloApiError::InvalidEndpoint {
            label: "getLoginInfo".into(),
            reason: e.to_string(),
        })?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("zcid", &encryptor.zcid);
            qp.append_pair("zcid_ext", &encryptor.zcid_ext);
            qp.append_pair("enc_ver", encryptor.enc_ver);
            qp.append_pair("params", &encrypted_params);
            qp.append_pair("type", &type_str);
            qp.append_pair("client_version", &ver_str);
            qp.append_pair("signkey", &sign_key);
            qp.append_pair("nretry", "0");
        }

        let resp = self
            .http
            .get(url)
            .header(USER_AGENT, &self.user_agent)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ZaloApiError::HttpTransport {
                endpoint: "getLoginInfo".into(),
                status: e.status().map(|s| s.as_u16()),
                retryable: true,
                message: e.to_string(),
            })?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            return Err(ZaloApiError::HttpTransport {
                endpoint: "getLoginInfo".into(),
                status: Some(status),
                retryable: false,
                message: format!("HTTP {status}"),
            });
        }
        let body: Value = resp.json().await.map_err(|e| ZaloApiError::HttpTransport {
            endpoint: "getLoginInfo".into(),
            status: Some(status),
            retryable: false,
            message: e.to_string(),
        })?;

        let encrypted_resp = body
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ZaloApiError::InvalidCookie("Login data is null or cookie expired".into()))?;

        let decrypted_str = encryptor.decrypt_login_response(encrypted_resp)?;
        let parsed: Value = serde_json::from_str(&decrypted_str)?;
        Ok(parsed)
    }

    pub async fn fetch_server_info(&self, wpa_base: &str) -> Result<Value, ZaloApiError> {
        let type_str = ZALO_API_TYPE.to_string();
        let ver_str = ZALO_API_VERSION.to_string();
        let sign_key = get_sign_key(
            "getserverinfo",
            [
                ("imei", self.imei.as_str()),
                ("type", type_str.as_str()),
                ("client_version", ver_str.as_str()),
                ("computer_name", "Web"),
            ],
        );

        let mut url = Url::parse(&format!(
            "{}/api/login/getServerInfo",
            wpa_base.trim_end_matches('/')
        ))
        .map_err(|e| ZaloApiError::InvalidEndpoint {
            label: "getServerInfo".into(),
            reason: e.to_string(),
        })?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("imei", &self.imei);
            qp.append_pair("type", &type_str);
            qp.append_pair("client_version", &ver_str);
            qp.append_pair("computer_name", "Web");
            qp.append_pair("signkey", &sign_key);
        }

        let resp = self
            .http
            .get(url)
            .header(USER_AGENT, &self.user_agent)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ZaloApiError::HttpTransport {
                endpoint: "getServerInfo".into(),
                status: e.status().map(|s| s.as_u16()),
                retryable: true,
                message: e.to_string(),
            })?;

        let status = resp.status().as_u16();
        let body: Value = resp.json().await.map_err(|e| ZaloApiError::HttpTransport {
            endpoint: "getServerInfo".into(),
            status: Some(status),
            retryable: false,
            message: e.to_string(),
        })?;

        body.get("data")
            .cloned()
            .ok_or_else(|| ZaloApiError::InvalidCookie("getServerInfo returned null data".into()))
    }
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
