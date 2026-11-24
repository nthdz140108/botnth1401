//! Standalone Zalo QR Login State Machine (`src/commands/mybot/Credentials/qr-login.js` parity)
//! + Headless SSH UTF-8 QR Renderer for Linux Ubuntu (`mybot-ctl qr-admin`).
//!
//! State transitions:
//! 1. `GET /account` (dynamically scrapes `stc-zlogin.zdn.vn/main-<ver>.js`, fallback `"5.5.7"`) + `POST /account/logininfo`
//! 2. `POST /account/verify-client`
//! 3. `POST /account/authen/qr/generate` (auto-recovers on `error_code == -1003`)
//! 4. `POST /account/authen/qr/waiting-scan` (`classify_qr_scan_response`)
//! 5. `POST /account/authen/qr/waiting-confirm` -> `GET /account/checksession` -> cookie harvest + `jr/userinfo`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use http::header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT};
use mybot_types::{
    CredentialsBundle, DEFAULT_ZALO_ID_URL, DEFAULT_ZALO_USER_AGENT, DEFAULT_ZALO_WEB_URL,
};
use qrcode::{Color, QrCode};
use reqwest_cookie_store::CookieStoreMutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::crypto::generate_zalo_imei;
use crate::error::ZaloApiError;
use crate::session::ensure_rustls_ring_provider;

