//! Isolated per-bot `ZaloSession` (`Arc<ZaloSession>`) replacing the V3 singleton `appContext`.
//!
//! Each session owns:
//! - Its own RFC 6265 `CookieStoreMutex` + `reqwest::Client` (with optional SOCKS5/HTTP proxy).
//! - Its exact stored `(cookie, imei, user_agent)` tuple so Windows cookies migrated to Linux Ubuntu
//!   never invalidate.
//! - Thread-safe `RwLock<Option<SessionKeys>>` supporting live in-place session refresh.
//! - `DashMap<String, oneshot::Sender<UploadDonePayload>>` for multi-chunk WebSocket `file_done` callbacks.
//! - SSRF validation (`*.zalo.me` over `https:` / `wss:` only).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cookie_store::{CookieStore, RawCookie};
use dashmap::DashMap;
use http::HeaderMap;
use http::header::{ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT};
use mybot_types::{
    CredentialsBundle, DEFAULT_ZALO_USER_AGENT, DEFAULT_ZALO_WEB_URL, UploadDonePayload,
    ZALO_API_TYPE, ZALO_API_VERSION, ZaloId,
};
use parking_lot::RwLock;
use reqwest::Proxy;
use reqwest_cookie_store::CookieStoreMutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;
use url::Url;

use crate::crypto::{decode_aes_cbc, encode_aes_cbc};
use crate::error::{ZaloApiError, is_retryable_http_status, redact_endpoint};
use crate::limiter::TransportLimiter;

pub const CORE_SERVICE_KEYS: &[&str] = &["chat", "group", "file", "profile", "reaction"];
const ZALOME_HOST_SUFFIX: &str = ".zalo.me";

static RUSTLS_PROVIDER_INIT: Once = Once::new();

