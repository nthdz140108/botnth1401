//! Interactive Multi-Step Quote-Reply, Numeric Selection, Reaction Confirmation,
//! `CLOCK` (`🕑`) Countdown Engine (`interaction-countdown.js` parity), and
//! Fleet / Passive Hook Traits.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use mybot_storage::{BotRecord, GroupSettingsRecord, TrialLedgerRow};
use mybot_types::{
    BotStatusV2, GroupEvent, InboundMessage, PermissionTier, ReactionEvent, ThreadType, UndoEvent,
    ZaloId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use zalo_sdk::{ReactionBatchOp, ReactionBatchTarget, ZaloSession};

use crate::v3_style::BotStyleProfile;

pub const MAX_REACTION_BATCH_SIZE: usize = 50;

/// Extracted Zalo message identifier triple (`msgId`, `cliMsgId`, `globalMsgId`) from any
/// `ZaloSession::send_*` JSON receipt (`interaction-countdown.js::normalizeMessageReference`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BotMessageRef {
    pub thread_id: ZaloId,
    pub thread_type: ThreadType,
    pub msg_id: ZaloId,
    pub cli_msg_id: ZaloId,
    pub global_msg_id: ZaloId,
    pub sender_uid: ZaloId,
}

impl BotMessageRef {
    pub fn is_valid_target(&self) -> bool {
        !self.thread_id.is_empty() && (!self.msg_id.is_empty() || !self.cli_msg_id.is_empty())
    }

    pub fn matches_quote(&self, quote: &mybot_types::QuotedMessage) -> bool {
        let q_cli = quote.cli_msg_id.as_str();
        let q_glob = quote.global_msg_id.as_str();
        (!self.cli_msg_id.is_empty() && !q_cli.is_empty() && self.cli_msg_id.as_str() == q_cli)
            || (!self.msg_id.is_empty() && !q_glob.is_empty() && self.msg_id.as_str() == q_glob)
            || (!self.global_msg_id.is_empty()
                && !q_glob.is_empty()
                && self.global_msg_id.as_str() == q_glob)
            || (!self.msg_id.is_empty() && !q_cli.is_empty() && self.msg_id.as_str() == q_cli)
    }

    pub fn matches_reaction(&self, react: &ReactionEvent) -> bool {
        let r_msg = react.msg_id.as_str();
        let r_cli = react.cli_msg_id.as_str();
        (!self.msg_id.is_empty() && !r_msg.is_empty() && self.msg_id.as_str() == r_msg)
            || (!self.global_msg_id.is_empty()
                && !r_msg.is_empty()
                && self.global_msg_id.as_str() == r_msg)
            || (!self.cli_msg_id.is_empty() && !r_cli.is_empty() && self.cli_msg_id.as_str() == r_cli)
    }
}

