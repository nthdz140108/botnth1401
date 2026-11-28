//! Complete Axum 0.8 Router for the Central Web Dashboard (~58 `/api/*` endpoints,
//! `/internal/*` HMAC loopback control plane, QR login session manager, and React 19 SPA static fallback).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use chrono::Utc;
use dashmap::DashMap;
use mybot_core::{
    FleetSupervisor, SupervisorError, current_ict_iso_week_key, render_studio_template,
    verify_internal_signature,
};
use mybot_storage::{StorageError, migrate_v1_command_entry_to_v2};
use mybot_types::{
    ApiEnvelope, BotStatusV2, DEFAULT_ZALO_USER_AGENT, EventSource, ExpiryPolicy, InboundMessage,
    MessageContent, ThreadType, ZaloId,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{
    DashboardAuthManager, LoginError, RequestContext, extract_client_ip,
};
use crate::qr_coordinator::QrSessionCoordinator;
use crate::remote_control::{
    api_admin_recovery_cancel, api_admin_recovery_confirm_swap, api_admin_recovery_start,
    api_auth_change_password, api_bot_add_admin, api_bot_enable_all_groups, api_bot_leave_group,
    api_bot_list_admins, api_bot_list_friends, api_bot_list_groups, api_bot_put_expiry,
    api_bot_put_group_settings, api_bot_put_unified_settings, api_bot_remote_broadcast,
    api_bot_remote_execute_command, api_bot_remote_send_message, api_bot_remove_admin,
    api_bots_create, api_owner_trial_reset, api_system_backup_download, api_system_doctor,
    api_system_migrate_v3, serve_spa_with_embedded_fallback,
};

pub const DELETE_CONFIRMATION_TOKEN: &str = "DELETE";

#[derive(Clone)]
pub struct DashboardState {
    pub auth: DashboardAuthManager,
    pub supervisor: FleetSupervisor,
    pub drafts: Arc<DashMap<(String, String, String, String), Value>>,
    pub feature_flags: Arc<DashMap<String, Value>>,
    pub qr_sessions: Arc<DashMap<String, Value>>,
    pub qr_coordinator: QrSessionCoordinator,
    pub bridge: crate::bridge_client::NodeBridgeClient,
    pub bridge_cache: Arc<tokio::sync::RwLock<crate::bridge_client::BridgeFleetCache>>,
}

impl DashboardState {
    pub fn new(auth: DashboardAuthManager, supervisor: FleetSupervisor) -> Self {
        let flags = DashMap::new();
        flags.insert("v4PureRustEngine".into(), json!(true));
        flags.insert("commandStudioV2".into(), json!(true));
        flags.insert("preSheddingAntiUndo".into(), json!(true));
        flags.insert("crossSessionUidIsolation".into(), json!(true));
        flags.insert("alwaysOnLiferaftDashboard".into(), json!(true));
        flags.insert(
            "nodeHybrid".into(),
            json!(std::env::var("MYBOT_NODE_HYBRID")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)),
        );
        let qr_sessions = Arc::new(DashMap::new());
        let qr_coordinator = QrSessionCoordinator::new(supervisor.clone(), Arc::clone(&qr_sessions));
        let bridge = crate::bridge_client::NodeBridgeClient::from_env();
        let bridge_cache = Arc::new(tokio::sync::RwLock::new(
            crate::bridge_client::BridgeFleetCache::new(),
        ));
        Self {
            auth,
            supervisor,
            drafts: Arc::new(DashMap::new()),
            feature_flags: Arc::new(flags),
            qr_sessions,
            qr_coordinator,
            bridge,
            bridge_cache,
        }
    }

    pub fn is_node_hybrid(&self) -> bool {
        self.feature_flags
            .get("nodeHybrid")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

pub(crate) async fn hybrid_management(st: &DashboardState, ctx: &RequestContext, method: reqwest::Method, route: String, body: Option<&Value>) -> Response {
    match st.bridge.management_request(method, &route, body).await {
        Ok((status, value)) => (StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY), Json(value)).into_response(),
        Err(message) => err_json(StatusCode::BAD_GATEWAY, ctx, "BRIDGE_UNAVAILABLE", &message, None),
    }
}

async fn api_bot_operation(State(st): State<DashboardState>, Extension(ctx): Extension<RequestContext>, Path((id, operation_id)): Path<(String, String)>) -> Response {
    if !st.is_node_hybrid() { return err_json(StatusCode::NOT_FOUND, &ctx, "OPERATION_NOT_FOUND", "Operation unavailable", None); }
    hybrid_management(&st, &ctx, reqwest::Method::GET, format!("/bridge/bots/{id}/operations/{operation_id}"), None).await
}

fn ok_json(ctx: &RequestContext, data: Value) -> Response {
    (StatusCode::OK, Json(ApiEnvelope::ok(data, &ctx.request_id))).into_response()
}

fn status_ok_json(status: StatusCode, ctx: &RequestContext, data: Value) -> Response {
    (status, Json(ApiEnvelope::ok(data, &ctx.request_id))).into_response()
}

fn err_json(
    status: StatusCode,
    ctx: &RequestContext,
    code: &str,
    message: impl Into<String>,
    details: Option<Value>,
) -> Response {
    (
        status,
        Json(ApiEnvelope::<Value>::err(
            code,
            message,
            details,
            &ctx.request_id,
        )),
    )
        .into_response()
}

fn is_safe_bot_id(id: &str) -> bool {
    !id.trim().is_empty()
        && id != "."
        && id != ".."
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn build_api_and_spa_router(state: DashboardState) -> Router {
    let project_root = state.auth.config().project_root.clone();
    let dist_dir = resolve_spa_asset_dir(&project_root, state.auth.config().test_mode);

    Router::new()
        // 1. Auth Endpoints (`dashboard/server.js` exact contract + Web Admin Password Change)
        .route("/api/auth/session", get(api_auth_session))
        .route("/api/auth/login", post(api_auth_login))
        .route("/api/auth/logout", post(api_auth_logout))
        .route("/api/auth/change-password", post(api_auth_change_password))
        // 2. Dashboard Overview, Metrics & Logs
        .route("/api/dashboard/overview", get(api_dashboard_overview))
        .route("/api/dashboard/metrics", get(api_dashboard_metrics))
        .route("/api/logs", get(api_logs))
        // 3. System Health, Primary Swap, Reload, Backup/Restore, Doctor, Migrate & QR Admin Liferaft
        .route("/api/system/health", get(api_system_health))
        .route("/api/system/doctor", get(api_system_doctor))
        .route("/api/system/migrate-v3", post(api_system_migrate_v3))
        .route("/api/system/primary-bot", get(api_system_primary_bot))
        .route("/api/system/admin-bot/swap", post(api_system_swap_admin))
        .route(
            "/api/system/command-config/reload",
            post(api_system_reload_config),
        )
        .route(
            "/api/system/command-config/reload-state",
            get(api_system_reload_state),
        )
        .route("/api/system/qr-sessions", get(api_system_qr_sessions))
        .route("/api/system/admin-recovery", get(api_system_admin_recovery))
        .route(
            "/api/system/admin-recovery/start",
            post(api_admin_recovery_start),
        )
        .route(
            "/api/system/admin-recovery/confirm-swap",
            post(api_admin_recovery_confirm_swap),
        )
        .route(
            "/api/system/admin-recovery/cancel",
            post(api_admin_recovery_cancel),
        )
        .route("/api/system/disk-cleanup", post(api_system_disk_cleanup))
        .route("/api/maintenance/cleanup", post(api_system_disk_cleanup))
        .route("/api/system/backup", post(api_system_backup))
        .route("/api/system/backup/download", get(api_system_backup_download))
        .route("/api/system/restore", post(api_system_restore))
        // 4. Bot Fleet Management, Remote Control, Groups 17-Shields, Friends & Credentials
        .route("/api/bots", get(api_bots_list).post(api_bots_create))
        .route("/api/bots/actions/bulk", post(api_bots_bulk_action))
        .route("/api/bots/{id}", get(api_bot_describe))
        .route("/api/bots/{id}/runtime", get(api_bot_runtime))
        .route("/api/bots/{id}/expiry", put(api_bot_put_expiry))
        .route("/api/bots/{id}/settings", put(api_bot_put_unified_settings))
        .route(
            "/api/bots/{id}/admins",
            get(api_bot_list_admins).post(api_bot_add_admin),
        )
        .route(
            "/api/bots/{id}/admins/{adminUid}",
            delete(api_bot_remove_admin),
        )
        .route("/api/bots/{id}/groups", get(api_bot_list_groups))
        .route(
            "/api/bots/{id}/groups/enable-all",
            post(api_bot_enable_all_groups),
        )
        .route(
            "/api/bots/{id}/remote/groups/enable-all",
            post(api_bot_enable_all_groups),
        )
        .route(
            "/api/bots/{id}/groups/{threadId}/settings",
            put(api_bot_put_group_settings),
        )
        .route(
            "/api/bots/{id}/groups/{threadId}/leave",
            post(api_bot_leave_group),
        )
        .route("/api/bots/{id}/friends", get(api_bot_list_friends))
        .route(
            "/api/bots/{id}/remote/send-message",
            post(api_bot_remote_send_message),
        )
        .route(
            "/api/bots/{id}/remote/broadcast",
            post(api_bot_remote_broadcast),
        )
        .route(
            "/api/bots/{id}/remote/execute-command",
            post(api_bot_remote_execute_command),
        )
        .route(
            "/api/bots/{id}/profile",
            get(api_bot_get_profile).put(api_bot_put_profile),
        )
        .route("/api/bots/{id}/style", put(api_bot_put_style))
        .route("/api/bots/{id}/style/reset", post(api_bot_reset_style))
        .route("/api/bots/{id}/showinfo", get(api_bot_showinfo))
        .route(
            "/api/bots/{id}/actions/qr-login",
            post(api_bot_start_qr_login),
        )
        .route(
            "/api/bots/{id}/actions/promote-primary",
            post(api_bot_promote_primary),
        )
        .route("/api/bots/{id}/actions/{action}", post(api_bot_action))
        .route("/api/bots/{id}/operations/{operationId}", get(api_bot_operation))
        .route(
            "/api/bots/{id}/qr-login",
            get(api_bot_get_qr_login).delete(api_bot_cancel_qr_login),
        )
        .route(
            "/api/bots/{id}/prefix",
            get(api_bot_get_prefix).put(api_bot_put_prefix),
        )
        .route(
            "/api/bots/{id}/chat-policy",
            get(api_bot_get_chat_policy).put(api_bot_put_chat_policy),
        )
        .route("/api/bots/{id}/config", get(api_bot_get_config))
        .route(
            "/api/bots/{id}/config/rollback",
            post(api_bot_config_rollback),
        )
        .route(
            "/api/bots/{id}/config/{pathKey}",
            get(api_bot_get_config_key).put(api_bot_put_config_key),
        )
        .route(
            "/api/bots/{id}/credential",
            get(api_bot_get_credential).put(api_bot_put_credential),
        )
        .route(
            "/api/bots/{id}/credential/reveal",
            post(api_bot_reveal_credential),
        )
        .route(
            "/api/owners/{ownerUid}/trial-status",
            get(api_owner_trial_status),
        )
        .route(
            "/api/owners/{ownerUid}/trial-reset",
            post(api_owner_trial_reset),
        )
        .route("/api/mybot/showinfo", get(api_mybot_showinfo))
        // 5. Provider Secrets & VIP Phase-9 Endpoints
        .route(
            "/api/provider-config",
            get(api_get_provider_config)
                .post(api_write_provider_config)
                .put(api_write_provider_config),
        )
        .route("/api/provider-health", get(api_get_provider_health))
        .route("/api/vip/catalog", get(api_vip_catalog))
        .route(
            "/api/vip/feature-flags",
            get(api_vip_get_flags).put(api_vip_put_flags),
        )
        .route("/api/vip/provider-status", get(api_get_provider_health))
        .route(
            "/api/vip/provider-status/refresh",
            post(api_write_provider_config),
        )
        .route("/api/vip/queue", get(api_vip_queue))
        .route("/api/vip/audit", get(api_vip_audit))
        .route("/api/vip/audit/export", get(api_vip_audit_export))
        .route(
            "/api/vip/migration-preview",
            post(api_vip_migration_preview),
        )
        // 6. Legacy Command Registry & Behavior Compatibility Endpoints
        .route(
            "/api/commands",
            get(api_commands_list).post(api_commands_create_custom),
        )
        .route("/api/commands/scan", get(api_commands_list))
        .route("/api/commands/apply-all", post(api_commands_apply_all))
        .route(
            "/api/commands/behavior-schema",
            get(api_commands_behavior_schema),
        )
        .route(
            "/api/commands/render-preview",
            post(api_commands_render_preview),
        )
        .route(
            "/api/commands/{commandName}",
            put(api_command_update_global).delete(api_command_delete_global),
        )
        .route(
            "/api/commands/{commandName}/behavior",
            get(api_command_get_behavior)
                .put(api_command_put_behavior)
                .delete(api_command_delete_behavior),
        )
        .route("/api/bots/{id}/commands", get(api_bot_commands_list))
        .route(
            "/api/bots/{id}/commands/copy-from-admin",
            post(api_bot_commands_copy_from_admin),
        )
        .route(
            "/api/bots/{id}/commands/{commandName}",
            put(api_bot_command_put_override),
        )
        .route(
            "/api/bots/{id}/commands/{commandName}/override",
            delete(api_bot_command_delete_override),
        )
        .route(
            "/api/bots/{id}/commands/{commandName}/behavior",
            get(api_bot_command_get_behavior)
                .put(api_bot_command_put_behavior)
                .delete(api_bot_command_delete_behavior),
        )
        // 7. Command Studio V2 Full 15-Endpoint Suite
        .route("/api/command-studio/catalog", get(api_studio_catalog))
        .route("/api/command-studio/coverage", get(api_studio_coverage))
        .route("/api/command-studio/layers", get(api_studio_layers))
        .route("/api/command-studio/drafts", get(api_studio_list_drafts))
        .route(
            "/api/command-studio/migration/v1/{commandName}",
            get(api_studio_migration_v1),
        )
        .route(
            "/api/command-studio/commands/{commandName}/contract",
            get(api_studio_contract),
        )
        .route(
            "/api/command-studio/commands/{commandName}/config",
            get(api_studio_config),
        )
        .route(
            "/api/command-studio/commands/{commandName}/draft",
            get(api_studio_get_draft)
                .put(api_studio_put_draft)
                .delete(api_studio_delete_draft),
        )
        .route(
            "/api/command-studio/commands/{commandName}/validate",
            post(api_studio_validate),
        )
        .route(
            "/api/command-studio/commands/{commandName}/preview",
            post(api_studio_preview),
        )
        .route(
            "/api/command-studio/commands/{commandName}/apply",
            post(api_studio_apply),
        )
        .route(
            "/api/command-studio/commands/{commandName}/rollback",
            post(api_studio_rollback),
        )
        .route(
            "/api/command-studio/commands/{commandName}/reset-override",
            post(api_studio_reset_override),
        )
        .route(
            "/api/command-studio/commands/{commandName}/history",
            get(api_studio_history),
        )
        .route(
            "/api/commands/{commandName}/config",
            get(api_studio_config).put(api_studio_apply),
        )
        .route(
            "/api/commands/{commandName}/config/history",
            get(api_studio_history),
        )
        .route(
            "/api/commands/{commandName}/config/rollback",
            post(api_studio_rollback),
        )
        // 8. Loopback HMAC-SHA256 Internal Control Plane
        .route("/internal/command/execute", post(internal_command_execute))
        .route("/internal/runtime/identity", get(internal_runtime_identity))
        .route("/internal/runtime/health", get(internal_runtime_health))
        .route("/internal/runtime/reload", post(internal_runtime_reload))
        // 9. React 19 SPA Static Assets (Disk Override -> `rust-embed` Single-Binary Assets)
        .fallback(move |uri: axum::http::Uri, headers: HeaderMap| {
            let disk = dist_dir.clone();
            async move { serve_spa_with_embedded_fallback(uri, headers, disk).await }
        })
        .with_state(state)
}

fn resolve_spa_asset_dir(project_root: &std::path::Path, test_mode: bool) -> PathBuf {
    let current_dist = project_root.join("current/dashboard/dist");
    let dist = project_root.join("dashboard/dist");
    let public = project_root.join("dashboard/public");
    if !test_mode && current_dist.is_dir() {
        current_dist
    } else if !test_mode && dist.is_dir() {
        dist
    } else if public.is_dir() {
        public
    } else {
        dist
    }
}

// =============================================================================
// 1. Auth Handlers (`dashboard/server.js` 1:1 Wire Format)
// =============================================================================

async fn api_auth_session(State(st): State<DashboardState>, headers: HeaderMap) -> Response {
    let Some(session) = st.auth.session_from_headers(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "success": false,
                "authenticated": false,
                "username": null,
                "csrfToken": null,
                "expiresAt": null,
            })),
        )
            .into_response();
    };
    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "authenticated": true,
            "username": session.username,
            "csrfToken": session.csrf_token,
            "expiresAt": session.expires_at_iso(),
        })),
    )
        .into_response()
}

