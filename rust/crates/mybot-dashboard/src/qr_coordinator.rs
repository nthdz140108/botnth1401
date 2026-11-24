//! Live Web QR Login & Admin Liferaft Recovery Coordinator (`QrSessionCoordinator`).
//!
//! Bridges Web Dashboard `/api/system/admin-recovery/*` and `/api/bots/{id}/actions/qr-login`
//! directly to `zalo_sdk::qr_login::authenticate_zalo_qr` with:
//! - Live QR image + countdown updates over REST and Socket.IO (`dashboard:admin_recovery`)
//! - 60-second **UID Mismatch Protection Guard** (`uid_mismatch_confirm`) when a different Zalo
//!   account scans the Admin QR without `allowAccountChange = true`
//! - Automatic SQLite credential persistence + `FleetSupervisor` hot-reload/restart upon completion.

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, Utc};
use dashmap::DashMap;
use mybot_core::{FleetSupervisor, SupervisorEvent};
use mybot_storage::BotRecord;
use mybot_types::{DEFAULT_ZALO_USER_AGENT, ExpiryPolicy, ZaloId};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zalo_sdk::qr_login::{
    QrLoginOptions, QrLoginOutcome, QrLoginPhase, authenticate_zalo_qr,
};

struct PendingAdminSwap {
    admin_bot_key: String,
    previous_uid: String,
    outcome: QrLoginOutcome,
    expires_at: Instant,
    expires_at_iso: String,
}

#[derive(Clone)]
pub struct QrSessionCoordinator {
    supervisor: FleetSupervisor,
    admin_state: Arc<Mutex<Value>>,
    admin_cancel: Arc<Mutex<Option<CancellationToken>>>,
    pending_swap: Arc<Mutex<Option<PendingAdminSwap>>>,
    bot_qr_states: Arc<DashMap<String, Value>>,
    bot_qr_cancels: Arc<DashMap<String, CancellationToken>>,
    qr_options_override: Arc<Mutex<Option<QrLoginOptions>>>,
}

impl QrSessionCoordinator {
    pub fn new(supervisor: FleetSupervisor, bot_qr_states: Arc<DashMap<String, Value>>) -> Self {
        Self {
            supervisor,
            admin_state: Arc::new(Mutex::new(json!({ "state": "idle" }))),
            admin_cancel: Arc::new(Mutex::new(None)),
            pending_swap: Arc::new(Mutex::new(None)),
            bot_qr_states,
            bot_qr_cancels: Arc::new(DashMap::new()),
            qr_options_override: Arc::new(Mutex::new(None)),
        }
    }

    /// Allows integration tests to redirect QR login calls to an in-process mock HTTP server.
    pub fn set_qr_options_override(&self, opts: Option<QrLoginOptions>) {
        *self.qr_options_override.lock() = opts;
    }

    fn effective_qr_options(&self) -> QrLoginOptions {
        if let Some(custom) = self.qr_options_override.lock().clone() {
            return custom;
        }
        let mut opts = QrLoginOptions::default();
        if let Ok(mock_base) = std::env::var("MYBOT_QR_MOCK_BASE_URL")
            && !mock_base.trim().is_empty()
        {
            let trimmed = mock_base.trim_end_matches('/').to_string();
            opts.id_base_url = trimmed.clone();
            opts.web_base_url = trimmed.clone();
            opts.user_info_url = format!("{trimmed}/jr/userinfo");
        }
        opts
    }

    pub fn get_admin_recovery_status(&self) -> Value {
        // Auto-expire stale 60s UID mismatch confirmation if deadline elapsed
        {
            let mut swap_guard = self.pending_swap.lock();
            if let Some(pending) = swap_guard.as_ref()
                && Instant::now() >= pending.expires_at
            {
                *swap_guard = None;
                let expired = json!({
                    "state": "expired",
                    "message": "Đã hết 60 giây chờ xác nhận đổi tài khoản Zalo Admin. Vui lòng quét lại mã QR.",
                    "updatedAt": Utc::now().to_rfc3339(),
                });
                *self.admin_state.lock() = expired.clone();
                return expired;
            }
        }
        self.admin_state.lock().clone()
    }

    fn publish_admin_state(&self, payload: Value) {
        *self.admin_state.lock() = payload.clone();
        self.supervisor
            .emit_custom_event(SupervisorEvent::AdminRecovery(payload));
    }