fn val_to_nonempty_str(v: Option<&Value>) -> Option<String> {
    let val = v?;
    match val {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn pick_first_id<'a>(candidates: impl IntoIterator<Item = Option<&'a Value>>) -> String {
    for c in candidates {
        if let Some(s) = val_to_nonempty_str(c) {
            return s;
        }
    }
    String::new()
}

/// Extracts `(msg_id, cli_msg_id, global_msg_id)` across all nested shapes returned by
/// `send_message`, `send_image`, `send_video`, `send_voice`, `send_link` (`interaction-countdown.js:17-297`).
pub fn extract_receipt_ref(
    receipt: &Value,
    thread_id: &ZaloId,
    thread_type: ThreadType,
    self_uid: &ZaloId,
) -> BotMessageRef {
    let inner_msg = match receipt.get("message") {
        Some(Value::Array(arr)) => arr.first(),
        Some(other) => Some(other),
        None => None,
    };
    let attach0 = match receipt
        .get("attachment")
        .or_else(|| receipt.get("attachments"))
    {
        Some(Value::Array(arr)) => arr.first(),
        Some(other) => Some(other),
        None => None,
    };
    let link_msg = receipt.get("link");

    let msg_id = pick_first_id([
        receipt.pointer("/data/msgId"),
        receipt.pointer("/data/globalMsgId"),
        receipt.pointer("/data/msgIds/0"),
        receipt.get("msgId"),
        receipt.get("globalMsgId"),
        receipt.pointer("/msgIds/0"),
        inner_msg.and_then(|v| v.pointer("/data/msgId")),
        inner_msg.and_then(|v| v.pointer("/data/globalMsgId")),
        inner_msg.and_then(|v| v.get("msgId")),
        inner_msg.and_then(|v| v.get("globalMsgId")),
        attach0.and_then(|v| v.pointer("/data/msgId")),
        attach0.and_then(|v| v.pointer("/data/globalMsgId")),
        attach0.and_then(|v| v.get("msgId")),
        attach0.and_then(|v| v.get("globalMsgId")),
        attach0.and_then(|v| v.get("photoId")),
        attach0.and_then(|v| v.get("fileId")),
        link_msg.and_then(|v| v.pointer("/data/msgId")),
        link_msg.and_then(|v| v.get("msgId")),
    ]);

    let cli_msg_id = pick_first_id([
        receipt.pointer("/data/cliMsgId"),
        receipt.get("cliMsgId"),
        receipt.pointer("/data/clientId"),
        receipt.get("clientId"),
        inner_msg.and_then(|v| v.pointer("/data/cliMsgId")),
        inner_msg.and_then(|v| v.get("cliMsgId")),
        inner_msg.and_then(|v| v.get("clientId")),
        attach0.and_then(|v| v.pointer("/data/cliMsgId")),
        attach0.and_then(|v| v.get("cliMsgId")),
        attach0.and_then(|v| v.get("clientId")),
        attach0.and_then(|v| v.get("clientFileId")),
        link_msg.and_then(|v| v.pointer("/data/cliMsgId")),
        link_msg.and_then(|v| v.get("cliMsgId")),
    ]);

    let global_msg_id = pick_first_id([
        receipt.pointer("/data/globalMsgId"),
        receipt.get("globalMsgId"),
        inner_msg.and_then(|v| v.pointer("/data/globalMsgId")),
        inner_msg.and_then(|v| v.get("globalMsgId")),
        attach0.and_then(|v| v.pointer("/data/globalMsgId")),
        attach0.and_then(|v| v.get("globalMsgId")),
    ]);
    let effective_global = if global_msg_id.is_empty() {
        msg_id.clone()
    } else {
        global_msg_id
    };

    BotMessageRef {
        thread_id: thread_id.clone(),
        thread_type,
        msg_id: ZaloId::new(msg_id),
        cli_msg_id: ZaloId::new(cli_msg_id),
        global_msg_id: ZaloId::new(effective_global),
        sender_uid: self_uid.clone(),
    }
}

pub fn build_reaction_ops_for_count(
    icon: &str,
    msg_ref: &BotMessageRef,
    count: usize,
) -> Vec<ReactionBatchOp> {
    let mut ops = Vec::new();
    let mut rem = count;
    let target = ReactionBatchTarget {
        msg_id: if !msg_ref.msg_id.is_empty() {
            msg_ref.msg_id.clone()
        } else {
            msg_ref.global_msg_id.clone()
        },
        cli_msg_id: msg_ref.cli_msg_id.clone(),
    };
    while rem > 0 {
        let chunk = rem.min(MAX_REACTION_BATCH_SIZE);
        ops.push(ReactionBatchOp {
            icon: icon.to_string(),
            targets: vec![target.clone(); chunk],
        });
        rem -= chunk;
    }
    ops
}

pub async fn replace_countdown_reaction_frame(
    zalo: &ZaloSession,
    msg_ref: &BotMessageRef,
    rendered_count: usize,
    next_count: usize,
) -> usize {
    if rendered_count == next_count || !msg_ref.is_valid_target() {
        return rendered_count;
    }
    let mut ops = build_reaction_ops_for_count("UNDO", msg_ref, rendered_count);
    ops.extend(build_reaction_ops_for_count("CLOCK", msg_ref, next_count));
    if ops.is_empty() {
        return rendered_count;
    }
    match zalo
        .add_reaction_batch(&ops, &msg_ref.thread_id, msg_ref.thread_type)
        .await
    {
        Ok(_) => next_count,
        Err(_) => rendered_count,
    }
}

pub async fn recall_bot_message(zalo: &ZaloSession, msg_ref: &BotMessageRef) -> bool {
    let msg_id = if !msg_ref.global_msg_id.is_empty() {
        &msg_ref.global_msg_id
    } else {
        &msg_ref.msg_id
    };
    if msg_ref.thread_id.is_empty() || msg_id.is_empty() || msg_ref.cli_msg_id.is_empty() {
        return false;
    }
    for attempt in 0..=2u64 {
        if zalo
            .undo_message(
                msg_id,
                &msg_ref.cli_msg_id,
                &msg_ref.thread_id,
                msg_ref.thread_type,
            )
            .await
            .is_ok()
        {
            return true;
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
        }
    }
    false
}

// =============================================================================
// Interactive Reply & Reaction Continuation Engine (`InteractionEngine`)
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyResolution {
    /// Reply was not meant for this wizard; keep wizard alive and let pipeline continue.
    NotMatched,
    /// User sent invalid input (e.g. invalid prefix or out-of-range number); keep wizard alive,
    /// stop processing this message further.
    KeepWaiting,
    /// Reply consumed and succeeded; countdown & prompt were cleaned up.
    Consumed,
    /// Reply matched and triggered prompt recall, then failed (e.g. network error); reopen wizard!
    ReopenOnFailure,
}

pub type ReplyCallbackFn = dyn Fn(InboundMessage, Option<Arc<ZaloSession>>) -> Pin<Box<dyn Future<Output = ReplyResolution> + Send>>
    + Send
    + Sync;

pub type ReactionCallbackFn = dyn Fn(ReactionEvent, Option<Arc<ZaloSession>>) -> Pin<Box<dyn Future<Output = bool> + Send>>
    + Send
    + Sync;

pub type ExpireCallbackFn = dyn Fn(Option<Arc<ZaloSession>>) -> Pin<Box<dyn Future<Output = ()> + Send>>
    + Send
    + Sync;

pub struct InteractiveReplySpec {
    pub key: String,
    pub bot_key: String,
    pub thread_id: ZaloId,
    pub sender_uid: ZaloId,
    pub prompt_ref: BotMessageRef,
    /// When `true`, user MUST quote `prompt_ref` (`zingmp3`, `zingchart`, `soundcloud`, `nhaccuatui`, `qrlogin`, `listgroups`, `scangroups`).
    /// When `false`, user may either quote `prompt_ref` OR send a bare selection (`youtube`, `tiktok`, `capcut`, `spotify`, `download`, `mybot active`).
    pub require_quote: bool,
    pub ttl: Duration,
    pub recall_on_consume: bool,
    pub recall_on_expire: bool,
    pub show_clock: bool,
    pub on_reply: Arc<ReplyCallbackFn>,
    pub on_expire: Option<Arc<ExpireCallbackFn>>,
}

struct ActiveReplySession {
    spec: InteractiveReplySpec,
    expires_at: Instant,
    cancel: CancellationToken,
    rendered_clock: Arc<AtomicUsize>,
    busy: AsyncMutex<()>,
    stopped: AtomicBool,
}

pub struct InteractiveReactionSpec {
    pub key: String,
    pub bot_key: String,
    pub thread_id: ZaloId,
    /// Empty means ANY user's reaction on `prompt_ref` triggers it (e.g. TikTok `❤️` next-video? In V3 `tiktok-command.js` checks sender or anyone; if `Some`, restricts to that UID).
    pub allowed_sender_uid: Option<ZaloId>,
    pub prompt_ref: BotMessageRef,
    /// Allowed reaction icons or names, e.g. `&["/-heart", "/-strong"]`.
    pub accepted_icons: Vec<String>,
    pub ttl: Duration,
    pub recall_on_consume: bool,
    pub recall_on_expire: bool,
    pub show_clock: bool,
    pub on_reaction: Arc<ReactionCallbackFn>,
    pub on_expire: Option<Arc<ExpireCallbackFn>>,
}

struct ActiveReactionSession {
    spec: InteractiveReactionSpec,
    expires_at: Instant,
    cancel: CancellationToken,
    rendered_clock: Arc<AtomicUsize>,
    stopped: AtomicBool,
}

struct CountdownSessionHandle {
    cancel: CancellationToken,
    msg_ref: BotMessageRef,
    rendered_count: Arc<AtomicUsize>,
}

#[derive(Clone, Default)]
pub struct InteractionEngine {
    replies: Arc<DashMap<String, Arc<ActiveReplySession>>>,
    reactions: Arc<DashMap<String, Arc<ActiveReactionSession>>>,
    countdowns: Arc<DashMap<String, CountdownSessionHandle>>,
    named_tasks: Arc<DashMap<String, CancellationToken>>,
}

impl InteractionEngine {
    pub fn new() -> Self {
        Self::default()
    }

    // -------------------------------------------------------------------------
    // Named Cancellable Tasks (`!scold` `"tha"`, `!todo_stop`, `!spamgroup stop`, `!sendstk`, `!sendtext`)
    // -------------------------------------------------------------------------

    pub fn register_named_task(&self, task_key: impl Into<String>) -> CancellationToken {
        let key = task_key.into();
        if let Some((_, old)) = self.named_tasks.remove(&key) {
            old.cancel();
        }
        let token = CancellationToken::new();
        self.named_tasks.insert(key, token.clone());
        token
    }

    pub fn cancel_named_task(&self, task_key: &str) -> bool {
        if let Some((_, tok)) = self.named_tasks.remove(task_key) {
            tok.cancel();
            true
        } else {
            false
        }
    }


    pub fn cancel_tasks_with_prefix(&self, prefix: &str) -> usize {
        let keys: Vec<String> = self
            .named_tasks
            .iter()
            .filter(|e| e.key().starts_with(prefix))
            .map(|e| e.key().clone())
            .collect();
        let mut count = 0;
        for k in keys {
            if self.cancel_named_task(&k) {
                count += 1;
            }
        }
        count
    }

    pub fn has_named_task(&self, task_key: &str) -> bool {
        self.named_tasks
            .get(task_key)
            .is_some_and(|t| !t.is_cancelled())
    }

    /// Returns the prompt message IDs of all currently registered active reaction sessions.
    pub fn list_active_reaction_prompt_ids(&self) -> Vec<ZaloId> {
        self.reactions
            .iter()
            .map(|e| e.value().spec.prompt_ref.msg_id.clone())
            .collect()
    }

    // -------------------------------------------------------------------------
    // Standalone `CLOCK` (`🕑`) Countdown & Cooldown Indicator
    // -------------------------------------------------------------------------

    pub fn show_cooldown_clock(
        &self,
        zalo: Arc<ZaloSession>,
        msg: &InboundMessage,
        remaining_secs: u64,
    ) {
        let secs = remaining_secs.clamp(1, 120) as usize;
        let msg_ref = BotMessageRef {
            thread_id: msg.thread_id.clone(),
            thread_type: msg.thread_type,
            msg_id: if !msg.msg_id.is_empty() {
                msg.msg_id.clone()
            } else {
                msg.global_msg_id.clone()
            },
            cli_msg_id: msg.cli_msg_id.clone(),
            global_msg_id: msg.global_msg_id.clone(),
            sender_uid: msg.sender_uid.clone(),
        };
        let key = format!(
            "cd:{}:{}:{}",
            msg.bot_key, msg.thread_id, msg_ref.cli_msg_id
        );
        self.start_standalone_countdown(key, zalo, msg_ref, secs, false, None);
    }

    pub fn start_standalone_countdown(
        &self,
        key: String,
        zalo: Arc<ZaloSession>,
        msg_ref: BotMessageRef,
        seconds: usize,
        delete_on_expire: bool,
        on_expire: Option<Arc<ExpireCallbackFn>>,
    ) {
        if seconds == 0 || !msg_ref.is_valid_target() {
            return;
        }
        if let Some((_, prev)) = self.countdowns.remove(&key) {
            prev.cancel.cancel();
        }
        let cancel = CancellationToken::new();
        let rendered = Arc::new(AtomicUsize::new(0));
        self.countdowns.insert(
            key.clone(),
            CountdownSessionHandle {
                cancel: cancel.clone(),
                msg_ref: msg_ref.clone(),
                rendered_count: Arc::clone(&rendered),
            },
        );

        let map_ref = Arc::clone(&self.countdowns);
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(seconds as u64);
            let initial = replace_countdown_reaction_frame(&zalo, &msg_ref, 0, seconds.min(60)).await;
            rendered.store(initial, Ordering::Relaxed);

            loop {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let rem_dur = deadline.saturating_duration_since(now);
                let sleep_dur = rem_dur.min(Duration::from_secs(3));
                tokio::select! {
                    _ = cancel.cancelled() => {
                        let cur = rendered.swap(0, Ordering::Relaxed);
                        if cur > 0 {
                            let _ = replace_countdown_reaction_frame(&zalo, &msg_ref, cur, 0).await;
                        }
                        return;
                    }
                    _ = tokio::time::sleep(sleep_dur) => {}
                }
                let next_secs = deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs() as usize;
                if next_secs == 0 {
                    break;
                }
                let cur = rendered.load(Ordering::Relaxed);
                let updated =
                    replace_countdown_reaction_frame(&zalo, &msg_ref, cur, next_secs.min(60)).await;
                rendered.store(updated, Ordering::Relaxed);
            }

            map_ref.remove(&key);
            let cur = rendered.swap(0, Ordering::Relaxed);
            if cur > 0 {
                let _ = replace_countdown_reaction_frame(&zalo, &msg_ref, cur, 0).await;
            }
            if let Some(cb) = on_expire {
                cb(Some(Arc::clone(&zalo))).await;
            }
            if delete_on_expire {
                let _ = recall_bot_message(&zalo, &msg_ref).await;
            }
        });
    }

    pub async fn cancel_standalone_countdown(&self, key: &str, zalo: Option<&Arc<ZaloSession>>) {
        if let Some((_, handle)) = self.countdowns.remove(key) {
            handle.cancel.cancel();
            let cur = handle.rendered_count.swap(0, Ordering::Relaxed);
            if cur > 0
                && let Some(z) = zalo
            {
                let _ = replace_countdown_reaction_frame(z, &handle.msg_ref, cur, 0).await;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Interactive Reply Wizards (Selection Lists, `qrlogin` Prefix, `listgroups`, `scangroups`)
    // -------------------------------------------------------------------------

    pub fn register_reply_wizard(
        &self,
        spec: InteractiveReplySpec,
        zalo: Option<Arc<ZaloSession>>,
    ) {
        let key = spec.key.clone();
        if let Some((_, old)) = self.replies.remove(&key) {
            old.stopped.store(true, Ordering::Relaxed);
            old.cancel.cancel();
        }

        let ttl = spec.ttl;
        let show_clock = spec.show_clock;
        let recall_on_expire = spec.recall_on_expire;
        let prompt_ref = spec.prompt_ref.clone();
        let on_expire = spec.on_expire.clone();
        let cancel = CancellationToken::new();
        let rendered_clock = Arc::new(AtomicUsize::new(0));

        let session = Arc::new(ActiveReplySession {
            spec,
            expires_at: Instant::now() + ttl,
            cancel: cancel.clone(),
            rendered_clock: Arc::clone(&rendered_clock),
            busy: AsyncMutex::new(()),
            stopped: AtomicBool::new(false),
        });
        self.replies.insert(key.clone(), Arc::clone(&session));

        let map_ref = Arc::clone(&self.replies);
        let sess_ref = Arc::clone(&session);
        tokio::spawn(async move {
            let deadline = sess_ref.expires_at;
            if show_clock
                && let Some(ref z) = zalo
                && prompt_ref.is_valid_target()
            {
                let secs = ttl.as_secs().clamp(1, 60) as usize;
                let init = replace_countdown_reaction_frame(z, &prompt_ref, 0, secs).await;
                rendered_clock.store(init, Ordering::Relaxed);
            }

            loop {
                let now = Instant::now();
                if now >= deadline || sess_ref.stopped.load(Ordering::Relaxed) {
                    break;
                }
                let sleep_dur = deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_secs(3));
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(sleep_dur) => {}
                }
                if sess_ref.stopped.load(Ordering::Relaxed) {
                    return;
                }
                let next_secs = deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs() as usize;
                if next_secs == 0 {
                    break;
                }
                if show_clock
                    && let Some(ref z) = zalo
                    && prompt_ref.is_valid_target()
                {
                    let cur = rendered_clock.load(Ordering::Relaxed);
                    let upd =
                        replace_countdown_reaction_frame(z, &prompt_ref, cur, next_secs.min(60))
                            .await;
                    rendered_clock.store(upd, Ordering::Relaxed);
                }
            }

            if sess_ref.stopped.swap(true, Ordering::AcqRel) {
                return;
            }
            map_ref.remove(&key);
            if let Some(ref z) = zalo {
                let cur = rendered_clock.swap(0, Ordering::Relaxed);
                if cur > 0 {
                    let _ = replace_countdown_reaction_frame(z, &prompt_ref, cur, 0).await;
                }
                if let Some(cb) = on_expire {
                    cb(Some(Arc::clone(z))).await;
                }
                if recall_on_expire {
                    let _ = recall_bot_message(z, &prompt_ref).await;
                }
            }
        });
    }

    /// Evaluates an inbound non-prefixed message against all active reply wizards for `(bot_key, thread_id)`.
    /// Returns `true` if a wizard matched and handled (or rejected with prompt) the message.
    pub async fn try_handle_reply(
        &self,
        bot_key: &str,
        msg: &InboundMessage,
        zalo: Option<Arc<ZaloSession>>,
    ) -> bool {
        let now = Instant::now();
        let mut candidates: Vec<Arc<ActiveReplySession>> = self
            .replies
            .iter()
            .filter(|entry| {
                let s = entry.value();
                !s.stopped.load(Ordering::Relaxed)
                    && now < s.expires_at
                    && s.spec.bot_key == bot_key
                    && s.spec.thread_id == msg.thread_id
                    && (s.spec.sender_uid.is_empty() || s.spec.sender_uid == msg.sender_uid)
            })
            .map(|e| Arc::clone(e.value()))
            .collect();

        if candidates.is_empty() {
            return false;
        }

        // Prioritize exact quote matches first, then newest active prompt!
        candidates.sort_by_key(|s| {
            let quoted = msg
                .quote
                .as_ref()
                .is_some_and(|q| s.spec.prompt_ref.matches_quote(q));
            (std::cmp::Reverse(quoted), std::cmp::Reverse(s.expires_at))
        });

        for sess in candidates {
            let is_quoted = msg
                .quote
                .as_ref()
                .is_some_and(|q| sess.spec.prompt_ref.matches_quote(q));
            if sess.spec.require_quote && !is_quoted {
                continue;
            }

            let _guard = sess.busy.lock().await;
            if sess.stopped.load(Ordering::Relaxed) || Instant::now() >= sess.expires_at {
                continue;
            }

            let res = (sess.spec.on_reply)(msg.clone(), zalo.clone()).await;
            match res {
                ReplyResolution::NotMatched => continue,
                ReplyResolution::KeepWaiting => return true,
                ReplyResolution::ReopenOnFailure => {
                    // Keep wizard open for retry up to remaining TTL
                    return true;
                }
                ReplyResolution::Consumed => {
                    sess.stopped.store(true, Ordering::Release);
                    sess.cancel.cancel();
                    self.replies.remove(&sess.spec.key);
                    if let Some(ref z) = zalo {
                        let cur = sess.rendered_clock.swap(0, Ordering::Relaxed);
                        if cur > 0 {
                            let _ = replace_countdown_reaction_frame(
                                z,
                                &sess.spec.prompt_ref,
                                cur,
                                0,
                            )
                            .await;
                        }
                        if sess.spec.recall_on_consume {
                            let _ = recall_bot_message(z, &sess.spec.prompt_ref).await;
                        }
                    }
                    return true;
                }
            }
        }
        false
    }

    // -------------------------------------------------------------------------
    // Interactive Reaction Confirmations (`❤️` / `👍` for `join`, `autojoin`, `locmem`, `tiktok`)
    // -------------------------------------------------------------------------

    pub fn register_reaction_wait(
        &self,
        spec: InteractiveReactionSpec,
        zalo: Option<Arc<ZaloSession>>,
    ) {
        let key = spec.key.clone();
        if let Some((_, old)) = self.reactions.remove(&key) {
            old.stopped.store(true, Ordering::Relaxed);
            old.cancel.cancel();
        }

        let ttl = spec.ttl;
        let show_clock = spec.show_clock;
        let recall_on_expire = spec.recall_on_expire;
        let prompt_ref = spec.prompt_ref.clone();
        let on_expire = spec.on_expire.clone();
        let cancel = CancellationToken::new();
        let rendered_clock = Arc::new(AtomicUsize::new(0));

        let session = Arc::new(ActiveReactionSession {
            spec,
            expires_at: Instant::now() + ttl,
            cancel: cancel.clone(),
            rendered_clock: Arc::clone(&rendered_clock),
            stopped: AtomicBool::new(false),
        });
        self.reactions.insert(key.clone(), Arc::clone(&session));

        let map_ref = Arc::clone(&self.reactions);
        let sess_ref = Arc::clone(&session);
        tokio::spawn(async move {
            let deadline = sess_ref.expires_at;
            if show_clock
                && let Some(ref z) = zalo
                && prompt_ref.is_valid_target()
            {
                let secs = ttl.as_secs().clamp(1, 60) as usize;
                let init = replace_countdown_reaction_frame(z, &prompt_ref, 0, secs).await;
                rendered_clock.store(init, Ordering::Relaxed);
            }

            loop {
                let now = Instant::now();
                if now >= deadline || sess_ref.stopped.load(Ordering::Relaxed) {
                    break;
                }
                let sleep_dur = deadline
                    .saturating_duration_since(now)
                    .min(Duration::from_secs(3));
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(sleep_dur) => {}
                }
                if sess_ref.stopped.load(Ordering::Relaxed) {
                    return;
                }
                let next_secs = deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs() as usize;
                if next_secs == 0 {
                    break;
                }
                if show_clock
                    && let Some(ref z) = zalo
                    && prompt_ref.is_valid_target()
                {
                    let cur = rendered_clock.load(Ordering::Relaxed);
                    let upd =
                        replace_countdown_reaction_frame(z, &prompt_ref, cur, next_secs.min(60))
                            .await;
                    rendered_clock.store(upd, Ordering::Relaxed);
                }
            }

            if sess_ref.stopped.swap(true, Ordering::AcqRel) {
                return;
            }
            map_ref.remove(&key);
            if let Some(ref z) = zalo {
                let cur = rendered_clock.swap(0, Ordering::Relaxed);
                if cur > 0 {
                    let _ = replace_countdown_reaction_frame(z, &prompt_ref, cur, 0).await;
                }
                if let Some(cb) = on_expire {
                    cb(Some(Arc::clone(z))).await;
                }
                if recall_on_expire {
                    let _ = recall_bot_message(z, &prompt_ref).await;
                }
            }
        });
    }

    pub async fn try_handle_reaction(
        &self,
        bot_key: &str,
        react: &ReactionEvent,
        zalo: Option<Arc<ZaloSession>>,
    ) -> bool {
        if react.is_self || react.r_type <= 0 {
            return false;
        }
        let now = Instant::now();
        let candidates: Vec<Arc<ActiveReactionSession>> = self
            .reactions
            .iter()
            .filter(|entry| {
                let s = entry.value();
                !s.stopped.load(Ordering::Relaxed)
                    && now < s.expires_at
                    && s.spec.bot_key == bot_key
                    && s.spec.thread_id == react.thread_id
                    && s.spec.prompt_ref.matches_reaction(react)
                    && s.spec
                        .allowed_sender_uid
                        .as_ref()
                        .is_none_or(|u| u == &react.sender_uid)
            })
            .map(|e| Arc::clone(e.value()))
            .collect();

        for sess in candidates {
            let icon_ok = sess.spec.accepted_icons.is_empty()
                || sess.spec.accepted_icons.iter().any(|ic| {
                    ic.eq_ignore_ascii_case(react.r_icon.as_str())
                        || ((ic == "HEART" || ic == "❤️" || ic == "/-heart")
                            && (react.r_icon.as_str() == "/-heart" || react.r_type == 5 || react.r_icon.as_str() == "❤️"))
                        || ((ic == "LIKE" || ic == "👍" || ic == "/-strong")
                            && (react.r_icon.as_str() == "/-strong" || react.r_type == 3 || react.r_icon.as_str() == "👍"))
                });
            if !icon_ok {
                continue;
            }

            let consumed = (sess.spec.on_reaction)(react.clone(), zalo.clone()).await;
            if consumed {
                sess.stopped.store(true, Ordering::Release);
                sess.cancel.cancel();
                self.reactions.remove(&sess.spec.key);
                if let Some(ref z) = zalo {
                    let cur = sess.rendered_clock.swap(0, Ordering::Relaxed);
                    if cur > 0 {
                        let _ = replace_countdown_reaction_frame(
                            z,
                            &sess.spec.prompt_ref,
                            cur,
                            0,
                        )
                        .await;
                    }
                    if sess.spec.recall_on_consume {
                        let _ = recall_bot_message(z, &sess.spec.prompt_ref).await;
                    }
                }
                return true;
            }
        }
        false
    }
}