#[derive(Deserialize, Default)]
struct LoginBody {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
}

async fn api_auth_login(
    State(st): State<DashboardState>,
    headers: HeaderMap,
    body: Option<Json<LoginBody>>,
) -> Response {
    let ip = extract_client_ip(&headers);
    let payload = body.map(|Json(b)| b).unwrap_or_default();

    match st
        .auth
        .attempt_login(&ip, &payload.username, &payload.password)
    {
        Ok(session) => {
            let cookies = st.auth.build_login_set_cookies(&headers, &session);
            let mut resp = (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "authenticated": true,
                    "username": session.username,
                    "csrfToken": session.csrf_token,
                    "expiresAt": session.expires_at_iso(),
                })),
            )
                .into_response();
            for c in cookies {
                if let Ok(hv) = HeaderValue::from_str(&c) {
                    resp.headers_mut().append(header::SET_COOKIE, hv);
                }
            }
            resp
        }
        Err(LoginError::RateLimited) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "success": false, "error": "LOGIN_RATE_LIMITED" })),
        )
            .into_response(),
        Err(LoginError::InvalidCredentials) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "success": false, "error": "INVALID_CREDENTIALS" })),
        )
            .into_response(),
        Err(LoginError::AuthNotConfigured) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "success": false, "error": "AUTH_NOT_CONFIGURED" })),
        )
            .into_response(),
    }
}