    pub fn cancel_admin_recovery(&self) -> Value {
        if let Some(tok) = self.admin_cancel.lock().take() {
            tok.cancel();
        }
        *self.pending_swap.lock() = None;
        let payload = json!({
            "state": "cancelled",
            "message": "Đã hủy phiên quét QR khôi phục Admin.",
            "updatedAt": Utc::now().to_rfc3339(),
        });
        self.publish_admin_state(payload.clone());
        payload
    }

    pub async fn start_admin_recovery(&self, allow_account_change: bool) -> Value {
        if let Some(prev_tok) = self.admin_cancel.lock().take() {
            prev_tok.cancel();
        }
        *self.pending_swap.lock() = None;

        let admin_bot = self
            .supervisor
            .ensure_admin_bot_seeded()
            .unwrap_or_else(|_| fallback_admin_record());
        let admin_key = admin_bot.bot_key.clone();
        let prev_uid = admin_bot.uid.as_str().to_string();

        let session_id = format!("adm_qr_{}", uuid::Uuid::new_v4().simple());
        let cancel = CancellationToken::new();
        *self.admin_cancel.lock() = Some(cancel.clone());

        let initial = json!({
            "sessionId": session_id,
            "botId": admin_key,
            "state": "starting",
            "allowAccountChange": allow_account_change,
            "message": "Đang kết nối cổng đăng nhập Zalo để lấy mã QR...",
            "startedAt": Utc::now().to_rfc3339(),
        });
        self.publish_admin_state(initial.clone());

        let coord = self.clone();
        let opts = self.effective_qr_options();

        tokio::spawn(async move {
            let sid = session_id.clone();
            let bkey = admin_key.clone();
            let coord_phase = coord.clone();

            let res = authenticate_zalo_qr(
                opts,
                move |phase| {
                    let next = match phase {
                        QrLoginPhase::Initializing => json!({
                            "sessionId": sid,
                            "botId": bkey,
                            "state": "starting",
                            "message": "Đang khởi tạo phiên xác thực Zalo...",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }),
                        QrLoginPhase::GeneratingQr => json!({
                            "sessionId": sid,
                            "botId": bkey,
                            "state": "generating",
                            "message": "Đang tạo ảnh mã QR...",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }),
                        QrLoginPhase::QrReady {
                            code,
                            qr_data_url,
                            expires_in_secs,
                        } => {
                            let exp_iso = (Utc::now()
                                + ChronoDuration::seconds(expires_in_secs as i64))
                            .to_rfc3339();
                            let formatted_url = if qr_data_url.starts_with("data:image/") {
                                qr_data_url
                            } else {
                                format!("data:image/png;base64,{qr_data_url}")
                            };
                            json!({
                                "sessionId": sid,
                                "botId": bkey,
                                "code": code,
                                "state": "waiting_scan",
                                "qrDataUrl": formatted_url,
                                "qrImage": formatted_url,
                                "expiresAt": exp_iso,
                                "message": "Mở Zalo trên điện thoại và quét mã QR trên màn hình",
                                "updatedAt": Utc::now().to_rfc3339(),
                            })
                        }
                        QrLoginPhase::WaitingScan => {
                            let mut curr = coord_phase.admin_state.lock().clone();
                            if let Some(obj) = curr.as_object_mut() {
                                obj.insert("state".into(), json!("waiting_scan"));
                                obj.insert("updatedAt".into(), json!(Utc::now().to_rfc3339()));
                            }
                            curr
                        }
                        QrLoginPhase::WaitingConfirm => {
                            let mut curr = coord_phase.admin_state.lock().clone();
                            if let Some(obj) = curr.as_object_mut() {
                                obj.insert("state".into(), json!("scanned_waiting_confirm"));
                                obj.insert(
                                    "message".into(),
                                    json!("Đã quét mã QR! Hãy bấm 'Xác nhận đăng nhập' trên điện thoại..."),
                                );
                                obj.insert("updatedAt".into(), json!(Utc::now().to_rfc3339()));
                            }
                            curr
                        }
                        QrLoginPhase::Completed => json!({
                            "sessionId": sid,
                            "botId": bkey,
                            "state": "saving",
                            "message": "Đang lưu Cookie mới và khởi động lại Bot Admin...",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }),
                    };
                    coord_phase.publish_admin_state(next);
                },
                cancel,
            )
            .await;

            match res {
                Ok(outcome) => {
                    let has_prev_real_uid = !prev_uid.is_empty()
                        && prev_uid != "admin"
                        && prev_uid != "main"
                        && prev_uid != "unconfigured";
                    let uid_differs = has_prev_real_uid
                        && !outcome.uid.is_empty()
                        && outcome.uid != prev_uid;

                    if uid_differs && !allow_account_change {
                        let exp_instant = Instant::now() + Duration::from_secs(60);
                        let exp_iso = (Utc::now() + ChronoDuration::seconds(60)).to_rfc3339();
                        let scanned_uid = outcome.uid.clone();
                        let scanned_name = outcome.display_name.clone();
                        let scanned_avatar = outcome.avatar.clone();

                        *coord.pending_swap.lock() = Some(PendingAdminSwap {
                            admin_bot_key: admin_key.clone(),
                            previous_uid: prev_uid.clone(),
                            outcome,
                            expires_at: exp_instant,
                            expires_at_iso: exp_iso.clone(),
                        });

                        coord.publish_admin_state(json!({
                            "sessionId": session_id,
                            "botId": admin_key,
                            "state": "uid_mismatch_confirm",
                            "previousUid": prev_uid,
                            "scannedUid": scanned_uid,
                            "scannedDisplayName": scanned_name,
                            "scannedAvatar": scanned_avatar,
                            "confirmExpiresAt": exp_iso,
                            "message": "Tài khoản Zalo vừa quét khác với Admin cũ — Vui lòng xác nhận đổi tài khoản trong 60 giây.",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }));
                        return;
                    }

                    coord
                        .commit_admin_outcome(&admin_key, outcome, &session_id)
                        .await;
                }
                Err(err) => {
                    let msg = err.to_string();
                    let st_name = if msg.contains("cancelled") {
                        "cancelled"
                    } else if msg.contains("expired") {
                        "expired"
                    } else {
                        "failed"
                    };
                    coord.publish_admin_state(json!({
                        "sessionId": session_id,
                        "botId": admin_key,
                        "state": st_name,
                        "error": msg,
                        "message": "Phiên quét mã QR không thành công.",
                        "updatedAt": Utc::now().to_rfc3339(),
                    }));
                }
            }
        });

        initial
    }