// =============================================================================
// Pluggable Fleet Controller & Passive Chat Hooks (Zero Circular Crate Deps)
// =============================================================================

#[async_trait]
pub trait BotFleetController: Send + Sync + 'static {
    fn is_bot_running(&self, bot_key: &str) -> bool;
    fn get_live_zalo_session(&self, bot_key: &str) -> Option<Arc<ZaloSession>>;
    async fn start_bot(&self, bot_key: &str) -> Result<BotStatusV2, String>;
    async fn stop_bot(
        &self,
        bot_key: &str,
        final_status: BotStatusV2,
        reason: Option<String>,
    ) -> Result<BotStatusV2, String>;
    async fn restart_bot(&self, bot_key: &str) -> Result<BotStatusV2, String>;
    async fn delete_bot(&self, bot_key: &str) -> Result<bool, String>;
    async fn reload_bot(&self, bot_key: &str) -> Result<BotRecord, String>;
    async fn update_bot_prefix(&self, bot_key: &str, new_prefix: &str) -> Result<BotRecord, String>;
    async fn claim_weekly_trial(
        &self,
        owner_uid: &str,
        bot_key: &str,
        now: DateTime<Utc>,
    ) -> Result<TrialLedgerRow, String>;
    async fn relay_command_to_bot(
        &self,
        target_bot_key: &str,
        msg: InboundMessage,
    ) -> Result<String, String>;
}

