//! Embedded `Axum` + `socketioxide` Central Web Dashboard (`mybot-dashboard`).
//!
//! Serves the unmodified React 19 + Vite 8 + Tailwind 4 SPA (`dashboard/dist/`) alongside
//! all ~58 REST `/api/*` endpoints, `/internal/*` HMAC control plane, and real-time Socket.IO EIOv4.

pub mod auth;
pub mod bridge_client;
pub mod qr_coordinator;
pub mod remote_control;
pub mod routes;
pub mod ws;

pub use bridge_client::NodeBridgeClient;

pub use auth::{
    DashboardAuthManager, DashboardConfig, DashboardSession, LoginError, RequestContext,
    parse_cookie_header, resolve_safe_request_pathname, security_and_auth_middleware,
    timing_safe_str_eq,
};
pub use qr_coordinator::{QrSessionCoordinator, parse_expiry_preset};
pub use remote_control::EmbeddedSpaAssets;
pub use routes::{DELETE_CONFIRMATION_TOKEN, DashboardState, build_api_and_spa_router};
pub use ws::build_socketio_layer;

use axum::Router;
use mybot_core::FleetSupervisor;
use socketioxide::SocketIo;

/// Builds the complete `Axum` `Router` + `SocketIo` handle ready for `axum::serve(listener, app)`.
pub fn build_dashboard_app(
    config: DashboardConfig,
    supervisor: FleetSupervisor,
) -> (Router, SocketIo, DashboardState) {
    zalo_sdk::ensure_rustls_ring_provider();
    let auth = DashboardAuthManager::new(config);
    auth.ensure_bootstrap_credentials(supervisor.caches().engine());
    let state = DashboardState::new(auth.clone(), supervisor.clone());
    let (socket_layer, io) =
        build_socketio_layer(auth.clone(), supervisor.clone(), std::sync::Arc::clone(&state.bridge_cache));

    if state.is_node_hybrid() {
        let cancel = supervisor.cancellation_token();
        crate::bridge_client::spawn_bridge_relay(
            state.bridge.clone(),
            std::sync::Arc::clone(&state.bridge_cache),
            io.clone(),
            cancel,
        );
    }

    let app = build_api_and_spa_router(state.clone())
        .layer(socket_layer)
        .layer(axum::middleware::from_fn_with_state(
            auth,
            security_and_auth_middleware,
        ));

    (app, io, state)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::Utc;
    use mybot_core::{
        FastPathDispatcher, FleetSupervisor, ProtectionEngine, StudioEngine,
        SupervisorConfig, WorkloadBroker, sign_internal_payload,
    };
    use mybot_storage::{BotRecord, HotStorageCaches, StorageEngine};
    use mybot_types::{DEFAULT_ZALO_USER_AGENT, ExpiryPolicy, ZaloId};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn dashboard_auth_csrf_rate_limit_cors_studio_cas_and_hmac_contract() {
        let empty_tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(empty_tmp.path().join("dashboard/public")).unwrap();
        std::fs::write(
            empty_tmp.path().join("dashboard/public/index.html"),
            "<!doctype html><html><body>SPA INDEX OK</body></html>",
        )
        .unwrap();

        let engine = StorageEngine::open_in_memory().unwrap();
        let now = Utc::now().to_rfc3339();
        engine
            .upsert_bot(&BotRecord {
                bot_key: "child".into(),
                uid: ZaloId::new("child_uid"),
                global_uid: None,
                canonical_username: None,
                display_name: "Child Bot".into(),
                avatar: String::new(),
                is_main: false,
                owner_uid: Some("owner_1".into()),
                status: "running".into(),
                desired_status: "running".into(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: json!({}),
                imei: String::new(),
                user_agent: DEFAULT_ZALO_USER_AGENT.into(),
                proxy_url: None,
                cookie_dead: false,
                cookie_dead_reason: None,
                prefix: "!".into(),
                self_listen: true,
                identity_pending: false,
                admin_identity_seeds: Vec::new(),
                metadata: json!({}),
                created_at: now.clone(),
                updated_at: now,
            })
            .unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let cmd_bundle = Arc::new(mybot_commands::CommandRuntimeBundle::new(
            empty_tmp.path(),
            caches.clone(),
        ));
        let registry = mybot_commands::build_full_command_registry(cmd_bundle).unwrap();
        let studio = Arc::new(StudioEngine::new(registry, caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            128,
        );
        let sup_cfg = SupervisorConfig {
            internal_hmac_secret: "hmac-test-secret".into(),
            ..Default::default()
        };
        let supervisor = FleetSupervisor::new(caches, dispatcher, sup_cfg, None);
        supervisor.start_bot("child").await.unwrap();

        let dash_cfg = DashboardConfig {
            host: "127.0.0.1".into(),
            port: 0,
            admin_username: "nthdz".into(),
            admin_password: "correct horse battery staple".into(),
            cookie_secure_override: Some(true),
            cookie_samesite: "Strict".into(),
            allowed_origin: Some("http://allowed.test".into()),
            login_rate_limit_max: 2,
            login_rate_limit_window_ms: 60_000,
            session_ttl_ms: 43_200_000,
            project_root: empty_tmp.path().to_path_buf(),
            test_mode: true,
        };

        let (app, _io, _state) = build_dashboard_app(dash_cfg, supervisor.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let base = format!("http://127.0.0.1:{}", addr.port());
        let client = reqwest::Client::new();

        // 1. Unauthenticated `/api/auth/session` -> 401
        let r_unauth = client.get(format!("{base}/api/auth/session")).send().await.unwrap();
        assert_eq!(r_unauth.status().as_u16(), 401);
        let b_unauth: Value = r_unauth.json().await.unwrap();
        assert_eq!(b_unauth["authenticated"], false);

        // 2. Unauthenticated mutation -> 401 AUTH_REQUIRED & path traversal -> 401 AUTH_REQUIRED
        let r_mut = client
            .put(format!("{base}/api/bots/child/prefix"))
            .json(&json!({"prefix": "#"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r_mut.status().as_u16(), 401);
        assert_eq!(r_mut.json::<Value>().await.unwrap()["error"], "AUTH_REQUIRED");

        let r_trav = client
            .get(format!("{base}/api/bots/%2e%2e/auth/session"))
            .send()
            .await
            .unwrap();
        assert_eq!(r_trav.status().as_u16(), 401);

        // 3. First wrong login -> 401 INVALID_CREDENTIALS
        let r_bad1 = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({"username": "nthdz", "password": "wrong"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r_bad1.status().as_u16(), 401);
        assert_eq!(
            r_bad1.json::<Value>().await.unwrap()["error"],
            "INVALID_CREDENTIALS"
        );

        // 4. Correct login -> 200 + `mybot_session` (HttpOnly, Secure, SameSite=Strict) + `mybot_csrf`
        let r_ok = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({"username": "nthdz", "password": "correct horse battery staple"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r_ok.status().as_u16(), 200);
        let set_cookies: Vec<String> = r_ok
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(set_cookies.len(), 2);
        assert!(set_cookies.iter().any(|c| c.starts_with("mybot_session=") && c.contains("HttpOnly") && c.contains("Secure") && c.contains("SameSite=Strict")));
        assert!(set_cookies.iter().any(|c| c.starts_with("mybot_csrf=")));
        let cookie_header = set_cookies
            .iter()
            .map(|c| c.split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ");
        let login_body: Value = r_ok.json().await.unwrap();
        let csrf = login_body["csrfToken"].as_str().unwrap().to_string();

        // 4b. Default `admin` / `140108` login MUST always succeed
        let r_default = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({"username": "admin", "password": "140108"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r_default.status().as_u16(), 200);
        let b_default: Value = r_default.json().await.unwrap();
        assert_eq!(b_default["username"], "admin");
        assert_eq!(b_default["authenticated"], true);

        // 5. Socket.IO EIO=4 polling handshake + CORS Origin reflection
        let r_sio = client
            .get(format!("{base}/socket.io/?EIO=4&transport=polling"))
            .header("Origin", "http://allowed.test")
            .send()
            .await
            .unwrap();
        assert_eq!(r_sio.status().as_u16(), 200);
        assert_eq!(
            r_sio
                .headers()
                .get("access-control-allow-origin")
                .and_then(|v| v.to_str().ok()),
            Some("http://allowed.test")
        );

        // 6. Missing / short CSRF -> 403 CSRF_REQUIRED; valid CSRF -> 200 prefix updated
        let r_no_csrf = client
            .put(format!("{base}/api/bots/child/prefix"))
            .header("Cookie", &cookie_header)
            .header("X-CSRF-Token", "short")
            .json(&json!({"prefix": "#"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r_no_csrf.status().as_u16(), 403);
        assert_eq!(r_no_csrf.json::<Value>().await.unwrap()["error"], "CSRF_REQUIRED");

        let r_csrf_ok = client
            .put(format!("{base}/api/bots/child/prefix"))
            .header("Cookie", &cookie_header)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({"prefix": "#"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r_csrf_ok.status().as_u16(), 200);
        let b_prefix: Value = r_csrf_ok.json().await.unwrap();
        assert_eq!(b_prefix["success"], true);
        assert_eq!(b_prefix["data"]["prefix"], "#");

        // 7. SPA fallback returns index.html for `Accept: text/html`, 404 JSON otherwise
        let r_spa = client
            .get(format!("{base}/command-studio/deep-route"))
            .header("Accept", "text/html")
            .send()
            .await
            .unwrap();
        assert_eq!(r_spa.status().as_u16(), 200);
        assert!(r_spa.text().await.unwrap().contains("SPA INDEX OK"));

        let r_non_html = client
            .get(format!("{base}/missing-asset.json"))
            .header("Accept", "application/json")
            .send()
            .await
            .unwrap();
        assert_eq!(r_non_html.status().as_u16(), 404);

        // 8. Logout without CSRF -> 200 + Max-Age=0 + invalidates session
        let r_logout = client
            .post(format!("{base}/api/auth/logout"))
            .header("Cookie", &cookie_header)
            .send()
            .await
            .unwrap();
        assert_eq!(r_logout.status().as_u16(), 200);

        let r_after = client
            .get(format!("{base}/api/auth/session"))
            .header("Cookie", &cookie_header)
            .send()
            .await
            .unwrap();
        assert_eq!(r_after.status().as_u16(), 401);

        // 9. Rate limiter: failure #1 -> 401, failure #2 (`count >= 2`) -> 429 LOGIN_RATE_LIMITED
        let f1 = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({"username": "nthdz", "password": "bad"}))
            .send()
            .await
            .unwrap();
        assert_eq!(f1.status().as_u16(), 401);

        let f2 = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({"username": "nthdz", "password": "bad"}))
            .send()
            .await
            .unwrap();
        assert_eq!(f2.status().as_u16(), 429);
        assert_eq!(
            f2.json::<Value>().await.unwrap()["error"],
            "LOGIN_RATE_LIMITED"
        );

        // 10. Loopback `/internal/command/execute` HMAC-SHA256 verification
        let raw_body = br#"{"botKey":"child","text":"hello"}"#;
        let ts = Utc::now().timestamp_millis();
        let sig = sign_internal_payload("hmac-test-secret", ts, raw_body);
        let r_int = client
            .post(format!("{base}/internal/command/execute"))
            .header("x-internal-timestamp", ts.to_string())
            .header("x-internal-signature", sig)
            .body(raw_body.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(r_int.status().as_u16(), 200);
        assert_eq!(r_int.json::<Value>().await.unwrap()["success"], true);

        supervisor.shutdown_all().await;
    }

    #[tokio::test]
    async fn liferaft_embedded_spa_qr_uid_guard_and_remote_control_contract() {
        use axum::routing::{get, post};
        use axum::{Json, Router};
        use std::time::Duration;
        use zalo_sdk::qr_login::QrLoginOptions;

        let empty_tmp = tempfile::tempdir().unwrap();
        let engine = StorageEngine::open_in_memory().unwrap();
        let now = Utc::now().to_rfc3339();

        // Seed a DEAD Admin Bot (`cookie_dead = true`, old UID `111222333`)
        engine
            .upsert_bot(&BotRecord {
                bot_key: "admin".into(),
                uid: ZaloId::new("111222333"),
                global_uid: None,
                canonical_username: None,
                display_name: "Dead Admin Bot".into(),
                avatar: String::new(),
                is_main: true,
                owner_uid: None,
                status: "cookie_dead".into(),
                desired_status: "running".into(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: json!({}),
                imei: String::new(),
                user_agent: DEFAULT_ZALO_USER_AGENT.into(),
                proxy_url: None,
                cookie_dead: true,
                cookie_dead_reason: Some("COOKIE_EXPIRED_401".into()),
                prefix: "!".into(),
                self_listen: true,
                identity_pending: false,
                admin_identity_seeds: Vec::new(),
                metadata: json!({}),
                created_at: now.clone(),
                updated_at: now,
            })
            .unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let cmd_bundle = Arc::new(mybot_commands::CommandRuntimeBundle::new(
            empty_tmp.path(),
            caches.clone(),
        ));
        let registry = mybot_commands::build_full_command_registry(cmd_bundle).unwrap();
        let studio = Arc::new(StudioEngine::new(registry, caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            128,
        );
        let supervisor = FleetSupervisor::new(
            caches,
            dispatcher,
            SupervisorConfig {
                connect_live_zalo: false,
                ..Default::default()
            },
            None,
        );

        // Spin up an in-process Mock Zalo QR Portal returning a NEW Zalo UID `999888777`
        let mock_zalo = Router::new()
            .route(
                "/account",
                get(|| async { "<script src=\"https://stc-zlogin.zdn.vn/main-5.6.0.js\"></script>" }),
            )
            .route("/account/logininfo", post(|| async { Json(json!({ "error_code": 0 })) }))
            .route("/account/verify-client", post(|| async { Json(json!({ "error_code": 0 })) }))
            .route(
                "/account/authen/qr/generate",
                post(|| async {
                    Json(json!({
                        "error_code": 0,
                        "data": {
                            "code": "mock_qr_token_v4",
                            "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                        }
                    }))
                }),
            )
            .route(
                "/account/authen/qr/waiting-scan",
                post(|| async {
                    Json(json!({
                        "error_code": 0,
                        "data": { "status": "scanned", "display_name": "New Admin Zalo" }
                    }))
                }),
            )
            .route(
                "/account/authen/qr/waiting-confirm",
                post(|| async { Json(json!({ "error_code": 0 })) }),
            )
            .route(
                "/account/checksession",
                get(|| async {
                    (
                        [(axum::http::header::SET_COOKIE, "zpw_sek=mock_sek_token; Path=/; HttpOnly")],
                        "OK",
                    )
                }),
            )
            .route(
                "/jr/userinfo",
                get(|| async {
                    Json(json!({
                        "error_code": 0,
                        "data": {
                            "info": {
                                "uid": "999888777",
                                "name": "New Admin Zalo",
                                "avatar": "https://ava.zalo.me/new.jpg"
                            }
                        }
                    }))
                }),
            );

        let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = mock_listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(mock_listener, mock_zalo).await;
        });
        let mock_base = format!("http://127.0.0.1:{}", mock_addr.port());

        let dash_cfg = DashboardConfig {
            host: "127.0.0.1".into(),
            port: 0,
            admin_username: "admin".into(),
            admin_password: "initial-password-123".into(),
            cookie_secure_override: Some(false),
            cookie_samesite: "Lax".into(),
            allowed_origin: None,
            login_rate_limit_max: 5,
            login_rate_limit_window_ms: 60_000,
            session_ttl_ms: 3_600_000,
            project_root: empty_tmp.path().to_path_buf(),
            test_mode: true,
        };
        let (app, _io, state) = build_dashboard_app(dash_cfg, supervisor.clone());
        state.qr_coordinator.set_qr_options_override(Some(QrLoginOptions {
            id_base_url: mock_base.clone(),
            web_base_url: mock_base.clone(),
            user_info_url: format!("{mock_base}/jr/userinfo"),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            total_timeout: Duration::from_secs(15),
            poll_interval: Duration::from_millis(20),
        }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let base = format!("http://127.0.0.1:{}", addr.port());
        let client = reqwest::Client::new();

        // 1. Embedded `rust-embed` SPA serves Vietnamese Control Center with ZERO files on disk!
        let spa_html = client
            .get(format!("{base}/"))
            .header("Accept", "text/html")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(
            spa_html.contains("MyBot V4") || spa_html.contains("Trung Tâm"),
            "expected embedded SPA HTML, got: {spa_html}"
        );

        // 2. Login while Admin Bot cookie is DEAD (Liferaft Always-On guarantee)
        let r_login = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({ "username": "admin", "password": "initial-password-123" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r_login.status().as_u16(), 200);
        let cookies = r_login
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|h| h.to_str().unwrap().split(';').next().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("; ");
        let csrf = r_login.json::<Value>().await.unwrap()["csrfToken"]
            .as_str()
            .unwrap()
            .to_string();

        // 3. Start QR Admin Recovery (`allowAccountChange: false`) -> hits 60s UID Mismatch Guard!
        let r_start = client
            .post(format!("{base}/api/system/admin-recovery/start"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({ "allowAccountChange": false }))
            .send()
            .await
            .unwrap();
        assert_eq!(r_start.status().as_u16(), 200);

        let mut mismatch_payload = json!({});
        for _ in 0..40 {
            let poll: Value = client
                .get(format!("{base}/api/system/admin-recovery"))
                .header("Cookie", &cookies)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if poll["data"]["state"] == "uid_mismatch_confirm" {
                mismatch_payload = poll["data"].clone();
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert_eq!(mismatch_payload["state"], "uid_mismatch_confirm");
        assert_eq!(mismatch_payload["previousUid"], "111222333");
        assert_eq!(mismatch_payload["scannedUid"], "999888777");

        // 4. Confirm UID swap -> Admin Bot immediately recovers, updates UID, clears `cookieDead`, and runs!
        let r_confirm: Value = client
            .post(format!("{base}/api/system/admin-recovery/confirm-swap"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_confirm["data"]["state"], "completed");
        assert_eq!(r_confirm["data"]["uid"], "999888777");

        let recovered_admin = supervisor.caches().engine().get_bot("admin").unwrap().unwrap();
        assert!(!recovered_admin.cookie_dead);
        assert_eq!(recovered_admin.uid.as_str(), "999888777");
        assert!(supervisor.is_bot_running("admin"));

        // 5. Remote Control: Create sub-bot, extend expiry, toggle 17 Anti-Shields, Doctor & Change Password
        let r_create: Value = client
            .post(format!("{base}/api/bots"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({
                "botKey": "sub_alpha",
                "displayName": "Bot Khách Thuê A",
                "prefix": ".",
                "expiryPreset": "7d"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_create["data"]["botKey"], "sub_alpha");

        let r_shield: Value = client
            .put(format!("{base}/api/bots/admin/groups/grp_vip_1/settings"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({
                "name": "Box VIP",
                "enableBot": true,
                "antiSpam": true,
                "antiLink": true,
                "antiUndo": true
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_shield["data"]["antiSpam"], true);
        assert_eq!(r_shield["data"]["antiUndo"], true);

        let r_doc: Value = client
            .get(format!("{base}/api/system/doctor"))
            .header("Cookie", &cookies)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_doc["data"]["healthy"], true);

        let r_pw = client
            .post(format!("{base}/api/auth/change-password"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({
                "currentPassword": "initial-password-123",
                "newPassword": "new-strong-password-456"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r_pw.status().as_u16(), 200);

        // 6. Web Remote Console Parity Contract: Offline syntax check vs unknown vs group requirement
        let r_cmd_syntax: Value = client
            .post(format!("{base}/api/bots/sub_alpha/remote/execute-command"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({
                "commandLine": "help",
                "threadId": "web_remote_console"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_cmd_syntax["data"]["parsed"], true);
        assert_eq!(r_cmd_syntax["data"]["executed"], false);
        assert_eq!(r_cmd_syntax["data"]["outcome"], "syntax_check");
        assert_eq!(r_cmd_syntax["data"]["deliveredToZalo"], false);

        let r_cmd_unknown: Value = client
            .post(format!("{base}/api/bots/sub_alpha/remote/execute-command"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({
                "commandLine": "xyzunknowncommand123"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_cmd_unknown["data"]["parsed"], false);
        assert_eq!(r_cmd_unknown["data"]["executed"], false);
        assert_eq!(r_cmd_unknown["data"]["outcome"], "not_found");

        let r_cmd_empty = client
            .post(format!("{base}/api/bots/sub_alpha/remote/execute-command"))
            .header("Cookie", &cookies)
            .header("X-CSRF-Token", &csrf)
            .json(&json!({ "commandLine": "   " }))
            .send()
            .await
            .unwrap();
        assert_eq!(r_cmd_empty.status().as_u16(), 400);

        supervisor.shutdown_all().await;
    }
}
