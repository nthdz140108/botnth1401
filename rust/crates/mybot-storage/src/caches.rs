//! Lock-free in-memory hot caches (`DashMap` + `moka`) with asynchronous SQLite WAL batch flushing.
//!
//! Eliminates all V3 file-lock contentions and disk I/O stalls on the hot inbound message path:
//! - `group_settings`: ~30ns read, dirty batch flush every `1s`.
//! - `rank_counters`: ~50ns increment, dirty batch flush every `5s`.
//! - `message_cache`: O(1) 3-ID (`cli_msg_id`, `msg_id`, `global_msg_id`) `!antiundo` index (24h TTL).
//! - `locmem_buffer`: O(1) `[msg, react, join_action]` accumulator per `(bot, thread, date_ict, user)`.

use std::sync::Arc;
use std::time::Duration;

use chrono::{TimeZone, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use dashmap::{DashMap, DashSet};
use moka::sync::Cache;
use mybot_types::InboundMessage;
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::db::{
    CachedMessageRecord, CommandStudioLayer, GroupSettingsRecord, LocmemDayRow, RankEntry,
    StorageEngine, StorageError,
};

const MESSAGE_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;

type LocmemDeltaKey = (String, String, String, String);
type LocmemDeltaValue = (u32, u32, u32, i64);

#[derive(Clone)]
pub struct HotStorageCaches {
    engine: StorageEngine,
    group_settings: Arc<DashMap<(String, String), GroupSettingsRecord>>,
    dirty_groups: Arc<DashSet<(String, String)>>,

    ranks: Arc<DashMap<(String, String, String), RankEntry>>,
    dirty_ranks: Arc<DashSet<(String, String, String)>>,

    studio_layers: Arc<DashMap<(String, String, String, String), CommandStudioLayer>>,

    msg_by_any_id: Cache<(String, String), Arc<CachedMessageRecord>>,
    pending_messages: Arc<Mutex<Vec<CachedMessageRecord>>>,

    locmem_deltas: Arc<DashMap<LocmemDeltaKey, LocmemDeltaValue>>,
}

impl HotStorageCaches {
    /// Warms up hot caches from SQLite (`group_settings`, `rank_counters`, `command_studio_layers`).
    pub fn load_from_engine(engine: StorageEngine) -> Result<Self, StorageError> {
        let group_settings = DashMap::new();
        for g in engine.load_all_group_settings()? {
            group_settings.insert((g.bot_key.clone(), g.thread_id.clone()), g);
        }

        let ranks = DashMap::new();
        for r in engine.load_all_ranks()? {
            ranks.insert(
                (r.bot_key.clone(), r.thread_id.clone(), r.user_uid.clone()),
                r,
            );
        }

        let studio_layers = DashMap::new();
        for l in engine.load_all_studio_layers()? {
            studio_layers.insert(
                (
                    l.scope_type.clone(),
                    l.bot_key.clone(),
                    l.thread_id.clone(),
                    l.command_name.clone(),
                ),
                l,
            );
        }

        let msg_by_any_id = Cache::builder()
            .max_capacity(100_000)
            .time_to_live(Duration::from_secs(86_400))
            .build();

        Ok(Self {
            engine,
            group_settings: Arc::new(group_settings),
            dirty_groups: Arc::new(DashSet::new()),
            ranks: Arc::new(ranks),
            dirty_ranks: Arc::new(DashSet::new()),
            studio_layers: Arc::new(studio_layers),
            msg_by_any_id,
            pending_messages: Arc::new(Mutex::new(Vec::with_capacity(256))),
            locmem_deltas: Arc::new(DashMap::new()),
        })
    }

    pub fn engine(&self) -> &StorageEngine {
        &self.engine
    }

    // -------------------------------------------------------------------------
    // Group Settings (~30ns read, dirty batch flush every 1s)
    // -------------------------------------------------------------------------

    pub fn get_or_default_group_settings(
        &self,
        bot_key: &str,
        thread_id: &str,
    ) -> GroupSettingsRecord {
        let key = (bot_key.to_string(), thread_id.to_string());
        if let Some(found) = self.group_settings.get(&key) {
            return found.clone();
        }
        GroupSettingsRecord::default_for(bot_key, thread_id)
    }

    pub fn update_group_settings<F>(&self, bot_key: &str, thread_id: &str, mutator: F) -> GroupSettingsRecord
    where
        F: FnOnce(&mut GroupSettingsRecord),
    {
        let key = (bot_key.to_string(), thread_id.to_string());
        let mut entry = self
            .group_settings
            .entry(key.clone())
            .or_insert_with(|| GroupSettingsRecord::default_for(bot_key, thread_id));
        mutator(&mut entry);
        entry.updated_at = Utc::now().to_rfc3339();
        let cloned = entry.clone();
        drop(entry);
        self.dirty_groups.insert(key);
        cloned
    }

    pub fn list_bot_group_settings(&self, bot_key: &str) -> Vec<GroupSettingsRecord> {
        self.group_settings
            .iter()
            .filter(|e| e.key().0 == bot_key)
            .map(|e| e.value().clone())
            .collect()
    }

    /// Bulk-updates `enable_bot` in-memory AND marks dirty for all known + supplied `group_ids` of `bot_key`.
    pub fn set_all_bot_groups_enable(
        &self,
        bot_key: &str,
        extra_group_ids: &[(String, String)],
        enabled: bool,
    ) -> usize {
        let mut touched_ids = std::collections::BTreeSet::new();
        for item in self.group_settings.iter() {
            if item.key().0 == bot_key {
                touched_ids.insert(item.key().1.clone());
            }
        }
        for (gid, gname) in extra_group_ids {
            if !gid.trim().is_empty() {
                touched_ids.insert(gid.clone());
                if !gname.is_empty() {
                    let key = (bot_key.to_string(), gid.clone());
                    let mut entry = self
                        .group_settings
                        .entry(key)
                        .or_insert_with(|| GroupSettingsRecord::default_for(bot_key, gid));
                    if entry.group_name.is_empty() {
                        entry.group_name = gname.clone();
                    }
                }
            }
        }

        let count = touched_ids.len();
        for gid in touched_ids {
            self.update_group_settings(bot_key, &gid, |rec| {
                rec.enable_bot = enabled;
                if let Some(obj) = rec.settings.as_object_mut() {
                    obj.insert("enableBot".into(), serde_json::Value::Bool(enabled));
                    obj.insert("activeBot".into(), serde_json::Value::Bool(enabled));
                } else {
                    rec.settings = json!({
                        "enableBot": enabled,
                        "activeBot": enabled,
                    });
                }
            });
        }
        count
    }

    // -------------------------------------------------------------------------
    // Rank Counters (~50ns increment)
    // -------------------------------------------------------------------------

    pub fn increment_rank(&self, bot_key: &str, thread_id: &str, user_uid: &str, user_name: &str) -> u64 {
        let now_ms = Utc::now().timestamp_millis();
        let key = (
            bot_key.to_string(),
            thread_id.to_string(),
            user_uid.to_string(),
        );
        let mut entry = self.ranks.entry(key.clone()).or_insert_with(|| RankEntry {
            bot_key: bot_key.to_string(),
            thread_id: thread_id.to_string(),
            user_uid: user_uid.to_string(),
            user_name: user_name.to_string(),
            msg_count: 0,
            daily_count: 0,
            last_msg_at: now_ms,
        });
        entry.msg_count += 1;
        entry.daily_count += 1;
        entry.last_msg_at = now_ms;
        if !user_name.is_empty() {
            entry.user_name = user_name.to_string();
        }
        let total = entry.msg_count;
        drop(entry);
        self.dirty_ranks.insert(key);
        total
    }

    pub fn top_ranks_hot(&self, bot_key: &str, thread_id: &str, limit: usize, daily_only: bool) -> Vec<RankEntry> {
        let mut vec: Vec<RankEntry> = self
            .ranks
            .iter()
            .filter(|e| {
                let (b, t, _) = e.key();
                b == bot_key && t == thread_id && (!daily_only || e.value().daily_count > 0)
            })
            .map(|e| e.value().clone())
            .collect();
        if daily_only {
            vec.sort_by_key(|a| std::cmp::Reverse(a.daily_count));
        } else {
            vec.sort_by_key(|a| std::cmp::Reverse(a.msg_count));
        }
        vec.truncate(limit);
        vec
    }

    /// Returns `(1-based rank position, msg_count, daily_count)` for a user in a group.
    pub fn user_rank_hot(&self, bot_key: &str, thread_id: &str, user_uid: &str) -> (usize, u64, u64) {
        let mut all: Vec<RankEntry> = self
            .ranks
            .iter()
            .filter(|e| e.key().0 == bot_key && e.key().1 == thread_id)
            .map(|e| e.value().clone())
            .collect();
        all.sort_by_key(|a| std::cmp::Reverse(a.msg_count));
        if let Some((idx, entry)) = all.iter().enumerate().find(|(_, r)| r.user_uid == user_uid) {
            (idx + 1, entry.msg_count, entry.daily_count)
        } else {
            (0, 0, 0)
        }
    }

    pub fn reset_daily_ranks_hot(&self) -> Result<usize, StorageError> {
        for mut entry in self.ranks.iter_mut() {
            if entry.daily_count != 0 {
                entry.daily_count = 0;
            }
        }
        self.engine.reset_daily_ranks()
    }

    // -------------------------------------------------------------------------
    // Command Studio V2 Layer Cache
    // -------------------------------------------------------------------------

    pub fn get_studio_layer_hot(
        &self,
        scope_type: &str,
        bot_key: &str,
        thread_id: &str,
        command_name: &str,
    ) -> Option<CommandStudioLayer> {
        self.studio_layers
            .get(&(
                scope_type.to_string(),
                bot_key.to_string(),
                thread_id.to_string(),
                command_name.to_string(),
            ))
            .map(|r| r.value().clone())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_studio_layer_cas(
        &self,
        scope_type: &str,
        bot_key: &str,
        thread_id: &str,
        command_name: &str,
        overrides: &serde_json::Value,
        expected_revision: Option<i64>,
        actor: &str,
        note: &str,
    ) -> Result<CommandStudioLayer, StorageError> {
        let saved = self.engine.save_studio_layer_cas(
            scope_type,
            bot_key,
            thread_id,
            command_name,
            overrides,
            expected_revision,
            actor,
            note,
        )?;
        self.studio_layers.insert(
            (
                saved.scope_type.clone(),
                saved.bot_key.clone(),
                saved.thread_id.clone(),
                saved.command_name.clone(),
            ),
            saved.clone(),
        );
        Ok(saved)
    }

    // -------------------------------------------------------------------------
    // Pre-Shedding `!antiundo` 3-Key Message Cache
    // -------------------------------------------------------------------------

    pub fn cache_inbound_message(&self, bot_key: &str, msg: &InboundMessage) {
        let now_ms = Utc::now().timestamp_millis();
        let rec = CachedMessageRecord {
            bot_key: bot_key.to_string(),
            thread_id: msg.thread_id.as_str().to_string(),
            sender_uid: msg.sender_uid.as_str().to_string(),
            sender_name: msg.sender_name.clone(),
            cli_msg_id: msg.cli_msg_id.as_str().to_string(),
            msg_id: msg.msg_id.as_str().to_string(),
            global_msg_id: msg.global_msg_id.as_str().to_string(),
            msg_type: msg.msg_type.as_str().to_string(),
            payload: json!({
                "content": msg.content,
                "mentions": msg.mentions,
                "timestampMs": msg.timestamp_ms,
            }),
            created_at_ms: now_ms,
            expires_at_ms: now_ms + MESSAGE_CACHE_TTL_MS,
        };
        let arc_rec = Arc::new(rec.clone());
        for id in [&rec.cli_msg_id, &rec.msg_id, &rec.global_msg_id] {
            if !id.is_empty() {
                self.msg_by_any_id
                    .insert((bot_key.to_string(), id.clone()), Arc::clone(&arc_rec));
            }
        }
        self.pending_messages.lock().push(rec);
    }

    pub fn lookup_undo_target(
        &self,
        bot_key: &str,
        cli_msg_id: &str,
        msg_id: &str,
        global_msg_id: Option<&str>,
    ) -> Option<Arc<CachedMessageRecord>> {
        let candidates = [
            Some(cli_msg_id),
            Some(msg_id),
            global_msg_id,
        ];
        for id in candidates.into_iter().flatten() {
            if !id.is_empty()
                && let Some(hit) = self.msg_by_any_id.get(&(bot_key.to_string(), id.to_string()))
            {
                return Some(hit);
            }
        }

        // Cold fallback to SQLite WAL (survives daemon restarts within 24h)
        let now_ms = Utc::now().timestamp_millis();
        for id in [Some(cli_msg_id), Some(msg_id), global_msg_id].into_iter().flatten() {
            if !id.is_empty()
                && let Ok(Some(db_hit)) = self.engine.lookup_cached_message(bot_key, id, now_ms)
            {
                let arc_hit = Arc::new(db_hit);
                self.msg_by_any_id
                    .insert((bot_key.to_string(), id.to_string()), Arc::clone(&arc_hit));
                return Some(arc_hit);
            }
        }
        None
    }

    // -------------------------------------------------------------------------
    // Locmem Rolling 35-Day Activity Recording (`Asia/Ho_Chi_Minh`)
    // -------------------------------------------------------------------------

    pub fn current_ict_date_string() -> String {
        let now_ict = Ho_Chi_Minh.from_utc_datetime(&Utc::now().naive_utc());
        now_ict.format("%Y-%m-%d").to_string()
    }

    pub fn record_locmem_activity(
        &self,
        bot_key: &str,
        thread_id: &str,
        user_uid: &str,
        msg_delta: u32,
        react_delta: u32,
        join_delta: u32,
    ) {
        let now_ms = Utc::now().timestamp_millis();
        let date_ict = Self::current_ict_date_string();
        let key = (
            bot_key.to_string(),
            thread_id.to_string(),
            date_ict,
            user_uid.to_string(),
        );
        let mut entry = self.locmem_deltas.entry(key).or_insert((0, 0, 0, now_ms));
        entry.0 += msg_delta;
        entry.1 += react_delta;
        entry.2 += join_delta;
        entry.3 = now_ms;
    }

    // -------------------------------------------------------------------------
    // Flush Operations & Background Flush Worker
    // -------------------------------------------------------------------------

    pub fn flush_group_settings(&self) -> Result<usize, StorageError> {
        if self.dirty_groups.is_empty() {
            return Ok(0);
        }
        let keys: Vec<(String, String)> = self.dirty_groups.iter().map(|k| k.clone()).collect();
        let mut batch = Vec::with_capacity(keys.len());
        for key in &keys {
            self.dirty_groups.remove(key);
            if let Some(rec) = self.group_settings.get(key) {
                batch.push(rec.clone());
            }
        }
        let count = batch.len();
        self.engine.upsert_group_settings_batch(&batch)?;
        Ok(count)
    }

    pub fn flush_ranks_messages_and_locmem(&self) -> Result<(usize, usize, usize), StorageError> {
        let rank_keys: Vec<(String, String, String)> =
            self.dirty_ranks.iter().map(|k| k.clone()).collect();
        let mut rank_batch = Vec::with_capacity(rank_keys.len());
        for key in &rank_keys {
            self.dirty_ranks.remove(key);
            if let Some(rec) = self.ranks.get(key) {
                rank_batch.push(rec.clone());
            }
        }
        let ranks_flushed = rank_batch.len();
        self.engine.upsert_rank_batch(&rank_batch)?;

        let msg_batch: Vec<CachedMessageRecord> = {
            let mut guard = self.pending_messages.lock();
            std::mem::take(&mut *guard)
        };
        let msgs_flushed = msg_batch.len();
        self.engine.insert_cached_messages_batch(&msg_batch)?;

        let loc_keys: Vec<(String, String, String, String)> =
            self.locmem_deltas.iter().map(|e| e.key().clone()).collect();
        let mut loc_batch = Vec::with_capacity(loc_keys.len());
        for key in loc_keys {
            if let Some(((bot_key, thread_id, date_ict, user_uid), (m, r, j, ts))) =
                self.locmem_deltas.remove(&key)
            {
                loc_batch.push(LocmemDayRow {
                    bot_key,
                    thread_id,
                    date_ict,
                    user_uid,
                    msg_count: m,
                    react_count: r,
                    join_actions: j,
                    last_seen_ms: ts,
                });
            }
        }
        let loc_flushed = loc_batch.len();
        self.engine.increment_locmem_batch(&loc_batch)?;

        Ok((ranks_flushed, msgs_flushed, loc_flushed))
    }

    /// Flushes all pending dirty hot-cache records synchronously (<200ms on SIGTERM).
    pub fn flush_all_sync(&self) -> Result<(), StorageError> {
        self.flush_group_settings()?;
        self.flush_ranks_messages_and_locmem()?;
        Ok(())
    }

    /// Spawns the background WAL batch writer (`1s` group settings, `5s` ranks/messages/locmem).
    pub fn spawn_batch_writer(&self) -> BatchFlushHandle {
        let caches = self.clone();
        let stop_notify = Arc::new(Notify::new());
        let stop_rx = Arc::clone(&stop_notify);

        let task = tokio::spawn(async move {
            let mut fast_tick = tokio::time::interval(Duration::from_secs(1));
            let mut slow_tick = tokio::time::interval(Duration::from_secs(5));
            fast_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            slow_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            loop {
                tokio::select! {
                    _ = stop_rx.notified() => {
                        let _ = caches.flush_all_sync();
                        break;
                    }
                    _ = fast_tick.tick() => {
                        let _ = caches.flush_group_settings();
                    }
                    _ = slow_tick.tick() => {
                        let _ = caches.flush_ranks_messages_and_locmem();
                    }
                }
            }
        });

        BatchFlushHandle { stop_notify, task }
    }
}

pub struct BatchFlushHandle {
    stop_notify: Arc<Notify>,
    task: JoinHandle<()>,
}

impl BatchFlushHandle {
    pub async fn shutdown_and_flush(self) {
        self.stop_notify.notify_waiters();
        let _ = self.task.await;
    }
}