/// Pluggable hooks registered by `mybot-commands` onto `FastPathDispatcher` so non-prefixed
/// Zalo chat features (`@bot` `autoreply`, `autodownload`, `dqt-bot` quote-learning & auto-reply,
/// `autojoin`, `replytag`, `GroupEvent` banners, and media-restoring `antiundo`) run 1:1 with V3!
#[async_trait]
pub trait PassiveChatHooks: Send + Sync + 'static {
    /// Runs on every non-command message after moderation & reply-wizard checks.
    #[allow(clippy::too_many_arguments)]
    async fn on_passive_message(
        &self,
        bot_key: &str,
        is_main_bot: bool,
        self_uid: &ZaloId,
        prefix: &str,
        profile: &BotStyleProfile,
        sender_tier: PermissionTier,
        group_settings: &GroupSettingsRecord,
        msg: &InboundMessage,
        zalo: Option<Arc<ZaloSession>>,
    ) -> bool;

    /// Runs on inbound `ZaloWsEvent::GroupEvent` (`welcome`, `bye`, `approve`, `target`, `antijoin`, `antiblockall`).
    async fn on_group_event(
        &self,
        bot_key: &str,
        self_uid: &ZaloId,
        profile: &BotStyleProfile,
        event: &GroupEvent,
        zalo: Option<Arc<ZaloSession>>,
    );

    /// Optional rich media `antiundo` handler (restoring recalled photos, videos, voices, stickers, files, cards).
    async fn on_rich_undo(
        &self,
        bot_key: &str,
        profile: &BotStyleProfile,
        group_settings: &GroupSettingsRecord,
        cached_msg: &mybot_storage::CachedMessageRecord,
        undo: &UndoEvent,
        zalo: Option<Arc<ZaloSession>>,
    ) -> Option<String>;
}