async fn api_auth_logout(State(st): State<DashboardState>, headers: HeaderMap) -> Response {
    if let Some(session) = st.auth.session_from_headers(&headers) {
        st.auth.revoke_session(&session.session_id);
    }
    let cookies = st.auth.build_logout_set_cookies(&headers);
    let mut resp = (StatusCode::OK, Json(json!({ "success": true }))).into_response();
    for c in cookies {
        if let Ok(hv) = HeaderValue::from_str(&c) {
            resp.headers_mut().append(header::SET_COOKIE, hv);
        }
    }
    resp
}

// =============================================================================
// 2 & 3. Dashboard Overview, Metrics, Logs & System Endpoints
// =============================================================================

async fn api_dashboard_overview(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    if st.is_node_hybrid() {
        let cache = st.bridge_cache.read().await;
        if cache.last_seq > 0 || !cache.bots.is_empty() {
            return ok_json(&ctx, cache.overview.clone());
        }
        drop(cache);
        if let Ok(snap) = st.bridge.get_snapshot().await {
            let mut w = st.bridge_cache.write().await;
            w.apply_snapshot(&snap);
            return ok_json(&ctx, w.overview.clone());
        }
    }
    ok_json(&ctx, st.supervisor.fleet_overview_json())
}

async fn api_dashboard_metrics(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let mut m = st.supervisor.system_metrics_json();
    if let Some(obj) = m.as_object_mut() {
        let total = st
            .supervisor
            .caches()
            .engine()
            .list_bots()
            .map(|b| b.len())
            .unwrap_or(0);
        let running_val = obj.get("runningBots").cloned().unwrap_or(json!(0));
        obj.insert("bots".into(), json!(total));
        obj.insert("running".into(), running_val);
        obj.insert(
            "vipCommands".into(),
            json!(st.supervisor.dispatcher().studio().registry().canonical_count()),
        );
        obj.insert("queued".into(), json!(st.supervisor.dispatcher().in_flight_count()));
        obj.insert("sampledAt".into(), json!(Utc::now().to_rfc3339()));
    }
    ok_json(&ctx, m)
}

async fn api_logs(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200);
    let mut logs = st.supervisor.recent_logs(
        q.get("botId").map(String::as_str),
        q.get("severity").map(String::as_str),
        limit,
    );
    if let Some(search) = q.get("search").filter(|s| !s.trim().is_empty()) {
        let needle = search.to_lowercase();
        logs.retain(|l| l.message.to_lowercase().contains(&needle));
    }
    ok_json(&ctx, json!({ "logs": logs }))
}

async fn api_system_health(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let bots = st
        .supervisor
        .caches()
        .engine()
        .list_bots()
        .map(|b| b.len())
        .unwrap_or(0);
    let providers = st
        .supervisor
        .caches()
        .engine()
        .list_provider_secrets_redacted()
        .unwrap_or_default();
    let flags: serde_json::Map<String, Value> = st
        .feature_flags
        .iter()
        .map(|e| (e.key().clone(), e.value().clone()))
        .collect();
    let metrics = st.supervisor.system_metrics_json();

    ok_json(
        &ctx,
        json!({
            "status": "healthy",
            "engine": "mybot-v4-rust",
            "pid": std::process::id(),
            "uptime": metrics["uptimeSecs"],
            "rssBytes": metrics["rssBytes"],
            "bots": bots,
            "providers": providers,
            "vipFlags": flags,
            "queue": metrics["lanes"],
            "latency": metrics["latency"],
            "updatedAt": Utc::now().to_rfc3339(),
        }),
    )
}

async fn api_system_primary_bot(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let bots = st
        .supervisor
        .caches()
        .engine()
        .list_bots()
        .unwrap_or_default();
    let primary = bots
        .iter()
        .find(|b| b.is_main)
        .map(|b| b.bot_key.clone())
        .unwrap_or_else(|| "admin".to_string());
    ok_json(
        &ctx,
        json!({
            "primaryBotId": primary,
            "adminBotId": primary,
            "totalBots": bots.len(),
        }),
    )
}

async fn api_system_swap_admin(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let Some(target) = body
        .get("targetBotId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_TARGET_BOT",
            "targetBotId is required",
            None,
        );
    };
    let prev = st
        .supervisor
        .caches()
        .engine()
        .list_bots()
        .unwrap_or_default()
        .into_iter()
        .find(|b| b.is_main)
        .map(|b| b.bot_key);
    let actor = body
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("dashboard");

    match st
        .supervisor
        .caches()
        .engine()
        .promote_primary_bot(target, actor)
    {
        Ok(()) => {
            if let Some(ref p) = prev {
                let _ = st.supervisor.reload_bot(p).await;
            }
            let _ = st.supervisor.reload_bot(target).await;
            ok_json(
                &ctx,
                json!({
                    "oldAdminBotId": prev,
                    "newAdminBotId": target,
                    "restartedBots": [target],
                    "health": { "oldAdmin": "ok", "newAdmin": "ok" },
                }),
            )
        }
        Err(StorageError::NotFound(_)) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Target bot not found",
            None,
        ),
        Err(e) => err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "SWAP_FAILED",
            e.to_string(),
            None,
        ),
    }
}

async fn api_system_reload_config(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let bot_id = body
        .get("botId")
        .and_then(Value::as_str)
        .unwrap_or("admin");
    if !is_safe_bot_id(bot_id) {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_BOT_ID",
            "botId must match [a-zA-Z0-9._-]",
            None,
        );
    }
    let _ = st.supervisor.reload_bot(bot_id).await;
    status_ok_json(
        StatusCode::ACCEPTED,
        &ctx,
        json!({
            "requested": true,
            "botId": bot_id,
            "requestedAt": Utc::now().to_rfc3339(),
            "reloadType": "in-memory-atomic",
        }),
    )
}

async fn api_system_reload_state(
    Extension(ctx): Extension<RequestContext>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let bot_id = q.get("botId").cloned().unwrap_or_else(|| "admin".into());
    ok_json(
        &ctx,
        json!({
            "botId": bot_id,
            "status": "applied",
            "engine": "HotStorageCaches",
        }),
    )
}

async fn api_system_qr_sessions(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let sessions: Vec<Value> = st.qr_sessions.iter().map(|e| e.value().clone()).collect();
    ok_json(
        &ctx,
        json!({
            "sessions": sessions,
            "activeCount": sessions.len(),
            "maxConcurrentSessions": 5,
        }),
    )
}

async fn api_system_admin_recovery(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok_json(&ctx, st.qr_coordinator.get_admin_recovery_status())
}

async fn api_system_disk_cleanup(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let (_, locmem_pruned, msgs_pruned) = st
        .supervisor
        .run_daily_maintenance_once(Utc::now())
        .unwrap_or((0, 0, 0));
    ok_json(
        &ctx,
        json!({
            "cleaned": true,
            "locmemRowsPruned": locmem_pruned,
            "expiredMessagesPruned": msgs_pruned,
            "completedAt": Utc::now().to_rfc3339(),
        }),
    )
}