/// Ensures `ring` crypto provider is installed once per OS process for `rustls 0.23`.
pub fn ensure_rustls_ring_provider() {
    RUSTLS_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharefileLimits {
    pub max_file: usize,
    pub max_size_mb: u64,
    pub chunk_size_bytes: usize,
}

impl Default for SharefileLimits {
    fn default() -> Self {
        Self {
            max_file: 10,
            max_size_mb: 25,
            chunk_size_bytes: 3 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKeys {
    pub uid: ZaloId,
    pub secret_key: String,
    pub send2me_id: Option<ZaloId>,
    pub service_map: HashMap<String, Vec<String>>,
    pub ws_url: String,
    pub ws_endpoints: Vec<String>,
    pub settings: Value,
    pub extra_ver: Value,
    pub sharefile: SharefileLimits,
}

pub struct ZaloSession {
    pub bot_key: String,
    pub is_main_bot: bool,
    pub imei: String,
    pub user_agent: String,
    pub language: String,
    pub web_url: String,
    pub origin: String,
    pub referer: String,
    pub self_listen: AtomicBool,
    pub prophylactic_upload: AtomicBool,
    /// When `Some`, overrides the trusted domain suffix (`*.zalo.me`) for local mock integration tests.
    pub allow_test_host: Option<String>,
    pub cookie_store: Arc<CookieStoreMutex>,
    pub http: reqwest::Client,
    pub limiter: TransportLimiter,
    pub keys: RwLock<Option<SessionKeys>>,
    pub upload_callbacks: DashMap<String, oneshot::Sender<UploadDonePayload>>,
    pub recent_outbound_ids: DashMap<String, Instant>,
}

impl ZaloSession {
    pub fn new(
        bot_key: impl Into<String>,
        is_main_bot: bool,
        credentials: &CredentialsBundle,
        self_listen: bool,
    ) -> Result<Arc<Self>, ZaloApiError> {
        Self::new_with_options(bot_key, is_main_bot, credentials, self_listen, None)
    }

    pub fn new_with_options(
        bot_key: impl Into<String>,
        is_main_bot: bool,
        credentials: &CredentialsBundle,
        self_listen: bool,
        allow_test_host: Option<String>,
    ) -> Result<Arc<Self>, ZaloApiError> {
        ensure_rustls_ring_provider();

        if credentials.imei.trim().is_empty() {
            return Err(ZaloApiError::MissingCredentials("imei"));
        }
        let user_agent = if credentials.user_agent.trim().is_empty() {
            DEFAULT_ZALO_USER_AGENT.to_string()
        } else {
            credentials.user_agent.trim().to_string()
        };

        let store = build_cookie_store(&credentials.cookie, DEFAULT_ZALO_WEB_URL)?;
        let cookie_store = Arc::new(CookieStoreMutex::new(store));

        let web_url = DEFAULT_ZALO_WEB_URL.to_string();
        let origin = web_url.clone();
        let referer = format!("{web_url}/");

        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            ACCEPT,
            "application/json, text/plain, */*".parse().unwrap(),
        );
        default_headers.insert(ACCEPT_ENCODING, "gzip, deflate, br".parse().unwrap());
        default_headers.insert(ACCEPT_LANGUAGE, "en-US,en;q=0.9".parse().unwrap());
        default_headers.insert(
            ORIGIN,
            origin
                .parse()
                .map_err(|_| ZaloApiError::InvalidParam("invalid origin header".into()))?,
        );
        default_headers.insert(
            REFERER,
            referer
                .parse()
                .map_err(|_| ZaloApiError::InvalidParam("invalid referer header".into()))?,
        );

        let mut builder = reqwest::Client::builder()
            .user_agent(&user_agent)
            .default_headers(default_headers)
            .cookie_provider(Arc::clone(&cookie_store))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(16)
            .tcp_nodelay(true)
            .connect_timeout(Duration::from_secs(8));

        if let Some(ref proxy_str) = credentials.proxy_url
            && !proxy_str.trim().is_empty()
        {
            let proxy = Proxy::all(proxy_str.trim())
                .map_err(|e| ZaloApiError::InvalidParam(format!("invalid proxy URL: {e}")))?;
            builder = builder.proxy(proxy);
        }

        let http = builder.build().map_err(|e| ZaloApiError::HttpTransport {
            endpoint: web_url.clone(),
            status: None,
            retryable: false,
            message: e.to_string(),
        })?;

        Ok(Arc::new(Self {
            bot_key: bot_key.into(),
            is_main_bot,
            imei: credentials.imei.trim().to_string(),
            user_agent,
            language: if credentials.language.trim().is_empty() {
                "vi".to_string()
            } else {
                credentials.language.trim().to_string()
            },
            web_url,
            origin,
            referer,
            self_listen: AtomicBool::new(self_listen),
            prophylactic_upload: AtomicBool::new(false),
            allow_test_host,
            cookie_store,
            http,
            limiter: TransportLimiter::default(),
            keys: RwLock::new(None),
            upload_callbacks: DashMap::new(),
            recent_outbound_ids: DashMap::new(),
        }))
    }

    /// Dynamically enables or disables self-message listening on this live session.
    pub fn set_self_listen(&self, enabled: bool) {
        self.self_listen.store(enabled, std::sync::atomic::Ordering::Relaxed);
    }

    /// Records an outbound `clientId` / `msgId` so WebSocket self-echoes are never re-parsed as commands.
    pub fn record_outbound_id(&self, id: &str) {
        let clean = id.trim();
        if clean.is_empty() {
            return;
        }
        let now = Instant::now();
        if self.recent_outbound_ids.len() > 512 {
            self.recent_outbound_ids
                .retain(|_, ts| now.duration_since(*ts) < Duration::from_secs(90));
        }
        self.recent_outbound_ids.insert(clean.to_string(), now);
    }

    /// Extracts and records message identifiers (`clientId`, `cliMsgId`, `msgId`, `globalMsgId`, `photoId`, `fileId`).
    pub fn record_outbound_value_ids(&self, val: &Value) {
        for target in [Some(val), val.get("data")] {
            let Some(obj) = target else { continue };
            for key in ["clientId", "cliMsgId", "msgId", "globalMsgId", "photoId", "fileId"] {
                if let Some(id_val) = obj.get(key) {
                    if let Some(s) = id_val.as_str() {
                        self.record_outbound_id(s);
                    } else if let Some(n) = id_val.as_u64() {
                        self.record_outbound_id(&n.to_string());
                    } else if let Some(n) = id_val.as_i64() {
                        self.record_outbound_id(&n.to_string());
                    }
                }
            }
        }
    }

    /// Checks whether an inbound `is_self` WebSocket frame is an echo of a message sent by this bot session.
    pub fn is_recent_outbound(
        &self,
        cli_msg_id: &ZaloId,
        msg_id: &ZaloId,
        global_msg_id: &ZaloId,
    ) -> bool {
        let now = Instant::now();
        for cand in [cli_msg_id.as_str(), msg_id.as_str(), global_msg_id.as_str()] {
            if !cand.is_empty()
                && let Some(ts) = self.recent_outbound_ids.get(cand)
                && now.duration_since(*ts) < Duration::from_secs(90)
            {
                return true;
            }
        }
        false
    }

    /// Exports RFC 6265 domain/path-scoped `"k1=v1; k2=v2"` Cookie header for a specific HTTP/WebSocket URL.
    /// Prevents `id.zalo.me` cookies from clobbering `chat.zalo.me` / `ws*.chat.zalo.me` session cookies!
    pub fn cookie_header_for_url(&self, target_url_str: &str) -> String {
        let normalized = if let Some(rest) = target_url_str.strip_prefix("wss://") {
            format!("https://{rest}")
        } else if let Some(rest) = target_url_str.strip_prefix("ws://") {
            format!("http://{rest}")
        } else {
            target_url_str.to_string()
        };

        let Ok(parsed_url) = Url::parse(&normalized) else {
            return String::new();
        };

        let guard = self.cookie_store.lock().unwrap();
        let mut pairs = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (name, val) in guard.get_request_values(&parsed_url) {
            if name != "undefined" && val != "undefined" && seen.insert(name.to_string()) {
                pairs.push(format!("{name}={val}"));
            }
        }
        if pairs.is_empty() {
            return String::new();
        }
        pairs.join("; ")
    }

    /// Exports flattened `"k1=v1; k2=v2"` Cookie header scoped to `self.web_url` (`https://chat.zalo.me`) with fallback.
    pub fn cookie_header_for_zalo(&self) -> String {
        if let Ok(web_url) = Url::parse(&self.web_url) {
            let guard = self.cookie_store.lock().unwrap();
            let mut pairs = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for (name, val) in guard.get_request_values(&web_url) {
                if name != "undefined" && val != "undefined" && seen.insert(name.to_string()) {
                    pairs.push(format!("{name}={val}"));
                }
            }
            if !pairs.is_empty() {
                return pairs.join("; ");
            }
        }

        let guard = self.cookie_store.lock().unwrap();
        let mut pairs = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for c in guard.iter_unexpired() {
            let name = c.name();
            let val = c.value();
            if name != "undefined" && val != "undefined" && seen.insert(name.to_string()) {
                pairs.push(format!("{name}={val}"));
            }
        }
        pairs.join("; ")
    }

    /// Exports full J2Team-compatible `{ url, cookies: [...] }` JSON for persistence.
    pub fn export_cookie_bundle(&self) -> Value {
        let guard = self.cookie_store.lock().unwrap();
        let cookies: Vec<Value> = guard
            .iter_unexpired()
            .map(|c| {
                let domain = c.domain.as_cow().unwrap_or_default().to_string();
                serde_json::json!({
                    "domain": if domain.is_empty() { ".zalo.me".to_string() } else { domain },
                    "name": c.name(),
                    "value": c.value(),
                    "path": &*c.path,
                    "secure": c.secure().unwrap_or(true),
                    "httpOnly": c.http_only().unwrap_or(false),
                })
            })
            .collect();
        serde_json::json!({
            "url": self.web_url,
            "cookies": cookies,
        })
    }

    #[inline]
    pub fn is_logged_in(&self) -> bool {
        self.keys.read().is_some()
    }

    pub fn require_keys(&self) -> Result<SessionKeys, ZaloApiError> {
        self.keys
            .read()
            .clone()
            .ok_or(ZaloApiError::MissingCredentials("session not logged in"))
    }

    pub fn uid(&self) -> Option<ZaloId> {
        self.keys.read().as_ref().map(|k| k.uid.clone())
    }

    pub fn service_endpoint(&self, service_key: &str) -> Result<String, ZaloApiError> {
        let keys = self.require_keys()?;
        keys.service_map
            .get(service_key)
            .and_then(|arr| arr.first())
            .cloned()
            .ok_or_else(|| ZaloApiError::InvalidEndpoint {
                label: service_key.to_string(),
                reason: "missing service endpoint in zpw_service_map_v3".to_string(),
            })
    }

    /// Atomically refreshes `SessionKeys` in-place (`zalo.js::applyRefreshedSession`) without breaking `Arc` holders.
    pub fn apply_session_keys(&self, new_keys: SessionKeys) -> Result<(), ZaloApiError> {
        validate_service_map(&new_keys.service_map, self.allow_test_host.as_deref())?;
        validate_endpoint(
            &new_keys.ws_url,
            "websocket",
            &["wss", "ws"],
            self.allow_test_host.as_deref(),
        )?;
        *self.keys.write() = Some(new_keys);
        Ok(())
    }

    /// Registers a one-shot callback woken when WS `(1, 601, 0)` emits `file_done` or `voice_aac_success`.
    pub fn register_upload_callback(
        &self,
        file_id: impl Into<String>,
    ) -> oneshot::Receiver<UploadDonePayload> {
        let (tx, rx) = oneshot::channel();
        self.upload_callbacks.insert(file_id.into(), tx);
        rx
    }

    /// Wakes a pending upload callback if registered.
    pub fn resolve_upload_callback(&self, payload: UploadDonePayload) {
        if let Some((_, tx)) = self.upload_callbacks.remove(payload.file_id.as_str()) {
            let _ = tx.send(payload);
        }
    }

    /// Builds a query-appended URL with `zpw_ver` & `zpw_type`.
    pub fn make_zalo_url(
        base: &str,
        zpw_ver: u32,
        zpw_type: u32,
        extra_query: &[(&str, &str)],
    ) -> Result<Url, ZaloApiError> {
        let mut parsed = Url::parse(base).map_err(|e| ZaloApiError::InvalidEndpoint {
            label: "url".into(),
            reason: e.to_string(),
        })?;
        {
            let mut qp = parsed.query_pairs_mut();
            qp.append_pair("zpw_ver", &zpw_ver.to_string());
            qp.append_pair("zpw_type", &zpw_type.to_string());
            for (k, v) in extra_query {
                qp.append_pair(k, v);
            }
        }
        Ok(parsed)
    }

    /// Encrypted `POST` (`application/x-www-form-urlencoded` `params=<AES>` + `handleZaloResponse`).
    pub async fn post_encrypted(
        &self,
        service_key: &str,
        path: &str,
        plain_params: &Value,
        extra_query: &[(&str, &str)],
    ) -> Result<Value, ZaloApiError> {
        self.post_encrypted_custom_ver(
            service_key,
            path,
            plain_params,
            ZALO_API_VERSION,
            ZALO_API_TYPE,
            extra_query,
        )
        .await
    }

    pub async fn post_encrypted_custom_ver(
        &self,
        service_key: &str,
        path: &str,
        plain_params: &Value,
        zpw_ver: u32,
        zpw_type: u32,
        extra_query: &[(&str, &str)],
    ) -> Result<Value, ZaloApiError> {
        self.record_outbound_value_ids(plain_params);
        let keys = self.require_keys()?;
        let base = self.service_endpoint(service_key)?;
        let full_base = format!("{}{}", base.trim_end_matches('/'), path);
        let encrypted = encode_aes_cbc(&keys.secret_key, &serde_json::to_string(plain_params)?)?;
        let url = Self::make_zalo_url(&full_base, zpw_ver, zpw_type, extra_query)?;
        let form_body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("params", &encrypted)
            .finish();

        let res = self
            .send_and_decrypt(&keys.secret_key, reqwest::Method::POST, url, Some(form_body), 2, 6_000)
            .await?;
        self.record_outbound_value_ids(&res);
        Ok(res)
    }

    /// Encrypted `GET` (`?zpw_ver=...&zpw_type=...&params=<AES>` + `handleZaloResponse`).
    pub async fn get_encrypted(
        &self,
        service_key: &str,
        path: &str,
        plain_params: &Value,
        extra_query: &[(&str, &str)],
    ) -> Result<Value, ZaloApiError> {
        self.get_encrypted_custom_ver(
            service_key,
            path,
            plain_params,
            ZALO_API_VERSION,
            ZALO_API_TYPE,
            extra_query,
        )
        .await
    }

    pub async fn get_encrypted_custom_ver(
        &self,
        service_key: &str,
        path: &str,
        plain_params: &Value,
        zpw_ver: u32,
        zpw_type: u32,
        extra_query: &[(&str, &str)],
    ) -> Result<Value, ZaloApiError> {
        let keys = self.require_keys()?;
        let base = self.service_endpoint(service_key)?;
        let full_base = format!("{}{}", base.trim_end_matches('/'), path);
        let encrypted = encode_aes_cbc(&keys.secret_key, &serde_json::to_string(plain_params)?)?;
        let mut query_vec = Vec::with_capacity(extra_query.len() + 1);
        query_vec.extend_from_slice(extra_query);
        query_vec.push(("params", encrypted.as_str()));
        let url = Self::make_zalo_url(&full_base, zpw_ver, zpw_type, &query_vec)?;

        self.send_and_decrypt(&keys.secret_key, reqwest::Method::GET, url, None, 2, 6_000)
            .await
    }

    /// Unencrypted query `GET` whose response `data` is still encrypted with `secretKey` (`fetchAllGroups`).
    pub async fn get_plain_query_encrypted_resp(
        &self,
        service_key: &str,
        path: &str,
        extra_query: &[(&str, &str)],
    ) -> Result<Value, ZaloApiError> {
        let keys = self.require_keys()?;
        let base = self.service_endpoint(service_key)?;
        let full_base = format!("{}{}", base.trim_end_matches('/'), path);
        let url = Self::make_zalo_url(&full_base, ZALO_API_VERSION, ZALO_API_TYPE, extra_query)?;

        self.send_and_decrypt(&keys.secret_key, reqwest::Method::GET, url, None, 2, 6_000)
            .await
    }

    /// Executes an HTTP request with retry (`250ms * (attempt + 1)`) and decrypts Zalo's `{ data: "<b64>" }` envelope.
    pub async fn send_and_decrypt(
        &self,
        secret_key: &str,
        method: reqwest::Method,
        url: Url,
        form_body: Option<String>,
        max_retries: usize,
        timeout_ms: u64,
    ) -> Result<Value, ZaloApiError> {
        let redacted = redact_endpoint(url.as_str());
        for attempt in 0..=max_retries {
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .header(USER_AGENT, &self.user_agent)
                .timeout(Duration::from_millis(timeout_ms));

            if let Some(ref body) = form_body {
                req = req
                    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(body.clone());
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if !resp.status().is_success() {
                        let retryable = is_retryable_http_status(status);
                        if retryable && attempt < max_retries {
                            tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
                            continue;
                        }
                        return Err(ZaloApiError::HttpTransport {
                            endpoint: redacted,
                            status: Some(status),
                            retryable,
                            message: format!("HTTP status {status}"),
                        });
                    }
                    let text = resp.text().await.map_err(|e| ZaloApiError::HttpTransport {
                        endpoint: redacted.clone(),
                        status: Some(status),
                        retryable: true,
                        message: e.to_string(),
                    })?;
                    return parse_and_decrypt_zalo_envelope(secret_key, &text, Some(status));
                }
                Err(err) => {
                    let retryable = err.is_timeout() || err.is_connect() || err.is_request();
                    if retryable && attempt < max_retries {
                        tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    return Err(ZaloApiError::HttpTransport {
                        endpoint: redacted,
                        status: err.status().map(|s| s.as_u16()),
                        retryable,
                        message: err.to_string(),
                    });
                }
            }
        }
        unreachable!("loop returns on final attempt")
    }
}

/// Parses and decrypts `{ error_code, error_message, data: "<AES-CBC>" }` (`utils.js::handleZaloResponse`).
pub fn parse_and_decrypt_zalo_envelope(
    secret_key: &str,
    body_text: &str,
    http_status: Option<u16>,
) -> Result<Value, ZaloApiError> {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    let outer: Value = serde_json::from_str(trimmed)?;
    if let Some(outer_code) = outer.get("error_code").and_then(|c| c.as_i64())
        && outer_code != 0
        && outer.get("data").and_then(|d| d.as_str()).is_none()
    {
        let msg = outer
            .get("error_message")
            .and_then(|m| m.as_str())
            .unwrap_or("Zalo outer API error");
        return Err(ZaloApiError::api_rejected(outer_code, http_status, msg));
    }

    let Some(data_val) = outer.get("data") else {
        return Ok(Value::Null);
    };
    if data_val.is_null() {
        return Ok(Value::Null);
    }
    if let Some(data_str) = data_val.as_str() {
        if data_str.trim().is_empty() {
            return Ok(Value::Null);
        }
        let decrypted = decode_aes_cbc(secret_key, data_str)?;
        if decrypted.trim().is_empty() {
            return Ok(Value::Null);
        }
        let inner: Value = serde_json::from_str(&decrypted)?;
        if let Some(code) = inner.get("error_code").and_then(|c| c.as_i64())
            && code != 0
        {
            let msg = inner
                .get("error_message")
                .and_then(|m| m.as_str())
                .unwrap_or("Zalo inner API error");
            return Err(ZaloApiError::api_rejected(code, http_status, msg));
        }
        return Ok(inner.get("data").cloned().unwrap_or(inner));
    }

    Ok(data_val.clone())
}

/// Validates endpoint scheme + `*.zalo.me` suffix (`zalo.js::validateEndpoint` SSRF defense).
pub fn validate_endpoint(
    url_str: &str,
    label: &str,
    allowed_schemes: &[&str],
    allow_test_host: Option<&str>,
) -> Result<String, ZaloApiError> {
    let trimmed = url_str.trim();
    if trimmed.is_empty() {
        return Err(ZaloApiError::InvalidEndpoint {
            label: label.into(),
            reason: "empty URL".into(),
        });
    }
    let parsed = Url::parse(trimmed).map_err(|e| ZaloApiError::InvalidEndpoint {
        label: label.into(),
        reason: e.to_string(),
    })?;

    let host = parsed.host_str().unwrap_or_default();
    if let Some(test_host) = allow_test_host
        && host == test_host
    {
        return Ok(trimmed.to_string());
    }

    if !allowed_schemes.contains(&parsed.scheme()) {
        return Err(ZaloApiError::InvalidEndpoint {
            label: label.into(),
            reason: format!("disallowed scheme '{}'", parsed.scheme()),
        });
    }
    if !host.ends_with(ZALOME_HOST_SUFFIX) && host != "zalo.me" {
        return Err(ZaloApiError::InvalidEndpoint {
            label: label.into(),
            reason: format!("untrusted host '{host}' (must end with {ZALOME_HOST_SUFFIX})"),
        });
    }
    Ok(trimmed.to_string())
}

pub fn normalize_service_map(raw: &Value) -> Result<HashMap<String, Vec<String>>, ZaloApiError> {
    let Some(obj) = raw.as_object() else {
        return Err(ZaloApiError::InvalidEndpoint {
            label: "zpw_service_map_v3".into(),
            reason: "missing or non-object service map".into(),
        });
    };
    let mut out = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        match v {
            Value::String(s) if !s.trim().is_empty() => {
                out.insert(k.clone(), vec![s.trim().to_string()]);
            }
            Value::Array(arr) => {
                let urls: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !urls.is_empty() {
                    out.insert(k.clone(), urls);
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

pub fn validate_service_map(
    service_map: &HashMap<String, Vec<String>>,
    allow_test_host: Option<&str>,
) -> Result<(), ZaloApiError> {
    for &key in CORE_SERVICE_KEYS {
        let Some(first) = service_map.get(key).and_then(|v| v.first()) else {
            return Err(ZaloApiError::InvalidEndpoint {
                label: key.into(),
                reason: format!("missing required core service endpoint '{key}'"),
            });
        };
        validate_endpoint(first, key, &["https"], allow_test_host)?;
    }
    Ok(())
}

/// Constructs `SessionKeys` from `getLoginInfo` + `getServerInfo` (`zalo.js::createLoginSession` parity,
/// including `setttings` 3-`t` spelling quirk!).
pub fn build_login_session_keys(
    login_data: &Value,
    server_info: &Value,
    allow_test_host: Option<&str>,
) -> Result<SessionKeys, ZaloApiError> {
    let info = login_data.get("data").unwrap_or(login_data);
    let uid: ZaloId = info
        .get("uid")
        .and_then(|u| serde_json::from_value(u.clone()).ok())
        .filter(|id: &ZaloId| !id.is_empty())
        .ok_or(ZaloApiError::MissingCredentials("loginInfo.uid"))?;

    let secret_key = info
        .get("zpw_enk")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or(ZaloApiError::MissingCredentials("loginInfo.zpw_enk"))?
        .to_string();

    let send2me_id = info
        .get("send2me_id")
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .filter(|id| !id.is_empty());

    let map_val = info
        .get("zpw_service_map_v3")
        .ok_or(ZaloApiError::MissingCredentials("zpw_service_map_v3"))?;
    let service_map = normalize_service_map(map_val)?;
    validate_service_map(&service_map, allow_test_host)?;

    let raw_ws: Vec<String> = match info.get("zpw_ws") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| x.as_str().map(ToOwned::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    if raw_ws.is_empty() {
        return Err(ZaloApiError::MissingCredentials("loginInfo.zpw_ws"));
    }

    let first_ws = validate_endpoint(&raw_ws[0], "zpw_ws[0]", &["wss"], allow_test_host)?;
    let mut valid_ws = vec![first_ws];
    for candidate in raw_ws.iter().skip(1) {
        if let Ok(ok_ws) = validate_endpoint(candidate, "zpw_ws", &["wss"], allow_test_host)
            && !valid_ws.contains(&ok_ws)
        {
            valid_ws.push(ok_ws);
        }
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let ws_endpoints: Vec<String> = valid_ws
        .iter()
        .filter_map(|ep| {
            ZaloSession::make_zalo_url(ep, ZALO_API_VERSION, ZALO_API_TYPE, &[("t", &ts)])
                .ok()
                .map(|u| u.to_string())
        })
        .collect();
    let ws_url = ws_endpoints
        .first()
        .cloned()
        .ok_or(ZaloApiError::MissingCredentials("resolved zpw_ws"))?;

    // Zalo server quirk: `setttings` with THREE 't's!
    let settings = server_info
        .get("setttings")
        .or_else(|| server_info.get("settings"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let extra_ver = server_info
        .get("extra_ver")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    let sharefile_node = settings.pointer("/features/sharefile");
    let max_file = sharefile_node
        .and_then(|s| s.get("max_file"))
        .and_then(|v| v.as_u64())
        .filter(|&n| n > 0)
        .unwrap_or(10) as usize;
    let max_size_mb = sharefile_node
        .and_then(|s| s.get("max_size_share_file_v3"))
        .and_then(|v| v.as_u64())
        .filter(|&n| n > 0)
        .unwrap_or(25);
    let chunk_size_bytes = sharefile_node
        .and_then(|s| s.get("chunk_size_file"))
        .and_then(|v| v.as_u64())
        .filter(|&n| n > 0)
        .unwrap_or(3 * 1024 * 1024) as usize;

    Ok(SessionKeys {
        uid,
        secret_key,
        send2me_id,
        service_map,
        ws_url,
        ws_endpoints,
        settings,
        extra_ver,
        sharefile: SharefileLimits {
            max_file,
            max_size_mb,
            chunk_size_bytes,
        },
    })
}

/// Parses all V3 cookie formats (`"k=v; ..."`, `[{name|key, value, domain}]`, `{cookies: [...]}`, `{zpw_sek: "..."}`)
/// into an RFC 6265 `CookieStore` scoped across `*.zalo.me` and `chat.zalo.me`.
pub fn build_cookie_store(cookie_val: &Value, default_web_url: &str) -> Result<CookieStore, ZaloApiError> {
    let mut store = CookieStore::default();
    let base_url = Url::parse(default_web_url).unwrap_or_else(|_| Url::parse("https://chat.zalo.me").unwrap());
    let mut inserted = 0usize;

    let mut insert_pair = |name: &str, value: &str, domain_opt: Option<&str>, path_opt: Option<&str>| {
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() || name == "undefined" || value == "undefined" {
            return;
        }
        let domain = domain_opt
            .map(|d| d.trim().trim_start_matches('.'))
            .filter(|d| !d.is_empty())
            .unwrap_or("zalo.me");
        let path = path_opt.filter(|p| !p.trim().is_empty()).unwrap_or("/");
        let target_url = Url::parse(&format!("https://{domain}{path}")).unwrap_or_else(|_| base_url.clone());

        let mut raw = RawCookie::new(name.to_string(), value.to_string());
        raw.set_domain(domain.to_string());
        raw.set_path(path.to_string());
        raw.set_secure(true);
        if store.insert_raw(&raw, &target_url).is_ok() {
            inserted += 1;
        }
    };

    match cookie_val {
        Value::String(s) => {
            for part in s.split(';') {
                if let Some((k, v)) = part.split_once('=') {
                    insert_pair(k, v, None, None);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                if let Some(obj) = item.as_object() {
                    let name = obj
                        .get("name")
                        .or_else(|| obj.get("key"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let val = obj.get("value").and_then(|v| v.as_str()).unwrap_or_default();
                    let domain = obj.get("domain").and_then(|v| v.as_str());
                    let path = obj.get("path").and_then(|v| v.as_str());
                    insert_pair(name, val, domain, path);
                }
            }
        }
        Value::Object(map) => {
            if let Some(arr) = map.get("cookies").and_then(|c| c.as_array()) {
                for item in arr {
                    if let Some(obj) = item.as_object() {
                        let name = obj
                            .get("name")
                            .or_else(|| obj.get("key"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let val = obj.get("value").and_then(|v| v.as_str()).unwrap_or_default();
                        let domain = obj.get("domain").and_then(|v| v.as_str());
                        let path = obj.get("path").and_then(|v| v.as_str());
                        insert_pair(name, val, domain, path);
                    }
                }
            } else {
                for (k, v) in map {
                    if let Some(vs) = v.as_str() {
                        insert_pair(k, vs, None, None);
                    }
                }
            }
        }
        _ => {}
    }

    if inserted == 0 {
        return Err(ZaloApiError::InvalidCookie(
            "no valid cookie pairs found in credentials".into(),
        ));
    }
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ssrf_validator_rejects_non_zalome_hosts() {
        assert!(validate_endpoint("https://chat.zalo.me/api", "chat", &["https"], None).is_ok());
        assert!(validate_endpoint("http://chat.zalo.me/api", "chat", &["https"], None).is_err());
        assert!(validate_endpoint("https://evil-zalo.me.attacker.com/api", "chat", &["https"], None).is_err());
    }

    #[test]
    fn cookie_parser_supports_j2team_raw_and_object_shapes() {
        let j2team = json!({
            "url": "https://chat.zalo.me",
            "cookies": [
                { "domain": ".chat.zalo.me", "name": "zpw_sek", "value": "secret123", "path": "/" },
                { "domain": ".zalo.me", "key": "zpsid", "value": "sid456", "path": "/" }
            ]
        });
        let creds = CredentialsBundle {
            imei: "uuid-md5".into(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            cookie: j2team,
            language: "vi".into(),
            proxy_url: None,
        };
        let session = ZaloSession::new("bot1", false, &creds, false).expect("valid session");
        let hdr = session.cookie_header_for_zalo();
        assert!(hdr.contains("zpw_sek=secret123"));
        assert!(hdr.contains("zpsid=sid456"));
    }

    #[test]
    fn cookie_header_for_url_prevents_id_zalo_me_from_clobbering_chat_ws_cookies() {
        let j2team = json!({
            "url": "https://chat.zalo.me",
            "cookies": [
                { "domain": "id.zalo.me", "name": "zpw_sek", "value": "stale_id_cookie", "path": "/" },
                { "domain": ".chat.zalo.me", "name": "zpw_sek", "value": "valid_chat_cookie", "path": "/" },
                { "domain": ".zalo.me", "name": "zpsid", "value": "shared_sid", "path": "/" }
            ]
        });
        let creds = CredentialsBundle {
            imei: "uuid-md5".into(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            cookie: j2team,
            language: "vi".into(),
            proxy_url: None,
        };
        let session = ZaloSession::new("bot1", false, &creds, false).expect("valid session");
        let ws_hdr = session.cookie_header_for_url("wss://ws1-msg.chat.zalo.me/?zpw_ver=671&zpw_type=30");
        assert!(ws_hdr.contains("zpw_sek=valid_chat_cookie"));
        assert!(!ws_hdr.contains("stale_id_cookie"));
        assert!(ws_hdr.contains("zpsid=shared_sid"));
    }

    #[test]
    fn cookie_header_for_url_never_falls_back_to_unscoped_cookies() {
        let creds = CredentialsBundle {
            imei: "uuid-md5".into(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            cookie: json!({
                "url": "https://chat.zalo.me",
                "cookies": [
                    { "domain": "id.zalo.me", "name": "zpw_sek", "value": "id_only_secret", "path": "/" }
                ]
            }),
            language: "vi".into(),
            proxy_url: None,
        };
        let session = ZaloSession::new("bot1", false, &creds, false).expect("valid session");

        assert_eq!(
            session.cookie_header_for_url("wss://ws1-msg.chat.zalo.me/?zpw_ver=671&zpw_type=30"),
            ""
        );
        assert_eq!(session.cookie_header_for_url("not a URL"), "");
    }

    #[test]
    fn server_info_handles_three_t_setttings_typo() {
        let login = json!({
            "data": {
                "uid": "849000111222",
                "zpw_enk": "MTIzNDU2Nzg5MDEyMzQ1Ng==",
                "zpw_ws": ["wss://ws1.chat.zalo.me"],
                "zpw_service_map_v3": {
                    "chat": ["https://tt-chat1-wpa.chat.zalo.me"],
                    "group": ["https://tt-group-wpa.chat.zalo.me"],
                    "file": ["https://tt-files-wpa.chat.zalo.me"],
                    "profile": ["https://tt-profile-wpa.chat.zalo.me"],
                    "reaction": ["https://tt-reaction-wpa.chat.zalo.me"]
                }
            }
        });
        let server = json!({
            "setttings": {
                "features": {
                    "sharefile": {
                        "max_file": 20,
                        "max_size_share_file_v3": 100,
                        "chunk_size_file": 4194304
                    }
                }
            }
        });
        let keys = build_login_session_keys(&login, &server, None).expect("keys");
        assert_eq!(keys.uid.as_str(), "849000111222");
        assert_eq!(keys.sharefile.max_file, 20);
        assert_eq!(keys.sharefile.max_size_mb, 100);
        assert_eq!(keys.sharefile.chunk_size_bytes, 4_194_304);
    }
}
