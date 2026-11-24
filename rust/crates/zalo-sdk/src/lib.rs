//! Multi-Tenant Pure-Rust Zalo Web SDK (`API_TYPE = 30`, `API_VERSION = 671`).
//!
//! Replaces all 111 files in `src/api-zalo/` plus `qr-login.js` & `qr-login-admin.js` with:
//! - Isolated `Arc<ZaloSession>` instances (zero global singleton state; 100+ bots per OS process).
//! - Hardware AES-128/256-CBC & **16-byte IV (`typenum::U16`)** AES-GCM + SIMD `flate2`.
//! - Binary WebSocket framing, dual keepalive, `socket_generation` guard, and `(1, 602, 0)` typing events.
//! - 4-lane `TransportLimiter` + 5-stage quote fallback + streaming 3 MiB chunk uploads.
//! - All 88 active Zalo APIs + `get_poll_detail` + headless QR Login state machine.

pub mod apis;
pub mod crypto;
pub mod error;
pub mod limiter;
pub mod qr_login;
pub mod session;
pub mod ws_listener;

pub use apis::groups::GroupSettingsToggle;
pub use apis::messaging::{
    CustomStickerRequest, OutboundMessage, ReactionBatchOp, ReactionBatchTarget, VideoSendRequest,
    extract_links, reaction_lookup,
};
pub use apis::upload::UploadedAttachment;
pub use error::{ZaloApiError, ZaloCryptoError, redact_endpoint};
pub use limiter::{LaneConfig, LaneTelemetry, TransportLimiter};
pub use qr_login::{
    QrLoginOptions, QrLoginOutcome, QrLoginPhase, QrScanClassification, authenticate_zalo_qr,
    classify_qr_scan_response, render_qr_terminal_utf8,
};
pub use session::{
    CORE_SERVICE_KEYS, SessionKeys, SharefileLimits, ZaloSession, build_cookie_store,
    build_login_session_keys, ensure_rustls_ring_provider, validate_endpoint,
};
pub use ws_listener::{
    WsListenerConfig, ZaloWsEvent, ZaloWsListener, decode_ws_binary_frame, encode_ws_binary_frame,
};

#[cfg(test)]
mod integration_tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::extract::State;
    use axum::routing::{get, post};
    use base64::Engine as _;
    use mybot_types::{
        CredentialsBundle, DEFAULT_ZALO_USER_AGENT, MentionSpan, QuotedMessage, ThreadType, ZaloId,
    };
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use crate::apis::messaging::OutboundMessage;
    use crate::crypto::{ decode_aes_cbc, encode_aes_cbc };
    use crate::session::{SessionKeys, SharefileLimits, ZaloSession};

    #[derive(Clone)]
    struct MockZaloServer {
        secret_key: String,
        quote_calls: Arc<AtomicUsize>,
        plain_calls: Arc<AtomicUsize>,
    }

    async fn mock_quote_fail(State(st): State<MockZaloServer>) -> axum::Json<Value> {
        st.quote_calls.fetch_add(1, Ordering::Relaxed);
        let err_inner = json!({
            "error_code": -201,
            "error_message": "Quote target deleted",
            "data": null
        });
        let enc = encode_aes_cbc(&st.secret_key, &err_inner.to_string()).unwrap();
        axum::Json(json!({ "error_code": 0, "data": enc }))
    }

    async fn mock_group_send_ok(
        State(st): State<MockZaloServer>,
        body: String,
    ) -> axum::Json<Value> {
        st.plain_calls.fetch_add(1, Ordering::Relaxed);
        let params_b64 = url::form_urlencoded::parse(body.as_bytes())
            .find(|(k, _)| k == "params")
            .map(|(_, v)| v.into_owned())
            .unwrap();
        let plain: Value =
            serde_json::from_str(&decode_aes_cbc(&st.secret_key, &params_b64).unwrap()).unwrap();
        assert_eq!(plain["grid"], "999888777");

        let ok_inner = json!({
            "error_code": 0,
            "error_message": "Success",
            "data": { "msgId": "777000111" }
        });
        let enc = encode_aes_cbc(&st.secret_key, &ok_inner.to_string()).unwrap();
        axum::Json(json!({ "error_code": 0, "data": enc }))
    }

    #[tokio::test]
    async fn send_message_executes_5_stage_quote_fallback_against_mock_zalo_server() {
        let secret_key = base64::engine::general_purpose::STANDARD.encode([0x33u8; 16]);
        let mock = MockZaloServer {
            secret_key: secret_key.clone(),
            quote_calls: Arc::new(AtomicUsize::new(0)),
            plain_calls: Arc::new(AtomicUsize::new(0)),
        };

        let app = Router::new()
            .route("/api/group/quote", post(mock_quote_fail))
            .route("/api/group/mention", post(mock_group_send_ok))
            .route("/api/group/sendmsg", post(mock_group_send_ok))
            .route("/api/group/getlg/v4", get(|| async { axum::Json(json!({"data": null})) }))
            .with_state(mock.clone());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let base_http = format!("http://127.0.0.1:{}", addr.port());
        let base_ws = format!("ws://127.0.0.1:{}", addr.port());

        let creds = CredentialsBundle {
            imei: "uuid-test-imei".into(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            cookie: json!("zpw_sek=testcookie"),
            language: "vi".into(),
            proxy_url: None,
        };
        let session = ZaloSession::new_with_options(
            "bot_test",
            false,
            &creds,
            false,
            Some("127.0.0.1".into()),
        )
        .unwrap();

        let mut map = std::collections::HashMap::new();
        for k in ["chat", "group", "file", "profile", "reaction"] {
            map.insert(k.to_string(), vec![base_http.clone()]);
        }
        session
            .apply_session_keys(SessionKeys {
                uid: ZaloId::from("849000999"),
                secret_key,
                send2me_id: None,
                service_map: map,
                ws_url: base_ws.clone(),
                ws_endpoints: vec![base_ws],
                settings: json!({}),
                extra_ver: json!({}),
                sharefile: SharefileLimits::default(),
            })
            .unwrap();

        let msg = OutboundMessage {
            text: "@User Xin chào!".into(),
            mentions: vec![MentionSpan {
                uid: ZaloId::from("849123"),
                pos: 0,
                len: 5,
                mention_type: 0,
            }],
            quote: Some(QuotedMessage {
                owner_id: ZaloId::from("849123"),
                cli_msg_id: ZaloId::from("111"),
                global_msg_id: ZaloId::from("222"),
                cli_msg_type: 1,
                ts: 1730000000000,
                ttl: 0,
                msg: "old".into(),
                from_display_name: None,
                attach: None,
            }),
            link_on: false,
            ..Default::default()
        };

        let res = session
            .send_message(msg, &ZaloId::from("999888777"), ThreadType::Group)
            .await
            .expect("fallback succeeded");
        assert_eq!(res["message"]["msgId"], "777000111");
        assert_eq!(mock.quote_calls.load(Ordering::Relaxed), 1);
        assert_eq!(mock.plain_calls.load(Ordering::Relaxed), 1);
    }
}
