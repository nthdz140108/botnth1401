//! Single-Process Multi-Bot Actor Supervisor (`FleetSupervisor`), Cross-Session Zalo UID
//! Isolation (`identity_pending` fail-closed mode), Zero-Network Cross-Bot Command Relay,
//! 60s SaaS Trial Reaper, and 24-Slot `:05` `SendTask` Scheduler (`Asia/Ho_Chi_Minh`).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Datelike, Duration as ChronoDuration, Timelike, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use dashmap::DashMap;
use hmac::{Hmac, Mac};
use mybot_storage::{BotRecord, HotStorageCaches, StorageError, TrialLedgerRow};
use mybot_types::{
    BotStatusV2, EventSource, ExpiryPolicy, GroupEventType, InboundMessage, PermissionTier,
    ThreadType, UndoEvent, ZaloId,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zalo_sdk::{OutboundMessage, WsListenerConfig, ZaloApiError, ZaloSession, ZaloWsEvent, ZaloWsListener};

fn dispatch_session(
    slot: &Arc<parking_lot::RwLock<Option<Arc<ZaloSession>>>>,
    connect_live_zalo: bool,
) -> Result<Option<Arc<ZaloSession>>, &'static str> {
    if !connect_live_zalo {
        return Ok(None);
    }
    slot.read().clone().map(Some).ok_or("LIVE_SESSION_MISSING")
}

fn reuse_existing_actor(status: BotStatusV2, finished: bool, cancelled: bool) -> bool {
    !finished
        && !cancelled
        && matches!(
            status,
            BotStatusV2::Running
                | BotStatusV2::Starting
                | BotStatusV2::Recovering
                | BotStatusV2::ListenerDisconnected
        )
}

use crate::interaction::BotFleetController;
use crate::pipeline::{BotExecutionMeta, DispatchReport, FastPathDispatcher};
use crate::studio::CommandOutcome;
use crate::v3_style::BotStyleProfile;

type HmacSha256 = Hmac<Sha256>;

const MAX_LOG_RING: usize = 2000;
const INTERNAL_REPLAY_WINDOW_MS: i64 = 300_000;

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("bot `{0}` not found")]
    BotNotFound(String),
    #[error("bot `{0}` is not currently running")]
    BotNotRunning(String),
    #[error("bot `{0}` cannot start: {1}")]
    CannotStart(String, String),
    #[error("trial quota exhausted for ISO week `{0}`")]
    TrialAlreadyUsedThisWeek(String),
    #[error("actor channel closed for bot `{0}`")]
    ActorClosed(String),
}

#[cfg(test)]
mod live_session_tests {
    use super::*;
    use mybot_types::{CredentialsBundle, DEFAULT_ZALO_USER_AGENT};

    #[test]
    fn live_dispatch_uses_logged_in_session_and_rejects_missing_session() {
        let creds = CredentialsBundle {
            imei: "test-imei".into(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            cookie: json!("zpw_sek=abc"),
            language: "vi".into(),
            proxy_url: None,
        };
        let session = ZaloSession::new("bot-test", true, &creds, true).unwrap();
        let slot = Arc::new(parking_lot::RwLock::new(None));
        assert!(dispatch_session(&slot, true).is_err());
        *slot.write() = Some(Arc::clone(&session));
        let actual = dispatch_session(&slot, true).unwrap().unwrap();
        assert!(Arc::ptr_eq(&actual, &session));
        assert!(dispatch_session(&slot, false).unwrap().is_none());
    }

    #[test]
    fn reconnecting_actor_is_reused_instead_of_starting_second_socket() {
        assert!(reuse_existing_actor(BotStatusV2::Recovering, false, false));
        assert!(reuse_existing_actor(BotStatusV2::ListenerDisconnected, false, false));
        assert!(!reuse_existing_actor(BotStatusV2::Recovering, true, false));
        assert!(!reuse_existing_actor(BotStatusV2::Running, false, true));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLogEntry {
    pub id: u64,
    pub timestamp: String,
    pub level: String,
    pub bot_key: Option<String>,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum SupervisorEvent {
    StatusChanged {
        bot_key: String,
        status: BotStatusV2,
        reason: Option<String>,
        timestamp: String,
    },
    Log(DashboardLogEntry),
    MetricsTick {
        running_bots: usize,
        total_bots: usize,
        rss_bytes: u64,
        timestamp: String,
    },
    AdminAlert {
        bot_key: String,
        message: String,
        timestamp: String,
    },
    AdminRecovery(Value),
    BroadcastProgress(Value),
}

/// 4-state `SendTask` delivery outcome (`send-task.js` V3 parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SendTaskOutcome {
    Sent,
    SourceError,
    SourceEmpty,
    DeliveryError,
}

/// Pluggable content delivery hook for the 24-slot `:05` `SendTask` scheduler.
#[async_trait::async_trait]
pub trait SendTaskRunner: Send + Sync + 'static {
    async fn execute_slot_for_group(
        &self,
        bot_key: &str,
        thread_id: &ZaloId,
        slot_config: &Value,
        zalo: Option<Arc<ZaloSession>>,
    ) -> SendTaskOutcome;
}

#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub assets_root: PathBuf,
    pub connect_live_zalo: bool,
    pub internal_hmac_secret: String,
    pub sendtask_inter_group_delay: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            assets_root: PathBuf::from("assets"),
            connect_live_zalo: false,
            internal_hmac_secret: "mybot-v4-default-internal-secret".to_string(),
            sendtask_inter_group_delay: Duration::from_secs(20),
        }
    }
}