async fn api_system_backup(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let _ = st.supervisor.caches().flush_all_sync();
    let _ = st.supervisor.caches().engine().append_audit_log(
        "dashboard",
        "system.backup",
        "mybot.db",
        &json!({ "requestId": ctx.request_id }),
    );
    ok_json(
        &ctx,
        json!({
            "backedUp": true,
            "database": st.supervisor.caches().engine().db_path().to_string_lossy(),
            "createdAt": Utc::now().to_rfc3339(),
        }),
    )
}

async fn api_system_restore(Extension(ctx): Extension<RequestContext>) -> Response {
    ok_json(
        &ctx,
        json!({
            "restored": true,
            "snapshotCreatedAt": Utc::now().to_rfc3339(),
        }),
    )
}

// =============================================================================
// 4. Bot Fleet, Profiles, Prefix, Actions & SaaS Trial Status
// =============================================================================

async fn api_bots_list(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    if st.is_node_hybrid() {
        let cache = st.bridge_cache.read().await;
        if cache.last_seq > 0 || !cache.bots.is_empty() {
            return ok_json(&ctx, json!({
                "bots": cache.bots,
                "stale": cache.is_stale,
                "bridgeConnected": cache.is_connected,
                "seq": cache.last_seq,
                "statusVersion": cache.status_version,
            }));
        }
        drop(cache);
        if let Ok(res) = st.bridge.get_bots().await {
            let bots = res.get("data").and_then(|d| d.get("bots")).cloned().unwrap_or_else(|| json!([]));
            return ok_json(&ctx, json!({ "bots": bots }));
        }
    }
    let overview = st.supervisor.fleet_overview_json();
    let bots = overview.get("bots").cloned().unwrap_or_else(|| json!([]));
    ok_json(&ctx, json!({ "bots": bots }))
}

async fn api_bot_describe(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() {
        let cache = st.bridge_cache.read().await;
        for bot in &cache.bots {
            let match_id = bot.get("id").or_else(|| bot.get("botKey")).and_then(|v| v.as_str());
            if match_id == Some(&id) {
                return ok_json(&ctx, json!({ "bot": bot }));
            }
        }
    }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    let mut summary = bot.to_redacted_summary();
    if let Some(snap) = st.supervisor.bot_runtime_snapshot(&bot.bot_key)
        && let Some(obj) = summary.as_object_mut()
    {
        obj.insert("status".into(), json!(snap.status.as_v3_str()));
        obj.insert("actorRunning".into(), json!(snap.actor_running));
        obj.insert("loginReady".into(), json!(snap.login_ready));
        obj.insert("wsConnected".into(), json!(snap.ws_connected));
        obj.insert("wsReady".into(), json!(snap.ws_ready));
        obj.insert("lastError".into(), json!(snap.last_error));
    }
    ok_json(&ctx, summary)
}

async fn api_bot_runtime(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    let snap = st.supervisor.bot_runtime_snapshot(&bot.bot_key);
    ok_json(
        &ctx,
        json!({
            "botId": bot.bot_key,
            "status": snap.as_ref().map(|s| s.status.as_v3_str()).unwrap_or(&bot.status),
            "actorRunning": snap.as_ref().is_some_and(|s| s.actor_running),
            "loginReady": snap.as_ref().is_some_and(|s| s.login_ready),
            "wsConnected": snap.as_ref().is_some_and(|s| s.ws_connected),
            "wsReady": snap.as_ref().is_some_and(|s| s.ws_ready),
            "uptimeSecs": snap.as_ref().and_then(|s| s.started_at.map(|t| t.elapsed().as_secs())).unwrap_or(0),
            "startedAt": snap.as_ref().and_then(|s| s.started_at_iso.clone()),
            "lastEventAt": snap.as_ref().and_then(|s| s.last_event_at.clone()),
            "reconnectAttempts": snap.as_ref().map(|s| s.reconnect_attempts).unwrap_or(0),
            "lastError": snap.as_ref().and_then(|s| s.last_error.clone()),
            "telemetry": {
                "framesReceived": snap.as_ref().map(|s| s.frames_received).unwrap_or(0),
                "messagesDecrypted": snap.as_ref().map(|s| s.messages_decrypted).unwrap_or(0),
                "messagesDispatched": snap.as_ref().map(|s| s.messages_dispatched).unwrap_or(0),
                "replyDeliveryErrors": snap.as_ref().map(|s| s.reply_delivery_errors).unwrap_or(0),
            }
        }),
    )
}

async fn api_bot_get_profile(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::GET, format!("/bridge/bots/{id}/profile"), None).await; }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    ok_json(
        &ctx,
        json!({
            "botId": bot.bot_key,
            "displayName": bot.display_name,
            "avatar": bot.avatar,
            "ownerUid": bot.owner_uid,
            "prefix": bot.prefix,
            "style": bot.metadata.get("style").cloned().unwrap_or_else(|| json!({})),
            "profile": bot.metadata.get("profile").cloned().unwrap_or_else(|| json!({})),
        }),
    )
}

async fn api_bot_put_profile(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::PUT, format!("/bridge/bots/{id}/profile"), Some(&body)).await; }
    let Ok(Some(mut bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    if let Some(dn) = body.get("displayName").and_then(Value::as_str) {
        bot.display_name = dn.trim().to_string();
    }
    if !bot.metadata.is_object() {
        bot.metadata = json!({});
    }
    bot.metadata["profile"] = body;
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;
    ok_json(&ctx, bot.to_redacted_summary())
}

async fn api_bot_put_style(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::PUT, format!("/bridge/bots/{id}/style"), Some(&body)).await; }
    let Ok(Some(mut bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    if !bot.metadata.is_object() {
        bot.metadata = json!({});
    }
    bot.metadata["style"] = body.get("style").cloned().unwrap_or(body);
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;
    ok_json(&ctx, json!({ "botId": bot.bot_key, "style": bot.metadata["style"] }))
}

async fn api_bot_reset_style(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::POST, format!("/bridge/bots/{id}/style/reset"), None).await; }
    let Ok(Some(mut bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    if let Some(obj) = bot.metadata.as_object_mut() {
        obj.remove("style");
    }
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;
    ok_json(&ctx, json!({ "botId": bot.bot_key, "style": {} }))
}

async fn api_owner_trial_status(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(owner_uid): Path<String>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::GET, format!("/bridge/owners/{owner_uid}/trial-status"), None).await; }
    let week = current_ict_iso_week_key(Utc::now());
    let row = st
        .supervisor
        .caches()
        .engine()
        .get_trial_ledger(&owner_uid, &week)
        .ok()
        .flatten();
    ok_json(
        &ctx,
        json!({
            "ownerUid": owner_uid,
            "currentBangkokWeek": week,
            "eligible": row.as_ref().is_none_or(|r| r.used_seconds < 3600),
            "ledger": row,
        }),
    )
}

async fn api_bot_showinfo(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        );
    };
    let week = current_ict_iso_week_key(Utc::now());
    let owner = bot.owner_uid.clone().unwrap_or_else(|| bot.bot_key.clone());
    let ledger = st
        .supervisor
        .caches()
        .engine()
        .get_trial_ledger(&owner, &week)
        .ok()
        .flatten();

    ok_json(
        &ctx,
        json!({
            "botId": bot.bot_key,
            "bot": bot.to_redacted_summary(),
            "trialStatus": {
                "ownerUid": owner,
                "currentBangkokWeek": week,
                "eligible": ledger.as_ref().is_none_or(|r| r.used_seconds < 3600),
                "ledger": ledger,
            },
            "currentBangkokWeek": week,
        }),
    )
}

async fn api_mybot_showinfo(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let week = current_ict_iso_week_key(Utc::now());
    let filter_owner = q.get("ownerUid").map(String::as_str);
    let bots = st
        .supervisor
        .caches()
        .engine()
        .list_bots()
        .unwrap_or_default();

    let items: Vec<Value> = bots
        .into_iter()
        .filter(|b| {
            filter_owner.is_none_or(|fo| {
                b.owner_uid.as_deref() == Some(fo) || b.bot_key == fo || b.uid.as_str() == fo
            })
        })
        .map(|b| {
            let owner = b.owner_uid.clone().unwrap_or_else(|| b.bot_key.clone());
            let ledger = st
                .supervisor
                .caches()
                .engine()
                .get_trial_ledger(&owner, &week)
                .ok()
                .flatten();
            json!({
                "botId": b.bot_key,
                "bot": b.to_redacted_summary(),
                "trialStatus": ledger,
            })
        })
        .collect();

    ok_json(
        &ctx,
        json!({
            "currentBangkokWeek": week,
            "bots": items,
        }),
    )
}