/// Parses numeric selection + optional modifier (`"1"`, `"2 audio"`, `"3 1080p"`, `"1 lyric"`).
pub fn parse_numeric_selection_reply(text: &str, max_index: usize) -> Option<(usize, Option<String>)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    let idx: usize = parts.next()?.parse().ok()?;
    if idx < 1 || idx > max_index {
        return None;
    }
    let modifier = parts.next().map(|s| s.trim().to_ascii_lowercase());
    if parts.next().is_some() {
        return None;
    }
    Some((idx - 1, modifier))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_receipt_ref_handles_nested_message_and_attachment_shapes() {
        let receipt = json!({
            "message": {
                "data": {
                    "msgId": 9876543210_u64,
                    "cliMsgId": "1730000012345"
                }
            }
        });
        let r = extract_receipt_ref(
            &receipt,
            &ZaloId::new("grp_1"),
            ThreadType::Group,
            &ZaloId::new("bot_1"),
        );
        assert!(r.is_valid_target());
        assert_eq!(r.msg_id.as_str(), "9876543210");
        assert_eq!(r.cli_msg_id.as_str(), "1730000012345");
    }

    #[test]
    fn parse_numeric_selection_supports_quality_and_lyric_modifiers() {
        assert_eq!(parse_numeric_selection_reply("1", 10), Some((0, None)));
        assert_eq!(
            parse_numeric_selection_reply("  3   1080P ", 10),
            Some((2, Some("1080p".to_string())))
        );
        assert_eq!(
            parse_numeric_selection_reply("2 lyric", 5),
            Some((1, Some("lyric".to_string())))
        );
        assert_eq!(parse_numeric_selection_reply("6", 5), None);
        assert_eq!(parse_numeric_selection_reply("hello world", 5), None);
    }
}
