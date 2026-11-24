//! Embedded Single-Binary React 19 SPA (`rust-embed`) + Full Remote Bot Control,
//! Group 17-Shield Matrix, Broadcast Stagger Engine, Web Command Console & System Doctor APIs.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Duration as ChronoDuration, Utc};
use mybot_core::{
    BotExecutionMeta, BotFleetController, BotStyleProfile, CommandOutcome, DispatchReport,
    SupervisorEvent,
};
use mybot_storage::{BotRecord, GroupSettingsRecord, migrate_v3_directory};
use mybot_types::{
    ApiEnvelope, DEFAULT_ZALO_USER_AGENT, EventSource, ExpiryPolicy, InboundMessage,
    MessageContent, PermissionTier, ThreadType, ZaloId,
};
use rust_embed::RustEmbed;
use serde_json::{Value, json};
use zalo_sdk::apis::messaging::VideoSendRequest;

use crate::auth::{LoginError, RequestContext};
use crate::qr_coordinator::parse_expiry_preset;
use crate::routes::DashboardState;

#[derive(RustEmbed)]
#[folder = "../../../dashboard/dist"]
pub struct EmbeddedSpaAssets;

fn ok(ctx: &RequestContext, data: Value) -> Response {
    (StatusCode::OK, Json(ApiEnvelope::ok(data, &ctx.request_id))).into_response()
}

fn err(
    status: StatusCode,
    ctx: &RequestContext,
    code: &str,
    message: impl Into<String>,
) -> Response {
    (
        status,
        Json(ApiEnvelope::<Value>::err(
            code,
            message,
            None,
            &ctx.request_id,
        )),
    )
        .into_response()
}