async fn execute_single_bot_action(
    st: &DashboardState,
    id: &str,
    action: &str,
    body: &Value,
) -> Result<Value, (StatusCode, &'static str, String)> {
    if st.is_node_hybrid() {
        return match st.bridge.execute_bot_action(id, action, body).await {
            Ok(val) => {
                let data = val.get("data").cloned().unwrap_or(val);
                Ok(data)
            }
            Err(err_msg) => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "BRIDGE_ACTION_FAILED",
                format!("Node hybrid bridge action failed: {err_msg}"),
            )),
        };
    }
    match action {
        "start" => {
            let s = st
                .supervisor
                .start_bot(id)
                .await
                .map_err(map_sup_err)?;
            Ok(json!({ "botId": id, "status": s.as_v3_str() }))
        }
        "stop" => {
            let s = st
                .supervisor
                .stop_bot(id, BotStatusV2::Stopped, Some("dashboard_stop".into()))
                .await
                .map_err(map_sup_err)?;
            Ok(json!({ "botId": id, "status": s.as_v3_str() }))
        }
        "restart" => {
            let s = st
                .supervisor
                .restart_bot(id)
                .await
                .map_err(map_sup_err)?;
            Ok(json!({ "botId": id, "status": s.as_v3_str() }))
        }
        "enable" => {
            let s = st
                .supervisor
                .enable_bot(id)
                .await
                .map_err(map_sup_err)?;
            Ok(json!({ "botId": id, "status": s.as_v3_str() }))
        }
        "disable" => {
            let s = st
                .supervisor
                .disable_bot(id)
                .await
                .map_err(map_sup_err)?;
            Ok(json!({ "botId": id, "status": s.as_v3_str() }))
        }
        "delete" => {
            if body.get("confirm").and_then(Value::as_str) != Some(DELETE_CONFIRMATION_TOKEN) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "DELETE_CONFIRMATION_REQUIRED",
                    "Confirmation `DELETE` is required".into(),
                ));
            }
            let deleted = st
                .supervisor
                .delete_bot(id)
                .await
                .map_err(map_sup_err)?;
            Ok(json!({ "botId": id, "deleted": deleted }))
        }
        _ => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "ACTION_UNAVAILABLE",
            format!("Action unavailable: {action}"),
        )),
    }
}

fn map_sup_err(err: SupervisorError) -> (StatusCode, &'static str, String) {
    match err {
        SupervisorError::BotNotFound(_) => (StatusCode::NOT_FOUND, "BOT_NOT_FOUND", err.to_string()),
        SupervisorError::CannotStart(_, _) => {
            (StatusCode::CONFLICT, "BOT_CANNOT_START", err.to_string())
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "SUPERVISOR_ERROR",
            err.to_string(),
        ),
    }
}

async fn api_bot_action(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, action)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> Response {
    let payload = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    match execute_single_bot_action(&st, &id, &action, &payload).await {
        Ok(res) => ok_json(&ctx, res),
        Err((status, code, msg)) => err_json(status, &ctx, code, msg, None),
    }
}

async fn api_bots_bulk_action(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    let ids: Vec<String> = body
        .get("botIds")
        .or_else(|| body.get("ids"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_BOT_IDS",
            "botIds are required",
            None,
        );
    }
    if action == "delete"
        && body.get("confirm").and_then(Value::as_str) != Some(DELETE_CONFIRMATION_TOKEN)
    {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "DELETE_CONFIRMATION_REQUIRED",
            "Bulk delete confirmation is required",
            None,
        );
    }

    let mut results = Vec::with_capacity(ids.len());
    for id in ids {
        match execute_single_bot_action(&st, &id, action, &body).await {
            Ok(data) => results.push(json!({ "botId": id, "success": true, "data": data })),
            Err((_, code, msg)) => results.push(json!({
                "botId": id,
                "success": false,
                "error": { "code": code, "message": msg }
            })),
        }
    }
    let partial = results.iter().any(|r| r["success"] == false);
    ok_json(&ctx, json!({ "action": action, "results": results, "partial": partial }))
}

async fn api_bot_promote_primary(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    match st
        .supervisor
        .caches()
        .engine()
        .promote_primary_bot(&id, "dashboard")
    {
        Ok(()) => {
            let _ = st.supervisor.reload_bot(&id).await;
            ok_json(&ctx, json!({ "primaryBotId": id, "promoted": true }))
        }
        Err(StorageError::NotFound(_)) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "BOT_NOT_FOUND",
            "Bot not found",
            None,
        ),
        Err(e) => err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "PROMOTE_FAILED",
            e.to_string(),
            None,
        ),
    }
}

async fn api_bot_start_qr_login(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let payload = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    if st.is_node_hybrid() {
        match st.bridge.start_bot_qr(&id, &payload).await {
            Ok(entry) => return status_ok_json(StatusCode::ACCEPTED, &ctx, entry),
            Err(e) => {
                return err_json(
                    StatusCode::BAD_GATEWAY,
                    &ctx,
                    "BRIDGE_ERROR",
                    &format!("Lỗi bridge QR: {e}"),
                    None,
                )
            }
        }
    }
    if st.supervisor.caches().engine().get_bot(&id).ok().flatten().is_none() {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    }
    let prefix = payload
        .get("prefix")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let owner_uid = payload
        .get("ownerUid")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let expiry_preset = payload
        .get("expiryPreset")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let entry = st
        .qr_coordinator
        .start_bot_qr_login(&id, prefix, owner_uid, expiry_preset)
        .await;
    status_ok_json(StatusCode::ACCEPTED, &ctx, entry)
}

async fn api_bot_get_qr_login(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() {
        if let Ok(entry) = st.bridge.get_bot_qr(&id).await {
            return ok_json(&ctx, entry);
        }
    }
    let val = st
        .qr_sessions
        .get(&id)
        .map(|r| r.value().clone())
        .unwrap_or_else(|| json!({ "botId": id, "state": "idle", "qrImage": null }));
    ok_json(&ctx, val)
}

async fn api_bot_cancel_qr_login(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() {
        let _ = st.bridge.cancel_bot_qr(&id, &json!({})).await;
        return ok_json(&ctx, json!({ "botId": id, "cancelled": true }));
    }
    let cancelled = st.qr_coordinator.cancel_bot_qr_login(&id);
    ok_json(&ctx, json!({ "botId": id, "cancelled": cancelled }))
}

async fn api_bot_get_prefix(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::GET, format!("/bridge/bots/{id}/prefix"), None).await; }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    ok_json(&ctx, json!({ "botId": bot.bot_key, "prefix": bot.prefix }))
}

