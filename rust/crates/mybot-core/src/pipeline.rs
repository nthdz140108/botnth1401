//! Low-Latency Fast-Path Inbound Pipeline, 8-Stage `LatencyRingBuffer`,
//! 4-Lane `WorkloadBroker`, `CooldownLedger`, Pre-Shedding `!antiundo` Guarantee,
//! V3 Non-Prefixed Hooks (`prefix`, `uid`, `"tha"`, Interactive Wizards, Passive Chat),
//! `"thanks"` Confirmation Reaction, `CLOCK` Cooldown, and `V3ChatStyle` Envelope.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use chrono::Utc;
use dashmap::DashMap;
use moka::sync::Cache;
use mybot_storage::HotStorageCaches;
use mybot_types::{
    ChatScope, ExecutionLane, GroupEvent, InboundMessage, InstanceScope, PermissionTier,
    ReactionEvent, ThreadType, UndoEvent, ZaloId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use zalo_sdk::{OutboundMessage, ZaloSession};

use crate::interaction::{BotFleetController, InteractionEngine, PassiveChatHooks};
use crate::protection::{ModerationDecision, ProtectionEngine, build_anti_undo_alert};
use crate::studio::{
    CommandContext, CommandOutcome, StudioEngine, normalize_command_key, render_studio_template,
};
use crate::v3_style::{
    BotStyleProfile, build_failed, build_from_sql, build_insufficient_authority, build_state_quote,
    build_warning, create_command_error_reference, format_permission_denied,
    build_not_found_command_caption, sanitize_no_markdown, send_quoted_plain_ttl,
    send_reaction_confirm_receive,
};

const RING_CAPACITY: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum LatencyStage {
    WsIngest = 0,
    DedupAndUndoCache = 1,
    RankAndLocmem = 2,
    ProtectionCheck = 3,
    StudioResolve = 4,
    HandlerExecute = 5,
    ReplyTransmit = 6,
    EndToEnd = 7,
}

impl LatencyStage {
    pub const ALL: [Self; 8] = [
        Self::WsIngest,
        Self::DedupAndUndoCache,
        Self::RankAndLocmem,
        Self::ProtectionCheck,
        Self::StudioResolve,
        Self::HandlerExecute,
        Self::ReplyTransmit,
        Self::EndToEnd,
    ];

    pub const fn as_key(self) -> &'static str {
        match self {
            Self::WsIngest => "wsIngestUs",
            Self::DedupAndUndoCache => "dedupUndoCacheUs",
            Self::RankAndLocmem => "rankLocmemUs",
            Self::ProtectionCheck => "protectionUs",
            Self::StudioResolve => "studioResolveUs",
            Self::HandlerExecute => "handlerExecUs",
            Self::ReplyTransmit => "replyTransmitUs",
            Self::EndToEnd => "endToEndUs",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PercentileSummary {
    pub samples: usize,
    pub p50_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub mean_us: u64,
}

struct StageRing {
    slots: Box<[AtomicU64; RING_CAPACITY]>,
    write_idx: AtomicUsize,
}

impl Default for StageRing {
    fn default() -> Self {
        let slots_vec: Vec<AtomicU64> = (0..RING_CAPACITY).map(|_| AtomicU64::new(0)).collect();
        let slots: Box<[AtomicU64; RING_CAPACITY]> = slots_vec
            .into_boxed_slice()
            .try_into()
            .expect("exact ring capacity");
        Self {
            slots,
            write_idx: AtomicUsize::new(0),
        }
    }
}

impl StageRing {
    #[inline]
    fn record(&self, micros: u64) {
        let idx = self.write_idx.fetch_add(1, Ordering::Relaxed) % RING_CAPACITY;
        self.slots[idx].store(micros.max(1), Ordering::Relaxed);
    }

    fn summarize(&self) -> PercentileSummary {
        let total_written = self.write_idx.load(Ordering::Relaxed);
        let len = total_written.min(RING_CAPACITY);
        if len == 0 {
            return PercentileSummary::default();
        }
        let mut samples = Vec::with_capacity(len);
        for i in 0..len {
            let v = self.slots[i].load(Ordering::Relaxed);
            if v > 0 {
                samples.push(v);
            }
        }
        if samples.is_empty() {
            return PercentileSummary::default();
        }
        samples.sort_unstable();
        let n = samples.len();
        let sum: u64 = samples.iter().sum();
        PercentileSummary {
            samples: n,
            p50_us: samples[(n * 50 / 100).min(n - 1)],
            p95_us: samples[(n * 95 / 100).min(n - 1)],
            p99_us: samples[(n * 99 / 100).min(n - 1)],
            mean_us: sum / (n as u64),
        }
    }
}

/// Lock-free 8-stage telemetry tracker (`AtomicU64` 4096-slot ring per stage).
#[derive(Clone)]
pub struct LatencyRingBuffer {
    rings: Arc<[StageRing; 8]>,
}

impl Default for LatencyRingBuffer {
    fn default() -> Self {
        Self {
            rings: Arc::new(std::array::from_fn(|_| StageRing::default())),
        }
    }
}

impl LatencyRingBuffer {
    #[inline]
    pub fn record(&self, stage: LatencyStage, elapsed: Duration) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        self.rings[stage as usize].record(micros);
    }

    pub fn stage_summary(&self, stage: LatencyStage) -> PercentileSummary {
        self.rings[stage as usize].summarize()
    }

    pub fn snapshot_json(&self) -> Value {
        let mut map = serde_json::Map::with_capacity(8);
        for st in LatencyStage::ALL {
            map.insert(
                st.as_key().to_string(),
                serde_json::to_value(self.stage_summary(st)).unwrap_or(Value::Null),
            );
        }
        Value::Object(map)
    }
}

// =============================================================================
// Cooldown & Hourly Quota Ledger
// =============================================================================

#[derive(Default)]
struct CooldownBucket {
    last_used_ms: i64,
    hourly_uses_ms: VecDeque<i64>,
}

#[derive(Clone, Default)]
pub struct CooldownLedger {
    buckets: Arc<DashMap<String, CooldownBucket>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CooldownVerdict {
    Allow,
    CooldownActive { remaining_secs: u64 },
    HourlyQuotaExceeded { max_per_hour: u64 },
}

impl CooldownLedger {
    #[allow(clippy::too_many_arguments)]
    pub fn check_and_record(
        &self,
        bot_key: &str,
        command_name: &str,
        mode: &str,
        thread_id: &str,
        sender_uid: &str,
        cooldown_secs: u64,
        max_uses_per_hour: Option<u64>,
        now_ms: i64,
    ) -> CooldownVerdict {
        if cooldown_secs == 0 && max_uses_per_hour.unwrap_or(0) == 0 {
            return CooldownVerdict::Allow;
        }
        let scope_key = match mode {
            "global" => format!("{bot_key}:{command_name}:global"),
            "perThread" => format!("{bot_key}:{command_name}:thread:{thread_id}"),
            _ => format!("{bot_key}:{command_name}:user:{sender_uid}"),
        };

        let mut entry = self.buckets.entry(scope_key).or_default();
        while let Some(&front) = entry.hourly_uses_ms.front() {
            if now_ms.saturating_sub(front) > 3_600_000 {
                entry.hourly_uses_ms.pop_front();
            } else {
                break;
            }
        }

        if cooldown_secs > 0 && entry.last_used_ms > 0 {
            let cooldown_ms = (cooldown_secs as i64) * 1000;
            let elapsed = now_ms.saturating_sub(entry.last_used_ms);
            if elapsed < cooldown_ms {
                let rem_secs = ((cooldown_ms - elapsed + 999) / 1000).max(1) as u64;
                return CooldownVerdict::CooldownActive {
                    remaining_secs: rem_secs,
                };
            }
        }

        if let Some(limit) = max_uses_per_hour.filter(|&n| n > 0)
            && (entry.hourly_uses_ms.len() as u64) >= limit
        {
            return CooldownVerdict::HourlyQuotaExceeded {
                max_per_hour: limit,
            };
        }

        entry.last_used_ms = now_ms;
        entry.hourly_uses_ms.push_back(now_ms);
        CooldownVerdict::Allow
    }
}

// =============================================================================
// 4-Lane Bounded Workload Broker (`FastText`, `Control`, `Heavy`, `Broadcast`)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatusSnapshot {
    pub job_id: String,
    pub lane: ExecutionLane,
    pub command_name: String,
    pub state: String,
    pub summary: Option<String>,
    pub updated_at_ms: i64,
}

struct LaneGates {
    sem: Arc<Semaphore>,
    capacity: usize,
    active: AtomicUsize,
    completed: AtomicU64,
    failed: AtomicU64,
}

impl LaneGates {
    fn new(capacity: usize) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(capacity)),
            capacity,
            active: AtomicUsize::new(0),
            completed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
        }
    }
}