    pub async fn confirm_admin_swap(&self) -> Result<Value, (axum::http::StatusCode, &'static str, String)> {
        let pending = {
            let mut guard = self.pending_swap.lock();
            guard.take()
        };
        let Some(p) = pending else {
            return Err((
                axum::http::StatusCode::CONFLICT,
                "NO_PENDING_SWAP",
                "Không có phiên xác nhận đổi tài khoản Admin nào đang chờ hoặc đã quá 60 giây.".into(),
            ));
        };
        if Instant::now() >= p.expires_at {
            return Err((
                axum::http::StatusCode::GONE,
                "SWAP_CONFIRMATION_EXPIRED",
                format!("Phiên xác nhận đã hết hạn lúc {}. Vui lòng quét lại mã QR.", p.expires_at_iso),
            ));
        }

        let _ = self.supervisor.caches().engine().append_audit_log(
            "dashboard",
            "admin.qr_uid_swap_confirmed",
            &p.admin_bot_key,
            &json!({
                "previousUid": p.previous_uid,
                "newUid": p.outcome.uid,
            }),
        );

        let done = self
            .commit_admin_outcome(&p.admin_bot_key, p.outcome, "confirmed_swap")
            .await;
        Ok(done)
    }

    async fn commit_admin_outcome(
        &self,
        admin_bot_key: &str,
        outcome: QrLoginOutcome,
        session_id: &str,
    ) -> Value {
        let engine = self.supervisor.caches().engine();
        let mut bot = engine
            .get_bot(admin_bot_key)
            .ok()
            .flatten()
            .unwrap_or_else(fallback_admin_record);

        if !outcome.uid.is_empty() {
            bot.uid = ZaloId::new(&outcome.uid);
        }
        if !outcome.display_name.trim().is_empty() {
            bot.display_name = outcome.display_name.trim().to_string();
        }
        if !outcome.avatar.trim().is_empty() {
            bot.avatar = outcome.avatar.trim().to_string();
        }
        bot.is_main = true;
        bot.self_listen = true;
        bot.cookie_json = outcome.credentials.cookie;
        bot.imei = outcome.credentials.imei;
        bot.user_agent = outcome.credentials.user_agent;
        bot.cookie_dead = false;
        bot.cookie_dead_reason = None;
        bot.status = "running".to_string();
        bot.desired_status = "running".to_string();
        bot.updated_at = Utc::now().to_rfc3339();

        let _ = engine.upsert_bot(&bot);
        if !bot.uid.is_empty() {
            let _ = engine.upsert_bot_admin(
                &bot.bot_key,
                bot.uid.as_str(),
                "high",
                &bot.display_name,
            );
        }
        let _ = engine.promote_primary_bot(&bot.bot_key, "qr_admin_recovery");
        sync_node_admin_credentials(&bot);
        let _ = self.supervisor.restart_bot(&bot.bot_key).await;

        self.supervisor.push_log(
            "info",
            Some(&bot.bot_key),
            "qr-recovery",
            format!(
                "Khôi phục QR Bot Admin thành công: {} (UID: {})",
                bot.display_name, bot.uid
            ),
        );

        let completed = json!({
            "sessionId": session_id,
            "botId": bot.bot_key,
            "state": "completed",
            "uid": bot.uid.as_str(),
            "displayName": bot.display_name,
            "avatar": bot.avatar,
            "message": "Khôi phục Bot Admin thành công! Bot đã kết nối Online.",
            "completedAt": Utc::now().to_rfc3339(),
        });
        self.publish_admin_state(completed.clone());
        completed
    }