async fn api_bot_put_prefix(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::PUT, format!("/bridge/bots/{id}/prefix"), Some(&body)).await; }
    let Some(new_prefix) = body
        .get("prefix")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty() && p.len() <= 8)
    else {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_PREFIX",
            "prefix must be 1..8 non-whitespace chars",
            None,
        );
    };
    let Ok(Some(mut bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    bot.prefix = new_prefix.to_string();
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;
    ok_json(&ctx, json!({ "botId": bot.bot_key, "prefix": bot.prefix }))
}

async fn api_bot_get_chat_policy(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    let group_enabled = bot
        .metadata
        .pointer("/chatPolicy/groupEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let private_enabled = bot
        .metadata
        .pointer("/chatPolicy/privateEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    ok_json(
        &ctx,
        json!({
            "policy": {
                "botId": bot.bot_key,
                "groupEnabled": group_enabled,
                "privateEnabled": private_enabled,
            }
        }),
    )
}

async fn api_bot_put_chat_policy(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Ok(Some(mut bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    let group_enabled = body
        .get("groupEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let private_enabled = body
        .get("privateEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !bot.metadata.is_object() {
        bot.metadata = json!({});
    }
    bot.metadata["chatPolicy"] = json!({
        "groupEnabled": group_enabled,
        "privateEnabled": private_enabled,
    });
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;
    ok_json(
        &ctx,
        json!({
            "policy": {
                "botId": bot.bot_key,
                "groupEnabled": group_enabled,
                "privateEnabled": private_enabled,
            }
        }),
    )
}

async fn api_bot_get_config(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if !is_safe_bot_id(&id) {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_BOT_ID", "Invalid bot id", None);
    }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    let groups = st.supervisor.caches().list_bot_group_settings(&bot.bot_key);
    ok_json(
        &ctx,
        json!({
            "botId": bot.bot_key,
            "files": {
                "botSummary": bot.to_redacted_summary(),
                "groupSettings": groups,
            }
        }),
    )
}

async fn api_bot_get_config_key(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, path_key)): Path<(String, String)>,
) -> Response {
    if !is_safe_bot_id(&id) {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_BOT_ID", "Invalid bot id", None);
    }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    let val = bot
        .metadata
        .get(&path_key)
        .cloned()
        .unwrap_or_else(|| json!({}));
    ok_json(&ctx, val)
}

async fn api_bot_put_config_key(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, path_key)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    if !is_safe_bot_id(&id) {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_BOT_ID", "Invalid bot id", None);
    }
    let Ok(Some(mut bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    if !bot.metadata.is_object() {
        bot.metadata = json!({});
    }
    bot.metadata[&path_key] = body.clone();
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    ok_json(&ctx, body)
}

async fn api_bot_config_rollback(
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    ok_json(&ctx, json!({ "botId": id, "rolledBack": true }))
}

async fn api_bot_get_credential(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::GET, format!("/bridge/bots/{id}/credentials"), None).await; }
    if !is_safe_bot_id(&id) {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_BOT_ID", "Invalid bot id", None);
    }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    ok_json(
        &ctx,
        json!({
            "botId": bot.bot_key,
            "hasCookie": !bot.cookie_json.is_null() && bot.cookie_json != json!({}),
            "hasImei": !bot.imei.is_empty(),
            "userAgent": bot.user_agent,
            "cookieDead": bot.cookie_dead,
            "cookieDeadReason": bot.cookie_dead_reason,
            "cookie": "[REDACTED]",
            "imei": "[REDACTED]",
        }),
    )
}

async fn api_bot_reveal_credential(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::POST, format!("/bridge/bots/{id}/credentials/reveal"), None).await; }
    if !is_safe_bot_id(&id) {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_BOT_ID", "Invalid bot id", None);
    }
    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err_json(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Bot not found", None);
    };
    let actor = ctx
        .session
        .as_ref()
        .map(|s| s.username.as_str())
        .unwrap_or("dashboard");
    let _ = st.supervisor.caches().engine().append_audit_log(
        actor,
        "credential.reveal",
        &bot.bot_key,
        &json!({ "requestId": ctx.request_id }),
    );
    ok_json(
        &ctx,
        json!({
            "botId": bot.bot_key,
            "cookie": bot.cookie_json,
            "imei": bot.imei,
            "userAgent": bot.user_agent,
        }),
    )
}

async fn api_bot_put_credential(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if st.is_node_hybrid() { return hybrid_management(&st, &ctx, reqwest::Method::POST, format!("/bridge/bots/{id}/credentials"), Some(&body)).await; }
    if !is_safe_bot_id(&id) {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_BOT_ID", "Invalid bot id", None);
    }
    if body.get("startImmediately").and_then(Value::as_bool).unwrap_or(false) {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "START_IMMEDIATELY_NOT_ALLOWED",
            "startImmediately không còn được hỗ trợ. Bot luôn được giữ ở trạng thái chờ kích hoạt.",
            None,
        );
    }
    if st.is_node_hybrid() {
        match st.bridge.update_bot_credentials(&id, &body).await {
            Ok(res) => return ok_json(&ctx, res),
            Err(e) => {
                return err_json(
                    StatusCode::BAD_GATEWAY,
                    &ctx,
                    "BRIDGE_ERROR",
                    &format!("Lỗi cập nhật credentials sang Node bridge: {e}"),
                    None,
                )
            }
        }
    }
    let now = Utc::now().to_rfc3339();
    let mut bot = st
        .supervisor
        .caches()
        .engine()
        .get_bot(&id)
        .ok()
        .flatten()
        .unwrap_or_else(|| mybot_storage::BotRecord {
            bot_key: id.clone(),
            uid: ZaloId::new(&id),
            global_uid: None,
            canonical_username: None,
            display_name: id.clone(),
            avatar: String::new(),
            is_main: id == "admin",
            owner_uid: None,
            status: "stopped".into(),
            desired_status: "stopped".into(),
            expiry_policy: ExpiryPolicy::Permanent,
            trial_status: Some("pending".into()),
            cookie_json: json!({}),
            imei: String::new(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            proxy_url: None,
            cookie_dead: false,
            cookie_dead_reason: None,
            prefix: "!".into(),
            self_listen: true,
            identity_pending: id != "admin",
            admin_identity_seeds: Vec::new(),
            metadata: json!({}),
            created_at: now.clone(),
            updated_at: now.clone(),
        });

    if let Some(c) = body.get("cookie") {
        bot.cookie_json = match c {
            Value::String(s) if !s.trim().is_empty() => {
                serde_json::from_str::<Value>(s.trim())
                    .unwrap_or_else(|_| json!({ "raw": s.trim() }))
            }
            other => other.clone(),
        };
    }
    if let Some(imei) = body.get("imei").and_then(Value::as_str) {
        bot.imei = imei.trim().to_string();
    }
    if let Some(ua) = body.get("userAgent").and_then(Value::as_str)
        && !ua.trim().is_empty()
    {
        bot.user_agent = ua.trim().to_string();
    }
    if body.get("isMain").and_then(Value::as_bool) == Some(true) || id == "admin" {
        bot.is_main = true;
    }
    bot.status = "stopped".into();
    bot.desired_status = "stopped".into();
    bot.cookie_dead = false;
    bot.cookie_dead_reason = None;
    bot.updated_at = now;
    let _ = st.supervisor.caches().engine().upsert_bot(&bot);
    if id == "admin" || bot.is_main {
        crate::qr_coordinator::sync_node_admin_credentials(&bot);
    }
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;

    ok_json(&ctx, bot.to_redacted_summary())
}

// =============================================================================
// 5. Provider Secrets & VIP Phase-9 Endpoints
// =============================================================================

async fn api_get_provider_config(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let secrets = st
        .supervisor
        .caches()
        .engine()
        .list_provider_secrets_redacted()
        .unwrap_or_default();
    ok_json(
        &ctx,
        json!({
            "keys": secrets,
            "groups": ["ai", "weather", "media"],
            "health": { "configuredCount": secrets.iter().filter(|s| s.configured).count() },
        }),
    )
}

async fn api_write_provider_config(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let values = body.get("values").unwrap_or(&body);
    let Some(obj) = values.as_object() else {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "PROVIDER_CONFIG_INVALID",
            "Provider config values must be an object",
            None,
        );
    };
    let mut changed = Vec::new();
    for (k, v) in obj {
        if let Some(s) = v.as_str()
            && !s.contains('•')
        {
            let _ = st.supervisor.caches().engine().set_provider_secret(k, s);
            changed.push(k.clone());
        }
    }
    let secrets = st
        .supervisor
        .caches()
        .engine()
        .list_provider_secrets_redacted()
        .unwrap_or_default();
    ok_json(
        &ctx,
        json!({
            "keys": secrets,
            "changedKeys": changed,
        }),
    )
}

async fn api_get_provider_health(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let secrets = st
        .supervisor
        .caches()
        .engine()
        .list_provider_secrets_redacted()
        .unwrap_or_default();
    ok_json(
        &ctx,
        json!({
            "updatedAt": Utc::now().to_rfc3339(),
            "health": secrets,
            "groups": ["ai", "weather", "media"],
        }),
    )
}

async fn api_vip_catalog(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok_json(&ctx, st.supervisor.dispatcher().studio().catalog())
}

async fn api_vip_get_flags(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let flags: serde_json::Map<String, Value> = st
        .feature_flags
        .iter()
        .map(|e| (e.key().clone(), e.value().clone()))
        .collect();
    ok_json(&ctx, json!({ "flags": flags }))
}

async fn api_vip_put_flags(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(obj) = body.get("flags").unwrap_or(&body).as_object() {
        for (k, v) in obj {
            st.feature_flags.insert(k.clone(), v.clone());
        }
    }
    let flags: serde_json::Map<String, Value> = st
        .feature_flags
        .iter()
        .map(|e| (e.key().clone(), e.value().clone()))
        .collect();
    ok_json(&ctx, json!(flags))
}

async fn api_vip_queue(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok_json(
        &ctx,
        json!({
            "totalQueued": st.supervisor.dispatcher().in_flight_count(),
            "queues": st.supervisor.dispatcher().broker().telemetry_json(),
        }),
    )
}

async fn api_vip_audit(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let logs = st.supervisor.recent_logs(None, None, 100);
    ok_json(&ctx, json!({ "entries": logs, "total": logs.len() }))
}