const ZALO_APP_URL: &str = "https://zalo.me/pc";
const DEFAULT_PORTAL_VERSION: &str = "5.5.7";
const FATAL_AUTH_PATTERNS: &[&str] = &[
    "cookie is expired or invalid",
    "cookie expired or invalid",
    "cookie sai định dạng",
    "cookie sai dinh dang",
    "invalid cookie",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QrScanClassification {
    Waiting,
    Scanned,
    Expired,
    Fatal,
}

/// Exact port of `classifyQrScanResponse` (`qr-login.js:513-547`).
pub fn classify_qr_scan_response(status_data: &Value) -> QrScanClassification {
    let Some(obj) = status_data.as_object() else {
        return QrScanClassification::Waiting;
    };
    let serialized = status_data.to_string().to_lowercase();
    if FATAL_AUTH_PATTERNS.iter().any(|p| serialized.contains(p)) {
        return QrScanClassification::Fatal;
    }

    let error_code = obj.get("error_code").and_then(|v| v.as_i64());
    let data = obj.get("data");

    if data.and_then(|d| d.get("data")).and_then(|v| v.as_str()) == Some("not_scanned")
        || data.and_then(|d| d.as_str()) == Some("not_scanned")
        || obj.get("status").and_then(|v| v.as_str()) == Some("not_scanned")
    {
        return QrScanClassification::Waiting;
    }
    if error_code == Some(8) && data.is_none_or(Value::is_null) {
        return QrScanClassification::Waiting;
    }
    if error_code == Some(0) && data.is_none_or(|d| d.is_null() || d == &json!(false) || d == &json!("")) {
        return QrScanClassification::Waiting;
    }
    if data.and_then(|d| d.get("status")).and_then(|v| v.as_str()) == Some("scanned")
        || obj.get("status").and_then(|v| v.as_str()) == Some("scanned")
    {
        return QrScanClassification::Scanned;
    }
    if error_code == Some(0) && data.is_some_and(|d| !d.is_null()) {
        return QrScanClassification::Scanned;
    }
    if data.and_then(|d| d.get("status")).and_then(|v| v.as_str()) == Some("expired")
        || obj.get("status").and_then(|v| v.as_str()) == Some("expired")
    {
        return QrScanClassification::Expired;
    }
    QrScanClassification::Waiting
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QrLoginPhase {
    Initializing,
    GeneratingQr,
    QrReady {
        code: String,
        qr_data_url: String,
        expires_in_secs: u64,
    },
    WaitingScan,
    WaitingConfirm,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QrLoginOutcome {
    pub credentials: CredentialsBundle,
    #[serde(default)]
    pub uid: String,
    pub display_name: String,
    pub avatar: String,
    pub zpw_sek: String,
}

#[derive(Debug, Clone)]
pub struct QrLoginOptions {
    pub id_base_url: String,
    pub web_base_url: String,
    pub user_info_url: String,
    pub user_agent: String,
    pub total_timeout: Duration,
    pub poll_interval: Duration,
}

impl Default for QrLoginOptions {
    fn default() -> Self {
        Self {
            id_base_url: DEFAULT_ZALO_ID_URL.to_string(),
            web_base_url: DEFAULT_ZALO_WEB_URL.to_string(),
            user_info_url: "https://jr.chat.zalo.me/jr/userinfo".to_string(),
            user_agent: DEFAULT_ZALO_USER_AGENT.to_string(),
            total_timeout: Duration::from_secs(100),
            poll_interval: Duration::from_millis(1200),
        }
    }
}

/// Renders any QR payload string into compact UTF-8 half-block characters (`▀`, `▄`, `█`, ` `)
/// for crisp display inside headless Ubuntu SSH sessions (`mybot-ctl qr-admin`).
pub fn render_qr_terminal_utf8(payload: &str) -> Result<String, ZaloApiError> {
    let code = QrCode::new(payload.as_bytes())
        .map_err(|e| ZaloApiError::InvalidParam(format!("QR generation error: {e}")))?;
    let width = code.width();
    let colors = code.to_colors();
    let quiet = 2isize;
    let total = width as isize + quiet * 2;
    let is_dark = |x: isize, y: isize| -> bool {
        if x < quiet || y < quiet || x >= quiet + width as isize || y >= quiet + width as isize {
            false
        } else {
            colors[(y - quiet) as usize * width + (x - quiet) as usize] == Color::Dark
        }
    };

    let mut out = String::with_capacity(((total as usize + 2) * (total as usize / 2 + 2)) * 3);
    let mut y = 0isize;
    while y < total {
        for x in 0..total {
            // Invert (light background around dark modules) for dark SSH terminals
            let top_light = !is_dark(x, y);
            let bot_light = if y + 1 < total { !is_dark(x, y + 1) } else { false };
            let ch = match (top_light, bot_light) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            };
            out.push(ch);
        }
        out.push('\n');
        y += 2;
    }
    Ok(out)
}

/// Decodes raw PNG bytes from `data:image/png;base64,...`.
pub fn decode_qr_png_data_url(data_url: &str) -> Result<Vec<u8>, ZaloApiError> {
    let raw_b64 = data_url
        .trim()
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(data_url.trim());
    base64::engine::general_purpose::STANDARD
        .decode(raw_b64.as_bytes())
        .map_err(|e| ZaloApiError::Crypto(e.into()))
}

struct QrHttpSession {
    http: reqwest::Client,
    cookie_store: Arc<CookieStoreMutex>,
    portal_version: String,
    referer: String,
}

/// Executes the complete Zalo QR Login flow asynchronously with cancellation and deadline enforcement.
pub async fn authenticate_zalo_qr<F>(
    opts: QrLoginOptions,
    mut on_phase: F,
    cancel: CancellationToken,
) -> Result<QrLoginOutcome, ZaloApiError>
where
    F: FnMut(QrLoginPhase),
{
    ensure_rustls_ring_provider();
    let deadline = Instant::now() + opts.total_timeout;
    on_phase(QrLoginPhase::Initializing);

    let mut sess = init_and_verify(&opts).await?;
    if cancel.is_cancelled() {
        return Err(ZaloApiError::WebSocket("QR login cancelled".into()));
    }

    on_phase(QrLoginPhase::GeneratingQr);
    let (qr_code_token, qr_data_url) = generate_qr_with_retry(&opts, &mut sess).await?;
    let remaining_secs = deadline.saturating_duration_since(Instant::now()).as_secs();
    on_phase(QrLoginPhase::QrReady {
        code: qr_code_token.clone(),
        qr_data_url,
        expires_in_secs: remaining_secs,
    });

    // Step 4: Poll `waiting-scan`
    on_phase(QrLoginPhase::WaitingScan);
    loop {
        if cancel.is_cancelled() {
            return Err(ZaloApiError::WebSocket("QR login cancelled".into()));
        }
        if Instant::now() >= deadline {
            return Err(ZaloApiError::WebSocket("QR login expired waiting for scan".into()));
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("code", &qr_code_token)
            .append_pair("continue", &format!("{}/", opts.web_base_url))
            .append_pair("v", &sess.portal_version)
            .finish();

        let post_res = sess
            .http
            .post(format!("{}/account/authen/qr/waiting-scan", opts.id_base_url))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(ORIGIN, &opts.id_base_url)
            .header(REFERER, &sess.referer)
            .header(ACCEPT, "application/json, text/plain, */*")
            .body(body)
            .timeout(Duration::from_secs(35))
            .send()
            .await;

        let resp_json: Value = match post_res {
            Ok(resp) => resp.json().await.unwrap_or_else(|_| json!({})),
            Err(e) => {
                tracing::debug!("waiting-scan transient transport drop/timeout: {e}");
                tokio::select! {
                    _ = cancel.cancelled() => return Err(ZaloApiError::WebSocket("QR login cancelled".into())),
                    _ = tokio::time::sleep(opts.poll_interval) => {}
                }
                continue;
            }
        };

        match classify_qr_scan_response(&resp_json) {
            QrScanClassification::Scanned => break,
            QrScanClassification::Expired => {
                return Err(ZaloApiError::WebSocket("QR code expired".into()));
            }
            QrScanClassification::Fatal => {
                return Err(ZaloApiError::InvalidCookie("QR session rejected as invalid".into()));
            }
            QrScanClassification::Waiting => {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(ZaloApiError::WebSocket("QR login cancelled".into())),
                    _ = tokio::time::sleep(opts.poll_interval) => {}
                }
            }
        }
    }

    // Step 5: Poll `waiting-confirm`
    on_phase(QrLoginPhase::WaitingConfirm);
    loop {
        if cancel.is_cancelled() {
            return Err(ZaloApiError::WebSocket("QR login cancelled".into()));
        }
        if Instant::now() >= deadline {
            return Err(ZaloApiError::WebSocket("QR login expired waiting for confirm".into()));
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("code", &qr_code_token)
            .append_pair("gToken", "")
            .append_pair("gAction", "CONFIRM_QR")
            .append_pair("continue", &format!("{}/index.html", opts.web_base_url))
            .append_pair("v", &sess.portal_version)
            .finish();

        let post_res = sess
            .http
            .post(format!("{}/account/authen/qr/waiting-confirm", opts.id_base_url))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(ORIGIN, &opts.id_base_url)
            .header(REFERER, &sess.referer)
            .header(ACCEPT, "application/json, text/plain, */*")
            .body(body)
            .timeout(Duration::from_secs(35))
            .send()
            .await;

        let status_data: Value = match post_res {
            Ok(resp) => resp.json().await.unwrap_or_else(|_| json!({})),
            Err(e) => {
                tracing::debug!("waiting-confirm transient transport drop/timeout: {e}");
                tokio::select! {
                    _ = cancel.cancelled() => return Err(ZaloApiError::WebSocket("QR login cancelled".into())),
                    _ = tokio::time::sleep(opts.poll_interval) => {}
                }
                continue;
            }
        };

        let err_code = status_data.get("error_code").and_then(|c| c.as_i64());
        match err_code {
            Some(0) => {
                // Exchange SSO ticket -> deposit `zpw_sek` cookie via `checksession` redirect chain
                let check_url = format!(
                    "{}/account/checksession?continue={}",
                    opts.id_base_url,
                    urlencoding::encode(&format!("{}/index.html", opts.web_base_url))
                );
                let _ = sess
                    .http
                    .get(&check_url)
                    .header(REFERER, &sess.referer)
                    .timeout(Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| ZaloApiError::WebSocket(format!("checksession failed: {e}")))?;

                let user_info: Value = match sess
                    .http
                    .get(&opts.user_info_url)
                    .header(REFERER, format!("{}/", opts.web_base_url))
                    .timeout(Duration::from_secs(8))
                    .send()
                    .await
                {
                    Ok(resp) => resp.json().await.unwrap_or_else(|_| json!({})),
                    Err(_) => json!({}),
                };

                let uid = ["/data/info/uid", "/data/info/userId", "/data/uid", "/uid"]
                    .iter()
                    .find_map(|ptr| {
                        user_info.pointer(ptr).and_then(|v| {
                            v.as_str()
                                .map(ToOwned::to_owned)
                                .or_else(|| v.as_i64().map(|n| n.to_string()))
                                .or_else(|| v.as_u64().map(|n| n.to_string()))
                        })
                    })
                    .unwrap_or_default();

                let display_name = user_info
                    .pointer("/data/info/name")
                    .or_else(|| user_info.pointer("/data/name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let avatar = user_info
                    .pointer("/data/info/avatar")
                    .or_else(|| user_info.pointer("/data/avatar"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let (cookie_json, zpw_sek) = harvest_cookies(&sess.cookie_store, &opts.web_base_url);
                let imei = generate_zalo_imei(&opts.user_agent);

                on_phase(QrLoginPhase::Completed);
                return Ok(QrLoginOutcome {
                    credentials: CredentialsBundle {
                        imei,
                        user_agent: opts.user_agent,
                        cookie: cookie_json,
                        language: "vi".to_string(),
                        proxy_url: None,
                    },
                    uid,
                    display_name,
                    avatar,
                    zpw_sek,
                });
            }
            Some(-13) => {
                return Err(ZaloApiError::WebSocket("QR login declined by user (-13)".into()));
            }
            _ => {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(ZaloApiError::WebSocket("QR login cancelled".into())),
                    _ = tokio::time::sleep(opts.poll_interval) => {}
                }
            }
        }
    }
}

async fn init_and_verify(opts: &QrLoginOptions) -> Result<QrHttpSession, ZaloApiError> {
    let cookie_store = Arc::new(CookieStoreMutex::new(cookie_store::CookieStore::default()));
    let http = reqwest::Client::builder()
        .user_agent(&opts.user_agent)
        .cookie_provider(Arc::clone(&cookie_store))
        .redirect(reqwest::redirect::Policy::limited(10))
        .tcp_nodelay(true)
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| ZaloApiError::WebSocket(e.to_string()))?;

    let cont = format!("{}/", opts.web_base_url);
    let referer = format!(
        "{}/account?continue={}",
        opts.id_base_url,
        urlencoding::encode(&cont)
    );

    let account_resp = http
        .get(format!(
            "{}/account?continue={}&v={DEFAULT_PORTAL_VERSION}",
            opts.id_base_url,
            urlencoding::encode(&cont)
        ))
        .header(ACCEPT, "text/html,application/json,*/*")
        .header(ACCEPT_LANGUAGE, "vi-VN,vi;q=0.9,en-US;q=0.8")
        .header(USER_AGENT, &opts.user_agent)
        .send()
        .await
        .map_err(|e| ZaloApiError::WebSocket(format!("GET /account failed: {e}")))?;

    let account_html = account_resp.text().await.unwrap_or_default();
    let portal_version = scrape_portal_version(&account_html)
        .unwrap_or_else(|| DEFAULT_PORTAL_VERSION.to_string());

    let login_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("continue", &cont)
        .append_pair("v", &portal_version)
        .finish();

    let mut login_ok = false;
    for path in ["/account/logininfo", "/account/login"] {
        if let Ok(r) = http
            .post(format!("{}{path}", opts.id_base_url))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(ORIGIN, &opts.id_base_url)
            .header(REFERER, &referer)
            .body(login_body.clone())
            .send()
            .await
            && r.status().is_success()
        {
            login_ok = true;
            break;
        }
    }
    if !login_ok {
        return Err(ZaloApiError::WebSocket("POST /account/logininfo failed".into()));
    }

    let verify_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("type", "device")
        .append_pair("continue", ZALO_APP_URL)
        .append_pair("v", &portal_version)
        .finish();

    let verify_resp = http
        .post(format!("{}/account/verify-client", opts.id_base_url))
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(ORIGIN, &opts.id_base_url)
        .header(REFERER, &referer)
        .body(verify_body)
        .send()
        .await
        .map_err(|e| ZaloApiError::WebSocket(format!("POST /verify-client failed: {e}")))?;
    if !verify_resp.status().is_success() {
        return Err(ZaloApiError::WebSocket(format!(
            "verify-client returned HTTP {}",
            verify_resp.status()
        )));
    }

    Ok(QrHttpSession {
        http,
        cookie_store,
        portal_version,
        referer,
    })
}

async fn generate_qr_with_retry(
    opts: &QrLoginOptions,
    sess: &mut QrHttpSession,
) -> Result<(String, String), ZaloApiError> {
    for attempt in 0..3 {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("continue", ZALO_APP_URL)
            .append_pair("v", &sess.portal_version)
            .finish();

        let resp = sess
            .http
            .post(format!("{}/account/authen/qr/generate", opts.id_base_url))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(ORIGIN, &opts.id_base_url)
            .header(REFERER, &sess.referer)
            .body(body)
            .send()
            .await
            .map_err(|e| ZaloApiError::WebSocket(format!("qr/generate failed: {e}")))?;

        let data: Value = resp.json().await.unwrap_or_else(|_| json!({}));
        if let Some(image) = data.pointer("/data/image").and_then(|v| v.as_str())
            && let Some(code) = data.pointer("/data/code").and_then(|v| v.as_str())
            && !image.is_empty()
            && !code.is_empty()
        {
            return Ok((code.to_string(), image.to_string()));
        }

        if data.get("error_code").and_then(|c| c.as_i64()) == Some(-1003) && attempt < 2 {
            tokio::time::sleep(Duration::from_millis(800)).await;
            *sess = init_and_verify(opts).await?;
            continue;
        }
    }
    Err(ZaloApiError::WebSocket("failed to generate QR code after 3 attempts".into()))
}

fn scrape_portal_version(html: &str) -> Option<String> {
    let marker = "stc-zlogin.zdn.vn/main-";
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find(".js")?;
    let ver = &rest[..end];
    if !ver.is_empty() && ver.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(ver.to_string())
    } else {
        None
    }
}

fn harvest_cookies(store: &CookieStoreMutex, web_url: &str) -> (Value, String) {
    let guard = store.lock().unwrap();
    let mut zpw_sek = String::new();
    let mut cookies = Vec::new();
    for c in guard.iter_unexpired() {
        if c.name() == "zpw_sek" {
            zpw_sek = c.value().to_string();
        }
        let domain = c.domain.as_cow().unwrap_or_default().to_string();
        cookies.push(json!({
            "domain": if domain.is_empty() { ".zalo.me".to_string() } else { domain },
            "hostOnly": !c.domain.as_cow().unwrap_or_default().starts_with('.'),
            "httpOnly": c.http_only().unwrap_or(false),
            "name": c.name(),
            "path": &*c.path,
            "sameSite": "unspecified",
            "secure": c.secure().unwrap_or(true),
            "session": true,
            "storeId": "0",
            "value": c.value(),
        }));
    }
    (
        json!({
            "url": web_url,
            "cookies": cookies,
        }),
        zpw_sek,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_scan_classifier_matches_v3_contract() {
        assert_eq!(
            classify_qr_scan_response(&json!({ "error_code": 8, "data": null })),
            QrScanClassification::Waiting
        );
        assert_eq!(
            classify_qr_scan_response(&json!({ "error_code": 0, "data": { "data": "not_scanned" } })),
            QrScanClassification::Waiting
        );
        assert_eq!(
            classify_qr_scan_response(&json!({ "error_code": 0, "data": { "display_name": "AD" } })),
            QrScanClassification::Scanned
        );
        assert_eq!(
            classify_qr_scan_response(&json!({ "status": "expired" })),
            QrScanClassification::Expired
        );
    }

    #[test]
    fn terminal_qr_renders_utf8_half_blocks() {
        let rendered = render_qr_terminal_utf8("https://zalo.me/qr/test-12345").unwrap();
        assert!(rendered.lines().count() >= 10);
        assert!(rendered.contains('█'));
    }
}