#[derive(Clone)]
pub struct WorkloadBroker {
    fast: Arc<LaneGates>,
    control: Arc<LaneGates>,
    heavy: Arc<LaneGates>,
    broadcast: Arc<LaneGates>,
    jobs: Cache<String, JobStatusSnapshot>,
}

impl Default for WorkloadBroker {
    fn default() -> Self {
        Self::new(512, 64, 24, 8)
    }
}

impl WorkloadBroker {
    pub fn new(fast_cap: usize, control_cap: usize, heavy_cap: usize, broadcast_cap: usize) -> Self {
        Self {
            fast: Arc::new(LaneGates::new(fast_cap.max(1))),
            control: Arc::new(LaneGates::new(control_cap.max(1))),
            heavy: Arc::new(LaneGates::new(heavy_cap.max(1))),
            broadcast: Arc::new(LaneGates::new(broadcast_cap.max(1))),
            jobs: Cache::builder()
                .max_capacity(10_000)
                .time_to_live(Duration::from_secs(1800))
                .build(),
        }
    }

    fn lane_gates(&self, lane: ExecutionLane) -> &Arc<LaneGates> {
        match lane {
            ExecutionLane::FastText => &self.fast,
            ExecutionLane::Control => &self.control,
            ExecutionLane::Heavy => &self.heavy,
            ExecutionLane::Broadcast => &self.broadcast,
        }
    }