    // -------------------------------------------------------------------------
    // Per-Bot Remote Web QR Login (`/api/bots/{id}/actions/qr-login`)
    // -------------------------------------------------------------------------

    pub async fn start_bot_qr_login(
        &self,
        bot_key: &str,
        prefix: Option<String>,
        owner_uid: Option<String>,
        expiry_preset: Option<String>,
    ) -> Value {
        if let Some((_, prev_cancel)) = self.bot_qr_cancels.remove(bot_key) {
            prev_cancel.cancel();
        }
        let cancel = CancellationToken::new();
        self.bot_qr_cancels.insert(bot_key.to_string(), cancel.clone());

        let initial = json!({
            "botId": bot_key,
            "state": "starting",
            "message": "Đang khởi tạo mã QR Zalo...",
            "startedAt": Utc::now().to_rfc3339(),
        });
        self.bot_qr_states
            .insert(bot_key.to_string(), initial.clone());

        let coord = self.clone();
        let bkey = bot_key.to_string();
        let opts = self.effective_qr_options();

        tokio::spawn(async move {
            let states_map = Arc::clone(&coord.bot_qr_states);
            let bkey_phase = bkey.clone();

            let res = authenticate_zalo_qr(
                opts,
                move |phase| {
                    let entry = match phase {
                        QrLoginPhase::Initializing | QrLoginPhase::GeneratingQr => json!({
                            "botId": bkey_phase,
                            "state": "generating",
                            "message": "Đang sinh mã QR từ Zalo...",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }),
                        QrLoginPhase::QrReady {
                            code,
                            qr_data_url,
                            expires_in_secs,
                        } => {
                            let formatted = if qr_data_url.starts_with("data:image/") {
                                qr_data_url
                            } else {
                                format!("data:image/png;base64,{qr_data_url}")
                            };
                            json!({
                                "botId": bkey_phase,
                                "code": code,
                                "state": "waiting_scan",
                                "qrDataUrl": formatted,
                                "qrImage": formatted,
                                "expiresAt": (Utc::now() + ChronoDuration::seconds(expires_in_secs as i64)).to_rfc3339(),
                                "message": "Mở Zalo trên điện thoại để quét mã QR",
                                "updatedAt": Utc::now().to_rfc3339(),
                            })
                        }
                        QrLoginPhase::WaitingScan => {
                            let mut curr = states_map
                                .get(&bkey_phase)
                                .map(|v| v.value().clone())
                                .unwrap_or_else(|| json!({ "botId": bkey_phase }));
                            if let Some(obj) = curr.as_object_mut() {
                                obj.insert("state".into(), json!("waiting_scan"));
                            }
                            curr
                        }
                        QrLoginPhase::WaitingConfirm => {
                            let mut curr = states_map
                                .get(&bkey_phase)
                                .map(|v| v.value().clone())
                                .unwrap_or_else(|| json!({ "botId": bkey_phase }));
                            if let Some(obj) = curr.as_object_mut() {
                                obj.insert("state".into(), json!("scanned_waiting_confirm"));
                                obj.insert(
                                    "message".into(),
                                    json!("Đã quét mã! Bấm xác nhận đăng nhập trên điện thoại..."),
                                );
                            }
                            curr
                        }
                        QrLoginPhase::Completed => json!({
                            "botId": bkey_phase,
                            "state": "saving",
                            "message": "Đang nạp Cookie và bật Bot...",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }),
                    };
                    states_map.insert(bkey_phase.clone(), entry);
                },
                cancel,
            )
            .await;

            coord.bot_qr_cancels.remove(&bkey);
            match res {
                Ok(outcome) => {
                    let engine = coord.supervisor.caches().engine();
                    if let Ok(Some(mut bot)) = engine.get_bot(&bkey) {
                        if !outcome.uid.is_empty() {
                            bot.uid = ZaloId::new(&outcome.uid);
                        }
                        if !outcome.display_name.trim().is_empty() {
                            bot.display_name = outcome.display_name.trim().to_string();
                        }
                        if !outcome.avatar.trim().is_empty() {
                            bot.avatar = outcome.avatar.trim().to_string();
                        }
                        if let Some(pfx) = prefix.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                            bot.prefix = pfx.to_string();
                        }
                        if let Some(ouid) = owner_uid.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                            bot.owner_uid = Some(ouid.to_string());
                        }
                        if let Some(preset) = expiry_preset.as_deref()
                            && let Some(policy) = parse_expiry_preset(preset)
                        {
                            bot.expiry_policy = policy;
                        }
                        bot.self_listen = true;
                        bot.cookie_json = outcome.credentials.cookie;
                        bot.imei = outcome.credentials.imei;
                        bot.user_agent = outcome.credentials.user_agent;
                        bot.cookie_dead = false;
                        bot.cookie_dead_reason = None;
                        bot.status = "stopped".to_string();
                        bot.desired_status = "stopped".to_string();
                        bot.trial_status = Some("pending".to_string());
                        bot.updated_at = Utc::now().to_rfc3339();
                        let _ = engine.upsert_bot(&bot);
                        if !bot.uid.is_empty() {
                            let _ = engine.upsert_bot_admin(
                                &bot.bot_key,
                                bot.uid.as_str(),
                                "high",
                                &bot.display_name,
                            );
                        }

                        coord.bot_qr_states.insert(
                            bkey.clone(),
                            json!({
                                "botId": bot.bot_key,
                                "state": "completed",
                                "uid": bot.uid.as_str(),
                                "displayName": bot.display_name,
                                "avatar": bot.avatar,
                                "message": "Quét mã QR thành công! Thông tin đăng nhập đã được lưu. Sẵn sàng kích hoạt.",
                                "completedAt": Utc::now().to_rfc3339(),
                            }),
                        );
                    }
                }
                Err(err) => {
                    coord.bot_qr_states.insert(
                        bkey.clone(),
                        json!({
                            "botId": bkey,
                            "state": "failed",
                            "error": err.to_string(),
                            "message": "Phiên quét QR kết thúc hoặc hết hạn.",
                            "updatedAt": Utc::now().to_rfc3339(),
                        }),
                    );
                }
            }
        });

        initial
    }

    pub fn cancel_bot_qr_login(&self, bot_key: &str) -> bool {
        let had = if let Some((_, tok)) = self.bot_qr_cancels.remove(bot_key) {
            tok.cancel();
            true
        } else {
            false
        };
        let existed = self.bot_qr_states.remove(bot_key).is_some();
        had || existed
    }
}