/// Serves disk override files when present (e.g. dev mode or temp-dir unit tests),
/// otherwise serves compiled `dashboard/dist` assets embedded directly inside `mybotd`!
pub async fn serve_spa_with_embedded_fallback(
    uri: Uri,
    headers: HeaderMap,
    disk_dir: PathBuf,
) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    let rel_path = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    // 1. Exact file on disk (safe relative path check)
    if !rel_path.contains("..") && !rel_path.contains('\\') {
        let candidate = disk_dir.join(rel_path);
        if let Ok(meta) = tokio::fs::metadata(&candidate).await
            && meta.is_file()
            && let Ok(bytes) = tokio::fs::read(&candidate).await
        {
            let mime = mime_guess::from_path(rel_path).first_or_octet_stream();
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.as_ref().to_string())],
                bytes,
            )
                .into_response();
        }
    }

    // 2. Exact file embedded inside `mybotd` via `rust-embed`
    if let Some(asset) = EmbeddedSpaAssets::get(rel_path) {
        let mime = mime_guess::from_path(rel_path).first_or_octet_stream();
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime.as_ref().to_string())],
            asset.data.into_owned(),
        )
            .into_response();
    }

    // 3. SPA HTML deep-route fallback when `Accept: text/html` (or browser root)
    let accepts_html = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/html") || a.contains("*/*") && raw_path.is_empty());

    if !accepts_html && !raw_path.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "Not found" })),
        )
            .into_response();
    }

    let disk_index = disk_dir.join("index.html");
    if let Ok(bytes) = tokio::fs::read(&disk_index).await {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            bytes,
        )
            .into_response();
    }

    if let Some(index_asset) = EmbeddedSpaAssets::get("index.html") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            index_asset.data.into_owned(),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>MyBot Control Center</title></head><body><div id=\"root\">MyBot V4 Ready</div></body></html>",
    )
        .into_response()
}

// =============================================================================
// Auth Password Change & Admin QR Recovery Endpoints
// =============================================================================

pub async fn api_auth_change_password(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let current_pw = body
        .get("currentPassword")
        .and_then(Value::as_str)
        .unwrap_or("");
    let new_pw = body
        .get("newPassword")
        .and_then(Value::as_str)
        .unwrap_or("");

    if new_pw.len() < 6 {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "WEAK_PASSWORD",
            "Mật khẩu mới phải có tối thiểu 6 ký tự.",
        );
    }

    let engine = st.supervisor.caches().engine();
    match st.auth.change_password(current_pw, new_pw, engine) {
        Ok(()) => {
            let _ = engine.append_audit_log(
                "dashboard",
                "auth.change_password",
                "web_admin",
                &json!({ "requestId": ctx.request_id }),
            );
            ok(&ctx, json!({ "changed": true }))
        }
        Err(LoginError::InvalidCredentials) => err(
            StatusCode::UNAUTHORIZED,
            &ctx,
            "INVALID_CURRENT_PASSWORD",
            "Mật khẩu hiện tại không chính xác.",
        ),
        Err(_) => err(
            StatusCode::SERVICE_UNAVAILABLE,
            &ctx,
            "AUTH_NOT_CONFIGURED",
            "Chưa khởi tạo cấu hình xác thực Web Admin.",
        ),
    }
}

pub async fn api_admin_recovery_start(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    body: Option<Json<Value>>,
) -> Response {
    let payload = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let allow_change = payload
        .get("allowAccountChange")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let snapshot = st.qr_coordinator.start_admin_recovery(allow_change).await;
    ok(&ctx, snapshot)
}

pub async fn api_admin_recovery_confirm_swap(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    match st.qr_coordinator.confirm_admin_swap().await {
        Ok(done) => ok(&ctx, done),
        Err((status, code, msg)) => err(status, &ctx, code, msg),
    }
}

pub async fn api_admin_recovery_cancel(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    ok(&ctx, st.qr_coordinator.cancel_admin_recovery())
}

// =============================================================================
// Create Bot, Rental Expiry, Owner Trial Reset, Bot Admins & Unified Settings
// =============================================================================

pub async fn api_bots_create(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Json(body): Json<Value>,
) -> Response {
    let requested_key = body
        .get("botKey")
        .or_else(|| body.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let bot_key = requested_key.map(ToOwned::to_owned).unwrap_or_else(|| {
        format!(
            "bot_{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        )
    });

    if !bot_key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_BOT_ID",
            "Mã định danh Bot không hợp lệ.",
        );
    }

    let prefix = body
        .get("prefix")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 8)
        .unwrap_or("!")
        .to_string();

    let display_name = body
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&bot_key)
        .to_string();

    let owner_uid = body
        .get("ownerUid")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let expiry_policy = body
        .get("expiryPreset")
        .and_then(Value::as_str)
        .and_then(parse_expiry_preset)
        .unwrap_or(ExpiryPolicy::Permanent);

    let raw_cookie = body.get("cookie");
    let cookie_json = match raw_cookie {
        Some(Value::String(s)) if !s.trim().is_empty() => {
            serde_json::from_str::<Value>(s.trim())
                .unwrap_or_else(|_| json!({ "raw": s.trim() }))
        }
        Some(v @ Value::Object(_)) | Some(v @ Value::Array(_)) => v.clone(),
        _ => json!({}),
    };
    let imei = body
        .get("imei")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let user_agent = body
        .get("userAgent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_ZALO_USER_AGENT)
        .to_string();

    let has_creds = !imei.is_empty() && cookie_json != json!({});
    let now = Utc::now().to_rfc3339();

    if body
        .get("startImmediately")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "START_IMMEDIATELY_NOT_ALLOWED",
            "startImmediately không còn được hỗ trợ. Bot luôn được tạo ở trạng thái chờ kích hoạt.",
        );
    }

    if st.is_node_hybrid() {
        match st.bridge.create_bot(&body).await {
            Ok(bridge_res) => {
                let key = bridge_res
                    .get("botKey")
                    .or_else(|| bridge_res.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or(&bot_key)
                    .to_string();
                let qr = if body.get("startQr").and_then(Value::as_bool).unwrap_or(false) {
                    st.bridge
                        .start_bot_qr(
                            &key,
                            &json!({
                                "prefix": prefix,
                                "ownerUid": owner_uid,
                                "expiryPreset": body.get("expiryPreset"),
                            }),
                        )
                        .await
                        .ok()
                } else {
                    bridge_res.get("qr").cloned()
                };
                return (
                    StatusCode::CREATED,
                    Json(ApiEnvelope::ok(
                        json!({
                            "botKey": key,
                            "bot": bridge_res.get("bot").unwrap_or(&bridge_res),
                            "qr": qr,
                            "status": "stopped",
                            "desired_status": "stopped",
                            "pendingActivation": true,
                        }),
                        &ctx.request_id,
                    )),
                )
                    .into_response();
            }
            Err(e) => {
                return err(
                    StatusCode::BAD_GATEWAY,
                    &ctx,
                    "BRIDGE_ERROR",
                    format!("Lỗi chuyển tiếp tạo bot sang Node bridge: {e}"),
                );
            }
        }
    }

    let record = BotRecord {
        bot_key: bot_key.clone(),
        uid: ZaloId::new(&bot_key),
        global_uid: None,
        canonical_username: None,
        display_name,
        avatar: String::new(),
        is_main: false,
        owner_uid: owner_uid.clone(),
        status: "stopped".to_string(),
        desired_status: "stopped".to_string(),
        expiry_policy,
        trial_status: Some("pending".to_string()),
        cookie_json,
        imei,
        user_agent,
        proxy_url: None,
        cookie_dead: !has_creds,
        cookie_dead_reason: if has_creds {
            None
        } else {
            Some("Đang chờ quét mã QR Zalo".to_string())
        },
        prefix: prefix.clone(),
        self_listen: true,
        identity_pending: false,
        admin_identity_seeds: Vec::new(),
        metadata: json!({}),
        created_at: now.clone(),
        updated_at: now,
    };

    if let Err(e) = st.supervisor.caches().engine().upsert_bot(&record) {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "STORAGE_ERROR",
            e.to_string(),
        );
    }

    let qr = if body
        .get("startQr")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        Some(
            st.qr_coordinator
                .start_bot_qr_login(
                    &bot_key,
                    Some(prefix),
                    owner_uid,
                    body.get("expiryPreset")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                )
                .await,
        )
    } else {
        None
    };

    (
        StatusCode::CREATED,
        Json(ApiEnvelope::ok(
            json!({
                "botKey": bot_key,
                "bot": record.to_redacted_summary(),
                "qr": qr,
            }),
            &ctx.request_id,
        )),
    )
        .into_response()
}

pub async fn api_bot_put_expiry(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let engine = st.supervisor.caches().engine();
    let Ok(Some(mut bot)) = engine.get_bot(&id) else {
        return err(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Không tìm thấy Bot.");
    };

    if let Some(ouid) = body.get("ownerUid").and_then(Value::as_str).map(str::trim)
        && !ouid.is_empty()
    {
        bot.owner_uid = Some(ouid.to_string());
    }

    let now = Utc::now();
    let base_time = match bot.expiry_policy {
        ExpiryPolicy::At(existing) if existing > now => existing,
        _ => now,
    };

    if let Some(preset) = body.get("preset").and_then(Value::as_str) {
        bot.expiry_policy = match preset.trim().to_ascii_lowercase().as_str() {
            "+1h" | "1h" => ExpiryPolicy::At(base_time + ChronoDuration::hours(1)),
            "+1d" | "1d" => ExpiryPolicy::At(base_time + ChronoDuration::days(1)),
            "+7d" | "7d" => ExpiryPolicy::At(base_time + ChronoDuration::days(7)),
            "+30d" | "30d" => ExpiryPolicy::At(base_time + ChronoDuration::days(30)),
            "permanent" | "never" | "-1" => ExpiryPolicy::Permanent,
            other => parse_expiry_preset(other).unwrap_or(bot.expiry_policy),
        };
    } else if let Some(iso) = body.get("expiryAt").and_then(Value::as_str) {
        if let Some(pol) = parse_expiry_preset(iso) {
            bot.expiry_policy = pol;
        } else {
            return err(
                StatusCode::BAD_REQUEST,
                &ctx,
                "INVALID_EXPIRY_DATE",
                "Định dạng ngày hết hạn không hợp lệ.",
            );
        }
    }

    if !bot.expiry_policy.is_expired_at(now) && bot.status == "expired" {
        bot.status = "stopped".to_string();
    }
    bot.updated_at = now.to_rfc3339();
    let _ = engine.upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;

    ok(&ctx, bot.to_redacted_summary())
}

pub async fn api_owner_trial_reset(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(owner_uid): Path<String>,
) -> Response {
    let removed = st
        .supervisor
        .caches()
        .engine()
        .reset_trial_ledger(&owner_uid)
        .unwrap_or(0);
    ok(
        &ctx,
        json!({
            "ownerUid": owner_uid,
            "reset": true,
            "removedRows": removed,
        }),
    )
}

pub async fn api_bot_list_admins(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    let rows = st
        .supervisor
        .caches()
        .engine()
        .list_bot_admins(&id)
        .unwrap_or_default();
    let admins: Vec<Value> = rows
        .into_iter()
        .map(|(uid, tier, name)| {
            json!({
                "adminUid": uid,
                "uid": uid,
                "tier": tier,
                "displayName": name,
            })
        })
        .collect();
    ok(&ctx, json!({ "botId": id, "admins": admins }))
}

pub async fn api_bot_add_admin(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(uid) = body
        .get("uid")
        .or_else(|| body.get("adminUid"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "INVALID_UID",
            "Vui lòng nhập UID Zalo hợp lệ.",
        );
    };
    let tier = body.get("tier").and_then(Value::as_str).unwrap_or("admin");
    let name = body
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let _ = st
        .supervisor
        .caches()
        .engine()
        .upsert_bot_admin(&id, uid, tier, name);
    ok(&ctx, json!({ "botId": id, "added": uid }))
}

pub async fn api_bot_remove_admin(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, admin_uid)): Path<(String, String)>,
) -> Response {
    let removed = st
        .supervisor
        .caches()
        .engine()
        .remove_bot_admin(&id, &admin_uid)
        .unwrap_or(false);
    ok(&ctx, json!({ "botId": id, "adminUid": admin_uid, "removed": removed }))
}

pub async fn api_bot_put_unified_settings(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let engine = st.supervisor.caches().engine();
    let Ok(Some(mut bot)) = engine.get_bot(&id) else {
        return err(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Không tìm thấy Bot.");
    };

    if let Some(pfx) = body
        .get("prefix")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 8)
    {
        bot.prefix = pfx.to_string();
    }
    if let Some(dn) = body
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        bot.display_name = dn.to_string();
    }
    if let Some(ouid) = body.get("ownerUid").and_then(Value::as_str).map(str::trim)
        && !ouid.is_empty()
    {
        bot.owner_uid = Some(ouid.to_string());
    }
    if !bot.metadata.is_object() {
        bot.metadata = json!({});
    }
    let group_enabled = body
        .get("groupEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let private_enabled = body
        .get("privateEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    bot.metadata["chatPolicy"] = json!({
        "groupEnabled": group_enabled,
        "privateEnabled": private_enabled,
    });
    bot.updated_at = Utc::now().to_rfc3339();
    let _ = engine.upsert_bot(&bot);
    let _ = st.supervisor.reload_bot(&bot.bot_key).await;

    ok(&ctx, bot.to_redacted_summary())
}

// =============================================================================
// Groups + 17 Anti-Shields, Friends & Full Remote Bot Control
// =============================================================================

fn group_record_to_ui_json(g: &GroupSettingsRecord) -> Value {
    let s = &g.settings;
    let flag = |key: &str, fallback: bool| s.get(key).and_then(Value::as_bool).unwrap_or(fallback);

    json!({
        "threadId": g.thread_id,
        "id": g.thread_id,
        "name": if g.group_name.is_empty() { format!("Nhóm {}", g.thread_id) } else { g.group_name.clone() },
        "memberCount": s.get("memberCount").and_then(Value::as_u64),
        "enableBot": g.enable_bot,
        "onlyAdminBox": flag("onlyAdminBox", false),
        "sendTask": flag("sendTask", false),
        "antiSpam": g.anti_spam,
        "filterBadWords": g.anti_bad_word || flag("filterBadWords", false),
        "removeLinks": g.anti_link || flag("removeLinks", false),
        "antiLink": g.anti_link,
        "antiMention": g.anti_mention,
        "antiUndo": g.anti_undo,
        "antiMedia": g.anti_photo_video || flag("antiMedia", false),
        "antiSticker": g.anti_sticker,
        "antiVoice": g.anti_voice,
        "antiFile": g.anti_file,
        "antiCard": g.anti_card,
        "antiForward": g.anti_forward,
        "antiKickBlock": flag("antiKickBlock", false),
        "antiJoinLeave": flag("antiJoinLeave", false),
        "enableSetup": g.welcome_group || g.bye_group || flag("enableSetup", false),
        "learnEnabled": flag("learnEnabled", false),
        "replyEnabled": flag("replyEnabled", false),
        "settings": g.settings,
    })
}

pub async fn api_bot_list_groups(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    // If bot has a live ZaloSession, opportunistically discover new group IDs from Zalo
    if let Some(zalo) = st.supervisor.get_live_zalo_session(&id)
        && let Ok(all) = zalo.get_all_groups().await
        && let Some(map_obj) = all.get("gridVerMap").and_then(Value::as_object)
    {
        let mut unknown_ids = Vec::new();
        for gid in map_obj.keys() {
            let cur = st.supervisor.caches().get_or_default_group_settings(&id, gid);
            if cur.group_name.is_empty() && unknown_ids.len() < 40 {
                unknown_ids.push(ZaloId::new(gid));
            }
        }
        if !unknown_ids.is_empty()
            && let Ok(info) = zalo.get_group_info(&unknown_ids).await
            && let Some(grid_map) = info.get("gridInfoMap").and_then(Value::as_object)
        {
            for (gid, gval) in grid_map {
                let name = gval
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let total_member = gval.get("totalMember").and_then(Value::as_u64);
                st.supervisor
                    .caches()
                    .update_group_settings(&id, gid, |rec| {
                        if !name.is_empty() {
                            rec.group_name = name;
                        }
                        if let Some(cnt) = total_member {
                            if !rec.settings.is_object() {
                                rec.settings = json!({});
                            }
                            rec.settings["memberCount"] = json!(cnt);
                        }
                    });
            }
        }
    }

    let cached = st.supervisor.caches().list_bot_group_settings(&id);
    let groups: Vec<Value> = cached.iter().map(group_record_to_ui_json).collect();
    ok(&ctx, json!({ "botId": id, "groups": groups }))
}

pub async fn api_bot_enable_all_groups(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let mut discovered_ids: Vec<(String, String)> = Vec::new();

    if let Some(zalo) = st.supervisor.get_live_zalo_session(&id)
        && let Ok(all) = zalo.get_all_groups().await
        && let Some(map_obj) = all.get("gridVerMap").and_then(Value::as_object)
    {
        let mut unknown_ids = Vec::new();
        for gid in map_obj.keys() {
            discovered_ids.push((gid.clone(), String::new()));
            let cur = st.supervisor.caches().get_or_default_group_settings(&id, gid);
            if cur.group_name.is_empty() && unknown_ids.len() < 80 {
                unknown_ids.push(ZaloId::new(gid));
            }
        }
        if !unknown_ids.is_empty()
            && let Ok(info) = zalo.get_group_info(&unknown_ids).await
            && let Some(grid_map) = info.get("gridInfoMap").and_then(Value::as_object)
        {
            for (gid, gval) in grid_map {
                let name = gval
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let total_member = gval.get("totalMember").and_then(Value::as_u64);
                st.supervisor
                    .caches()
                    .update_group_settings(&id, gid, |rec| {
                        if !name.is_empty() {
                            rec.group_name = name;
                        }
                        if let Some(cnt) = total_member {
                            if !rec.settings.is_object() {
                                rec.settings = json!({});
                            }
                            rec.settings["memberCount"] = json!(cnt);
                        }
                    });
            }
        }
    }

    let updated_count = st
        .supervisor
        .caches()
        .set_all_bot_groups_enable(&id, &discovered_ids, enabled);
    let _ = st.supervisor.caches().flush_all_sync();

    st.supervisor.push_log(
        "info",
        Some(&id),
        "groups",
        format!(
            "Đã {} Bot hoạt động cho toàn bộ {updated_count} nhóm",
            if enabled { "BẬT" } else { "TẮT" }
        ),
    );

    let cached = st.supervisor.caches().list_bot_group_settings(&id);
    let groups: Vec<Value> = cached.iter().map(group_record_to_ui_json).collect();
    ok(
        &ctx,
        json!({
            "botId": id,
            "enabled": enabled,
            "updatedCount": updated_count,
            "groups": groups,
        }),
    )
}

pub async fn api_bot_put_group_settings(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, thread_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Response {
    if st.is_node_hybrid() {
        let name = body.get("name").and_then(Value::as_str);
        let settings = body.get("settings").unwrap_or(&body);
        return match st.bridge.put_group_settings(&id, &thread_id, name, settings).await {
            Ok(val) => {
                let data = val.get("data").cloned().unwrap_or(val);
                ok(&ctx, data)
            }
            Err(e) => err(
                StatusCode::SERVICE_UNAVAILABLE,
                &ctx,
                "BRIDGE_ERROR",
                format!("Node bridge error: {e}"),
            ),
        };
    }
    let updated = st
        .supervisor
        .caches()
        .update_group_settings(&id, &thread_id, |rec| {
            let mut merged_bag = if rec.settings.is_object() {
                rec.settings.clone()
            } else {
                json!({})
            };
            if let (Some(dst), Some(src)) = (merged_bag.as_object_mut(), body.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            let b = |k: &str, cur: bool| merged_bag.get(k).and_then(Value::as_bool).unwrap_or(cur);

            rec.enable_bot = b("enableBot", rec.enable_bot);
            rec.anti_spam = b("antiSpam", rec.anti_spam);
            rec.anti_bad_word = b("filterBadWords", b("antiBadWord", rec.anti_bad_word));
            rec.anti_link = b("antiLink", b("removeLinks", rec.anti_link));
            rec.anti_mention = b("antiMention", rec.anti_mention);
            rec.anti_undo = b("antiUndo", rec.anti_undo);
            rec.anti_photo_video = b("antiMedia", b("antiPhotoVideo", rec.anti_photo_video));
            rec.anti_sticker = b("antiSticker", rec.anti_sticker);
            rec.anti_voice = b("antiVoice", rec.anti_voice);
            rec.anti_file = b("antiFile", rec.anti_file);
            rec.anti_card = b("antiCard", rec.anti_card);
            rec.anti_forward = b("antiForward", rec.anti_forward);
            let setup = b("enableSetup", rec.welcome_group);
            rec.welcome_group = setup;
            rec.bye_group = setup;
            if let Some(name) = body.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                rec.group_name = name.to_string();
            }
            rec.settings = merged_bag;
            rec.updated_at = Utc::now().to_rfc3339();
        });

    let _ = st.supervisor.caches().flush_all_sync();
    ok(&ctx, group_record_to_ui_json(&updated))
}

pub async fn api_bot_leave_group(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path((id, thread_id)): Path<(String, String)>,
) -> Response {
    if let Some(zalo) = st.supervisor.get_live_zalo_session(&id)
        && let Err(e) = zalo.leave_group(&[ZaloId::new(&thread_id)], false).await
    {
        return err(
            StatusCode::BAD_GATEWAY,
            &ctx,
            "ZALO_LEAVE_FAILED",
            e.to_string(),
        );
    }
    st.supervisor
        .caches()
        .update_group_settings(&id, &thread_id, |rec| {
            rec.enable_bot = false;
        });
    ok(&ctx, json!({ "botId": id, "threadId": thread_id, "left": true }))
}

pub async fn api_bot_list_friends(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
) -> Response {
    if let Some(zalo) = st.supervisor.get_live_zalo_session(&id)
        && let Ok(res) = zalo.get_all_friends(1, 500).await
    {
        let arr = res
            .as_array()
            .cloned()
            .or_else(|| res.get("data").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        let friends: Vec<Value> = arr
            .into_iter()
            .map(|f| {
                let uid = f
                    .get("userId")
                    .or_else(|| f.get("uid"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let name = f
                    .get("displayName")
                    .or_else(|| f.get("zaloName"))
                    .and_then(Value::as_str)
                    .unwrap_or(uid);
                json!({
                    "uid": uid,
                    "displayName": name,
                    "avatar": f.get("avatar").and_then(Value::as_str).unwrap_or_default(),
                })
            })
            .filter(|v| !v["uid"].as_str().unwrap_or_default().is_empty())
            .collect();
        return ok(&ctx, json!({ "botId": id, "friends": friends }));
    }
    ok(&ctx, json!({ "botId": id, "friends": [] }))
}

pub async fn api_bot_remote_send_message(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let thread_id = body
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if thread_id.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "MISSING_THREAD_ID",
            "Vui lòng chọn Nhóm hoặc UID người nhận.",
        );
    }
    let text = body.get("text").and_then(Value::as_str).unwrap_or("");
    let media_url = body
        .get("mediaUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let target_type = match body.get("targetType").and_then(Value::as_str) {
        Some("user") | Some("private") => ThreadType::User,
        _ => ThreadType::Group,
    };
    let ttl_ms = body.get("ttlMs").and_then(Value::as_u64).unwrap_or(0);

    let tid = ZaloId::new(thread_id);
    if let Some(zalo) = st.supervisor.get_live_zalo_session(&id) {
        let send_res = if let Some(url) = media_url {
            zalo.send_video(
                &VideoSendRequest {
                    video_url: url.to_string(),
                    thumbnail_url: None,
                    caption: text.to_string(),
                    mentions: Vec::new(),
                    duration_ms: 15_000,
                    width: 720,
                    height: 1280,
                    file_size: 0,
                    ttl_ms,
                    video_already_uploaded: true,
                },
                &tid,
                target_type,
            )
            .await
        } else {
            zalo.send_message(text, &tid, target_type).await
        };

        if let Err(e) = send_res {
            return err(StatusCode::BAD_GATEWAY, &ctx, "ZALO_SEND_FAILED", e.to_string());
        }
    } else if !st.auth.config().test_mode {
        return err(
            StatusCode::CONFLICT,
            &ctx,
            "BOT_OFFLINE",
            "Bot này hiện chưa kết nối Zalo trực tuyến. Hãy bấm Chạy hoặc Quét lại mã QR trước!",
        );
    }

    st.supervisor.push_log(
        "info",
        Some(&id),
        "remote-chat",
        format!("Đã gửi tin nhắn từ xa tới `{thread_id}`"),
    );

    ok(
        &ctx,
        json!({
            "sent": true,
            "botId": id,
            "threadId": thread_id,
        }),
    )
}

pub async fn api_bot_remote_broadcast(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let thread_ids: Vec<String> = body
        .get("threadIds")
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

    if thread_ids.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "MISSING_TARGETS",
            "Vui lòng chọn ít nhất 1 nhóm để gửi thông báo hàng loạt.",
        );
    }

    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let media_url = body
        .get("mediaUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let delay_ms = body
        .get("delayMs")
        .and_then(Value::as_u64)
        .unwrap_or(5_000)
        .clamp(1_000, 60_000);

    let total = thread_ids.len();
    let sup = st.supervisor.clone();
    let bot_id = id.clone();

    tokio::spawn(async move {
        let mut sent = 0usize;
        let mut failed = 0usize;

        for (idx, gid) in thread_ids.iter().enumerate() {
            if idx > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            if let Some(zalo) = sup.get_live_zalo_session(&bot_id) {
                let tid = ZaloId::new(gid);
                let ok_send = if let Some(ref url) = media_url {
                    zalo.send_video(
                        &VideoSendRequest {
                            video_url: url.clone(),
                            thumbnail_url: None,
                            caption: text.clone(),
                            mentions: Vec::new(),
                            duration_ms: 15_000,
                            width: 720,
                            height: 1280,
                            file_size: 0,
                            ttl_ms: 0,
                            video_already_uploaded: false,
                        },
                        &tid,
                        ThreadType::Group,
                    )
                    .await
                    .is_ok()
                } else {
                    zalo.send_message(text.as_str(), &tid, ThreadType::Group)
                        .await
                        .is_ok()
                };
                if ok_send {
                    sent += 1;
                } else {
                    failed += 1;
                }
            } else {
                sent += 1;
            }

            sup.emit_custom_event(SupervisorEvent::BroadcastProgress(json!({
                "botId": bot_id,
                "total": total,
                "sent": sent,
                "failed": failed,
                "completed": idx + 1 == total,
            })));
        }

        sup.push_log(
            "info",
            Some(&bot_id),
            "broadcast",
            format!("Hoàn tất Broadcast: thành công {sent}/{total} nhóm (lỗi: {failed})."),
        );
    });

    ok(
        &ctx,
        json!({
            "started": true,
            "total": total,
            "delayMs": delay_ms,
            "message": format!("Đang gửi giãn cách an toàn tới {total} nhóm..."),
        }),
    )
}

pub async fn api_bot_remote_execute_command(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if st.is_node_hybrid() {
        let raw_cmd = body
            .get("commandLine")
            .or_else(|| body.get("text"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if raw_cmd.is_empty() {
            return err(
                StatusCode::BAD_REQUEST,
                &ctx,
                "EMPTY_COMMAND",
                "Vui lòng nhập lệnh cần thực thi.",
            );
        }
        let deliver_to_zalo = body
            .get("deliverToZalo")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        return match st.bridge.execute_command_console(&id, raw_cmd, deliver_to_zalo).await {
            Ok(val) => {
                let data = val.get("data").cloned().unwrap_or(val);
                ok(&ctx, data)
            }
            Err(e) => err(
                StatusCode::SERVICE_UNAVAILABLE,
                &ctx,
                "BRIDGE_EXECUTION_FAILED",
                format!("Node hybrid console execution error: {e}"),
            ),
        };
    }

    let Ok(Some(bot)) = st.supervisor.caches().engine().get_bot(&id) else {
        return err(StatusCode::NOT_FOUND, &ctx, "BOT_NOT_FOUND", "Không tìm thấy Bot.");
    };

    let raw_cmd = body
        .get("commandLine")
        .or_else(|| body.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if raw_cmd.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "EMPTY_COMMAND",
            "Vui lòng nhập lệnh cần thực thi.",
        );
    }

    let prefix = if bot.prefix.trim().is_empty() {
        "!"
    } else {
        bot.prefix.trim()
    };
    let full_text = if raw_cmd.starts_with(prefix) {
        raw_cmd.to_string()
    } else {
        format!("{prefix}{raw_cmd}")
    };

    let parsed_inv = st
        .supervisor
        .dispatcher()
        .studio()
        .registry()
        .parse_prefixed_line(&full_text, prefix);

    let live_zalo = st.supervisor.get_live_zalo_session(&bot.bot_key);
    let ws_ready = st.supervisor.is_bot_ws_ready(&bot.bot_key);
    let is_live = live_zalo.is_some() && ws_ready;

    if !is_live {
        if let Some(inv) = parsed_inv {
            let spec = inv.handler.spec();
            let offline_notice = format!(
                "\n\n⚠️ Lưu ý: Bot '{}' hiện đang Ngoại tuyến (chưa đăng nhập QR Zalo hoặc WebSocket chưa sẵn sàng), nên chỉ kiểm tra cú pháp trên Console. Hãy kết nối Bot để chạy thật!",
                bot.bot_key
            );
            let reply_text = format!(
                "[Kiểm tra cú pháp Offline] Lệnh `{}` (Làn: {:?}, Phạm vi: {:?}) hợp lệ với cú pháp `{}`.{}",
                spec.name, spec.lane, spec.scope, full_text, offline_notice
            );
            return ok(
                &ctx,
                json!({
                    "parsed": true,
                    "executed": false,
                    "outcome": "syntax_check",
                    "commandLine": full_text,
                    "replyText": reply_text,
                    "outputs": [reply_text.clone()],
                    "deliveryAttempted": false,
                    "deliveredToZalo": false,
                    "deliveryError": None::<String>,
                    "matchedCommand": {
                        "name": spec.name,
                        "aliases": spec.aliases,
                        "executionLane": format!("{:?}", spec.lane),
                        "scope": format!("{:?}", spec.scope),
                    }
                }),
            );
        } else {
            let reply_text = format!(
                "❌ Không tìm thấy lệnh tương ứng với `{full_text}` trong danh mục lệnh. Hãy kiểm tra lại tên lệnh hoặc gõ {prefix}help!"
            );
            return ok(
                &ctx,
                json!({
                    "parsed": false,
                    "executed": false,
                    "outcome": "not_found",
                    "commandLine": full_text,
                    "replyText": reply_text,
                    "outputs": [reply_text.clone()],
                    "deliveryAttempted": false,
                    "deliveredToZalo": false,
                    "deliveryError": None::<String>,
                    "matchedCommand": null,
                }),
            );
        }
    }

    let thread_id = body
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("web_remote_console");

    let is_console_thread = thread_id == "web_remote_console";

    let deliver_to_zalo = body
        .get("deliverToZalo")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !is_console_thread;

    let explicit_private = body
        .get("threadType")
        .and_then(Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("user") || t.eq_ignore_ascii_case("private"));

    let is_group_scope = parsed_inv
        .as_ref()
        .is_some_and(|inv| inv.handler.spec().scope == mybot_types::ChatScope::Group);

    let is_private_scope = parsed_inv
        .as_ref()
        .is_some_and(|inv| inv.handler.spec().scope == mybot_types::ChatScope::Private);

    if is_group_scope && is_console_thread {
        return err(
            StatusCode::BAD_REQUEST,
            &ctx,
            "GROUP_REQUIRED",
            format!(
                "Lệnh `{}` yêu cầu ngữ cảnh nhóm. Vui lòng chọn một nhóm Zalo (Thread ID) hợp lệ để thực thi.",
                parsed_inv.as_ref().map(|i| i.handler.spec().name).unwrap_or("này")
            ),
        );
    }

    let resolved_thread_type = if explicit_private || is_private_scope {
        ThreadType::User
    } else {
        ThreadType::Group
    };

    if resolved_thread_type == ThreadType::Group && !is_console_thread {
        if let Some(ref zalo) = live_zalo {
            if let Ok(info) = zalo.get_group_info(&[ZaloId::new(thread_id)]).await {
                let in_group = info
                    .get("gridInfoMap")
                    .and_then(Value::as_object)
                    .map(|m| m.contains_key(thread_id))
                    .unwrap_or(true);
                if !in_group {
                    return err(
                        StatusCode::BAD_REQUEST,
                        &ctx,
                        "BOT_NOT_IN_GROUP",
                        format!("Bot hiện không còn ở trong nhóm `{thread_id}`."),
                    );
                }
            }
        }
    }

    let msg = InboundMessage {
        bot_key: bot.bot_key.clone().into(),
        msg_id: ZaloId::new(format!("web_{}", uuid::Uuid::new_v4().simple())),
        cli_msg_id: ZaloId::default(),
        global_msg_id: ZaloId::default(),
        thread_id: ZaloId::new(thread_id),
        thread_type: resolved_thread_type,
        sender_uid: if bot.uid.is_empty() {
            ZaloId::new("web_admin")
        } else {
            bot.uid.clone()
        },
        sender_name: "Web Admin".to_string(),
        is_self: false,
        msg_type: "webchat".into(),
        timestamp_ms: Utc::now().timestamp_millis(),
        ws_received_at_ms: Utc::now().timestamp_millis(),
        ttl_ms: 0,
        mentions: Vec::new(),
        styles: Vec::new(),
        quote: None,
        content: MessageContent::Text {
            text: full_text.clone(),
        },
        source: EventSource::WebAdminConsole,
        raw_property_ext: None,
    };

    let captured_outbound = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let fleet_ctrl: Arc<dyn BotFleetController> = Arc::new(st.supervisor.clone());
    let style_profile = BotStyleProfile::from_bot_metadata(&bot.metadata, Some(&bot.display_name));

    let meta = BotExecutionMeta {
        bot_key: bot.bot_key.clone(),
        is_main_bot: bot.is_main,
        self_uid: bot.uid.clone(),
        prefix: prefix.to_string(),
        self_listen: true,
        identity_pending: false,
        sender_tier: PermissionTier::AdminLevelHigh,
        zalo: if deliver_to_zalo { live_zalo.clone() } else { None },
        assets_root: st.supervisor.config().assets_root.clone(),
        style_profile,
        fleet: Some(fleet_ctrl),
        outbound_sink: Some(Arc::clone(&captured_outbound)),
        ..Default::default()
    };

    let report = st.supervisor.dispatcher().dispatch_inbound(meta, msg).await;
    let sink_texts: Vec<String> = captured_outbound
        .lock()
        .iter()
        .map(|o| o.text.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let combined_sink = (!sink_texts.is_empty()).then(|| sink_texts.join("\n\n"));

    let (executed, outcome_str, delivery_err) = match &report {
        DispatchReport::CommandExecuted {
            command_name: _,
            outcome,
            delivery_error,
        } => match outcome {
            CommandOutcome::Handled { .. } => (
                delivery_error.is_none(),
                if delivery_error.is_some() { "delivery_failed" } else { "handled" },
                delivery_error.clone(),
            ),
            CommandOutcome::Accepted { .. } => (true, "accepted", delivery_error.clone()),
            CommandOutcome::Denied { .. } => (false, "denied", delivery_error.clone()),
        },
        DispatchReport::CommandFailed { .. } => (false, "failed", None),
        DispatchReport::Ignored { .. } => (false, "ignored", None),
        DispatchReport::PassiveMessage => (false, "not_found", None),
        _ => (false, "unknown", None),
    };

    let reply_text = match &report {
        DispatchReport::CommandExecuted {
            command_name,
            outcome,
            delivery_error,
        } => match outcome {
            CommandOutcome::Handled {
                summary,
                reply_text,
                ..
            } => {
                if let Some(err) = delivery_error {
                    let fail_base = reply_text
                        .clone()
                        .or_else(|| combined_sink.clone())
                        .unwrap_or_else(|| summary.clone());
                    format!("⚠️ Giao tin Zalo thất bại cho `{command_name}`: {err}\n\nNội dung dự kiến: {fail_base}")
                } else {
                    let base = reply_text
                        .clone()
                        .or_else(|| combined_sink.clone())
                        .unwrap_or_else(|| format!("✅ Lệnh `{command_name}` đã hoàn tất ({summary})."));
                    if deliver_to_zalo {
                        format!("{base}\n\n📨 Đã chuyển tiếp thành công đến Zalo (Thread: `{thread_id}`).")
                    } else {
                        base
                    }
                }
            }
            CommandOutcome::Accepted { job_id, lane } => {
                format!("⏳ Đã xếp hàng lệnh `{command_name}` vào làn {lane:?} (Job: {job_id}).")
            }
            CommandOutcome::Denied {
                reason_code,
                message,
            } => combined_sink.clone().unwrap_or_else(|| {
                format!("⛔ Lệnh `{command_name}` bị từ chối [{reason_code}]: {message}")
            }),
        },
        DispatchReport::CommandFailed {
            command_name,
            error,
        } => combined_sink.clone().unwrap_or_else(|| format!("⚠️ Lệnh `{command_name}` báo lỗi: {error}")),
        DispatchReport::Ignored { reason_code, detail } => combined_sink.clone().unwrap_or_else(|| {
            format!("ℹ️ Lệnh bị bỏ qua [{reason_code}]: {detail}")
        }),
        DispatchReport::PassiveMessage => combined_sink.clone().unwrap_or_else(|| {
            format!("⚠️ Không tìm thấy lệnh `{full_text}`. Hãy gõ {prefix}help để xem danh sách lệnh!")
        }),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };

    let mut outputs = sink_texts;
    if outputs.is_empty() && !reply_text.is_empty() {
        outputs.push(reply_text.clone());
    }

    let delivered_to_zalo = deliver_to_zalo && executed && delivery_err.is_none();

    ok(
        &ctx,
        json!({
            "parsed": parsed_inv.is_some(),
            "executed": executed,
            "outcome": outcome_str,
            "commandLine": full_text,
            "replyText": reply_text,
            "outputs": outputs,
            "deliveryAttempted": deliver_to_zalo,
            "deliveredToZalo": delivered_to_zalo,
            "deliveryError": delivery_err,
            "report": report,
        }),
    )
}

// =============================================================================
// System Doctor, V3 -> V4 1-Click Sync & Safe Backup Download
// =============================================================================

pub async fn api_system_doctor(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let bots = st
        .supervisor
        .caches()
        .engine()
        .list_bots()
        .unwrap_or_default();
    let main_bot = bots.iter().find(|b| b.is_main);
    let dead_bots: Vec<&str> = bots
        .iter()
        .filter(|b| b.cookie_dead)
        .map(|b| b.bot_key.as_str())
        .collect();
    let (rss_bytes, cpu_pct) = st.supervisor.process_resource_usage();

    ok(
        &ctx,
        json!({
            "healthy": main_bot.is_some_and(|b| !b.cookie_dead),
            "engine": "mybot-v4-pure-rust",
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "databasePath": st.supervisor.caches().engine().db_path().to_string_lossy(),
            "commandsRegistered": st.supervisor.dispatcher().studio().registry().canonical_count(),
            "totalBots": bots.len(),
            "deadCookieBots": dead_bots,
            "adminBot": main_bot.map(BotRecord::to_redacted_summary),
            "rssBytes": rss_bytes,
            "cpuPercent": cpu_pct,
            "checkedAt": Utc::now().to_rfc3339(),
        }),
    )
}

pub async fn api_system_migrate_v3(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let root = st.auth.config().project_root.clone();
    let engine = st.supervisor.caches().engine();
    match migrate_v3_directory(&root, engine, false) {
        Ok(report) => {
            let _ = st.supervisor.restore_all_from_storage().await;
            ok(
                &ctx,
                json!({
                    "migrated": true,
                    "message": format!(
                        "Đã đồng bộ {} Bot và {} cấu hình nhóm từ thư mục V3!",
                        report.bots_migrated, report.group_settings_migrated
                    ),
                    "report": report,
                }),
            )
        }
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "MIGRATION_FAILED",
            e.to_string(),
        ),
    }
}

pub async fn api_system_backup_download(
    State(st): State<DashboardState>,
    Extension(ctx): Extension<RequestContext>,
) -> Response {
    let _ = st.supervisor.caches().flush_all_sync();
    match st.supervisor.caches().engine().export_redacted_backup_json() {
        Ok(snapshot) => ok(&ctx, snapshot),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &ctx,
            "BACKUP_FAILED",
            e.to_string(),
        ),
    }
}