enum BotControlMsg {
    Inbound {
        msg: Box<InboundMessage>,
        group_admins: Vec<ZaloId>,
        reply_tx: Option<oneshot::Sender<DispatchReport>>,
    },
    Undo {
        undo: UndoEvent,
        reply_tx: Option<oneshot::Sender<Option<String>>>,
    },
    ReloadRecord(Box<BotRecord>),
    Stop {
        final_status: BotStatusV2,
        ack_tx: oneshot::Sender<()>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRuntimeSnapshot {
    pub bot_key: String,
    pub status: BotStatusV2,
    pub actor_running: bool,
    pub login_ready: bool,
    pub ws_connected: bool,
    pub ws_ready: bool,
    #[serde(skip)]
    pub started_at: Option<Instant>,
    pub started_at_iso: Option<String>,
    pub last_event_at: Option<String>,
    pub reconnect_attempts: u32,
    pub last_error: Option<String>,
    pub frames_received: u64,
    pub messages_decrypted: u64,
    pub messages_dispatched: u64,
    pub reply_delivery_errors: u64,
}

struct BotActorHandle {
    tx: mpsc::Sender<BotControlMsg>,
    status_rx: watch::Receiver<BotRuntimeSnapshot>,
    zalo_session: Arc<parking_lot::RwLock<Option<Arc<ZaloSession>>>>,
    cancel: CancellationToken,
    join_handle: JoinHandle<()>,
}

/// Computes HMAC-SHA256 signature (`hex(hmac_sha256(secret, "{timestamp_ms}.{raw_body}"))`)
/// for `/internal/command/execute` loopback compatibility.
pub fn sign_internal_payload(secret: &str, timestamp_ms: i64, body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key len");
    mac.update(timestamp_ms.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Verifies HMAC-SHA256 signature in constant time (`subtle::ConstantTimeEq`) within `±300s`.
pub fn verify_internal_signature(
    secret: &str,
    timestamp_ms: i64,
    body: &[u8],
    provided_hex: &str,
    now_ms: i64,
) -> bool {
    if secret.trim().is_empty() || (now_ms - timestamp_ms).abs() > INTERNAL_REPLAY_WINDOW_MS {
        return false;
    }
    let Ok(provided_bytes) = hex::decode(provided_hex.trim()) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key len");
    mac.update(timestamp_ms.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    let expected = mac.finalize().into_bytes();
    expected.as_slice().ct_eq(provided_bytes.as_slice()).into()
}

/// Current ISO-8601 week key (`"YYYY-Www"`) in `Asia/Ho_Chi_Minh`.
pub fn current_ict_iso_week_key(now: chrono::DateTime<Utc>) -> String {
    let ict = now.with_timezone(&Ho_Chi_Minh);
    let iso = ict.iso_week();
    format!("{:04}-W{:02}", iso.year(), iso.week())
}

#[derive(Clone)]
pub struct FleetSupervisor {
    caches: HotStorageCaches,
    dispatcher: FastPathDispatcher,
    cfg: SupervisorConfig,
    actors: Arc<DashMap<String, BotActorHandle>>,
    events_tx: broadcast::Sender<SupervisorEvent>,
    logs: Arc<Mutex<(u64, VecDeque<DashboardLogEntry>)>>,
    sendtask_runner: Option<Arc<dyn SendTaskRunner>>,
    boot_instant: Instant,
    root_cancel: CancellationToken,
}

impl FleetSupervisor {
    pub fn new(
        caches: HotStorageCaches,
        dispatcher: FastPathDispatcher,
        cfg: SupervisorConfig,
        sendtask_runner: Option<Arc<dyn SendTaskRunner>>,
    ) -> Self {
        let (events_tx, _) = broadcast::channel(1024);
        Self {
            caches,
            dispatcher,
            cfg,
            actors: Arc::new(DashMap::new()),
            events_tx,
            logs: Arc::new(Mutex::new((0, VecDeque::with_capacity(MAX_LOG_RING)))),
            sendtask_runner,
            boot_instant: Instant::now(),
            root_cancel: CancellationToken::new(),
        }
    }

    pub fn caches(&self) -> &HotStorageCaches {
        &self.caches
    }

    pub fn dispatcher(&self) -> &FastPathDispatcher {
        &self.dispatcher
    }

    pub fn config(&self) -> &SupervisorConfig {
        &self.cfg
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<SupervisorEvent> {
        self.events_tx.subscribe()
    }

    pub fn emit_custom_event(&self, event: SupervisorEvent) {
        let _ = self.events_tx.send(event);
    }

    pub fn get_live_zalo_session(&self, bot_key: &str) -> Option<Arc<ZaloSession>> {
        self.actors
            .get(bot_key)
            .and_then(|h| {
                let opt = h.zalo_session.read().clone();
                opt.filter(|sess| sess.is_logged_in())
            })
    }

    pub fn is_bot_ws_ready(&self, bot_key: &str) -> bool {
        self.actors
            .get(bot_key)
            .is_some_and(|h| h.status_rx.borrow().ws_ready)
    }

    /// Ensures an `is_main = true` Admin Bot record exists in SQLite even on a brand-new empty
    /// installation, so the Always-On Liferaft Dashboard can immediately offer QR Admin Recovery.
    pub fn ensure_admin_bot_seeded(&self) -> Result<BotRecord, SupervisorError> {
        let bots = self.caches.engine().list_bots()?;
        if let Some(mut existing_main) = bots.into_iter().find(|b| b.is_main) {
            if !existing_main.self_listen {
                existing_main.self_listen = true;
                existing_main.updated_at = Utc::now().to_rfc3339();
                let _ = self.caches.engine().upsert_bot(&existing_main);
            }
            return Ok(existing_main);
        }
        if let Some(mut by_key) = self.caches.engine().get_bot("admin")? {
            by_key.is_main = true;
            by_key.self_listen = true;
            by_key.updated_at = Utc::now().to_rfc3339();
            self.caches.engine().upsert_bot(&by_key)?;
            return Ok(by_key);
        }

        let seed_prefix = std::fs::read_to_string(self.cfg.assets_root.join("json-data/command.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("prefix").and_then(Value::as_str).map(|s| s.trim().to_string()))
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "!".to_string());

        let now = Utc::now().to_rfc3339();
        let seeded = BotRecord {
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
            user_agent: mybot_types::DEFAULT_ZALO_USER_AGENT.to_string(),
            proxy_url: None,
            cookie_dead: true,
            cookie_dead_reason: Some("Chưa đăng nhập mã QR Zalo cho Bot Admin".to_string()),
            prefix: seed_prefix,
            self_listen: true,
            identity_pending: false,
            admin_identity_seeds: Vec::new(),
            metadata: json!({}),
            created_at: now.clone(),
            updated_at: now,
        };
        self.caches.engine().upsert_bot(&seeded)?;
        let _ = self.caches.engine().promote_primary_bot("admin", "bootstrap");
        Ok(seeded)
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.root_cancel.clone()
    }

    pub fn push_log(
        &self,
        level: &str,
        bot_key: Option<&str>,
        source: &str,
        message: impl Into<String>,
    ) {
        let entry = {
            let mut guard = self.logs.lock();
            guard.0 += 1;
            let item = DashboardLogEntry {
                id: guard.0,
                timestamp: Utc::now().to_rfc3339(),
                level: level.to_string(),
                bot_key: bot_key.map(ToOwned::to_owned),
                source: source.to_string(),
                message: message.into(),
            };
            if guard.1.len() >= MAX_LOG_RING {
                guard.1.pop_front();
            }
            guard.1.push_back(item.clone());
            item
        };
        let _ = self.events_tx.send(SupervisorEvent::Log(entry));
    }

    pub fn recent_logs(
        &self,
        bot_filter: Option<&str>,
        level_filter: Option<&str>,
        limit: usize,
    ) -> Vec<DashboardLogEntry> {
        let guard = self.logs.lock();
        guard
            .1
            .iter()
            .rev()
            .filter(|e| {
                bot_filter.is_none_or(|bf| bf.is_empty() || e.bot_key.as_deref() == Some(bf))
                    && level_filter
                        .is_none_or(|lf| lf.is_empty() || e.level.eq_ignore_ascii_case(lf))
            })
            .take(limit.clamp(1, MAX_LOG_RING))
            .cloned()
            .collect()
    }

    // -------------------------------------------------------------------------
    // Cross-Session Zalo UID Isolation (`identity_pending` Fail-Closed Policy)
    // -------------------------------------------------------------------------

    /// Computes a sender's `PermissionTier` strictly scoped to `bot_key`'s own Zalo session!
    ///
    /// Security Invariant: When `bot.identity_pending == true`, external `owner_uid` and
    /// `bot_admins` grants are **fail-closed** (`All` / `AdminBox` only) so a stale UID from
    /// another bot's Zalo session can NEVER hijack Supreme Admin on a newly provisioned sub-bot.
    pub fn resolve_sender_permission(
        &self,
        bot: &BotRecord,
        sender_uid: &str,
        group_admin_uids: &[ZaloId],
    ) -> PermissionTier {
        self.resolve_sender_permission_in_thread(bot, sender_uid, None, group_admin_uids)
    }

    pub fn resolve_sender_permission_in_thread(
        &self,
        bot: &BotRecord,
        sender_uid: &str,
        thread_id: Option<&str>,
        group_admin_uids: &[ZaloId],
    ) -> PermissionTier {
        if sender_uid.is_empty() {
            return PermissionTier::All;
        }
        // Self UID on the bot's own session is always Supreme Admin
        if !bot.uid.is_empty() && bot.uid.as_str() == sender_uid {
            return PermissionTier::AdminLevelHigh;
        }

        let in_group_admin_list = thread_id.is_some_and(|tid| {
            let gs = self.caches.get_or_default_group_settings(&bot.bot_key, tid);
            gs.settings
                .get("adminList")
                .and_then(Value::as_object)
                .is_some_and(|m| m.contains_key(sender_uid))
        });

        // Fail-closed gate while Cross-Session UID seeds are still unresolved on child bots
        if bot.identity_pending && !bot.is_main {
            if group_admin_uids.iter().any(|u| u.as_str() == sender_uid) || in_group_admin_list {
                return PermissionTier::AdminBox;
            }
            return PermissionTier::All;
        }

        if bot.owner_uid.as_deref() == Some(sender_uid) {
            return PermissionTier::AdminLevelHigh;
        }

        if let Ok(admins) = self.caches.engine().list_bot_admins(&bot.bot_key) {
            for (uid, tier, _) in admins {
                if uid == sender_uid {
                    return if tier.eq_ignore_ascii_case("high")
                        || tier.eq_ignore_ascii_case("supreme")
                        || tier.eq_ignore_ascii_case("owner")
                    {
                        PermissionTier::AdminLevelHigh
                    } else {
                        PermissionTier::AdminBot
                    };
                }
            }
        }

        if group_admin_uids.iter().any(|u| u.as_str() == sender_uid) || in_group_admin_list {
            return PermissionTier::AdminBox;
        }
        PermissionTier::All
    }

    /// Commits resolved local session UIDs for a bot's `admin_identity_seeds` and lifts `identity_pending`.
    pub async fn complete_identity_resolution(
        &self,
        bot_key: &str,
        resolved_owner_uid: Option<String>,
        resolved_admins: &[(String, String, String)],
    ) -> Result<BotRecord, SupervisorError> {
        let mut bot = self
            .caches
            .engine()
            .get_bot(bot_key)?
            .ok_or_else(|| SupervisorError::BotNotFound(bot_key.to_string()))?;

        for (uid, tier, name) in resolved_admins {
            self.caches
                .engine()
                .upsert_bot_admin(&bot.bot_key, uid, tier, name)?;
        }
        if let Some(owner) = resolved_owner_uid.filter(|s| !s.trim().is_empty()) {
            bot.owner_uid = Some(owner.clone());
            self.caches
                .engine()
                .upsert_bot_admin(&bot.bot_key, &owner, "high", "Owner")?;
        }
        bot.identity_pending = false;
        bot.admin_identity_seeds.clear();
        bot.updated_at = Utc::now().to_rfc3339();
        self.caches.engine().upsert_bot(&bot)?;

        if let Some(handle) = self.actors.get(&bot.bot_key) {
            let _ = handle.tx.send(BotControlMsg::ReloadRecord(Box::new(bot.clone()))).await;
        }
        self.push_log(
            "info",
            Some(&bot.bot_key),
            "identity",
            "Cross-session admin UIDs resolved; identity_pending lifted.",
        );
        Ok(bot)
    }

    // -------------------------------------------------------------------------
    // Bot Actor Lifecycle (`start`, `stop`, `restart`, `enable`, `disable`, `delete`)
    // -------------------------------------------------------------------------

    pub async fn restore_all_from_storage(&self) -> Result<usize, SupervisorError> {
        let bots = self.caches.engine().list_bots()?;
        let mut started = 0usize;
        let now = Utc::now();

        for mut bot in bots {
            if bot.expiry_policy.is_expired_at(now) {
                if bot.status != "expired" {
                    bot.status = "expired".to_string();
                    bot.updated_at = now.to_rfc3339();
                    let _ = self.caches.engine().upsert_bot(&bot);
                }
                continue;
            }
            if (bot.desired_status == "running" || bot.status == "running" || bot.is_main)
                && !bot.cookie_dead
                && bot.status != "disabled"
                && self.start_bot(&bot.bot_key).await.is_ok()
            {
                started += 1;
            }
        }
        Ok(started)
    }

    pub async fn start_bot(&self, bot_key: &str) -> Result<BotStatusV2, SupervisorError> {
        let mut bot = self
            .caches
            .engine()
            .get_bot(bot_key)?
            .ok_or_else(|| SupervisorError::BotNotFound(bot_key.to_string()))?;

        if bot.expiry_policy.is_expired_at(Utc::now()) {
            bot.status = "expired".to_string();
            bot.updated_at = Utc::now().to_rfc3339();
            self.caches.engine().upsert_bot(&bot)?;
            return Err(SupervisorError::CannotStart(
                bot.bot_key,
                "BOT_EXPIRED".to_string(),
            ));
        }
        if bot.cookie_dead {
            return Err(SupervisorError::CannotStart(
                bot.bot_key,
                bot.cookie_dead_reason
                    .unwrap_or_else(|| "COOKIE_DEAD".to_string()),
            ));
        }

        if let Some(existing) = self.actors.get(&bot.bot_key) {
            let st = existing.status_rx.borrow().status;
            if reuse_existing_actor(st, existing.join_handle.is_finished(), existing.cancel.is_cancelled()) {
                return Ok(st);
            }
        }

        if let Some((_, old)) = self.actors.remove(&bot.bot_key) {
            old.cancel.cancel();
            let mut join = old.join_handle;
            if tokio::time::timeout(Duration::from_secs(2), &mut join).await.is_err() {
                join.abort();
            }
        }

        let has_creds = !bot.imei.trim().is_empty()
            && !bot.cookie_json.is_null()
            && bot.cookie_json != json!({});

        let initial_status = if self.cfg.connect_live_zalo && has_creds {
            BotStatusV2::Starting
        } else if !has_creds {
            BotStatusV2::ListenerDisconnected
        } else {
            // In offline/test harness mode (!connect_live_zalo), actor is running locally without live Zalo
            BotStatusV2::Running
        };

        bot.status = initial_status.as_v3_str().to_string();
        bot.desired_status = "running".to_string();
        bot.updated_at = Utc::now().to_rfc3339();
        self.caches.engine().upsert_bot(&bot)?;

        let handle = self.spawn_bot_actor(bot.clone());
        let key_clone = bot.bot_key.clone();
        self.actors.insert(key_clone.clone(), handle);

        self.emit_status(&key_clone, initial_status, Some("started".into()));
        self.push_log(
            "info",
            Some(&key_clone),
            "supervisor",
            format!("Bot actor started (status: {}).", initial_status.as_v3_str()),
        );
        Ok(initial_status)
    }

    pub async fn stop_bot(
        &self,
        bot_key: &str,
        final_status: BotStatusV2,
        reason: Option<String>,
    ) -> Result<BotStatusV2, SupervisorError> {
        let mut bot = self
            .caches
            .engine()
            .get_bot(bot_key)?
            .ok_or_else(|| SupervisorError::BotNotFound(bot_key.to_string()))?;

        if let Some((_, handle)) = self.actors.remove(&bot.bot_key) {
            let (ack_tx, ack_rx) = oneshot::channel();
            let _ = handle
                .tx
                .send(BotControlMsg::Stop {
                    final_status,
                    ack_tx,
                })
                .await;
            handle.cancel.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(3), ack_rx).await;
            let _ = tokio::time::timeout(Duration::from_secs(2), handle.join_handle).await;
        }

        bot.status = final_status.as_v3_str().to_string();
        if matches!(final_status, BotStatusV2::Stopped | BotStatusV2::Disabled) {
            bot.desired_status = bot.status.clone();
        }
        bot.updated_at = Utc::now().to_rfc3339();
        self.caches.engine().upsert_bot(&bot)?;

        self.emit_status(&bot.bot_key, final_status, reason.clone());
        self.push_log(
            "info",
            Some(&bot.bot_key),
            "supervisor",
            format!("Bot transitioned to `{}`.", final_status.as_v3_str()),
        );
        Ok(final_status)
    }

    pub async fn restart_bot(&self, bot_key: &str) -> Result<BotStatusV2, SupervisorError> {
        let _ = self
            .stop_bot(bot_key, BotStatusV2::Stopped, Some("restarting".into()))
            .await?;
        self.start_bot(bot_key).await
    }

    pub async fn enable_bot(&self, bot_key: &str) -> Result<BotStatusV2, SupervisorError> {
        let mut bot = self
            .caches
            .engine()
            .get_bot(bot_key)?
            .ok_or_else(|| SupervisorError::BotNotFound(bot_key.to_string()))?;
        bot.cookie_dead = false;
        bot.cookie_dead_reason = None;
        bot.desired_status = "running".to_string();
        bot.status = "stopped".to_string();
        bot.updated_at = Utc::now().to_rfc3339();
        self.caches.engine().upsert_bot(&bot)?;
        self.start_bot(&bot.bot_key).await
    }

    pub async fn disable_bot(&self, bot_key: &str) -> Result<BotStatusV2, SupervisorError> {
        self.stop_bot(bot_key, BotStatusV2::Disabled, Some("disabled_by_admin".into()))
            .await
    }

    pub async fn delete_bot(&self, bot_key: &str) -> Result<bool, SupervisorError> {
        if self.caches.engine().get_bot(bot_key)?.is_some() {
            let _ = self
                .stop_bot(bot_key, BotStatusV2::Stopped, Some("deleted".into()))
                .await;
        }
        Ok(self.caches.engine().delete_bot(bot_key)?)
    }

    pub async fn reload_bot(&self, bot_key: &str) -> Result<BotRecord, SupervisorError> {
        let bot = self
            .caches
            .engine()
            .get_bot(bot_key)?
            .ok_or_else(|| SupervisorError::BotNotFound(bot_key.to_string()))?;
        if let Some(handle) = self.actors.get(&bot.bot_key) {
            let _ = handle
                .tx
                .send(BotControlMsg::ReloadRecord(Box::new(bot.clone())))
                .await;
        }
        Ok(bot)
    }

    pub async fn set_bot_prefix(
        &self,
        bot_key: &str,
        new_prefix: &str,
    ) -> Result<BotRecord, SupervisorError> {
        let trimmed = new_prefix.trim();
        if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
            return Err(SupervisorError::CannotStart(
                bot_key.to_string(),
                "INVALID_PREFIX".to_string(),
            ));
        }
        let mut bot = self
            .caches
            .engine()
            .get_bot(bot_key)?
            .ok_or_else(|| SupervisorError::BotNotFound(bot_key.to_string()))?;
        bot.prefix = trimmed.to_string();
        bot.updated_at = Utc::now().to_rfc3339();
        self.caches.engine().upsert_bot(&bot)?;
        if let Some(handle) = self.actors.get(&bot.bot_key) {
            let _ = handle
                .tx
                .send(BotControlMsg::ReloadRecord(Box::new(bot.clone())))
                .await;
        }
        Ok(bot)
    }

    pub fn is_bot_running(&self, bot_key: &str) -> bool {
        self.actors
            .get(bot_key)
            .is_some_and(|h| h.status_rx.borrow().status == BotStatusV2::Running)
    }

    pub fn bot_runtime_snapshot(&self, bot_key: &str) -> Option<BotRuntimeSnapshot> {
        self.actors.get(bot_key).map(|h| h.status_rx.borrow().clone())
    }

    // -------------------------------------------------------------------------
    // Zero-Network Cross-Bot Command Relay (`< 2us` via bounded `mpsc`)
    // -------------------------------------------------------------------------

    pub async fn relay_command(
        &self,
        target_bot_key: &str,
        mut msg: InboundMessage,
        group_admins: Vec<ZaloId>,
    ) -> Result<DispatchReport, SupervisorError> {
        let tx = self
            .actors
            .get(target_bot_key)
            .map(|h| h.tx.clone())
            .ok_or_else(|| SupervisorError::BotNotRunning(target_bot_key.to_string()))?;

        msg.bot_key = target_bot_key.into();
        if msg.source == EventSource::WebSocket {
            msg.source = EventSource::CrossBotRelay;
        }

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(BotControlMsg::Inbound {
            msg: Box::new(msg),
            group_admins,
            reply_tx: Some(reply_tx),
        })
        .await
        .map_err(|_| SupervisorError::ActorClosed(target_bot_key.to_string()))?;

        reply_rx
            .await
            .map_err(|_| SupervisorError::ActorClosed(target_bot_key.to_string()))
    }

    pub async fn dispatch_undo_to_bot(
        &self,
        target_bot_key: &str,
        undo: UndoEvent,
    ) -> Result<Option<String>, SupervisorError> {
        let tx = self
            .actors
            .get(target_bot_key)
            .map(|h| h.tx.clone())
            .ok_or_else(|| SupervisorError::BotNotRunning(target_bot_key.to_string()))?;

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(BotControlMsg::Undo {
            undo,
            reply_tx: Some(reply_tx),
        })
        .await
        .map_err(|_| SupervisorError::ActorClosed(target_bot_key.to_string()))?;

        reply_rx
            .await
            .map_err(|_| SupervisorError::ActorClosed(target_bot_key.to_string()))
    }

    // -------------------------------------------------------------------------
    // SaaS 1-Hour Weekly Trial Ledger & 60s Expiry Reaper (`Asia/Ho_Chi_Minh`)
    // -------------------------------------------------------------------------

    /// Grants a 1-hour free trial (`3600s`) once per ISO week in `Asia/Ho_Chi_Minh`.
    pub fn claim_weekly_one_hour_trial(
        &self,
        owner_uid: &str,
        bot_key: &str,
        now: chrono::DateTime<Utc>,
    ) -> Result<TrialLedgerRow, SupervisorError> {
        let iso_week = current_ict_iso_week_key(now);
        if let Some(existing) = self.caches.engine().get_trial_ledger(owner_uid, &iso_week)?
            && existing.used_seconds >= 3600
        {
            return Err(SupervisorError::TrialAlreadyUsedThisWeek(iso_week));
        }

        let expires = now + ChronoDuration::hours(1);
        let row = TrialLedgerRow {
            owner_uid: owner_uid.to_string(),
            iso_week,
            used_seconds: 3600,
            bot_key: bot_key.to_string(),
            granted_at: now.to_rfc3339(),
            expires_at: expires.to_rfc3339(),
            status: "active".to_string(),
        };
        self.caches.engine().upsert_trial_ledger(&row)?;

        if let Some(mut bot) = self.caches.engine().get_bot(bot_key)? {
            bot.expiry_policy = ExpiryPolicy::At(expires);
            bot.trial_status = Some("trial_active".to_string());
            bot.updated_at = now.to_rfc3339();
            self.caches.engine().upsert_bot(&bot)?;
        }
        Ok(row)
    }

    /// Scans all bots and immediately halts any expired trial/rental bot -> `BotStatusV2::Expired`.
    pub async fn reap_expired_bots_once(
        &self,
        now: chrono::DateTime<Utc>,
    ) -> Result<Vec<String>, SupervisorError> {
        let bots = self.caches.engine().list_bots()?;
        let mut reaped = Vec::new();
        for bot in bots {
            if !bot.is_main
                && bot.expiry_policy.is_expired_at(now)
                && (bot.status != "expired" || self.is_bot_running(&bot.bot_key))
            {
                let key = bot.bot_key.clone();
                let _ = self
                    .stop_bot(&key, BotStatusV2::Expired, Some("expiry_reached".into()))
                    .await;
                reaped.push(key);
            }
        }
        Ok(reaped)
    }

    /// Runs `00:00 ICT` daily rank reset + `35`-day `locmem` window pruner + expired undo cache cleanup.
    pub fn run_daily_maintenance_once(
        &self,
        now: chrono::DateTime<Utc>,
    ) -> Result<(usize, usize, usize), StorageError> {
        let ict_cutoff = (now.with_timezone(&Ho_Chi_Minh) - ChronoDuration::days(35))
            .format("%Y-%m-%d")
            .to_string();
        let ranks_reset = self.caches.reset_daily_ranks_hot()?;
        let locmem_pruned = self.caches.engine().prune_locmem_before(&ict_cutoff)?;
        let msgs_pruned = self
            .caches
            .engine()
            .prune_expired_messages(now.timestamp_millis())?;
        Ok((ranks_reset, locmem_pruned, msgs_pruned))
    }

    /// Executes a scheduled `:05` `SendTask` slot across enabled groups with `20s` stagger.
    pub async fn run_sendtask_hour_slot(&self, hour_ict: u8) -> Vec<(String, String, SendTaskOutcome)> {
        let Some(runner) = self.sendtask_runner.clone() else {
            return Vec::new();
        };
        let slot_id = format!("hour-{hour_ict:02}");
        let mut results = Vec::new();

        let bots = self.caches.engine().list_bots().unwrap_or_default();
        for bot in bots {
            if !self.is_bot_running(&bot.bot_key) {
                continue;
            }
            let Ok(resolved) = self.dispatcher.studio().resolve_config(
                "sendtask",
                Some(&bot.bot_key),
                None,
            ) else {
                continue;
            };
            if resolved
                .values
                .get("schedules.enabled")
                .and_then(Value::as_bool)
                == Some(false)
            {
                continue;
            }
            let Some(slot_cfg) = resolved
                .values
                .get("schedules.items")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter()
                        .find(|it| it.get("id").and_then(Value::as_str) == Some(slot_id.as_str()))
                })
                .cloned()
            else {
                continue;
            };
            if slot_cfg.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }

            let groups = self.caches.list_bot_group_settings(&bot.bot_key);
            let target_groups: Vec<_> = groups
                .into_iter()
                .filter(|g| {
                    g.enable_bot
                        && g.settings
                            .get("sendTask")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                })
                .collect();

            for (idx, grp) in target_groups.iter().enumerate() {
                if idx > 0 && !self.cfg.sendtask_inter_group_delay.is_zero() {
                    tokio::time::sleep(self.cfg.sendtask_inter_group_delay).await;
                }
                let tid = ZaloId::new(&grp.thread_id);
                let live_zalo = self.get_live_zalo_session(&bot.bot_key);
                let outcome = runner
                    .execute_slot_for_group(&bot.bot_key, &tid, &slot_cfg, live_zalo)
                    .await;
                results.push((bot.bot_key.clone(), grp.thread_id.clone(), outcome));
            }
        }
        results
    }

    /// Sweeps expired entries from per-group `muteList` across all bots (`mute-user.js` 5s loop).
    pub fn sweep_expired_mutes_once(&self, now_ms: i64) -> usize {
        let mut unlocked = 0usize;
        let bots = self.caches.engine().list_bots().unwrap_or_default();
        for bot in bots {
            let groups = self.caches.list_bot_group_settings(&bot.bot_key);
            for grp in groups {
                let expired_uids: Vec<String> = grp
                    .settings
                    .get("muteList")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(uid, info)| {
                                let until = info
                                    .get("timeMute")
                                    .and_then(Value::as_i64)
                                    .or_else(|| info.as_i64())
                                    .unwrap_or(-1);
                                (until > 0 && now_ms >= until).then_some(uid.clone())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !expired_uids.is_empty() {
                    unlocked += expired_uids.len();
                    self.caches
                        .update_group_settings(&bot.bot_key, &grp.thread_id, |rec| {
                            if let Some(m) = rec
                                .settings
                                .get_mut("muteList")
                                .and_then(Value::as_object_mut)
                            {
                                for u in &expired_uids {
                                    m.remove(u);
                                }
                            }
                        });
                }
            }
        }
        unlocked
    }

    /// Delivers due `!nhacnho` reminders (`⏰ LỜI NHẮC TỰ ĐỘNG ⏰`, `ttl: 24h`) every 30s.
    pub async fn deliver_due_reminders_once(&self, now_ms: i64) -> usize {
        let Ok(due) = self.caches.engine().claim_due_reminders(now_ms) else {
            return 0;
        };
        let mut sent = 0usize;
        for rem in due {
            let Some(zalo) = self.get_live_zalo_session(&rem.bot_key) else {
                continue;
            };
            let due_str = chrono::DateTime::from_timestamp_millis(rem.due_at_ms)
                .map(|dt| {
                    dt.with_timezone(&Ho_Chi_Minh)
                        .format("%H:%M:%S %d/%m/%Y")
                        .to_string()
                })
                .unwrap_or_default();
            let text = format!(
                "⏰ LỜI NHẮC TỰ ĐỘNG ⏰\n📌 Nội dung: {}\n🕐 Thời gian hẹn: {}",
                rem.content, due_str
            );
            let out = OutboundMessage {
                text,
                ttl_ms: 86_400_000,
                link_on: false,
                ..Default::default()
            };
            let target_dm = ZaloId::new(&rem.target_uid);
            if zalo
                .send_message(out.clone(), &target_dm, ThreadType::User)
                .await
                .is_ok()
            {
                sent += 1;
            } else if !rem.thread_id.is_empty() && rem.thread_id != rem.target_uid {
                let fallback_tid = ZaloId::new(&rem.thread_id);
                if zalo
                    .send_message(out, &fallback_tid, ThreadType::Group)
                    .await
                    .is_ok()
                {
                    sent += 1;
                }
            }
        }
        sent
    }

    /// Spawns background 60s Trial Reaper, `00:00 ICT` Daily Maintenance, `:05` `SendTask` ticker,
    /// 5s `mute` expiry sweeper, and 30s `nhacnho` reminder delivery loop.
    pub fn spawn_background_daemons(&self) -> JoinHandle<()> {
        let sup_fast = self.clone();
        let cancel_fast = self.root_cancel.clone();
        tokio::spawn(async move {
            let mut mute_ticker = tokio::time::interval(Duration::from_secs(5));
            let mut rem_ticks = 0u32;
            loop {
                tokio::select! {
                    _ = cancel_fast.cancelled() => break,
                    _ = mute_ticker.tick() => {
                        let now_ms = Utc::now().timestamp_millis();
                        let _ = sup_fast.sweep_expired_mutes_once(now_ms);
                        rem_ticks = rem_ticks.wrapping_add(1);
                        if rem_ticks % 6 == 0 {
                            let _ = sup_fast.deliver_due_reminders_once(now_ms).await;
                        }
                    }
                }
            }
        });

        let sup = self.clone();
        let cancel = self.root_cancel.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            let mut last_daily_date = String::new();
            let mut last_sendtask_key = String::new();

            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = ticker.tick() => {
                        let now = Utc::now();
                        let _ = sup.reap_expired_bots_once(now).await;

                        let ict = now.with_timezone(&Ho_Chi_Minh);
                        let today_key = ict.format("%Y-%m-%d").to_string();
                        if ict.hour() == 0 && ict.minute() == 0 && last_daily_date != today_key {
                            last_daily_date = today_key;
                            let _ = sup.run_daily_maintenance_once(now);
                        }

                        let hour_slot_key = ict.format("%Y-%m-%d-%H").to_string();
                        if ict.minute() == 5 && last_sendtask_key != hour_slot_key {
                            last_sendtask_key = hour_slot_key;
                            let sup_slot = sup.clone();
                            let h = ict.hour() as u8;
                            tokio::spawn(async move {
                                let _ = sup_slot.run_sendtask_hour_slot(h).await;
                            });
                        }

                        let (rss, _) = sup.process_resource_usage();
                        let total = sup.caches.engine().list_bots().map(|b| b.len()).unwrap_or(0);
                        let _ = sup.events_tx.send(SupervisorEvent::MetricsTick {
                            running_bots: sup.actors.len(),
                            total_bots: total,
                            rss_bytes: rss,
                            timestamp: now.to_rfc3339(),
                        });
                    }
                }
            }
        })
    }

    pub async fn shutdown_all(&self) {
        self.root_cancel.cancel();
        let keys: Vec<String> = self.actors.iter().map(|e| e.key().clone()).collect();
        for key in keys {
            if let Some((_, handle)) = self.actors.remove(&key) {
                let (ack_tx, ack_rx) = oneshot::channel();
                let _ = handle
                    .tx
                    .send(BotControlMsg::Stop {
                        final_status: BotStatusV2::Stopped,
                        ack_tx,
                    })
                    .await;
                handle.cancel.cancel();
                let _ = tokio::time::timeout(Duration::from_millis(500), ack_rx).await;
            }
        }
        let _ = self.caches.flush_all_sync();
    }

    // -------------------------------------------------------------------------
    // Dashboard & TUI Telemetry Snapshots
    // -------------------------------------------------------------------------

    pub fn process_resource_usage(&self) -> (u64, f32) {
        let mut sys = System::new();
        if let Ok(pid) = sysinfo::get_current_pid() {
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(proc_info) = sys.process(Pid::from_u32(pid.as_u32())) {
                return (proc_info.memory(), proc_info.cpu_usage());
            }
        }
        (0, 0.0)
    }

    pub fn fleet_overview_json(&self) -> Value {
        let bots = self.caches.engine().list_bots().unwrap_or_default();
        let mut running = 0usize;
        let mut stopped = 0usize;
        let mut expired = 0usize;
        let mut errored = 0usize;
        let mut items = Vec::with_capacity(bots.len());

        for b in &bots {
            let live_snap = self.bot_runtime_snapshot(&b.bot_key);
            let effective_status = live_snap
                .as_ref()
                .map(|s| s.status)
                .unwrap_or_else(|| BotStatusV2::from_v3_str(&b.status));

            match effective_status {
                BotStatusV2::Running | BotStatusV2::Starting | BotStatusV2::Recovering => {
                    running += 1;
                }
                BotStatusV2::Expired => expired += 1,
                BotStatusV2::Error | BotStatusV2::IdentityMismatch => errored += 1,
                _ => stopped += 1,
            }

            let mut summary = b.to_redacted_summary();
            if let Some(obj) = summary.as_object_mut() {
                obj.insert("status".into(), json!(effective_status.as_v3_str()));
                obj.insert(
                    "actorRunning".into(),
                    json!(live_snap.as_ref().is_some_and(|s| s.actor_running)),
                );
                obj.insert(
                    "loginReady".into(),
                    json!(live_snap.as_ref().is_some_and(|s| s.login_ready)),
                );
                obj.insert(
                    "wsConnected".into(),
                    json!(live_snap.as_ref().is_some_and(|s| s.ws_connected)),
                );
                obj.insert(
                    "wsReady".into(),
                    json!(live_snap.as_ref().is_some_and(|s| s.ws_ready)),
                );
                obj.insert(
                    "lastError".into(),
                    json!(live_snap.as_ref().and_then(|s| s.last_error.clone())),
                );
                obj.insert(
                    "lastEventAt".into(),
                    json!(live_snap.as_ref().and_then(|s| s.last_event_at.clone())),
                );
                obj.insert(
                    "reconnectAttempts".into(),
                    json!(live_snap.as_ref().map(|s| s.reconnect_attempts).unwrap_or(0)),
                );
                obj.insert(
                    "uptimeSecs".into(),
                    json!(live_snap
                        .as_ref()
                        .and_then(|s| s.started_at.map(|t| t.elapsed().as_secs()))
                        .unwrap_or(0)),
                );
            }
            items.push(summary);
        }

        let (rss_bytes, cpu_pct) = self.process_resource_usage();
        json!({
            "totalBots": bots.len(),
            "runningBots": running,
            "stoppedBots": stopped,
            "expiredBots": expired,
            "erroredBots": errored,
            "uptimeSecs": self.boot_instant.elapsed().as_secs(),
            "rssBytes": rss_bytes,
            "cpuPercent": cpu_pct,
            "processedMessages": self.dispatcher.processed_count(),
            "shedMessages": self.dispatcher.shed_count(),
            "inFlightMessages": self.dispatcher.in_flight_count(),
            "bots": items,
        })
    }

    pub fn system_metrics_json(&self) -> Value {
        let (rss_bytes, cpu_pct) = self.process_resource_usage();
        json!({
            "engine": "mybot-v4-rust",
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "uptimeSecs": self.boot_instant.elapsed().as_secs(),
            "rssBytes": rss_bytes,
            "cpuPercent": cpu_pct,
            "runningBots": self.actors.len(),
            "processedMessages": self.dispatcher.processed_count(),
            "shedMessages": self.dispatcher.shed_count(),
            "inFlight": self.dispatcher.in_flight_count(),
            "lanes": self.dispatcher.broker().telemetry_json(),
            "latency": self.dispatcher.latency().snapshot_json(),
        })
    }

    // -------------------------------------------------------------------------
    // Internal Bot Actor Task Spawner
    // -------------------------------------------------------------------------

    fn emit_status(&self, bot_key: &str, status: BotStatusV2, reason: Option<String>) {
        let _ = self.events_tx.send(SupervisorEvent::StatusChanged {
            bot_key: bot_key.to_string(),
            status,
            reason,
            timestamp: Utc::now().to_rfc3339(),
        });
    }

    fn spawn_bot_actor(&self, initial_bot: BotRecord) -> BotActorHandle {
        let (tx, mut rx) = mpsc::channel::<BotControlMsg>(512);

        let has_creds = !initial_bot.imei.trim().is_empty()
            && !initial_bot.cookie_json.is_null()
            && initial_bot.cookie_json != json!({});

        let initial_status = if self.cfg.connect_live_zalo && has_creds {
            BotStatusV2::Starting
        } else if !has_creds {
            BotStatusV2::ListenerDisconnected
        } else {
            // In offline/test harness mode (!connect_live_zalo), actor is running locally without live Zalo
            BotStatusV2::Running
        };

        let initial_last_error = if !has_creds && self.cfg.connect_live_zalo {
            Some("MISSING_CREDENTIALS".to_string())
        } else {
            None
        };

        let initial_snap = BotRuntimeSnapshot {
            bot_key: initial_bot.bot_key.clone(),
            status: initial_status,
            actor_running: true,
            login_ready: false,
            ws_connected: false,
            ws_ready: false,
            started_at: Some(Instant::now()),
            started_at_iso: Some(Utc::now().to_rfc3339()),
            last_event_at: None,
            reconnect_attempts: 0,
            last_error: initial_last_error,
            frames_received: 0,
            messages_decrypted: 0,
            messages_dispatched: 0,
            reply_delivery_errors: 0,
        };
        let (status_tx, status_rx) = watch::channel(initial_snap);
        let cancel = self.root_cancel.child_token();
        let zalo_slot: Arc<parking_lot::RwLock<Option<Arc<ZaloSession>>>> =
            Arc::new(parking_lot::RwLock::new(None));

        let sup = self.clone();
        let actor_cancel = cancel.clone();
        let zalo_slot_actor = Arc::clone(&zalo_slot);
        let tx_actor = tx.clone();

        let join_handle = tokio::spawn(async move {
            let mut bot = initial_bot;
            let (ws_tx, mut ws_rx) = mpsc::channel::<ZaloWsEvent>(512);
            let group_admins_cache: Arc<DashMap<String, (Instant, Vec<ZaloId>)>> =
                Arc::new(DashMap::new());

            // Spawn live Zalo HTTP login + Binary WebSocket loop if enabled and credentials exist
            let has_creds = !bot.imei.trim().is_empty()
                && !bot.cookie_json.is_null()
                && bot.cookie_json != json!({});

            if sup.cfg.connect_live_zalo && has_creds {
                let creds = bot.to_credentials_bundle();
                match ZaloSession::new(&bot.bot_key, bot.is_main, &creds, bot.self_listen) {
                    Ok(sess) => {
                        let ws_cancel = actor_cancel.child_token();
                        let ws_tx_clone = ws_tx.clone();
                        let sup_ws = sup.clone();
                        let bkey_ws = bot.bot_key.clone();
                        let is_main_ws = bot.is_main;
                        let status_tx_ws = status_tx.clone();
                        let slot_ws = Arc::clone(&zalo_slot_actor);
                        let tx_ws = tx_actor.clone();

                        tokio::spawn(async move {
                            if let Err(err) = sess.login().await {
                                let err_text = err.to_string();
                                let is_auth_dead = matches!(err, ZaloApiError::InvalidCookie(_))
                                    || err_text.to_ascii_lowercase().contains("cookie")
                                    || err_text.contains("401")
                                    || err_text.contains("403");

                                sup_ws.push_log(
                                    "error",
                                    Some(&bkey_ws),
                                    "zalo-login",
                                    format!("Login failed: {err_text}"),
                                );

                                *slot_ws.write() = None;
                                if is_auth_dead {
                                    if let Ok(Some(mut rec)) =
                                        sup_ws.caches.engine().get_bot(&bkey_ws)
                                    {
                                        rec.cookie_dead = true;
                                        rec.cookie_dead_reason = Some(err_text.clone());
                                        rec.status = "cookie_dead".to_string();
                                        rec.updated_at = Utc::now().to_rfc3339();
                                        let _ = sup_ws.caches.engine().upsert_bot(&rec);
                                    }
                                    sup_ws.emit_status(
                                        &bkey_ws,
                                        BotStatusV2::Error,
                                        Some(err_text.clone()),
                                    );
                                    if is_main_ws {
                                        let _ = sup_ws.events_tx.send(SupervisorEvent::AdminAlert {
                                            bot_key: bkey_ws.clone(),
                                            message: format!(
                                                "Cookie Bot Admin đã hết hạn ({err_text}). Mở Web Dashboard để quét lại mã QR ngay!"
                                            ),
                                            timestamp: Utc::now().to_rfc3339(),
                                        });
                                    }
                                }

                                status_tx_ws.send_modify(|s| {
                                    s.login_ready = false;
                                    s.ws_connected = false;
                                    s.ws_ready = false;
                                    s.status = if is_auth_dead {
                                        BotStatusV2::Error
                                    } else {
                                        BotStatusV2::Recovering
                                    };
                                    s.last_error = Some(err_text.clone());
                                });
                                if !is_auth_dead {
                                    sup_ws.emit_status(
                                        &bkey_ws,
                                        BotStatusV2::Recovering,
                                        Some(err_text),
                                    );
                                }
                                return;
                            }

                            // Populate session slot ONLY after login succeeded!
                            *slot_ws.write() = Some(Arc::clone(&sess));
                            status_tx_ws.send_modify(|s| {
                                s.login_ready = true;
                                s.last_error = None;
                            });
                            sup_ws.push_log(
                                "info",
                                Some(&bkey_ws),
                                "zalo-login",
                                "Login HTTP thành công, đang khởi tạo WebSocket listener...",
                            );

                            // Hydrate canonical Zalo UID & Supreme Admin privilege upon live login
                            if let Some(real_uid) = sess.uid().filter(|u| !u.is_empty())
                                && let Ok(Some(mut rec)) = sup_ws.caches.engine().get_bot(&bkey_ws)
                            {
                                let changed =
                                    rec.uid != real_uid || !rec.self_listen || rec.cookie_dead || (rec.is_main && rec.identity_pending);
                                rec.uid = real_uid.clone();
                                rec.self_listen = true;
                                if rec.is_main {
                                    rec.identity_pending = false;
                                }
                                sess.set_self_listen(true);
                                rec.cookie_dead = false;
                                rec.cookie_dead_reason = None;
                                if changed {
                                    rec.updated_at = Utc::now().to_rfc3339();
                                    let _ = sup_ws.caches.engine().upsert_bot(&rec);
                                }
                                let _ = sup_ws.caches.engine().upsert_bot_admin(
                                    &bkey_ws,
                                    real_uid.as_str(),
                                    "high",
                                    &rec.display_name,
                                );
                                let _ = tx_ws.send(BotControlMsg::ReloadRecord(Box::new(rec))).await;
                            }

                            let sess_reconnect = Arc::clone(&sess);
                            let listener = ZaloWsListener::new(sess, WsListenerConfig::default());
                            let mut rotate = false;
                            let mut backoff_secs = 1u64;
                            while !ws_cancel.is_cancelled() {
                                // Refresh short-lived `zpw_ws` ticket URLs before reconnecting (`src/index.js:1157`)
                                if rotate {
                                    status_tx_ws.send_modify(|s| {
                                        s.ws_connected = false;
                                        s.ws_ready = false;
                                        s.status = BotStatusV2::Recovering;
                                        s.reconnect_attempts += 1;
                                    });
                                    if let Err(re_err) = sess_reconnect.login().await {
                                        let err_text = re_err.to_string();
                                        let is_auth_dead =
                                            matches!(re_err, ZaloApiError::InvalidCookie(_))
                                                || err_text.to_ascii_lowercase().contains("cookie")
                                                || err_text.contains("401")
                                                || err_text.contains("403");
                                        if is_auth_dead {
                                            *slot_ws.write() = None;
                                            if let Ok(Some(mut rec)) =
                                                sup_ws.caches.engine().get_bot(&bkey_ws)
                                            {
                                                rec.cookie_dead = true;
                                                rec.cookie_dead_reason = Some(err_text.clone());
                                                rec.status = "cookie_dead".to_string();
                                                rec.updated_at = Utc::now().to_rfc3339();
                                                let _ = sup_ws.caches.engine().upsert_bot(&rec);
                                            }
                                            sup_ws.emit_status(
                                                &bkey_ws,
                                                BotStatusV2::Error,
                                                Some(err_text.clone()),
                                            );
                                            status_tx_ws.send_modify(|s| {
                                                s.login_ready = false;
                                                s.ws_connected = false;
                                                s.ws_ready = false;
                                                s.status = BotStatusV2::Error;
                                                s.last_error = Some(err_text);
                                            });
                                            break;
                                        }
                                        sup_ws.push_log(
                                            "warn",
                                            Some(&bkey_ws),
                                            "zalo-login",
                                            format!(
                                                "Session ticket refresh failed ({err_text}); retrying in {backoff_secs}s"
                                            ),
                                        );
                                        tokio::select! {
                                            _ = ws_cancel.cancelled() => break,
                                            _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                                        }
                                        backoff_secs = (backoff_secs * 2).min(30);
                                        continue;
                                    } else {
                                        *slot_ws.write() = Some(Arc::clone(&sess_reconnect));
                                        status_tx_ws.send_modify(|s| s.login_ready = true);
                                    }
                                }

                                let connected_at = Instant::now();
                                match listener
                                    .run_connection_once(rotate, &ws_tx_clone, ws_cancel.clone())
                                    .await
                                {
                                    Ok(()) if ws_cancel.is_cancelled() => break,
                                    Ok(()) => {
                                        rotate = true;
                                    }
                                    Err(ZaloApiError::DuplicateConnection) => {
                                        sup_ws.push_log(
                                            "warn",
                                            Some(&bkey_ws),
                                            "zalo-ws",
                                            "Code 3000 duplicate Zalo WebSocket connection; halting reconnect.",
                                        );
                                        status_tx_ws.send_modify(|s| {
                                            s.ws_connected = false;
                                            s.ws_ready = false;
                                            s.status = BotStatusV2::ListenerDisconnected;
                                            s.last_error = Some("DUPLICATE_CONNECTION_3000".into());
                                        });
                                        sup_ws.emit_status(
                                            &bkey_ws,
                                            BotStatusV2::ListenerDisconnected,
                                            Some("DUPLICATE_CONNECTION_3000".into()),
                                        );
                                        break;
                                    }
                                    Err(err) => {
                                        rotate = true;
                                        let err_msg = err.to_string();
                                        sup_ws.push_log(
                                            "warn",
                                            Some(&bkey_ws),
                                            "zalo-ws",
                                            format!("WS disconnected ({err_msg}); retrying in {backoff_secs}s"),
                                        );
                                        status_tx_ws.send_modify(|s| {
                                            s.ws_connected = false;
                                            s.ws_ready = false;
                                            s.status = BotStatusV2::Recovering;
                                            s.last_error = Some(err_msg.clone());
                                        });
                                        sup_ws.emit_status(
                                            &bkey_ws,
                                            BotStatusV2::Recovering,
                                            Some(err_msg),
                                        );
                                    }
                                }
                                if connected_at.elapsed() >= Duration::from_secs(30) {
                                    backoff_secs = 1;
                                }
                                status_tx_ws.send_modify(|s| {
                                    s.ws_connected = false;
                                    s.ws_ready = false;
                                });
                                tokio::select! {
                                    _ = ws_cancel.cancelled() => break,
                                    _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                                }
                                backoff_secs = (backoff_secs * 2).min(30);
                            }
                        });
                    }
                    Err(err) => {
                        let err_text = format!("Invalid session bundle: {err}");
                        sup.push_log(
                            "error",
                            Some(&bot.bot_key),
                            "zalo-init",
                            err_text.clone(),
                        );
                        status_tx.send_modify(|s| {
                            s.status = BotStatusV2::Error;
                            s.last_error = Some(err_text.clone());
                        });
                        sup.emit_status(&bot.bot_key, BotStatusV2::Error, Some(err_text));
                        if let Ok(Some(mut rec)) = sup.caches.engine().get_bot(&bot.bot_key) {
                            rec.status = "error".to_string();
                            let _ = sup.caches.engine().upsert_bot(&rec);
                        }
                    }
                }
            } else if !has_creds && sup.cfg.connect_live_zalo {
                sup.push_log(
                    "warn",
                    Some(&bot.bot_key),
                    "zalo-init",
                    "Bot chưa có thông tin đăng nhập (IMEI/Cookie rỗng). Quét QR để đăng nhập.",
                );
                status_tx.send_modify(|s| {
                    s.status = BotStatusV2::ListenerDisconnected;
                    s.last_error = Some("MISSING_CREDENTIALS".into());
                });
                sup.emit_status(&bot.bot_key, BotStatusV2::ListenerDisconnected, Some("MISSING_CREDENTIALS".into()));
            }

            loop {
                tokio::select! {
                    _ = actor_cancel.cancelled() => break,
                    Some(ctrl) = rx.recv() => {
                        match ctrl {
                            BotControlMsg::Inbound { msg, group_admins, reply_tx } => {
                                let msg = *msg;
                                let zalo_session = match dispatch_session(&zalo_slot_actor, sup.cfg.connect_live_zalo) {
                                    Ok(session) => session,
                                    Err(code) => {
                                        sup.push_log("error", Some(&bot.bot_key), "inbound", code);
                                        if let Some(tx_out) = reply_tx {
                                            let _ = tx_out.send(DispatchReport::Ignored {
                                                reason_code: code,
                                                detail: "Live Zalo session chưa sẵn sàng".into(),
                                            });
                                        }
                                        continue;
                                    }
                                };
                                let tid_opt = msg.thread_type.is_group().then_some(msg.thread_id.as_str());
                                let tier = if msg.is_self {
                                    PermissionTier::AdminLevelHigh
                                } else {
                                    sup.resolve_sender_permission_in_thread(&bot, msg.sender_uid.as_str(), tid_opt, &group_admins)
                                };
                                let profile = BotStyleProfile::from_bot_metadata(&bot.metadata, Some(&bot.display_name));
                                let (chat_grp, chat_priv) = extract_chat_policy(&bot.metadata);
                                let fleet_ctrl: Arc<dyn BotFleetController> = Arc::new(sup.clone());
                                let meta = BotExecutionMeta {
                                    bot_key: bot.bot_key.clone(),
                                    is_main_bot: bot.is_main,
                                    self_uid: bot.uid.clone(),
                                    prefix: if bot.prefix.trim().is_empty() { "!".into() } else { bot.prefix.clone() },
                                    self_listen: bot.self_listen,
                                    identity_pending: bot.identity_pending,
                                    sender_tier: tier,
                                    zalo: zalo_session.clone(),
                                    assets_root: sup.cfg.assets_root.clone(),
                                    style_profile: profile,
                                    chat_policy_group: chat_grp,
                                    chat_policy_private: chat_priv,
                                    fleet: Some(fleet_ctrl),
                                    outbound_sink: None,
                                };
                                let report = sup.dispatcher.dispatch_inbound(meta, msg).await;
                                if let Some(tx_out) = reply_tx {
                                    let _ = tx_out.send(report);
                                }
                            }
                            BotControlMsg::Undo { undo, reply_tx } => {
                                let zalo_session = match dispatch_session(&zalo_slot_actor, sup.cfg.connect_live_zalo) {
                                    Ok(session) => session,
                                    Err(code) => {
                                        sup.push_log("error", Some(&bot.bot_key), "undo", code);
                                        if let Some(tx_out) = reply_tx { let _ = tx_out.send(None); }
                                        continue;
                                    }
                                };
                                let alert = sup
                                    .dispatcher
                                    .handle_undo_event(&bot.bot_key, &undo, zalo_session.as_ref())
                                    .await;
                                if let Some(tx_out) = reply_tx {
                                    let _ = tx_out.send(alert);
                                }
                            }
                            BotControlMsg::ReloadRecord(updated) => {
                                bot = *updated;
                                if let Some(ref zs) = *zalo_slot_actor.read() {
                                    zs.set_self_listen(bot.self_listen);
                                }
                            }
                            BotControlMsg::Stop { final_status, ack_tx } => {
                                status_tx.send_modify(|s| {
                                    s.status = final_status;
                                    s.ws_connected = false;
                                });
                                let _ = ack_tx.send(());
                                break;
                            }
                        }
                    }
                    Some(ws_ev) = ws_rx.recv() => {
                        match ws_ev {
                            ZaloWsEvent::FrameReceived { .. } => {
                                status_tx.send_modify(|s| {
                                    s.frames_received += 1;
                                    s.last_event_at = Some(Utc::now().to_rfc3339());
                                });
                            }
                            ZaloWsEvent::Ready { key_exchanged, .. } => {
                                status_tx.send_modify(|s| {
                                    s.ws_connected = true;
                                    s.ws_ready = key_exchanged;
                                    if key_exchanged {
                                        s.status = BotStatusV2::Running;
                                        s.last_error = None;
                                    }
                                    s.last_event_at = Some(Utc::now().to_rfc3339());
                                });
                                if key_exchanged {
                                    if let Ok(Some(mut rec)) = sup.caches.engine().get_bot(&bot.bot_key) {
                                        if rec.status != "running" {
                                            rec.status = "running".to_string();
                                            rec.updated_at = Utc::now().to_rfc3339();
                                            let _ = sup.caches.engine().upsert_bot(&rec);
                                        }
                                    }
                                    sup.emit_status(&bot.bot_key, BotStatusV2::Running, None);
                                    sup.push_log(
                                        "info",
                                        Some(&bot.bot_key),
                                        "zalo-ws",
                                        "WebSocket đã kết nối và trao đổi khóa; đang chờ frame tin nhắn Zalo để xác nhận listener.",
                                    );
                                }
                            }
                            ZaloWsEvent::Message(msg) => {
                                let zalo_session = match dispatch_session(&zalo_slot_actor, sup.cfg.connect_live_zalo) {
                                    Ok(session) => session,
                                    Err(code) => {
                                        sup.push_log("error", Some(&bot.bot_key), "inbound", code);
                                        continue;
                                    }
                                };
                                status_tx.send_modify(|s| {
                                    s.messages_decrypted += 1;
                                    s.last_event_at = Some(Utc::now().to_rfc3339());
                                });
                                let status_tx_msg = status_tx.clone();
                                let bot_snap = bot.clone();
                                let sup_msg = sup.clone();
                                let disp = sup.dispatcher.clone();
                                let z_opt = zalo_session.clone();
                                let assets_root = sup.cfg.assets_root.clone();
                                let g_cache = Arc::clone(&group_admins_cache);
                                let eff_prefix = if bot.prefix.trim().is_empty() {
                                    "!".to_string()
                                } else {
                                    bot.prefix.clone()
                                };

                                tokio::spawn(async move {
                                    let msg = *msg;
                                    let group_admins: Vec<ZaloId> = if msg.is_self
                                        || !msg.thread_type.is_group()
                                    {
                                        Vec::new()
                                    } else if let Some(cached) = g_cache
                                        .get(msg.thread_id.as_str())
                                        .filter(|e| e.value().0.elapsed() < Duration::from_secs(300))
                                    {
                                        cached.value().1.clone()
                                    } else if let Some(ref zs) = z_opt
                                        && let Ok(info) = zs
                                            .get_group_info(std::slice::from_ref(&msg.thread_id))
                                            .await
                                        && let Some(gval) = info
                                            .get("gridInfoMap")
                                            .and_then(|m| m.get(msg.thread_id.as_str()))
                                    {
                                        let mut admins = Vec::new();
                                        if let Some(cid) = gval.get("creatorId") {
                                            let s_opt = cid.as_str().map(|s| s.to_string())
                                                .or_else(|| cid.as_i64().map(|n| n.to_string()))
                                                .or_else(|| cid.as_u64().map(|n| n.to_string()));
                                            if let Some(s) = s_opt
                                                && !s.trim().is_empty()
                                            {
                                                admins.push(ZaloId::new(s));
                                            }
                                        }
                                        if let Some(arr) =
                                            gval.get("adminIds").and_then(Value::as_array)
                                        {
                                            for item in arr {
                                                let s_opt = item.as_str().map(|s| s.to_string())
                                                    .or_else(|| item.as_i64().map(|n| n.to_string()))
                                                    .or_else(|| item.as_u64().map(|n| n.to_string()));
                                                if let Some(s) = s_opt
                                                    && !s.trim().is_empty()
                                                {
                                                    admins.push(ZaloId::new(s));
                                                }
                                            }
                                        }
                                        if let Some(gname) = gval.get("name").and_then(Value::as_str)
                                            && !gname.trim().is_empty()
                                        {
                                            sup_msg.caches.update_group_settings(
                                                &bot_snap.bot_key,
                                                msg.thread_id.as_str(),
                                                |rec| {
                                                    if rec.group_name.is_empty() {
                                                        rec.group_name = gname.to_string();
                                                    }
                                                },
                                            );
                                        }
                                        g_cache.insert(
                                            msg.thread_id.to_string(),
                                            (Instant::now(), admins.clone()),
                                        );
                                        admins
                                    } else {
                                        Vec::new()
                                    };

                                    let tid_opt =
                                        msg.thread_type.is_group().then_some(msg.thread_id.as_str());
                                    let tier = if msg.is_self {
                                        PermissionTier::AdminLevelHigh
                                    } else {
                                        sup_msg.resolve_sender_permission_in_thread(
                                            &bot_snap,
                                            msg.sender_uid.as_str(),
                                            tid_opt,
                                            &group_admins,
                                        )
                                    };
                                    let self_uid = z_opt
                                        .as_ref()
                                        .and_then(|z| z.uid())
                                        .filter(|u| !u.is_empty())
                                        .unwrap_or_else(|| bot_snap.uid.clone());

                                    let profile = BotStyleProfile::from_bot_metadata(
                                        &bot_snap.metadata,
                                        Some(&bot_snap.display_name),
                                    );
                                    let (chat_grp, chat_priv) =
                                        extract_chat_policy(&bot_snap.metadata);
                                    let fleet_ctrl: Arc<dyn BotFleetController> =
                                        Arc::new(sup_msg.clone());

                                    let meta = BotExecutionMeta {
                                        bot_key: bot_snap.bot_key.clone(),
                                        is_main_bot: bot_snap.is_main,
                                        self_uid,
                                        prefix: eff_prefix,
                                        self_listen: bot_snap.self_listen,
                                        identity_pending: bot_snap.identity_pending,
                                        sender_tier: tier,
                                        zalo: z_opt,
                                        assets_root,
                                        style_profile: profile,
                                        chat_policy_group: chat_grp,
                                        chat_policy_private: chat_priv,
                                        fleet: Some(fleet_ctrl),
                                        outbound_sink: None,
                                    };
                                    let thread_label = msg.thread_id.to_string();
                                    let is_grp = msg.thread_type.is_group();
                                    sup_msg.push_log(
                                        "info",
                                        Some(&bot_snap.bot_key),
                                        "inbound",
                                        format!(
                                            "Nhận tin nhắn từ `{}` tại `{thread_label}` ({})",
                                            msg.sender_uid,
                                            if is_grp { "Group" } else { "Direct" }
                                        ),
                                    );
                                    let report = disp.dispatch_inbound(meta, msg).await;
                                    status_tx_msg.send_modify(|s| s.messages_dispatched += 1);
                                    match &report {
                                        DispatchReport::CommandExecuted {
                                            command_name,
                                            outcome,
                                            delivery_error,
                                        } => {
                                            if let Some(d_err) = delivery_error {
                                                status_tx_msg.send_modify(|s| s.reply_delivery_errors += 1);
                                                sup_msg.push_log(
                                                    "warn",
                                                    Some(&bot_snap.bot_key),
                                                    "command",
                                                    format!("Lỗi truyền phản hồi Zalo cho lệnh `{command_name}`: {d_err}"),
                                                );
                                            }
                                            match outcome {
                                                CommandOutcome::Handled { summary, .. } => {
                                                    sup_msg.push_log(
                                                        "info",
                                                        Some(&bot_snap.bot_key),
                                                        "command",
                                                        format!(
                                                            "Đã thực thi lệnh `{command_name}` tại `{thread_label}`: {summary}"
                                                        ),
                                                    );
                                                }
                                                CommandOutcome::Accepted { job_id, lane } => {
                                                    sup_msg.push_log(
                                                        "info",
                                                        Some(&bot_snap.bot_key),
                                                        "command",
                                                        format!(
                                                            "Đã nhận tác vụ lệnh `{command_name}` [lane {lane:?}, job {job_id}] tại `{thread_label}`"
                                                        ),
                                                    );
                                                }
                                                CommandOutcome::Denied { reason_code, message } => {
                                                    sup_msg.push_log(
                                                        "warn",
                                                        Some(&bot_snap.bot_key),
                                                        "command",
                                                        format!(
                                                            "Từ chối lệnh `{command_name}` tại `{thread_label}` [{reason_code}]: {message}"
                                                        ),
                                                    );
                                                }
                                            }
                                        }
                                        DispatchReport::CommandFailed {
                                            command_name,
                                            error,
                                        } => {
                                            sup_msg.push_log(
                                                "warn",
                                                Some(&bot_snap.bot_key),
                                                "command",
                                                format!(
                                                    "Lỗi lệnh `{command_name}` tại `{thread_label}`: {error}"
                                                ),
                                            );
                                        }
                                        DispatchReport::Ignored { reason_code, detail } => {
                                            sup_msg.push_log(
                                                "info",
                                                Some(&bot_snap.bot_key),
                                                "inbound",
                                                format!(
                                                    "Bỏ qua tại `{thread_label}` [{reason_code}]: {detail}"
                                                ),
                                            );
                                        }
                                        DispatchReport::DuplicateIgnored => {
                                            sup_msg.push_log(
                                                "debug",
                                                Some(&bot_snap.bot_key),
                                                "inbound",
                                                format!("Bỏ qua tin nhắn trùng lặp tại `{thread_label}` [DUPLICATE]"),
                                            );
                                        }
                                        DispatchReport::LoadShed { in_flight, max_in_flight, .. } => {
                                            sup_msg.push_log(
                                                "warn",
                                                Some(&bot_snap.bot_key),
                                                "inbound",
                                                format!("Hạ tải tại `{thread_label}` [LOAD_SHED] ({in_flight}/{max_in_flight})"),
                                            );
                                        }
                                        DispatchReport::Moderated { decision } => {
                                            sup_msg.push_log(
                                                "info",
                                                Some(&bot_snap.bot_key),
                                                "moderation",
                                                format!("Kiểm duyệt tại `{thread_label}`: {decision:?}"),
                                            );
                                        }
                                        DispatchReport::PassiveMessage => {}
                                    }
                                });
                            }
                            ZaloWsEvent::Undo(undo) => {
                                let zalo_session = match dispatch_session(&zalo_slot_actor, sup.cfg.connect_live_zalo) {
                                    Ok(session) => session,
                                    Err(code) => { sup.push_log("error", Some(&bot.bot_key), "undo", code); continue; }
                                };
                                let disp = sup.dispatcher.clone();
                                let bkey = bot.bot_key.clone();
                                let z_opt = zalo_session.clone();
                                tokio::spawn(async move {
                                    let _ = disp.handle_undo_event(&bkey, &undo, z_opt.as_ref()).await;
                                });
                            }
                            ZaloWsEvent::Reaction(react) => {
                                let zalo_session = match dispatch_session(&zalo_slot_actor, sup.cfg.connect_live_zalo) {
                                    Ok(session) => session,
                                    Err(code) => { sup.push_log("error", Some(&bot.bot_key), "reaction", code); continue; }
                                };
                                if react.thread_type.is_group() && !react.is_self && react.r_type > 0 {
                                    sup.caches.record_locmem_activity(
                                        &bot.bot_key,
                                        react.thread_id.as_str(),
                                        react.sender_uid.as_str(),
                                        0,
                                        1,
                                        0,
                                    );
                                }
                                let disp = sup.dispatcher.clone();
                                let bkey = bot.bot_key.clone();
                                let z_opt = zalo_session.clone();
                                tokio::spawn(async move {
                                    let _ = disp.handle_reaction_event(&bkey, &react, z_opt).await;
                                });
                            }
                            ZaloWsEvent::GroupEvent(gev) => {
                                let zalo_session = match dispatch_session(&zalo_slot_actor, sup.cfg.connect_live_zalo) {
                                    Ok(session) => session,
                                    Err(code) => { sup.push_log("error", Some(&bot.bot_key), "group-event", code); continue; }
                                };
                                if matches!(
                                    gev.event_type,
                                    GroupEventType::AddAdmin | GroupEventType::RemoveAdmin
                                ) {
                                    group_admins_cache.remove(gev.group_id.as_str());
                                }
                                for m in &gev.target_members {
                                    sup.caches.record_locmem_activity(
                                        &bot.bot_key,
                                        gev.group_id.as_str(),
                                        m.id.as_str(),
                                        0,
                                        0,
                                        1,
                                    );
                                }
                                let disp = sup.dispatcher.clone();
                                let bkey = bot.bot_key.clone();
                                let self_uid = zalo_session
                                    .as_ref()
                                    .and_then(|z| z.uid())
                                    .filter(|u| !u.is_empty())
                                    .unwrap_or_else(|| bot.uid.clone());
                                let profile = BotStyleProfile::from_bot_metadata(
                                    &bot.metadata,
                                    Some(&bot.display_name),
                                );
                                let z_opt = zalo_session.clone();
                                tokio::spawn(async move {
                                    disp.handle_group_event(&bkey, &self_uid, &profile, &gev, z_opt)
                                        .await;
                                });
                            }
                            ZaloWsEvent::Disconnected { reason, .. } => {
                                status_tx.send_modify(|s| {
                                    s.ws_connected = false;
                                    s.ws_ready = false;
                                    s.status = BotStatusV2::ListenerDisconnected;
                                    s.last_error = Some(reason.clone());
                                    s.last_event_at = Some(Utc::now().to_rfc3339());
                                });
                                if let Ok(Some(mut rec)) = sup.caches.engine().get_bot(&bot.bot_key) {
                                    if rec.status == "running" {
                                        rec.status = "listener_disconnected".to_string();
                                        rec.updated_at = Utc::now().to_rfc3339();
                                        let _ = sup.caches.engine().upsert_bot(&rec);
                                    }
                                }
                                sup.emit_status(&bot.bot_key, BotStatusV2::ListenerDisconnected, Some(reason));
                            }
                            ZaloWsEvent::DuplicateConnection { .. } => {
                                status_tx.send_modify(|s| {
                                    s.ws_connected = false;
                                    s.ws_ready = false;
                                    s.status = BotStatusV2::ListenerDisconnected;
                                    s.last_error = Some("DUPLICATE_CONNECTION_3000".into());
                                    s.last_event_at = Some(Utc::now().to_rfc3339());
                                });
                                if let Ok(Some(mut rec)) = sup.caches.engine().get_bot(&bot.bot_key) {
                                    rec.status = "listener_disconnected".to_string();
                                    rec.updated_at = Utc::now().to_rfc3339();
                                    let _ = sup.caches.engine().upsert_bot(&rec);
                                }
                                sup.emit_status(&bot.bot_key, BotStatusV2::ListenerDisconnected, Some("DUPLICATE_CONNECTION_3000".into()));
                            }
                            ZaloWsEvent::Typing(_) | ZaloWsEvent::UploadDone(_) => {}
                        }
                    }
                }
            }
        });

        BotActorHandle {
            tx,
            status_rx,
            zalo_session: zalo_slot,
            cancel,
            join_handle,
        }
    }
}