pub fn parse_expiry_preset(preset: &str) -> Option<ExpiryPolicy> {
    let now = Utc::now();
    match preset.trim().to_ascii_lowercase().as_str() {
        "permanent" | "never" | "-1" | "forever" => Some(ExpiryPolicy::Permanent),
        "1h" | "+1h" => Some(ExpiryPolicy::At(now + ChronoDuration::hours(1))),
        "1d" | "+1d" | "24h" => Some(ExpiryPolicy::At(now + ChronoDuration::days(1))),
        "7d" | "+7d" => Some(ExpiryPolicy::At(now + ChronoDuration::days(7))),
        "30d" | "+30d" => Some(ExpiryPolicy::At(now + ChronoDuration::days(30))),
        other => chrono::DateTime::parse_from_rfc3339(other)
            .ok()
            .map(|dt| ExpiryPolicy::At(dt.with_timezone(&Utc))),
    }
}

fn fallback_admin_record() -> BotRecord {
    let now = Utc::now().to_rfc3339();
    BotRecord {
        bot_key: "admin".to_string(),
        uid: ZaloId::new("admin"),
        global_uid: None,
        canonical_username: None,
        display_name: "Bot Admin Chính".to_string(),
        avatar: String::new(),
        is_main: true,
        owner_uid: None,
        status: "cookie_dead".to_string(),
        desired_status: "running".to_string(),
        expiry_policy: ExpiryPolicy::Permanent,
        trial_status: None,
        cookie_json: json!({}),
        imei: String::new(),
        user_agent: DEFAULT_ZALO_USER_AGENT.to_string(),
        proxy_url: None,
        cookie_dead: true,
        cookie_dead_reason: Some("Chưa đăng nhập QR Admin".to_string()),
        prefix: "!".to_string(),
        self_listen: true,
        identity_pending: false,
        admin_identity_seeds: Vec::new(),
        metadata: json!({}),
        created_at: now.clone(),
        updated_at: now,
    }
}