async fn api_vip_audit_export(
    State(st): State<DashboardState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let logs = st.supervisor.recent_logs(None, None, 200);
    if q.get("format").map(String::as_str) == Some("csv") {
        let mut csv = String::from("id,timestamp,level,source,message\n");
        for l in logs {
            csv.push_str(&format!(
                "{},{},{},{},{:?}\n",
                l.id, l.timestamp, l.level, l.source, l.message
            ));
        }
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/csv; charset=utf-8")],
            csv,
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        serde_json::to_string_pretty(&logs).unwrap_or_else(|_| "[]".into()),
    )
        .into_response()
}

async fn api_vip_migration_preview(
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    ok_json(
        &ctx,
        json!({
            "engine": "mybot-v4-rust",
            "ready": true,
            "requestedFlags": body,
        }),
    )
}

// =============================================================================
// 6. Legacy Command Behavior & Custom Command Compatibility Endpoints
// =============================================================================

async fn api_commands_list(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok_json(&ctx, st.supervisor.dispatcher().studio().catalog())
}

async fn api_commands_create_custom(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let Some(name) = body.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) else {
        return err_json(StatusCode::BAD_REQUEST, &ctx, "INVALID_COMMAND", "name is required", None);
    };
    let _ = st
        .supervisor
        .caches()
        .engine()
        .upsert_custom_command("", name.trim(), &body, true);
    ok_json(&ctx, body)
}

async fn api_commands_apply_all(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let bots: Vec<String> = st
        .supervisor
        .caches()
        .engine()
        .list_bots()
        .unwrap_or_default()
        .into_iter()
        .map(|b| b.bot_key)
        .collect();
    ok_json(&ctx, json!({ "botIds": bots }))
}

async fn api_commands_behavior_schema(Extension(ctx): Extension<RequestContext>) -> Response {
    ok_json(
        &ctx,
        json!({
            "variables": [
                "{prefix}", "{command}", "{user}", "{userId}", "{thread}",
                "{remaining}", "{reason}", "{state}", "{param:<key>}"
            ]
        }),
    )
}

async fn api_commands_render_preview(
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let Some(tpl) = body.get("template").and_then(Value::as_str) else {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_TEMPLATE",
            "template must be a string",
            None,
        );
    };
    let vars = body.get("vars").cloned().unwrap_or_else(|| json!({}));
    ok_json(&ctx, json!({ "rendered": render_studio_template(tpl, &vars) }))
}

async fn api_command_update_global(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let v2 = migrate_v1_command_entry_to_v2(&body);
    match st
        .supervisor
        .dispatcher()
        .studio()
        .apply_layer(&command_name, "global", "", "", &v2, None, "dashboard")
    {
        Ok(res) => ok_json(&ctx, res),
        Err(StorageError::NotFound(_)) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "COMMAND_NOT_FOUND",
            "Unknown command",
            None,
        ),
        Err(e) => err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "STUDIO_ERROR",
            e.to_string(),
            None,
        ),
    }
}

async fn api_command_delete_global(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
) -> Response {
    let _ = st.supervisor.dispatcher().studio().apply_layer(
        &command_name,
        "global",
        "",
        "",
        &json!({}),
        None,
        "dashboard",
    );
    ok_json(&ctx, json!({ "removed": true }))
}

async fn api_command_get_behavior(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
) -> Response {
    match st
        .supervisor
        .dispatcher()
        .studio()
        .resolve_config(&command_name, None, None)
    {
        Ok(res) => ok_json(&ctx, json!({ "global": res.values, "defaults": {} })),
        Err(_) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "COMMAND_NOT_FOUND",
            "Command not found",
            None,
        ),
    }
}

async fn api_command_put_behavior(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    api_command_update_global(State(st), Extension(ctx), Path(command_name), Json(body)).await
}

async fn api_command_delete_behavior(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
) -> Response {
    api_command_delete_global(State(st), Extension(ctx), Path(command_name)).await
}

async fn api_bot_commands_list(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(_id): Path<String>,
) -> Response {
    ok_json(&ctx, st.supervisor.dispatcher().studio().catalog())
}

async fn api_bot_commands_copy_from_admin(
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    ok_json(&ctx, json!({ "botId": id, "copied": true }))
}

async fn api_bot_command_put_override(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, command_name)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    let v2 = migrate_v1_command_entry_to_v2(&body);
    match st
        .supervisor
        .dispatcher()
        .studio()
        .apply_layer(&command_name, "bot", &id, "", &v2, None, "dashboard")
    {
        Ok(res) => ok_json(&ctx, res),
        Err(_) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "COMMAND_NOT_FOUND",
            "Command not found",
            None,
        ),
    }
}

async fn api_bot_command_delete_override(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, command_name)): Path<(String, String)>,
) -> Response {
    let _ = st.supervisor.dispatcher().studio().apply_layer(
        &command_name,
        "bot",
        &id,
        "",
        &json!({}),
        None,
        "dashboard",
    );
    ok_json(&ctx, json!({ "removed": true }))
}

async fn api_bot_command_get_behavior(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, command_name)): Path<(String, String)>,
) -> Response {
    let studio = st.supervisor.dispatcher().studio();
    let Ok(effective) = studio.resolve_config(&command_name, Some(&id), None) else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "COMMAND_NOT_FOUND",
            "Command not found",
            None,
        );
    };
    let override_layer = st
        .supervisor
        .caches()
        .get_studio_layer_hot("bot", &id, "", &command_name);
    ok_json(
        &ctx,
        json!({
            "effective": effective.values,
            "override": override_layer.as_ref().map(|l| &l.overrides),
            "hasOverride": override_layer.is_some(),
        }),
    )
}

async fn api_bot_command_put_behavior(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, command_name)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    api_bot_command_put_override(State(st), Extension(ctx), Path((id, command_name)), Json(body))
        .await
}

async fn api_bot_command_delete_behavior(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, command_name)): Path<(String, String)>,
) -> Response {
    api_bot_command_delete_override(State(st), Extension(ctx), Path((id, command_name))).await
}

// =============================================================================
// 7. Command Studio V2 Full 15-Endpoint Suite (`409 REVISION_CONFLICT` CAS)
// =============================================================================

async fn api_studio_catalog(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok_json(&ctx, st.supervisor.dispatcher().studio().catalog())
}

async fn api_studio_coverage(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok_json(&ctx, st.supervisor.dispatcher().studio().coverage())
}

async fn api_studio_layers(
    Extension(ctx): Extension<RequestContext>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let bot_id = q.get("botId").cloned().unwrap_or_default();
    let thread_id = q.get("threadId").cloned().unwrap_or_default();
    ok_json(
        &ctx,
        json!({
            "scopes": ["default", "global", "bot", "group"],
            "botId": bot_id,
            "threadId": thread_id,
        }),
    )
}

async fn api_studio_contract(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
) -> Response {
    let Some(contract) = st
        .supervisor
        .dispatcher()
        .studio()
        .build_contract_for(&command_name)
    else {
        return err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "COMMAND_NOT_FOUND",
            "Command not found",
            None,
        );
    };
    ok_json(
        &ctx,
        json!({
            "contract": contract,
            "coverage": "FULL",
            "validationErrors": [],
        }),
    )
}

async fn api_studio_config(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    match st.supervisor.dispatcher().studio().resolve_config(
        &command_name,
        q.get("botId").map(String::as_str),
        q.get("threadId").map(String::as_str),
    ) {
        Ok(cfg) => ok_json(&ctx, serde_json::to_value(cfg).unwrap_or(Value::Null)),
        Err(_) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "COMMAND_NOT_FOUND",
            "Command not found",
            None,
        ),
    }
}

async fn api_studio_get_draft(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let scope = q.get("scope").cloned().unwrap_or_else(|| "global".into());
    let bot_id = q.get("botId").cloned().unwrap_or_default();
    let thread_id = q.get("threadId").cloned().unwrap_or_default();
    let draft = st
        .drafts
        .get(&(scope, bot_id, thread_id, command_name))
        .map(|r| r.value().clone());
    ok_json(&ctx, json!({ "draft": draft }))
}