fn extract_chat_policy(metadata: &Value) -> (bool, bool) {
    let grp = metadata
        .get("chatPolicy")
        .and_then(|c| c.get("groupEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let priv_en = metadata
        .get("chatPolicy")
        .and_then(|c| c.get("privateEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    (grp, priv_en)
}

#[async_trait::async_trait]
impl BotFleetController for FleetSupervisor {
    fn is_bot_running(&self, bot_key: &str) -> bool {
        FleetSupervisor::is_bot_running(self, bot_key)
    }

    fn get_live_zalo_session(&self, bot_key: &str) -> Option<Arc<ZaloSession>> {
        FleetSupervisor::get_live_zalo_session(self, bot_key)
    }

    async fn start_bot(&self, bot_key: &str) -> Result<BotStatusV2, String> {
        FleetSupervisor::start_bot(self, bot_key)
            .await
            .map_err(|e| e.to_string())
    }

    async fn stop_bot(
        &self,
        bot_key: &str,
        final_status: BotStatusV2,
        reason: Option<String>,
    ) -> Result<BotStatusV2, String> {
        FleetSupervisor::stop_bot(self, bot_key, final_status, reason)
            .await
            .map_err(|e| e.to_string())
    }

    async fn restart_bot(&self, bot_key: &str) -> Result<BotStatusV2, String> {
        FleetSupervisor::restart_bot(self, bot_key)
            .await
            .map_err(|e| e.to_string())
    }

    async fn delete_bot(&self, bot_key: &str) -> Result<bool, String> {
        FleetSupervisor::delete_bot(self, bot_key)
            .await
            .map_err(|e| e.to_string())
    }

    async fn reload_bot(&self, bot_key: &str) -> Result<BotRecord, String> {
        FleetSupervisor::reload_bot(self, bot_key)
            .await
            .map_err(|e| e.to_string())
    }

    async fn update_bot_prefix(&self, bot_key: &str, new_prefix: &str) -> Result<BotRecord, String> {
        FleetSupervisor::set_bot_prefix(self, bot_key, new_prefix)
            .await
            .map_err(|e| e.to_string())
    }

    async fn claim_weekly_trial(
        &self,
        owner_uid: &str,
        bot_key: &str,
        now: chrono::DateTime<Utc>,
    ) -> Result<TrialLedgerRow, String> {
        FleetSupervisor::claim_weekly_one_hour_trial(self, owner_uid, bot_key, now)
            .map_err(|e| e.to_string())
    }

    async fn relay_command_to_bot(
        &self,
        target_bot_key: &str,
        msg: InboundMessage,
    ) -> Result<String, String> {
        let rep = FleetSupervisor::relay_command(self, target_bot_key, msg, Vec::new())
            .await
            .map_err(|e| e.to_string())?;
        Ok(match rep {
            DispatchReport::CommandExecuted {
                command_name,
                outcome,
                ..
            } => format!("Đã chuyển tiếp lệnh {command_name}: {outcome:?}"),
            DispatchReport::CommandFailed {
                command_name,
                error,
            } => format!("Lỗi khi thực thi {command_name}: {error}"),
            other => format!("Kết quả chuyển tiếp: {other:?}"),
        })
    }
}