pub fn sync_node_admin_credentials(bot: &BotRecord) {
    let project_root = std::env::var("MYBOT_PROJECT_ROOT")
        .or_else(|_| std::env::var("PROJECT_ROOT"))
        .unwrap_or_else(|_| "/opt/mybot".into());

    let root_path = std::path::Path::new(&project_root);
    let cfg_path = root_path.join("assets").join("config.json");
    if cfg_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&cfg_path) {
            if let Ok(mut json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = json_val.as_object_mut() {
                    obj.insert("cookie".into(), bot.cookie_json.clone());
                    obj.insert("imei".into(), serde_json::Value::String(bot.imei.clone()));
                    obj.insert("userAgent".into(), serde_json::Value::String(bot.user_agent.clone()));
                    if !bot.uid.is_empty() {
                        obj.insert("uid".into(), serde_json::Value::String(bot.uid.as_str().to_string()));
                    }
                    if !bot.display_name.is_empty() {
                        obj.insert("name".into(), serde_json::Value::String(bot.display_name.clone()));
                    }
                    if !bot.avatar.is_empty() {
                        obj.insert("avatar".into(), serde_json::Value::String(bot.avatar.clone()));
                    }
                }
                let _ = std::fs::write(&cfg_path, serde_json::to_string_pretty(&json_val).unwrap_or_default());
            }
        }
    }

    let state_dir = root_path.join("mybot").join("state");
    let _ = std::fs::create_dir_all(&state_dir);
    let state_path = state_dir.join("admin.json");
    let mut state_map = serde_json::Map::new();
    if let Ok(content) = std::fs::read_to_string(&state_path) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(obj) = parsed.as_object() {
                state_map = obj.clone();
            }
        }
    }
    state_map.insert("id".into(), serde_json::Value::String("admin".into()));
    state_map.insert("uid".into(), serde_json::Value::String(bot.uid.as_str().to_string()));
    state_map.insert("name".into(), serde_json::Value::String(bot.display_name.clone()));
    state_map.insert("isMain".into(), serde_json::Value::Bool(true));
    state_map.insert("status".into(), serde_json::Value::String("running".into()));
    state_map.insert("cookie".into(), bot.cookie_json.clone());
    state_map.insert("imei".into(), serde_json::Value::String(bot.imei.clone()));
    state_map.insert("userAgent".into(), serde_json::Value::String(bot.user_agent.clone()));
    state_map.insert("cookieDead".into(), serde_json::Value::Bool(false));
    state_map.remove("cookieDeadAt");
    state_map.remove("cookieDeadReason");
    state_map.insert("connected".into(), serde_json::Value::Bool(true));
    let _ = std::fs::write(&state_path, serde_json::to_string_pretty(&serde_json::Value::Object(state_map)).unwrap_or_default());

    let _ = std::process::Command::new("pm2")
        .args(["restart", "admin"])
        .output();
}