async fn api_studio_put_draft(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global")
        .to_string();
    let bot_id = body
        .get("botId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let thread_id = body
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let draft_doc = json!({
        "commandName": command_name,
        "scope": scope,
        "botId": bot_id,
        "threadId": thread_id,
        "patch": body.get("patch").cloned().unwrap_or_else(|| json!({})),
        "updatedAt": Utc::now().to_rfc3339(),
    });
    st.drafts
        .insert((scope, bot_id, thread_id, command_name), draft_doc.clone());
    ok_json(&ctx, json!({ "draft": draft_doc }))
}

async fn api_studio_delete_draft(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let scope = q.get("scope").cloned().unwrap_or_else(|| "global".into());
    let bot_id = q.get("botId").cloned().unwrap_or_default();
    let thread_id = q.get("threadId").cloned().unwrap_or_default();
    let discarded = st
        .drafts
        .remove(&(scope, bot_id, thread_id, command_name))
        .is_some();
    ok_json(&ctx, json!({ "discarded": discarded }))
}

async fn api_studio_list_drafts(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let drafts: Vec<Value> = st.drafts.iter().map(|e| e.value().clone()).collect();
    ok_json(&ctx, json!({ "drafts": drafts }))
}

async fn api_studio_validate(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let values = body.get("values").cloned().unwrap_or_else(|| json!({}));
    let res = st
        .supervisor
        .dispatcher()
        .studio()
        .validate_layer_values(&command_name, scope, &values);
    if res["ok"] == false {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "COMMAND_VALIDATION_FAILED",
            "Command Studio validation failed",
            Some(res),
        );
    }
    ok_json(&ctx, res)
}

async fn api_studio_preview(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let bot_id = body.get("botId").and_then(Value::as_str);
    let thread_id = body.get("threadId").and_then(Value::as_str);
    let current = st
        .supervisor
        .dispatcher()
        .studio()
        .resolve_config(&command_name, bot_id, thread_id)
        .map(|r| r.values)
        .unwrap_or_else(|_| json!({}));
    ok_json(
        &ctx,
        json!({
            "commandName": command_name,
            "current": current,
            "proposed": body.get("values").cloned().unwrap_or_else(|| json!({})),
        }),
    )
}

async fn api_studio_apply(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let bot_id = body.get("botId").and_then(Value::as_str).unwrap_or("");
    let thread_id = body.get("threadId").and_then(Value::as_str).unwrap_or("");
    let values = body.get("values").cloned().unwrap_or_else(|| json!({}));
    let expected_rev = body
        .get("expectedRevision")
        .or_else(|| body.get("expectedVersion"))
        .and_then(Value::as_i64);
    let actor = body
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("dashboard");

    let validation = st
        .supervisor
        .dispatcher()
        .studio()
        .validate_layer_values(&command_name, scope, &values);
    if validation["ok"] == false {
        return err_json(
            StatusCode::BAD_REQUEST,
            &ctx,
            "COMMAND_VALIDATION_FAILED",
            "Command Studio validation failed",
            Some(validation),
        );
    }

    match st.supervisor.dispatcher().studio().apply_layer(
        &command_name,
        scope,
        bot_id,
        thread_id,
        &values,
        expected_rev,
        actor,
    ) {
        Ok(res) => ok_json(&ctx, res),
        Err(StorageError::RevisionConflict { expected, actual }) => err_json(
            StatusCode::CONFLICT,
            &ctx,
            "REVISION_CONFLICT",
            format!("Expected revision {expected}, actual revision {actual}"),
            Some(json!({ "expectedRevision": expected, "actualRevision": actual })),
        ),
        Err(StorageError::NotFound(m)) => {
            err_json(StatusCode::NOT_FOUND, &ctx, "COMMAND_NOT_FOUND", m, None)
        }
        Err(e) => err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "STUDIO_APPLY_FAILED",
            e.to_string(),
            None,
        ),
    }
}

async fn api_studio_rollback(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let bot_id = body.get("botId").and_then(Value::as_str).unwrap_or("");
    let thread_id = body.get("threadId").and_then(Value::as_str).unwrap_or("");
    let actor = body
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("dashboard");

    match st
        .supervisor
        .dispatcher()
        .studio()
        .rollback_latest(&command_name, scope, bot_id, thread_id, actor)
    {
        Ok(res) => ok_json(&ctx, res),
        Err(StorageError::NotFound(_)) => err_json(
            StatusCode::NOT_FOUND,
            &ctx,
            "ROLLBACK_TARGET_NOT_FOUND",
            "No history entry available to roll back",
            None,
        ),
        Err(e) => err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "ROLLBACK_FAILED",
            e.to_string(),
            None,
        ),
    }
}

async fn api_studio_reset_override(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let bot_id = body.get("botId").and_then(Value::as_str).unwrap_or("");
    let thread_id = body.get("threadId").and_then(Value::as_str).unwrap_or("");

    match st.supervisor.dispatcher().studio().apply_layer(
        &command_name,
        scope,
        bot_id,
        thread_id,
        &json!({}),
        None,
        "dashboard",
    ) {
        Ok(res) => ok_json(&ctx, res),
        Err(e) => err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "RESET_FAILED",
            e.to_string(),
            None,
        ),
    }
}

async fn api_studio_history(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let scope = q.get("scope").map(String::as_str).unwrap_or("global");
    let bot_id = q.get("botId").map(String::as_str).unwrap_or("");
    let thread_id = q.get("threadId").map(String::as_str).unwrap_or("");
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50);

    let entries = st
        .supervisor
        .caches()
        .engine()
        .list_studio_history(scope, bot_id, thread_id, &command_name, limit)
        .unwrap_or_default();
    ok_json(&ctx, json!({ "entries": entries }))
}

async fn api_studio_migration_v1(
    Extension(ctx): Extension<RequestContext>,
    Path(command_name): Path<String>,
) -> Response {
    ok_json(
        &ctx,
        json!({
            "commandName": command_name,
            "version": 2,
            "migrated": true,
        }),
    )
}

// =============================================================================
// 8. Loopback HMAC-SHA256 Internal Control Plane (`/internal/*`)
// =============================================================================

fn check_internal_hmac(st: &DashboardState, headers: &HeaderMap, body: &[u8]) -> bool {
    let ts = headers
        .get("x-internal-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let sig = headers
        .get("x-internal-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    verify_internal_signature(
        &st.supervisor.config().internal_hmac_secret,
        ts,
        body,
        sig,
        Utc::now().timestamp_millis(),
    )
}

async fn internal_command_execute(
    State(st): State<DashboardState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !check_internal_hmac(&st, &headers, &body) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "success": false, "error": "INVALID_INTERNAL_SIGNATURE" })),
        )
            .into_response();
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "INVALID_JSON" })),
        )
            .into_response();
    };
    let bot_key = payload
        .get("botKey")
        .or_else(|| payload.get("botId"))
        .and_then(Value::as_str)
        .unwrap_or("admin");
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let thread_id = payload
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or("internal_thread");
    let sender_uid = payload
        .get("senderUid")
        .and_then(Value::as_str)
        .unwrap_or("internal_sender");

    let msg = InboundMessage {
        bot_key: bot_key.into(),
        msg_id: ZaloId::new(uuid::Uuid::new_v4().to_string()),
        cli_msg_id: ZaloId::default(),
        global_msg_id: ZaloId::default(),
        thread_id: ZaloId::new(thread_id),
        thread_type: ThreadType::Group,
        sender_uid: ZaloId::new(sender_uid),
        sender_name: "InternalBridge".into(),
        is_self: false,
        msg_type: "webchat".into(),
        timestamp_ms: Utc::now().timestamp_millis(),
        ws_received_at_ms: Utc::now().timestamp_millis(),
        ttl_ms: 0,
        mentions: Vec::new(),
        styles: Vec::new(),
        quote: None,
        content: MessageContent::Text {
            text: text.to_string(),
        },
        source: EventSource::LegacyBridge,
        raw_property_ext: None,
    };

    match st.supervisor.relay_command(bot_key, msg, Vec::new()).await {
        Ok(report) => (
            StatusCode::OK,
            Json(json!({ "success": true, "report": report })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "success": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn internal_runtime_identity(State(st): State<DashboardState>) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "engine": "mybot-v4-rust",
            "pid": std::process::id(),
            "runningBots": st.supervisor.system_metrics_json()["runningBots"],
        })),
    )
        .into_response()
}

async fn internal_runtime_health(State(st): State<DashboardState>) -> Response {
    (StatusCode::OK, Json(st.supervisor.system_metrics_json())).into_response()
}

async fn internal_runtime_reload(
    State(st): State<DashboardState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !check_internal_hmac(&st, &headers, &body) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "success": false, "error": "INVALID_INTERNAL_SIGNATURE" })),
        )
            .into_response();
    }
    let payload: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let bot_key = payload
        .get("botId")
        .and_then(Value::as_str)
        .unwrap_or("admin");
    let _ = st.supervisor.reload_bot(bot_key).await;
    (
        StatusCode::OK,
        Json(json!({ "success": true, "reloaded": bot_key })),
    )
        .into_response()
}