    pub async fn run_in_lane<F, Fut, T>(&self, lane: ExecutionLane, f: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let gates = self.lane_gates(lane).clone();
        let _permit = Arc::clone(&gates.sem)
            .acquire_owned()
            .await
            .map_err(|_| "workload broker closed".to_string())?;
        gates.active.fetch_add(1, Ordering::Relaxed);
        let res = f().await;
        gates.active.fetch_sub(1, Ordering::Relaxed);
        match &res {
            Ok(_) => {
                gates.completed.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                gates.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        res
    }

    pub fn record_job(&self, snap: JobStatusSnapshot) {
        self.jobs.insert(snap.job_id.clone(), snap);
    }

    pub fn get_job(&self, job_id: &str) -> Option<JobStatusSnapshot> {
        self.jobs.get(job_id)
    }

    pub fn telemetry_json(&self) -> Value {
        let render = |g: &LaneGates| {
            json!({
                "capacity": g.capacity,
                "active": g.active.load(Ordering::Relaxed),
                "available": g.sem.available_permits(),
                "completed": g.completed.load(Ordering::Relaxed),
                "failed": g.failed.load(Ordering::Relaxed),
            })
        };
        json!({
            "fastText": render(&self.fast),
            "control": render(&self.control),
            "heavy": render(&self.heavy),
            "broadcast": render(&self.broadcast),
        })
    }
}

// =============================================================================
// Fast-Path Dispatcher (Dedup -> Pre-Shedding Undo Cache -> Shed -> Anti -> V3 Hooks -> Studio)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum DispatchReport {
    DuplicateIgnored,
    LoadShed {
        in_flight: usize,
        max_in_flight: usize,
        undo_cached: bool,
    },
    Moderated {
        decision: ModerationDecision,
    },
    PassiveMessage,
    Ignored {
        reason_code: &'static str,
        detail: String,
    },
    CommandExecuted {
        command_name: String,
        outcome: CommandOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery_error: Option<String>,
    },
    CommandFailed {
        command_name: String,
        error: String,
    },
}

#[derive(Clone)]
pub struct BotExecutionMeta {
    pub bot_key: String,
    pub is_main_bot: bool,
    pub self_uid: ZaloId,
    pub prefix: String,
    pub self_listen: bool,
    pub identity_pending: bool,
    pub sender_tier: PermissionTier,
    pub zalo: Option<Arc<ZaloSession>>,
    pub assets_root: PathBuf,
    pub style_profile: BotStyleProfile,
    pub chat_policy_group: bool,
    pub chat_policy_private: bool,
    pub fleet: Option<Arc<dyn BotFleetController>>,
    pub outbound_sink: Option<Arc<parking_lot::Mutex<Vec<OutboundMessage>>>>,
}

impl Default for BotExecutionMeta {
    fn default() -> Self {
        Self {
            bot_key: "admin".to_string(),
            is_main_bot: true,
            self_uid: ZaloId::default(),
            prefix: "!".to_string(),
            self_listen: true,
            identity_pending: false,
            sender_tier: PermissionTier::All,
            zalo: None,
            assets_root: PathBuf::from("assets"),
            style_profile: BotStyleProfile::default(),
            chat_policy_group: true,
            chat_policy_private: true,
            fleet: None,
            outbound_sink: None,
        }
    }
}

#[derive(Clone)]
pub struct FastPathDispatcher {
    caches: HotStorageCaches,
    protection: ProtectionEngine,
    studio: Arc<StudioEngine>,
    broker: WorkloadBroker,
    cooldowns: CooldownLedger,
    interactions: Arc<InteractionEngine>,
    passive_hooks: Arc<parking_lot::RwLock<Option<Arc<dyn PassiveChatHooks>>>>,
    latency: LatencyRingBuffer,
    dedup: Cache<(String, ThreadType, ZaloId, ZaloId, String), ()>,
    antiundo_recent: Cache<(String, String), ()>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: usize,
    shed_counter: Arc<AtomicU64>,
    processed_counter: Arc<AtomicU64>,
}

impl FastPathDispatcher {
    pub fn new(
        caches: HotStorageCaches,
        protection: ProtectionEngine,
        studio: Arc<StudioEngine>,
        broker: WorkloadBroker,
        max_in_flight: usize,
    ) -> Self {
        Self {
            caches,
            protection,
            studio,
            broker,
            cooldowns: CooldownLedger::default(),
            interactions: Arc::new(InteractionEngine::new()),
            passive_hooks: Arc::new(parking_lot::RwLock::new(None)),
            latency: LatencyRingBuffer::default(),
            dedup: Cache::builder()
                .max_capacity(20_000)
                .time_to_live(Duration::from_secs(300))
                .build(),
            antiundo_recent: Cache::builder()
                .max_capacity(10_000)
                .time_to_live(Duration::from_secs(600))
                .build(),
            in_flight: Arc::new(AtomicUsize::new(0)),
            max_in_flight: max_in_flight.max(1),
            shed_counter: Arc::new(AtomicU64::new(0)),
            processed_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_passive_hooks(&self, hooks: Arc<dyn PassiveChatHooks>) {
        *self.passive_hooks.write() = Some(hooks);
    }

    pub fn studio(&self) -> &Arc<StudioEngine> {
        &self.studio
    }

    pub fn protection(&self) -> &ProtectionEngine {
        &self.protection
    }

    pub fn broker(&self) -> &WorkloadBroker {
        &self.broker
    }

    pub fn interactions(&self) -> &Arc<InteractionEngine> {
        &self.interactions
    }

    pub fn latency(&self) -> &LatencyRingBuffer {
        &self.latency
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.load(Ordering::Relaxed)
    }

    pub fn shed_count(&self) -> u64 {
        self.shed_counter.load(Ordering::Relaxed)
    }

    pub fn processed_count(&self) -> u64 {
        self.processed_counter.load(Ordering::Relaxed)
    }

    async fn emit_outbound(&self, meta: &BotExecutionMeta, msg: &InboundMessage, mut out: OutboundMessage) {
        out.text = sanitize_no_markdown(&out.text);
        if let Some(ref sink) = meta.outbound_sink {
            sink.lock().push(out.clone());
        }
        if let Some(ref zalo) = meta.zalo {
            let _ = zalo
                .send_message(out, &msg.thread_id, msg.thread_type)
                .await;
        }
    }

    /// Processes an inbound message end-to-end with pre-shedding `!antiundo` preservation
    /// and 1:1 V3 live-chat routing.
    pub async fn dispatch_inbound(
        &self,
        meta: BotExecutionMeta,
        msg: InboundMessage,
    ) -> DispatchReport {
        let e2e_start = Instant::now();
        let now_ms = Utc::now().timestamp_millis();
        if msg.ws_received_at_ms > 0 && now_ms >= msg.ws_received_at_ms {
            self.latency.record(
                LatencyStage::WsIngest,
                Duration::from_millis((now_ms - msg.ws_received_at_ms) as u64),
            );
        }

        // Ignore own messages unless `self_listen` is explicitly turned on
        if msg.is_self && !meta.self_listen {
            return DispatchReport::Ignored {
                reason_code: "SELF_LISTEN_DISABLED",
                detail: "Tin nhắn tự gửi bị bỏ qua do self_listen tắt".to_string(),
            };
        }
        // Suppress WebSocket self-echoes of messages transmitted by this bot session itself
        if msg.is_self
            && meta.zalo.as_ref().is_some_and(|z| {
                z.is_recent_outbound(&msg.cli_msg_id, &msg.msg_id, &msg.global_msg_id)
            })
        {
            return DispatchReport::Ignored {
                reason_code: "ECHO_SUPPRESSED",
                detail: "Bỏ qua WebSocket echo của tin nhắn bot vừa gửi".to_string(),
            };
        }

        // 1. O(1) Deduplication + PRE-SHEDDING `!antiundo` Cache Guarantee
        let t_dedup = Instant::now();
        let valid_id = |id: &ZaloId| !id.is_empty() && id.as_str() != "0";
        let dedup_id = if valid_id(&msg.msg_id) {
            msg.msg_id.as_str()
        } else if valid_id(&msg.global_msg_id) {
            msg.global_msg_id.as_str()
        } else {
            msg.cli_msg_id.as_str()
        };
        if !dedup_id.is_empty() && dedup_id != "0" {
            let dkey = (
                meta.bot_key.clone(),
                msg.thread_type,
                msg.thread_id.clone(),
                msg.sender_uid.clone(),
                dedup_id.to_string(),
            );
            if self.dedup.contains_key(&dkey) {
                return DispatchReport::DuplicateIgnored;
            }
            self.dedup.insert(dkey, ());
        }

        // CRITICAL INVARIANT: Cache message for `!antiundo` BEFORE checking `max_in_flight`!
        self.caches.cache_inbound_message(&meta.bot_key, &msg);
        self.latency
            .record(LatencyStage::DedupAndUndoCache, t_dedup.elapsed());

        // 2. Bounded In-Flight Admission Gate (load shedding under extreme spikes)
        let prev_in_flight = self.in_flight.fetch_add(1, Ordering::AcqRel);
        if prev_in_flight >= self.max_in_flight {
            self.in_flight.fetch_sub(1, Ordering::AcqRel);
            self.shed_counter.fetch_add(1, Ordering::Relaxed);
            return DispatchReport::LoadShed {
                in_flight: prev_in_flight,
                max_in_flight: self.max_in_flight,
                undo_cached: true,
            };
        }

        struct InFlightGuard(Arc<AtomicUsize>);
        impl Drop for InFlightGuard {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _flight_guard = InFlightGuard(Arc::clone(&self.in_flight));
        self.processed_counter.fetch_add(1, Ordering::Relaxed);

        // 2b. Chat Access Policy (`privateEnabled` / `groupEnabled` in `event-send-msg.js:257-274`)
        if meta.sender_tier < PermissionTier::AdminLevelHigh {
            if msg.thread_type == ThreadType::User && !meta.chat_policy_private {
                return DispatchReport::Ignored {
                    reason_code: "PRIVATE_CHAT_DISABLED",
                    detail: "Chat riêng tư bị tắt trong cấu hình bot".to_string(),
                };
            }
            if msg.thread_type == ThreadType::Group && !meta.chat_policy_group {
                return DispatchReport::Ignored {
                    reason_code: "GROUP_CHAT_DISABLED",
                    detail: "Chat nhóm bị tắt trong cấu hình bot".to_string(),
                };
            }
        }

        // 2c. Global Bot Blocklist (`!ban` / `!blockbot` in `event-send-msg.js:316`)
        if !msg.is_self
            && meta.sender_tier < PermissionTier::AdminLevelHigh
            && self
                .caches
                .engine()
                .is_user_blocked_globally(&meta.bot_key, msg.sender_uid.as_str())
                .unwrap_or(false)
        {
            return DispatchReport::Ignored {
                reason_code: "USER_BLOCKED_GLOBALLY",
                detail: format!("Người dùng {} bị chặn toàn cục", msg.sender_uid),
            };
        }

        // 3. Hot Group Settings + O(1) Rank & `locmem` Activity Tracking
        let t_rank = Instant::now();
        let group_settings = if msg.thread_type == ThreadType::Group {
            if !msg.is_self {
                self.caches.increment_rank(
                    &meta.bot_key,
                    msg.thread_id.as_str(),
                    msg.sender_uid.as_str(),
                    &msg.sender_name,
                );
                self.caches.record_locmem_activity(
                    &meta.bot_key,
                    msg.thread_id.as_str(),
                    msg.sender_uid.as_str(),
                    1,
                    0,
                    0,
                );
            }
            self.caches
                .get_or_default_group_settings(&meta.bot_key, msg.thread_id.as_str())
        } else {
            mybot_storage::GroupSettingsRecord::default_for(&meta.bot_key, msg.thread_id.as_str())
        };
        self.latency
            .record(LatencyStage::RankAndLocmem, t_rank.elapsed());

        // Strip `@Mentions` using exact UTF-16 code unit spans (`format-util.js::removeMention`)
        let clean_text = msg.text_without_mentions();
        let clean_trimmed = clean_text.trim();

        // Allow muted group/bot Admin to invoke `!unmute` before moderation deletes their message (`mute-user.js`)
        let is_admin_unmute = meta.sender_tier >= PermissionTier::AdminBox
            && clean_trimmed
                .strip_prefix(&meta.prefix)
                .and_then(|r| r.split_whitespace().next())
                .is_some_and(|w| w.eq_ignore_ascii_case("unmute"));

        // 4. Message Protection Engine (skip for bot's own self-typed messages or admin `!unmute`)
        let t_prot = Instant::now();
        let decision = if msg.is_self || is_admin_unmute {
            ModerationDecision::Allow
        } else {
            self.protection
                .inspect_inbound(&meta.bot_key, &msg, &group_settings, meta.sender_tier)
                .await
        };
        self.latency
            .record(LatencyStage::ProtectionCheck, t_prot.elapsed());

        if decision.is_blocked() {
            if let Some(zalo) = &meta.zalo {
                let del_msg_id = if !msg.global_msg_id.is_empty() {
                    &msg.global_msg_id
                } else {
                    &msg.msg_id
                };
                let del_res = zalo
                    .delete_message(
                        del_msg_id,
                        &msg.cli_msg_id,
                        &msg.sender_uid,
                        &msg.thread_id,
                        msg.thread_type,
                        false,
                    )
                    .await;
                match &decision {
                    ModerationDecision::WarnAndDelete { warning_text, .. } => {
                        let out = build_warning(&meta.style_profile, &msg, warning_text, false);
                        let mut out_ttl = out;
                        out_ttl.ttl_ms = 30_000;
                        let _ = zalo
                            .send_message(out_ttl, &msg.thread_id, msg.thread_type)
                            .await;
                        // Anti-delete escalation: if offender blocked message deletion, block immediately (`anti-service`)
                        if del_res.is_err() {
                            let _ = zalo
                                .block_users_in_group(
                                    &msg.thread_id,
                                    std::slice::from_ref(&msg.sender_uid),
                                )
                                .await;
                        }
                    }
                    ModerationDecision::KickAndDelete { kick_text, .. } => {
                        let mut out = build_warning(&meta.style_profile, &msg, kick_text, false);
                        out.ttl_ms = 60_000;
                        let _ = zalo
                            .send_message(out, &msg.thread_id, msg.thread_type)
                            .await;
                        if zalo
                            .block_users_in_group(
                                &msg.thread_id,
                                std::slice::from_ref(&msg.sender_uid),
                            )
                            .await
                            .is_err()
                        {
                            let _ = zalo
                                .remove_user_from_group(
                                    &msg.thread_id,
                                    std::slice::from_ref(&msg.sender_uid),
                                )
                                .await;
                        }
                    }
                    ModerationDecision::DeleteOnly { .. } | ModerationDecision::Allow => {}
                }
            }
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::Moderated { decision };
        }

        // ---------------------------------------------------------------------
        // 4b. V3 Non-Prefixed Hooks (`"tha"`, bare `uid`, bare `prefix`, Interactive Wizards)
        // ---------------------------------------------------------------------

        // Bare `"tha"` from Admin immediately halts active `!scold` loop (`scold-user.js`)
        if clean_trimmed.eq_ignore_ascii_case("tha") && meta.sender_tier >= PermissionTier::AdminBox
        {
            let scold_prefix = format!("scold:{}:{}:", meta.bot_key, msg.thread_id);
            if self.interactions.cancel_tasks_with_prefix(&scold_prefix) > 0 {
                let apology = "Dạ đại ca em sẽ tha cho nó ạ!";
                let out = build_state_quote(
                    &meta.style_profile,
                    &msg,
                    apology,
                    true,
                    30_000,
                    false,
                );
                self.emit_outbound(&meta, &msg, out).await;
                self.latency
                    .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                return DispatchReport::CommandExecuted {
                    command_name: "scold".to_string(),
                    outcome: CommandOutcome::Handled {
                        summary: apology.to_string(),
                        reply_text: None,
                        custom_ttl_ms: None,
                    },
                    delivery_error: None,
                };
            }
        }

        // Bare `"uid"` in Direct Message (`event-send-msg.js:278-279`)
        if msg.thread_type == ThreadType::User && clean_trimmed.eq_ignore_ascii_case("uid") {
            let uid_str = msg.sender_uid.to_string();
            if let Some(ref z) = meta.zalo {
                let _ = send_quoted_plain_ttl(z, &msg, &uid_str, 60_000).await;
            } else if let Some(ref sink) = meta.outbound_sink {
                sink.lock().push(OutboundMessage {
                    text: uid_str.clone(),
                    quote: Some(msg.to_quote_target()),
                    ttl_ms: 60_000,
                    link_on: false,
                    ..Default::default()
                });
            }
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::CommandExecuted {
                command_name: "uid".to_string(),
                outcome: CommandOutcome::Handled {
                    summary: uid_str,
                    reply_text: None,
                    custom_ttl_ms: None,
                },
                delivery_error: None,
            };
        }

        // Bare `"prefix"` in Group or Direct Message (`prefix.js:67-78`)
        if clean_trimmed.eq_ignore_ascii_case("prefix") {
            let reply = format!("Prefix bây giờ của bot là: {}", meta.prefix);
            if let Some(ref z) = meta.zalo {
                let _ = send_quoted_plain_ttl(z, &msg, &reply, 30_000).await;
            } else if let Some(ref sink) = meta.outbound_sink {
                sink.lock().push(OutboundMessage {
                    text: reply.clone(),
                    quote: Some(msg.to_quote_target()),
                    ttl_ms: 30_000,
                    link_on: false,
                    ..Default::default()
                });
            }
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::CommandExecuted {
                command_name: "prefix".to_string(),
                outcome: CommandOutcome::Handled {
                    summary: reply,
                    reply_text: None,
                    custom_ttl_ms: None,
                },
                delivery_error: None,
            };
        }

        let is_prefixed = !meta.prefix.is_empty() && clean_trimmed.starts_with(&meta.prefix);

        // Active Interactive Reply Wizards (`youtube`, `zingmp3`, `tiktok`, `qrlogin`, `listgroups`, `scangroups`...)
        if !is_prefixed
            && self
                .interactions
                .try_handle_reply(&meta.bot_key, &msg, meta.zalo.clone())
                .await
        {
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::CommandExecuted {
                command_name: "interactive_reply".to_string(),
                outcome: CommandOutcome::Handled {
                    summary: "Đã xử lý phản hồi tương tác".to_string(),
                    reply_text: None,
                    custom_ttl_ms: None,
                },
                delivery_error: None,
            };
        }

        // Non-prefixed Passive Chat Hooks (`@bot` `autoreply`, `autodownload`, `autojoin`, `replytag`, `dqt-bot`)
        if !is_prefixed {
            let hooks_opt = self.passive_hooks.read().clone();
            if let Some(hooks) = hooks_opt {
                let _ = hooks
                    .on_passive_message(
                        &meta.bot_key,
                        meta.is_main_bot,
                        &meta.self_uid,
                        &meta.prefix,
                        &meta.style_profile,
                        meta.sender_tier,
                        &group_settings,
                        &msg,
                        meta.zalo.clone(),
                    )
                    .await;
            }
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::PassiveMessage;
        }

        // Group `enable_bot` (`activeBot`) & `onlyAdminBox` gates (`command.js:851-859`)
        let is_bot_toggle_cmd = clean_trimmed
            .strip_prefix(&meta.prefix)
            .and_then(|rest| rest.split_whitespace().next())
            .is_some_and(|first| first.eq_ignore_ascii_case("bot"));
        if msg.thread_type == ThreadType::Group {
            if !group_settings.enable_bot
                && meta.sender_tier < PermissionTier::AdminBot
                && !(is_bot_toggle_cmd && meta.sender_tier >= PermissionTier::AdminBox)
            {
                self.latency
                    .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                return DispatchReport::Ignored {
                    reason_code: "GROUP_BOT_DISABLED",
                    detail: format!("Bot đang tắt trong nhóm {}, cần {}bot on để bật", msg.thread_id, meta.prefix),
                };
            }
            let only_admin_box = group_settings
                .settings
                .get("onlyAdminBox")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if only_admin_box && meta.sender_tier < PermissionTier::AdminBox {
                self.latency
                    .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                return DispatchReport::Ignored {
                    reason_code: "ONLY_ADMIN_BOX",
                    detail: "Nhóm đang bật chế độ chỉ Admin Box".to_string(),
                };
            }
        }

        // 5. Command Prefix Parsing (Static 399 Keys + Dynamic `!alias` + `!cmdadd` + Fuzzy Suggestion)
        let t_studio = Instant::now();
        let after_prefix = clean_trimmed[meta.prefix.len()..].trim();
        if after_prefix.is_empty() {
            let cap = build_not_found_command_caption(&meta.prefix, "", &[]);
            let out = build_from_sql(&meta.style_profile, &msg, false, &cap, false, 30_000);
            self.emit_outbound(&meta, &msg, out).await;
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::CommandExecuted {
                command_name: "".to_string(),
                outcome: CommandOutcome::Denied {
                    reason_code: "EMPTY_COMMAND".to_string(),
                    message: cap,
                },
                delivery_error: None,
            };
        }

        let Some(invocation) = self.studio.parse_prefixed_with_dynamic_aliases(
            clean_trimmed,
            &meta.prefix,
            Some(&meta.bot_key),
        ) else {
            let typed_first = after_prefix.split_whitespace().next().unwrap_or_default();
            if let Some(custom_report) = self
                .try_execute_custom_command(&meta, &msg, typed_first, now_ms, e2e_start)
                .await
            {
                return custom_report;
            }

            // V3 Fuzzy Suggestion (`utilities.js::checkNotFindCommand`)
            let candidates: Vec<(&str, PermissionTier)> = self
                .studio
                .registry()
                .handlers()
                .iter()
                .map(|h| (h.spec().name, h.spec().permission))
                .collect();
            let cap = build_not_found_command_caption(&meta.prefix, typed_first, &candidates);
            let out = build_from_sql(&meta.style_profile, &msg, false, &cap, false, 30_000);
            self.emit_outbound(&meta, &msg, out).await;
            self.latency
                .record(LatencyStage::EndToEnd, e2e_start.elapsed());
            return DispatchReport::CommandExecuted {
                command_name: typed_first.to_string(),
                outcome: CommandOutcome::Denied {
                    reason_code: "UNKNOWN_COMMAND".to_string(),
                    message: cap,
                },
                delivery_error: None,
            };
        };

        let spec = invocation.handler.spec();
        let cmd_name = spec.name.to_string();
        let thread_opt = (msg.thread_type == ThreadType::Group).then_some(msg.thread_id.as_str());
        let resolved_cfg = self
            .studio
            .resolve_config(spec.name, Some(&meta.bot_key), thread_opt)
            .map(|r| r.values)
            .unwrap_or_else(|_| json!({}));
        self.latency
            .record(LatencyStage::StudioResolve, t_studio.elapsed());

        let tpl_vars = json!({
            "prefix": meta.prefix,
            "command": spec.name,
            "user": msg.sender_name,
            "userId": msg.sender_uid.as_str(),
            "thread": msg.thread_id.as_str(),
        });

        // 5a. InstanceScope Gate (`mybot`, `cmdadd` require Main Bot)
        if spec.instance_scope == InstanceScope::MainOnly && !meta.is_main_bot {
            return self
                .finish_denied(
                    &meta,
                    &msg,
                    &cmd_name,
                    "INSTANCE_SCOPE_DENIED",
                    "Lệnh này chỉ hoạt động trên Bot Chính.",
                    e2e_start,
                )
                .await;
        }

        // 5b. ChatScope Gate (`Group` vs `Private`)
        let scope_ok = match spec.scope {
            ChatScope::Both => true,
            ChatScope::Group => msg.thread_type == ThreadType::Group,
            ChatScope::Private => msg.thread_type == ThreadType::User,
        };
        if !scope_ok {
            let default_msg = if spec.scope == ChatScope::Group {
                "Lệnh này chỉ có thể sử dụng trong Nhóm chat."
            } else {
                "Lệnh này chỉ có thể sử dụng trong Tin nhắn riêng."
            };
            let custom = custom_studio_tpl(&resolved_cfg, "onScopeDenied", &tpl_vars);
            return self
                .finish_denied(
                    &meta,
                    &msg,
                    &cmd_name,
                    "SCOPE_DENIED",
                    custom.as_deref().unwrap_or(default_msg),
                    e2e_start,
                )
                .await;
        }

        // 5c. Studio V2 Kill Switch (`operation.enabled == false`, bypassed by Bot Admins in V3 `command.js:978` unless Studio force-blocks)
        if resolved_cfg
            .get("operation.enabled")
            .and_then(Value::as_bool)
            == Some(false)
        {
            let custom = custom_studio_tpl(&resolved_cfg, "onKillSwitch", &tpl_vars);
            return self
                .finish_denied(
                    &meta,
                    &msg,
                    &cmd_name,
                    "KILL_SWITCH_ACTIVE",
                    custom
                        .as_deref()
                        .unwrap_or("Lệnh này hiện đang tạm tắt."),
                    e2e_start,
                )
                .await;
        }

        // 5d. Studio V2 Thread / User Restrictions (`whitelist` / `blacklist`)
        if meta.sender_tier < PermissionTier::AdminLevelHigh
            && let Some(deny_msg) = check_studio_restrictions(&resolved_cfg, &msg)
        {
            return self
                .finish_denied(
                    &meta,
                    &msg,
                    &cmd_name,
                    "RESTRICTION_DENIED",
                    &deny_msg,
                    e2e_start,
                )
                .await;
        }

        // 5e. Permission Tier Check (supports dynamic `!setcmd p <cmd> <1-4>` via `access.permission`)
        let configured_perm = if spec.name == "setcmd" {
            PermissionTier::AdminLevelHigh
        } else if spec.name == "prefix" && invocation.args.is_empty() {
            // Viewing `!prefix` without arguments is allowed for everyone (`prefix.js:67`)
            PermissionTier::All
        } else {
            resolved_cfg
                .get("access.permission")
                .and_then(Value::as_str)
                .map(parse_v3_permission_tier)
                .unwrap_or(spec.permission)
                .max(spec.permission)
        };

        if meta.sender_tier < configured_perm {
            let custom = custom_studio_tpl(&resolved_cfg, "onPermissionDenied", &tpl_vars);
            let default_denied = format_permission_denied(configured_perm);
            return self
                .finish_denied(
                    &meta,
                    &msg,
                    &cmd_name,
                    "PERMISSION_DENIED",
                    custom.as_deref().unwrap_or(&default_denied),
                    e2e_start,
                )
                .await;
        }

        // 5f. Minimum Arguments Check
        if invocation.args.len() < spec.min_args {
            return self
                .finish_denied(
                    &meta,
                    &msg,
                    &cmd_name,
                    "MISSING_ARGUMENTS",
                    &format!("Thiếu tham số! Cú pháp: {}{}", meta.prefix, spec.syntax),
                    e2e_start,
                )
                .await;
        }

        // 5g. Cooldown & Hourly Quota Gate (`CLOCK` reaction countdown on user's message like V3!)
        if meta.sender_tier < PermissionTier::AdminBot {
            let mode = resolved_cfg
                .get("operation.cooldownMode")
                .and_then(Value::as_str)
                .unwrap_or("perUser");
            let cd_secs = resolved_cfg
                .get("operation.cooldownSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(spec.default_cooldown_secs as u64);
            let max_hr = resolved_cfg
                .get("operation.maxUsesPerHour")
                .and_then(Value::as_u64);

            match self.cooldowns.check_and_record(
                &meta.bot_key,
                spec.name,
                mode,
                msg.thread_id.as_str(),
                msg.sender_uid.as_str(),
                cd_secs,
                max_hr,
                now_ms,
            ) {
                CooldownVerdict::Allow => {}
                CooldownVerdict::CooldownActive { remaining_secs } => {
                    let mut cd_vars = tpl_vars.clone();
                    cd_vars["remaining"] = json!(remaining_secs);
                    if let Some(custom) = custom_studio_tpl(&resolved_cfg, "onCooldown", &cd_vars) {
                        return self
                            .finish_denied(
                                &meta,
                                &msg,
                                &cmd_name,
                                "COOLDOWN_ACTIVE",
                                &custom,
                                e2e_start,
                            )
                            .await;
                    }
                    if let Some(ref zalo) = meta.zalo {
                        self.interactions.show_cooldown_clock(
                            Arc::clone(zalo),
                            &msg,
                            remaining_secs,
                        );
                    }
                    self.latency
                        .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                    return DispatchReport::CommandExecuted {
                        command_name: cmd_name,
                        outcome: CommandOutcome::Denied {
                            reason_code: "COOLDOWN_ACTIVE".to_string(),
                            message: format!(
                                "Vui lòng chờ {remaining_secs}s trước khi dùng lại lệnh {}{}",
                                meta.prefix, spec.name
                            ),
                        },
                        delivery_error: None,
                    };
                }
                CooldownVerdict::HourlyQuotaExceeded { max_per_hour } => {
                    let fallback = format!(
                        "Lệnh {}{} đã đạt giới hạn {max_per_hour} lượt/giờ.",
                        meta.prefix, spec.name
                    );
                    return self
                        .finish_denied(
                            &meta,
                            &msg,
                            &cmd_name,
                            "HOURLY_QUOTA_EXCEEDED",
                            &fallback,
                            e2e_start,
                        )
                        .await;
                }
            }
        }

        // 5h. V3 `"thanks"` Confirmation Reaction (`command-response.js::sendReactionConfirmReceive`)
        if let Some(ref zalo) = meta.zalo
            && matches!(spec.legacy_type, 1 | 2 | 3 | 5)
        {
            let z_react = Arc::clone(zalo);
            let m_react = msg.clone();
            let ltype = spec.legacy_type;
            tokio::spawn(async move {
                let _ = send_reaction_confirm_receive(&z_react, &m_react, ltype).await;
            });
        }

        // 6. Execute Static `CommandHandler` inside Bounded `WorkloadBroker` Lane
        let ctx = CommandContext {
            bot_key: meta.bot_key.clone(),
            is_main_bot: meta.is_main_bot,
            self_uid: meta.self_uid.clone(),
            prefix: meta.prefix.clone(),
            invoked_alias: invocation.matched_key,
            args: invocation.args,
            raw_args_text: invocation.raw_args_text,
            message: msg.clone(),
            sender_tier: meta.sender_tier,
            group_settings,
            effective_studio_config: resolved_cfg.clone(),
            zalo: meta.zalo.clone(),
            caches: self.caches.clone(),
            assets_root: meta.assets_root.clone(),
            style_profile: meta.style_profile.clone(),
            interactions: Arc::clone(&self.interactions),
            fleet: meta.fleet.clone(),
            outbound_sink: meta.outbound_sink.clone(),
        };

        let handler = invocation.handler;
        let lane = spec.lane;
        let t_exec = Instant::now();
        let exec_res = self
            .broker
            .run_in_lane(lane, || async move {
                handler.execute(ctx).await.map_err(|e| e.to_string())
            })
            .await;
        self.latency
            .record(LatencyStage::HandlerExecute, t_exec.elapsed());

        match exec_res {
            Ok(mut outcome) => {
                // Sanitize summary & reply_text so ZERO raw Markdown ever escapes!
                if let CommandOutcome::Handled {
                    ref mut summary,
                    ref mut reply_text,
                    ..
                } = outcome
                {
                    *summary = sanitize_no_markdown(summary);
                    if let Some(raw_txt) = reply_text.as_mut() {
                        *raw_txt = sanitize_no_markdown(raw_txt);
                    }
                }

                let mut delivery_error = None;
                if let CommandOutcome::Handled {
                    reply_text: Some(ref text),
                    custom_ttl_ms,
                    ..
                } = outcome
                    && !text.is_empty()
                {
                    let t_tx = Instant::now();
                    let ttl_ms = custom_ttl_ms.unwrap_or(60_000);
                    let styled = build_state_quote(
                        &meta.style_profile,
                        &msg,
                        text,
                        true,
                        ttl_ms,
                        true,
                    );
                    if let Some(ref sink) = meta.outbound_sink {
                        sink.lock().push(styled.clone());
                    }
                    if let Some(ref zalo) = meta.zalo
                        && let Err(err) = zalo
                            .send_message(styled, &msg.thread_id, msg.thread_type)
                            .await
                    {
                        let err_text = err.to_string();
                        tracing::warn!(
                            bot = %meta.bot_key,
                            cmd = %cmd_name,
                            thread = %msg.thread_id,
                            error = %err_text,
                            "Failed to transmit styled command reply"
                        );
                        delivery_error = Some(err_text);
                    }
                    self.latency
                        .record(LatencyStage::ReplyTransmit, t_tx.elapsed());
                }
                self.latency
                    .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                DispatchReport::CommandExecuted {
                    command_name: cmd_name,
                    outcome,
                    delivery_error,
                }
            }
            Err(err_str) => {
                let mut err_vars = tpl_vars;
                err_vars["reason"] = json!(err_str);
                let reference = createCommandErrorRefCompat(&msg, &err_str);
                let reply_err = custom_studio_tpl(&resolved_cfg, "onError", &err_vars)
                    .unwrap_or_else(|| {
                        format!(
                            "Đã xảy ra lỗi khi xử lý lệnh. Vui lòng thử lại sau.\nMã lỗi: {reference}"
                        )
                    });
                let styled_err = build_failed(&meta.style_profile, &msg, &reply_err, true);
                self.emit_outbound(&meta, &msg, styled_err).await;
                self.latency
                    .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                DispatchReport::CommandFailed {
                    command_name: cmd_name,
                    error: sanitize_no_markdown(&err_str),
                }
            }
        }
    }

    async fn try_execute_custom_command(
        &self,
        meta: &BotExecutionMeta,
        msg: &InboundMessage,
        typed_first: &str,
        now_ms: i64,
        e2e_start: Instant,
    ) -> Option<DispatchReport> {
        let norm = normalize_command_key(typed_first);
        let mut custom_list = self
            .caches
            .engine()
            .list_custom_commands(Some(&meta.bot_key))
            .unwrap_or_default();
        if meta.bot_key != "admin"
            && let Ok(mut global_list) = self.caches.engine().list_custom_commands(Some("admin"))
        {
            custom_list.append(&mut global_list);
        }
        let (cmd_bot_key, trigger_name, mut def_json, _enabled) = custom_list
            .into_iter()
            .find(|(_, name, _, enabled)| *enabled && normalize_command_key(name) == norm)?;

        if meta.sender_tier < PermissionTier::AdminBot {
            match self.cooldowns.check_and_record(
                &meta.bot_key,
                &format!("custom:{trigger_name}"),
                "perUser",
                msg.thread_id.as_str(),
                msg.sender_uid.as_str(),
                30,
                None,
                now_ms,
            ) {
                CooldownVerdict::Allow => {}
                CooldownVerdict::CooldownActive { remaining_secs } => {
                    if let Some(ref zalo) = meta.zalo {
                        self.interactions
                            .show_cooldown_clock(Arc::clone(zalo), msg, remaining_secs);
                    }
                    self.latency
                        .record(LatencyStage::EndToEnd, e2e_start.elapsed());
                    return Some(DispatchReport::CommandExecuted {
                        command_name: trigger_name,
                        outcome: CommandOutcome::Denied {
                            reason_code: "COOLDOWN_ACTIVE".to_string(),
                            message: format!("Chờ {remaining_secs}s"),
                        },
                        delivery_error: None,
                    });
                }
                CooldownVerdict::HourlyQuotaExceeded { .. } => {}
            }
        }

        if let Some(ref zalo) = meta.zalo {
            let z_c = Arc::clone(zalo);
            let m_c = msg.clone();
            tokio::spawn(async move {
                let _ = send_reaction_confirm_receive(&z_c, &m_c, 3).await;
            });
        }

        let mut attachments = Vec::new();
        if let Some(arr) = def_json.get("attachments").and_then(Value::as_array) {
            for item in arr {
                if let Some(p) = item.as_str().or_else(|| item.get("path").and_then(Value::as_str))
                    && !p.is_empty()
                {
                    let pb = PathBuf::from(p);
                    if pb.exists() {
                        attachments.push(pb);
                    }
                }
            }
        }
        if attachments.is_empty() {
            if let Some(p) = def_json.get("media").and_then(|m| m.get("path")).and_then(Value::as_str) {
                let pb = PathBuf::from(p);
                if pb.exists() {
                    attachments.push(pb);
                }
            }
        }

        let raw_response = def_json
            .get("content")
            .or_else(|| def_json.get("responseContent"))
            .or_else(|| def_json.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let clean_body = sanitize_no_markdown(raw_response);
        let mut out = build_state_quote(
            &meta.style_profile,
            msg,
            &clean_body,
            true,
            60_000,
            false,
        );
        out.attachments = attachments;
        self.emit_outbound(meta, msg, out).await;

        let prev_usage = def_json
            .get("usageCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if let Some(obj) = def_json.as_object_mut() {
            obj.insert("usageCount".to_string(), serde_json::json!(prev_usage + 1));
            obj.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
        }
        let _ = self
            .caches
            .engine()
            .upsert_custom_command(&cmd_bot_key, &trigger_name, &def_json, true);

        self.latency
            .record(LatencyStage::EndToEnd, e2e_start.elapsed());
        Some(DispatchReport::CommandExecuted {
            command_name: trigger_name,
            outcome: CommandOutcome::Handled {
                summary: clean_body,
                reply_text: None,
                custom_ttl_ms: None,
            },
            delivery_error: None,
        })
    }

    /// Handles an inbound `ReactionEvent` (forwarding to `InteractionEngine` for `❤️` / `👍` workflows).
    pub async fn handle_reaction_event(
        &self,
        bot_key: &str,
        react: &ReactionEvent,
        zalo: Option<Arc<ZaloSession>>,
    ) -> bool {
        self.interactions
            .try_handle_reaction(bot_key, react, zalo)
            .await
    }

    /// Handles an inbound `GroupEvent` (`welcome`, `bye`, `approve`, `target`, `antijoin`, `antiblockall`).
    pub async fn handle_group_event(
        &self,
        bot_key: &str,
        self_uid: &ZaloId,
        profile: &BotStyleProfile,
        gev: &GroupEvent,
        zalo: Option<Arc<ZaloSession>>,
    ) {
        let hooks_opt = self.passive_hooks.read().clone();
        if let Some(hooks) = hooks_opt {
            hooks
                .on_group_event(bot_key, self_uid, profile, gev, zalo)
                .await;
        }
    }

    /// Handles an inbound `UndoEvent` (`!antiundo` recall recovery via 3-key hot/cold lookup,
    /// respecting whitelist & 10m anti-repeat, and restoring recalled media via `PassiveChatHooks`).
    pub async fn handle_undo_event(
        &self,
        bot_key: &str,
        undo: &UndoEvent,
        zalo: Option<&Arc<ZaloSession>>,
    ) -> Option<String> {
        if undo.is_self || undo.thread_type != ThreadType::Group {
            return None;
        }
        let group = self
            .caches
            .get_or_default_group_settings(bot_key, undo.thread_id.as_str());
        if !group.enable_bot || !group.anti_undo {
            return None;
        }

        // Exempt whitelisted users and group `adminList` members (`anti-undo.js`)
        let sender = undo.sender_uid.as_str();
        let in_whitelist = group
            .settings
            .get("whiteList")
            .and_then(Value::as_object)
            .is_some_and(|w| w.contains_key(sender))
            || group
                .settings
                .get("whitelist")
                .and_then(Value::as_array)
                .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(sender)));
        let in_admin_list = group
            .settings
            .get("adminList")
            .and_then(Value::as_object)
            .is_some_and(|a| a.contains_key(sender));
        if in_whitelist || in_admin_list {
            return None;
        }

        let dedup_key = (
            bot_key.to_string(),
            format!("{}:{}", undo.cli_msg_id, undo.global_msg_id),
        );
        if self.antiundo_recent.contains_key(&dedup_key) {
            return None;
        }
        self.antiundo_recent.insert(dedup_key, ());

        let cached = self.caches.lookup_undo_target(
            bot_key,
            undo.cli_msg_id.as_str(),
            undo.global_msg_id.as_str(),
            Some(undo.global_msg_id.as_str()),
        )?;

        let profile = self
            .caches
            .engine()
            .get_bot(bot_key)
            .ok()
            .flatten()
            .map(|b| BotStyleProfile::from_bot_metadata(&b.metadata, Some(&b.display_name)))
            .unwrap_or_default();

        let hooks_opt = self.passive_hooks.read().clone();
        if let Some(hooks) = hooks_opt
            && let Some(rich_summary) = hooks
                .on_rich_undo(
                    bot_key,
                    &profile,
                    &group,
                    &cached,
                    undo,
                    zalo.cloned(),
                )
                .await
        {
            return Some(rich_summary);
        }

        let alert = sanitize_no_markdown(&build_anti_undo_alert(&cached, undo));
        if let Some(z) = zalo {
            let mut out = crate::v3_style::build_state_no_quote(&profile, true, &alert, true, 60_000);
            out.ttl_ms = 60_000;
            let _ = z
                .send_message(out, &undo.thread_id, undo.thread_type)
                .await;
        }
        Some(alert)
    }

    async fn finish_denied(
        &self,
        meta: &BotExecutionMeta,
        msg: &InboundMessage,
        cmd_name: &str,
        reason_code: &str,
        message: &str,
        e2e_start: Instant,
    ) -> DispatchReport {
        let clean = sanitize_no_markdown(message);
        if !clean.is_empty() {
            let styled = if reason_code == "PERMISSION_DENIED" || reason_code == "INSTANCE_SCOPE_DENIED" {
                build_insufficient_authority(&meta.style_profile, msg, &clean, true)
            } else {
                build_warning(&meta.style_profile, msg, &clean, true)
            };
            self.emit_outbound(meta, msg, styled).await;
        }
        self.latency
            .record(LatencyStage::EndToEnd, e2e_start.elapsed());
        DispatchReport::CommandExecuted {
            command_name: cmd_name.to_string(),
            outcome: CommandOutcome::Denied {
                reason_code: reason_code.to_string(),
                message: clean,
            },
            delivery_error: None,
        }
    }
}

#[allow(non_snake_case)]
fn createCommandErrorRefCompat(msg: &InboundMessage, err_str: &str) -> String {
    create_command_error_reference(msg, err_str)
}

fn parse_v3_permission_tier(s: &str) -> PermissionTier {
    match s.trim() {
        "adminLevelHigh" | "high" | "4" => PermissionTier::AdminLevelHigh,
        "adminBot" | "bot" | "3" => PermissionTier::AdminBot,
        "adminBox" | "box" | "2" => PermissionTier::AdminBox,
        _ => PermissionTier::All,
    }
}

fn custom_studio_tpl(cfg: &Value, key: &str, vars: &Value) -> Option<String> {
    if cfg
        .get("responses.useCustomTemplates")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return None;
    }
    let full_key = format!("responses.templates.{key}");
    let raw = cfg.get(&full_key).and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(sanitize_no_markdown(&render_studio_template(raw, vars)))
}

fn check_studio_restrictions(cfg: &Value, msg: &InboundMessage) -> Option<String> {
    let mode = cfg
        .get("restrictions.mode")
        .and_then(Value::as_str)
        .unwrap_or("all");

    let list_contains = |field: &str, target: &str| -> bool {
        cfg.get(field)
            .and_then(Value::as_array)
            .is_some_and(|arr| {
                arr.iter().any(|item| {
                    item.as_str() == Some(target)
                        || item.get("id").and_then(Value::as_str) == Some(target)
                })
            })
    };

    if mode == "blacklist" && list_contains("restrictions.blockedThreads", msg.thread_id.as_str()) {
        return Some("Nhóm này đang nằm trong danh sách hạn chế sử dụng lệnh.".to_string());
    }
    if mode == "whitelist" {
        let thread_ok = list_contains("restrictions.allowedThreads", msg.thread_id.as_str());
        let user_ok = list_contains("restrictions.allowedUsers", msg.sender_uid.as_str());
        if !thread_ok && !user_ok {
            return Some("Lệnh này hiện chỉ cho phép nhóm/thành viên trong whitelist.".to_string());
        }
    }
    None
}
