//! SQLite WAL persistence engine (`StorageEngine`) with separated writer and concurrent reader pool.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chrono::Utc;
use mybot_types::{CredentialsBundle, ExpiryPolicy, ZaloId};
use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const INITIAL_SCHEMA_SQL: &str = include_str!("../migrations/0001_initial_schema.sql");

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("REVISION_CONFLICT: expected revision {expected}, actual revision {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
    #[error("not found: {0}")]
    NotFound(String),
}

#[derive(Clone, Serialize, Deserialize)]
pub struct BotRecord {
    pub bot_key: String,
    pub uid: ZaloId,
    pub global_uid: Option<String>,
    pub canonical_username: Option<String>,
    pub display_name: String,
    pub avatar: String,
    pub is_main: bool,
    pub owner_uid: Option<String>,
    pub status: String,
    pub desired_status: String,
    pub expiry_policy: ExpiryPolicy,
    pub trial_status: Option<String>,
    pub cookie_json: Value,
    pub imei: String,
    pub user_agent: String,
    pub proxy_url: Option<String>,
    pub cookie_dead: bool,
    pub cookie_dead_reason: Option<String>,
    pub prefix: String,
    pub self_listen: bool,
    pub identity_pending: bool,
    pub admin_identity_seeds: Vec<Value>,
    pub metadata: Value,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for BotRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BotRecord")
            .field("bot_key", &self.bot_key)
            .field("uid", &self.uid)
            .field("display_name", &self.display_name)
            .field("is_main", &self.is_main)
            .field("status", &self.status)
            .field("cookie_json", &"[REDACTED]")
            .field("imei", &"[REDACTED]")
            .finish()
    }
}

impl BotRecord {
    pub fn to_credentials_bundle(&self) -> CredentialsBundle {
        CredentialsBundle {
            cookie: self.cookie_json.clone(),
            imei: self.imei.clone(),
            user_agent: self.user_agent.clone(),
            language: "vi".to_string(),
            proxy_url: self.proxy_url.clone(),
        }
    }

    /// Safe public view for Dashboard REST / Socket.IO (never exposes cookies or IMEI).
    pub fn to_redacted_summary(&self) -> Value {
        json!({
            "botKey": self.bot_key,
            "uid": self.uid.as_str(),
            "globalUid": self.global_uid,
            "canonicalUsername": self.canonical_username,
            "displayName": self.display_name,
            "avatar": self.avatar,
            "isMain": self.is_main,
            "ownerUid": self.owner_uid,
            "status": self.status,
            "desiredStatus": self.desired_status,
            "expiryAt": self.expiry_policy,
            "trialStatus": self.trial_status,
            "cookieDead": self.cookie_dead,
            "cookieDeadReason": self.cookie_dead_reason,
            "prefix": self.prefix,
            "selfListen": self.self_listen,
            "identityPending": self.identity_pending,
            "hasCookie": !self.cookie_json.is_null() && self.cookie_json != json!({}),
            "hasImei": !self.imei.is_empty(),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSettingsRecord {
    pub bot_key: String,
    pub thread_id: String,
    pub group_name: String,
    pub anti_bot: bool,
    pub only_text: bool,
    pub anti_photo_video: bool,
    pub anti_voice: bool,
    pub anti_file: bool,
    pub anti_text: bool,
    pub anti_mention: bool,
    pub anti_sticker: bool,
    pub anti_sticker_effect: bool,
    pub anti_gif: bool,
    pub anti_forward: bool,
    pub anti_spam: bool,
    pub anti_bad_word: bool,
    pub anti_link: bool,
    pub anti_card: bool,
    pub anti_nude: bool,
    pub anti_all_effect_sticker: bool,
    pub anti_undo: bool,
    pub enable_bot: bool,
    pub welcome_group: bool,
    pub bye_group: bool,
    /// Full extra JSON bag (whitelist, muteList, badWordCustom, strikeThresholds, etc.)
    pub settings: Value,
    pub updated_at: String,
}

impl GroupSettingsRecord {
    pub fn default_for(bot_key: impl Into<String>, thread_id: impl Into<String>) -> Self {
        Self {
            bot_key: bot_key.into(),
            thread_id: thread_id.into(),
            group_name: String::new(),
            anti_bot: false,
            only_text: false,
            anti_photo_video: false,
            anti_voice: false,
            anti_file: false,
            anti_text: false,
            anti_mention: false,
            anti_sticker: false,
            anti_sticker_effect: false,
            anti_gif: false,
            anti_forward: false,
            anti_spam: false,
            anti_bad_word: false,
            anti_link: false,
            anti_card: false,
            anti_nude: false,
            anti_all_effect_sticker: false,
            anti_undo: false,
            enable_bot: false,
            welcome_group: false,
            bye_group: false,
            settings: json!({ "activeBot": false }),
            updated_at: Utc::now().to_rfc3339(),
        }
    }

    pub fn from_v3_json(bot_key: &str, thread_id: &str, raw: &Value) -> Self {
        let b = |keys: &[&str], default: bool| -> bool {
            for k in keys {
                if let Some(v) = raw.get(*k) {
                    if let Some(flag) = v.as_bool() {
                        return flag;
                    }
                    if let Some(n) = v.as_i64() {
                        return n != 0;
                    }
                }
            }
            default
        };
        let group_name = raw
            .get("nameGroup")
            .or_else(|| raw.get("groupName"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        Self {
            bot_key: bot_key.to_string(),
            thread_id: thread_id.to_string(),
            group_name,
            anti_bot: b(&["antiBot", "filterBot"], false),
            only_text: b(&["onlyText"], false),
            anti_photo_video: b(&["antiPhotoVideo", "antiMedia", "antiPhoto"], false),
            anti_voice: b(&["antiVoice"], false),
            anti_file: b(&["antiFile"], false),
            anti_text: b(&["antiText"], false),
            anti_mention: b(&["antiMention", "antiTag"], false),
            anti_sticker: b(&["antiSticker"], false),
            anti_sticker_effect: b(&["antiStickerEffect"], false),
            anti_gif: b(&["antiGif"], false),
            anti_forward: b(&["antiForward"], false),
            anti_spam: b(&["antiSpam"], false),
            anti_bad_word: b(&["antiBadWord", "filterBadWords"], false),
            anti_link: b(&["antiLink", "removeLinks"], false),
            anti_card: b(&["antiCard"], false),
            anti_nude: b(&["antiNude"], false),
            anti_all_effect_sticker: b(&["antiAllEffectSticker"], false),
            anti_undo: b(&["antiUndo"], false),
            enable_bot: b(&["enableBot", "activeBot"], false),
            welcome_group: b(&["welcomeGroup"], false),
            bye_group: b(&["byeGroup"], false),
            settings: raw.clone(),
            updated_at: Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRecord {
    pub id: i64,
    pub bot_key: String,
    pub thread_id: String,
    pub thread_type: u8,
    pub target_uid: String,
    pub creator_uid: String,
    pub content: String,
    pub due_at_ms: i64,
    pub repeat_mode: String,
    pub delivered: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankAccountRecord {
    pub id: i64,
    pub bot_key: String,
    pub bin_bank: u32,
    pub bank_short_name: String,
    pub account_number: String,
    pub account_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedUserRecord {
    pub bot_key: String,
    pub user_uid: String,
    pub user_name: String,
    pub reason: String,
    pub blocked_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStudioLayer {
    pub scope_type: String,
    pub bot_key: String,
    pub thread_id: String,
    pub command_name: String,
    pub overrides: Value,
    pub revision: i64,
    pub updated_by: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStudioHistoryItem {
    pub id: i64,
    pub scope_type: String,
    pub bot_key: String,
    pub thread_id: String,
    pub command_name: String,
    pub revision: i64,
    pub previous: Value,
    pub next: Value,
    pub actor: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankEntry {
    pub bot_key: String,
    pub thread_id: String,
    pub user_uid: String,
    pub user_name: String,
    pub msg_count: u64,
    pub daily_count: u64,
    pub last_msg_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedMessageRecord {
    pub bot_key: String,
    pub thread_id: String,
    pub sender_uid: String,
    pub sender_name: String,
    pub cli_msg_id: String,
    pub msg_id: String,
    pub global_msg_id: String,
    pub msg_type: String,
    pub payload: Value,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocmemDayRow {
    pub bot_key: String,
    pub thread_id: String,
    pub date_ict: String,
    pub user_uid: String,
    pub msg_count: u32,
    pub react_count: u32,
    pub join_actions: u32,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialLedgerRow {
    pub owner_uid: String,
    pub iso_week: String,
    pub used_seconds: i64,
    pub bot_key: String,
    pub granted_at: String,
    pub expires_at: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretMeta {
    pub secret_key: String,
    pub configured: bool,
    pub fingerprint_prefix: String,
    pub updated_at: String,
}

/// Thread-safe SQLite WAL engine with a single serialized writer and a round-robin reader pool.
#[derive(Clone)]
pub struct StorageEngine {
    db_path: PathBuf,
    writer: Arc<Mutex<Connection>>,
    readers: Arc<Vec<Mutex<Connection>>>,
    reader_cursor: Arc<AtomicUsize>,
}

impl StorageEngine {
    /// Opens or creates a disk-backed SQLite WAL database with V4 pragmas and runs migrations.
    pub fn open(path: impl AsRef<Path>, reader_count: usize) -> Result<Self, StorageError> {
        let db_path = path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }

        let writer_conn = Connection::open(&db_path)?;
        Self::apply_pragmas(&writer_conn, false)?;
        Self::apply_migrations(&writer_conn)?;

        // Set 0600 permissions on Unix because `bots.cookie_json` & `provider_secrets` live inside `mybot.db`.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
        }

        let pool_size = reader_count.max(1);
        let mut readers = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            let r = Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            Self::apply_pragmas(&r, true)?;
            readers.push(Mutex::new(r));
        }

        Ok(Self {
            db_path,
            writer: Arc::new(Mutex::new(writer_conn)),
            readers: Arc::new(readers),
            reader_cursor: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Opens an isolated shared in-memory database for unit & dry-run migration tests.
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let uri = format!("file:mybot_mem_{}?mode=memory&cache=shared", uuid::Uuid::new_v4());
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let writer_conn = Connection::open_with_flags(&uri, flags)?;
        Self::apply_pragmas(&writer_conn, false)?;
        Self::apply_migrations(&writer_conn)?;

        let reader_conn = Connection::open_with_flags(&uri, flags)?;
        Self::apply_pragmas(&reader_conn, true)?;

        Ok(Self {
            db_path: PathBuf::from(":memory:"),
            writer: Arc::new(Mutex::new(writer_conn)),
            readers: Arc::new(vec![Mutex::new(reader_conn)]),
            reader_cursor: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn apply_pragmas(conn: &Connection, read_only: bool) -> Result<(), StorageError> {
        conn.busy_timeout(Duration::from_millis(5000))?;
        if !read_only {
            let _ = conn.pragma_update(None, "journal_mode", "WAL");
            conn.pragma_update(None, "synchronous", "NORMAL")?;
        }
        let _ = conn.pragma_update(None, "mmap_size", 268_435_456i64);
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    fn apply_migrations(conn: &Connection) -> Result<(), StorageError> {
        conn.execute_batch(INITIAL_SCHEMA_SQL)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![1i64, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn with_writer<T, F>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError>,
    {
        let mut guard = self.writer.lock();
        f(&mut guard)
    }

    pub fn with_reader<T, F>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection) -> Result<T, StorageError>,
    {
        let idx = self.reader_cursor.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let guard = self.readers[idx].lock();
        f(&guard)
    }

    // -------------------------------------------------------------------------
    // Bots & Role Registry
    // -------------------------------------------------------------------------

    pub fn upsert_bot(&self, bot: &BotRecord) -> Result<(), StorageError> {
        self.with_writer(|conn| Self::upsert_bot_on_conn(conn, bot))
    }

    pub(crate) fn upsert_bot_on_conn(conn: &Connection, bot: &BotRecord) -> Result<(), StorageError> {
        let cookie_str = serde_json::to_string(&bot.cookie_json)?;
        let expiry_val = serde_json::to_value(bot.expiry_policy)?;
        let expiry_str = expiry_val
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| expiry_val.to_string());
        let seeds_str = serde_json::to_string(&bot.admin_identity_seeds)?;
        let meta_str = serde_json::to_string(&bot.metadata)?;

        conn.execute(
            r#"
            INSERT INTO bots (
                bot_key, uid, global_uid, canonical_username, display_name, avatar,
                is_main, owner_uid, status, desired_status, expiry_policy, trial_status,
                cookie_json, imei, user_agent, proxy_url, cookie_dead, cookie_dead_reason,
                prefix, self_listen, identity_pending, admin_identity_seeds_json,
                metadata_json, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21, ?22,
                ?23, ?24, ?25
            )
            ON CONFLICT(bot_key) DO UPDATE SET
                uid = excluded.uid,
                global_uid = excluded.global_uid,
                canonical_username = excluded.canonical_username,
                display_name = excluded.display_name,
                avatar = excluded.avatar,
                is_main = excluded.is_main,
                owner_uid = excluded.owner_uid,
                status = excluded.status,
                desired_status = excluded.desired_status,
                expiry_policy = excluded.expiry_policy,
                trial_status = excluded.trial_status,
                cookie_json = excluded.cookie_json,
                imei = excluded.imei,
                user_agent = excluded.user_agent,
                proxy_url = excluded.proxy_url,
                cookie_dead = excluded.cookie_dead,
                cookie_dead_reason = excluded.cookie_dead_reason,
                prefix = excluded.prefix,
                self_listen = excluded.self_listen,
                identity_pending = excluded.identity_pending,
                admin_identity_seeds_json = excluded.admin_identity_seeds_json,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at
            "#,
            params![
                bot.bot_key,
                bot.uid.as_str(),
                bot.global_uid,
                bot.canonical_username,
                bot.display_name,
                bot.avatar,
                i32::from(bot.is_main),
                bot.owner_uid,
                bot.status,
                bot.desired_status,
                expiry_str,
                bot.trial_status,
                cookie_str,
                bot.imei,
                bot.user_agent,
                bot.proxy_url,
                i32::from(bot.cookie_dead),
                bot.cookie_dead_reason,
                bot.prefix,
                i32::from(bot.self_listen),
                i32::from(bot.identity_pending),
                seeds_str,
                meta_str,
                bot.created_at,
                bot.updated_at,
            ],
        )?;
        Ok(())
    }

    fn row_to_bot(row: &rusqlite::Row<'_>) -> rusqlite::Result<BotRecord> {
        let cookie_raw: String = row.get(12)?;
        let expiry_raw: String = row.get(10)?;
        let seeds_raw: String = row.get(21)?;
        let meta_raw: String = row.get(22)?;

        let expiry_policy = serde_json::from_value(Value::String(expiry_raw))
            .unwrap_or(ExpiryPolicy::Permanent);

        Ok(BotRecord {
            bot_key: row.get(0)?,
            uid: ZaloId::new(row.get::<_, String>(1)?),
            global_uid: row.get(2)?,
            canonical_username: row.get(3)?,
            display_name: row.get(4)?,
            avatar: row.get(5)?,
            is_main: row.get::<_, i32>(6)? != 0,
            owner_uid: row.get(7)?,
            status: row.get(8)?,
            desired_status: row.get(9)?,
            expiry_policy,
            trial_status: row.get(11)?,
            cookie_json: serde_json::from_str(&cookie_raw).unwrap_or_else(|_| json!({})),
            imei: row.get(13)?,
            user_agent: row.get(14)?,
            proxy_url: row.get(15)?,
            cookie_dead: row.get::<_, i32>(16)? != 0,
            cookie_dead_reason: row.get(17)?,
            prefix: row.get(18)?,
            self_listen: row.get::<_, i32>(19)? != 0,
            identity_pending: row.get::<_, i32>(20)? != 0,
            admin_identity_seeds: serde_json::from_str(&seeds_raw).unwrap_or_default(),
            metadata: serde_json::from_str(&meta_raw).unwrap_or_else(|_| json!({})),
            created_at: row.get(23)?,
            updated_at: row.get(24)?,
        })
    }

    pub fn list_bots(&self) -> Result<Vec<BotRecord>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT
                    bot_key, uid, global_uid, canonical_username, display_name, avatar,
                    is_main, owner_uid, status, desired_status, expiry_policy, trial_status,
                    cookie_json, imei, user_agent, proxy_url, cookie_dead, cookie_dead_reason,
                    prefix, self_listen, identity_pending, admin_identity_seeds_json,
                    metadata_json, created_at, updated_at
                FROM bots
                ORDER BY is_main DESC, bot_key ASC
                "#,
            )?;
            let rows = stmt
                .query_map([], Self::row_to_bot)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn get_bot(&self, bot_key: &str) -> Result<Option<BotRecord>, StorageError> {
        self.with_reader(|conn| {
            conn.query_row(
                r#"
                SELECT
                    bot_key, uid, global_uid, canonical_username, display_name, avatar,
                    is_main, owner_uid, status, desired_status, expiry_policy, trial_status,
                    cookie_json, imei, user_agent, proxy_url, cookie_dead, cookie_dead_reason,
                    prefix, self_listen, identity_pending, admin_identity_seeds_json,
                    metadata_json, created_at, updated_at
                FROM bots
                WHERE bot_key = ?1 OR uid = ?1
                LIMIT 1
                "#,
                params![bot_key],
                Self::row_to_bot,
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn delete_bot(&self, bot_key: &str) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let changed = conn.execute("DELETE FROM bots WHERE bot_key = ?1", params![bot_key])?;
            Ok(changed > 0)
        })
    }

    /// Atomically swaps the primary admin bot inside a single ACID SQLite transaction.
    pub fn promote_primary_bot(&self, new_primary_bot_key: &str, actor: &str) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            let exists: Option<i32> = tx
                .query_row(
                    "SELECT 1 FROM bots WHERE bot_key = ?1",
                    params![new_primary_bot_key],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(StorageError::NotFound(format!("bot `{new_primary_bot_key}`")));
            }
            let now = Utc::now().to_rfc3339();
            tx.execute("UPDATE bots SET is_main = 0, updated_at = ?1", params![now])?;
            tx.execute(
                "UPDATE bots SET is_main = 1, updated_at = ?1 WHERE bot_key = ?2",
                params![now, new_primary_bot_key],
            )?;

            let prev_hist: Option<String> = tx
                .query_row(
                    "SELECT history_json FROM role_registry WHERE singleton_id = 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let mut history: Vec<Value> = prev_hist
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            history.push(json!({
                "primaryBotKey": new_primary_bot_key,
                "actor": actor,
                "swappedAt": now,
            }));

            tx.execute(
                r#"
                INSERT INTO role_registry (singleton_id, primary_bot_key, updated_at, history_json)
                VALUES (1, ?1, ?2, ?3)
                ON CONFLICT(singleton_id) DO UPDATE SET
                    primary_bot_key = excluded.primary_bot_key,
                    updated_at = excluded.updated_at,
                    history_json = excluded.history_json
                "#,
                params![new_primary_bot_key, now, serde_json::to_string(&history)?],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn upsert_bot_admin(
        &self,
        bot_key: &str,
        admin_uid: &str,
        tier: &str,
        display_name: &str,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO bot_admins (bot_key, admin_uid, tier, display_name, added_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(bot_key, admin_uid) DO UPDATE SET
                    tier = excluded.tier,
                    display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE bot_admins.display_name END
                "#,
                params![bot_key, admin_uid, tier, display_name, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn list_bot_admins(&self, bot_key: &str) -> Result<Vec<(String, String, String)>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT admin_uid, tier, display_name FROM bot_admins WHERE bot_key = ?1 ORDER BY admin_uid ASC",
            )?;
            let rows = stmt
                .query_map(params![bot_key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn remove_bot_admin(&self, bot_key: &str, admin_uid: &str) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM bot_admins WHERE bot_key = ?1 AND admin_uid = ?2",
                params![bot_key, admin_uid],
            )?;
            Ok(n > 0)
        })
    }

    // -------------------------------------------------------------------------
    // Group Settings (Batch Upsert & Warm Load)
    // -------------------------------------------------------------------------

    pub fn upsert_group_settings_batch(&self, items: &[GroupSettingsRecord]) -> Result<(), StorageError> {
        if items.is_empty() {
            return Ok(());
        }
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            Self::upsert_group_settings_in_tx(&tx, items)?;
            tx.commit()?;
            Ok(())
        })
    }

    pub(crate) fn upsert_group_settings_in_tx(
        conn: &Connection,
        items: &[GroupSettingsRecord],
    ) -> Result<(), StorageError> {
        let mut stmt = conn.prepare_cached(
            r#"
            INSERT INTO group_settings (
                bot_key, thread_id, group_name,
                anti_bot, only_text, anti_photo_video, anti_voice, anti_file,
                anti_text, anti_mention, anti_sticker, anti_sticker_effect, anti_gif,
                anti_forward, anti_spam, anti_bad_word, anti_link, anti_card,
                anti_nude, anti_all_effect_sticker, anti_undo,
                enable_bot, welcome_group, bye_group, settings_json, updated_at
            ) VALUES (
                ?1, ?2, ?3,
                ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21,
                ?22, ?23, ?24, ?25, ?26
            )
            ON CONFLICT(bot_key, thread_id) DO UPDATE SET
                group_name = excluded.group_name,
                anti_bot = excluded.anti_bot,
                only_text = excluded.only_text,
                anti_photo_video = excluded.anti_photo_video,
                anti_voice = excluded.anti_voice,
                anti_file = excluded.anti_file,
                anti_text = excluded.anti_text,
                anti_mention = excluded.anti_mention,
                anti_sticker = excluded.anti_sticker,
                anti_sticker_effect = excluded.anti_sticker_effect,
                anti_gif = excluded.anti_gif,
                anti_forward = excluded.anti_forward,
                anti_spam = excluded.anti_spam,
                anti_bad_word = excluded.anti_bad_word,
                anti_link = excluded.anti_link,
                anti_card = excluded.anti_card,
                anti_nude = excluded.anti_nude,
                anti_all_effect_sticker = excluded.anti_all_effect_sticker,
                anti_undo = excluded.anti_undo,
                enable_bot = excluded.enable_bot,
                welcome_group = excluded.welcome_group,
                bye_group = excluded.bye_group,
                settings_json = excluded.settings_json,
                updated_at = excluded.updated_at
            "#,
        )?;

        for g in items {
            stmt.execute(params![
                g.bot_key,
                g.thread_id,
                g.group_name,
                i32::from(g.anti_bot),
                i32::from(g.only_text),
                i32::from(g.anti_photo_video),
                i32::from(g.anti_voice),
                i32::from(g.anti_file),
                i32::from(g.anti_text),
                i32::from(g.anti_mention),
                i32::from(g.anti_sticker),
                i32::from(g.anti_sticker_effect),
                i32::from(g.anti_gif),
                i32::from(g.anti_forward),
                i32::from(g.anti_spam),
                i32::from(g.anti_bad_word),
                i32::from(g.anti_link),
                i32::from(g.anti_card),
                i32::from(g.anti_nude),
                i32::from(g.anti_all_effect_sticker),
                i32::from(g.anti_undo),
                i32::from(g.enable_bot),
                i32::from(g.welcome_group),
                i32::from(g.bye_group),
                serde_json::to_string(&g.settings)?,
                g.updated_at,
            ])?;
        }
        Ok(())
    }

    pub fn load_all_group_settings(&self) -> Result<Vec<GroupSettingsRecord>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT
                    bot_key, thread_id, group_name,
                    anti_bot, only_text, anti_photo_video, anti_voice, anti_file,
                    anti_text, anti_mention, anti_sticker, anti_sticker_effect, anti_gif,
                    anti_forward, anti_spam, anti_bad_word, anti_link, anti_card,
                    anti_nude, anti_all_effect_sticker, anti_undo,
                    enable_bot, welcome_group, bye_group, settings_json, updated_at
                FROM group_settings
                "#,
            )?;
            let rows = stmt
                .query_map([], |r| {
                    let s_raw: String = r.get(24)?;
                    Ok(GroupSettingsRecord {
                        bot_key: r.get(0)?,
                        thread_id: r.get(1)?,
                        group_name: r.get(2)?,
                        anti_bot: r.get::<_, i32>(3)? != 0,
                        only_text: r.get::<_, i32>(4)? != 0,
                        anti_photo_video: r.get::<_, i32>(5)? != 0,
                        anti_voice: r.get::<_, i32>(6)? != 0,
                        anti_file: r.get::<_, i32>(7)? != 0,
                        anti_text: r.get::<_, i32>(8)? != 0,
                        anti_mention: r.get::<_, i32>(9)? != 0,
                        anti_sticker: r.get::<_, i32>(10)? != 0,
                        anti_sticker_effect: r.get::<_, i32>(11)? != 0,
                        anti_gif: r.get::<_, i32>(12)? != 0,
                        anti_forward: r.get::<_, i32>(13)? != 0,
                        anti_spam: r.get::<_, i32>(14)? != 0,
                        anti_bad_word: r.get::<_, i32>(15)? != 0,
                        anti_link: r.get::<_, i32>(16)? != 0,
                        anti_card: r.get::<_, i32>(17)? != 0,
                        anti_nude: r.get::<_, i32>(18)? != 0,
                        anti_all_effect_sticker: r.get::<_, i32>(19)? != 0,
                        anti_undo: r.get::<_, i32>(20)? != 0,
                        enable_bot: r.get::<_, i32>(21)? != 0,
                        welcome_group: r.get::<_, i32>(22)? != 0,
                        bye_group: r.get::<_, i32>(23)? != 0,
                        settings: serde_json::from_str(&s_raw).unwrap_or_else(|_| json!({})),
                        updated_at: r.get(25)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    // -------------------------------------------------------------------------
    // Command Studio V2 Layers (Atomic 409 REVISION_CONFLICT Optimistic CAS)
    // -------------------------------------------------------------------------

    pub fn get_studio_layer(
        &self,
        scope_type: &str,
        bot_key: &str,
        thread_id: &str,
        command_name: &str,
    ) -> Result<Option<CommandStudioLayer>, StorageError> {
        self.with_reader(|conn| {
            conn.query_row(
                r#"
                SELECT scope_type, bot_key, thread_id, command_name, overrides_json, revision, updated_by, updated_at
                FROM command_studio_layers
                WHERE scope_type = ?1 AND bot_key = ?2 AND thread_id = ?3 AND command_name = ?4
                "#,
                params![scope_type, bot_key, thread_id, command_name],
                |r| {
                    let raw: String = r.get(4)?;
                    Ok(CommandStudioLayer {
                        scope_type: r.get(0)?,
                        bot_key: r.get(1)?,
                        thread_id: r.get(2)?,
                        command_name: r.get(3)?,
                        overrides: serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
                        revision: r.get(5)?,
                        updated_by: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn load_all_studio_layers(&self) -> Result<Vec<CommandStudioLayer>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT scope_type, bot_key, thread_id, command_name, overrides_json, revision, updated_by, updated_at FROM command_studio_layers",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    let raw: String = r.get(4)?;
                    Ok(CommandStudioLayer {
                        scope_type: r.get(0)?,
                        bot_key: r.get(1)?,
                        thread_id: r.get(2)?,
                        command_name: r.get(3)?,
                        overrides: serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
                        revision: r.get(5)?,
                        updated_by: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Atomically updates a Command Studio layer, checking `expected_revision` if `Some(...)`
    /// and appending an immutable audit entry to `command_studio_history`.
    #[allow(clippy::too_many_arguments)]
    pub fn save_studio_layer_cas(
        &self,
        scope_type: &str,
        bot_key: &str,
        thread_id: &str,
        command_name: &str,
        overrides: &Value,
        expected_revision: Option<i64>,
        actor: &str,
        note: &str,
    ) -> Result<CommandStudioLayer, StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            let current: Option<(String, i64)> = tx
                .query_row(
                    r#"
                    SELECT overrides_json, revision FROM command_studio_layers
                    WHERE scope_type = ?1 AND bot_key = ?2 AND thread_id = ?3 AND command_name = ?4
                    "#,
                    params![scope_type, bot_key, thread_id, command_name],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;

            let (prev_json, actual_rev) = current.unwrap_or_else(|| ("{}".to_string(), 0));
            if let Some(exp) = expected_revision
                && exp != actual_rev
            {
                return Err(StorageError::RevisionConflict {
                    expected: exp,
                    actual: actual_rev,
                });
            }

            let next_rev = actual_rev + 1;
            let next_json = serde_json::to_string(overrides)?;
            let now = Utc::now().to_rfc3339();

            tx.execute(
                r#"
                INSERT INTO command_studio_layers (
                    scope_type, bot_key, thread_id, command_name, overrides_json, revision, updated_by, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(scope_type, bot_key, thread_id, command_name) DO UPDATE SET
                    overrides_json = excluded.overrides_json,
                    revision = excluded.revision,
                    updated_by = excluded.updated_by,
                    updated_at = excluded.updated_at
                "#,
                params![
                    scope_type,
                    bot_key,
                    thread_id,
                    command_name,
                    next_json,
                    next_rev,
                    actor,
                    now
                ],
            )?;

            tx.execute(
                r#"
                INSERT INTO command_studio_history (
                    scope_type, bot_key, thread_id, command_name, revision,
                    previous_json, next_json, actor, note, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    scope_type,
                    bot_key,
                    thread_id,
                    command_name,
                    next_rev,
                    prev_json,
                    next_json,
                    actor,
                    note,
                    now
                ],
            )?;

            tx.commit()?;
            Ok(CommandStudioLayer {
                scope_type: scope_type.to_string(),
                bot_key: bot_key.to_string(),
                thread_id: thread_id.to_string(),
                command_name: command_name.to_string(),
                overrides: overrides.clone(),
                revision: next_rev,
                updated_by: actor.to_string(),
                updated_at: now,
            })
        })
    }

    pub fn list_studio_history(
        &self,
        scope_type: &str,
        bot_key: &str,
        thread_id: &str,
        command_name: &str,
        limit: usize,
    ) -> Result<Vec<CommandStudioHistoryItem>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, scope_type, bot_key, thread_id, command_name, revision, previous_json, next_json, actor, note, created_at
                FROM command_studio_history
                WHERE scope_type = ?1 AND bot_key = ?2 AND thread_id = ?3 AND command_name = ?4
                ORDER BY id DESC
                LIMIT ?5
                "#,
            )?;
            let rows = stmt
                .query_map(
                    params![scope_type, bot_key, thread_id, command_name, limit as i64],
                    |r| {
                        let p: String = r.get(6)?;
                        let n: String = r.get(7)?;
                        Ok(CommandStudioHistoryItem {
                            id: r.get(0)?,
                            scope_type: r.get(1)?,
                            bot_key: r.get(2)?,
                            thread_id: r.get(3)?,
                            command_name: r.get(4)?,
                            revision: r.get(5)?,
                            previous: serde_json::from_str(&p).unwrap_or_else(|_| json!({})),
                            next: serde_json::from_str(&n).unwrap_or_else(|_| json!({})),
                            actor: r.get(8)?,
                            note: r.get(9)?,
                            created_at: r.get(10)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_studio_draft(
        &self,
        draft_key: &str,
        scope_type: &str,
        bot_key: &str,
        thread_id: &str,
        command_name: &str,
        draft: &Value,
        base_revision: i64,
        actor: &str,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO command_studio_drafts (
                    draft_key, scope_type, bot_key, thread_id, command_name, draft_json, base_revision, updated_by, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(draft_key) DO UPDATE SET
                    draft_json = excluded.draft_json,
                    base_revision = excluded.base_revision,
                    updated_by = excluded.updated_by,
                    updated_at = excluded.updated_at
                "#,
                params![
                    draft_key,
                    scope_type,
                    bot_key,
                    thread_id,
                    command_name,
                    serde_json::to_string(draft)?,
                    base_revision,
                    actor,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(())
        })
    }

    pub fn get_studio_draft(&self, draft_key: &str) -> Result<Option<Value>, StorageError> {
        self.with_reader(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT draft_json FROM command_studio_drafts WHERE draft_key = ?1",
                    params![draft_key],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
        })
    }

    // -------------------------------------------------------------------------
    // Rank Counters & TopChat
    // -------------------------------------------------------------------------

    pub fn upsert_rank_batch(&self, items: &[RankEntry]) -> Result<(), StorageError> {
        if items.is_empty() {
            return Ok(());
        }
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            Self::upsert_rank_in_tx(&tx, items)?;
            tx.commit()?;
            Ok(())
        })
    }

    pub(crate) fn upsert_rank_in_tx(conn: &Connection, items: &[RankEntry]) -> Result<(), StorageError> {
        let mut stmt = conn.prepare_cached(
            r#"
            INSERT INTO rank_counters (bot_key, thread_id, user_uid, user_name, msg_count, daily_count, last_msg_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(bot_key, thread_id, user_uid) DO UPDATE SET
                user_name = CASE WHEN excluded.user_name != '' THEN excluded.user_name ELSE rank_counters.user_name END,
                msg_count = excluded.msg_count,
                daily_count = excluded.daily_count,
                last_msg_at = excluded.last_msg_at
            "#,
        )?;
        for r in items {
            stmt.execute(params![
                r.bot_key,
                r.thread_id,
                r.user_uid,
                r.user_name,
                r.msg_count as i64,
                r.daily_count as i64,
                r.last_msg_at,
            ])?;
        }
        Ok(())
    }

    pub fn load_all_ranks(&self) -> Result<Vec<RankEntry>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT bot_key, thread_id, user_uid, user_name, msg_count, daily_count, last_msg_at FROM rank_counters",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(RankEntry {
                        bot_key: r.get(0)?,
                        thread_id: r.get(1)?,
                        user_uid: r.get(2)?,
                        user_name: r.get(3)?,
                        msg_count: r.get::<_, i64>(4)?.max(0) as u64,
                        daily_count: r.get::<_, i64>(5)?.max(0) as u64,
                        last_msg_at: r.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn top_ranks_for_thread(
        &self,
        bot_key: &str,
        thread_id: &str,
        limit: usize,
        daily_only: bool,
    ) -> Result<Vec<RankEntry>, StorageError> {
        self.with_reader(|conn| {
            let sql = if daily_only {
                "SELECT bot_key, thread_id, user_uid, user_name, msg_count, daily_count, last_msg_at FROM rank_counters WHERE bot_key = ?1 AND thread_id = ?2 AND daily_count > 0 ORDER BY daily_count DESC LIMIT ?3"
            } else {
                "SELECT bot_key, thread_id, user_uid, user_name, msg_count, daily_count, last_msg_at FROM rank_counters WHERE bot_key = ?1 AND thread_id = ?2 ORDER BY msg_count DESC LIMIT ?3"
            };
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt
                .query_map(params![bot_key, thread_id, limit as i64], |r| {
                    Ok(RankEntry {
                        bot_key: r.get(0)?,
                        thread_id: r.get(1)?,
                        user_uid: r.get(2)?,
                        user_name: r.get(3)?,
                        msg_count: r.get::<_, i64>(4)?.max(0) as u64,
                        daily_count: r.get::<_, i64>(5)?.max(0) as u64,
                        last_msg_at: r.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn reset_daily_ranks(&self) -> Result<usize, StorageError> {
        self.with_writer(|conn| {
            let changed = conn.execute("UPDATE rank_counters SET daily_count = 0 WHERE daily_count != 0", [])?;
            Ok(changed)
        })
    }

    // -------------------------------------------------------------------------
    // Message Cache (24h `!antiundo`) & Locmem (35-day rolling window)
    // -------------------------------------------------------------------------

    pub fn insert_cached_messages_batch(&self, items: &[CachedMessageRecord]) -> Result<(), StorageError> {
        if items.is_empty() {
            return Ok(());
        }
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    r#"
                    INSERT INTO message_cache (
                        bot_key, thread_id, sender_uid, sender_name,
                        cli_msg_id, msg_id, global_msg_id, msg_type, payload_json,
                        created_at_ms, expires_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                    "#,
                )?;
                for m in items {
                    stmt.execute(params![
                        m.bot_key,
                        m.thread_id,
                        m.sender_uid,
                        m.sender_name,
                        m.cli_msg_id,
                        m.msg_id,
                        m.global_msg_id,
                        m.msg_type,
                        serde_json::to_string(&m.payload)?,
                        m.created_at_ms,
                        m.expires_at_ms,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn lookup_cached_message(
        &self,
        bot_key: &str,
        any_id: &str,
        now_ms: i64,
    ) -> Result<Option<CachedMessageRecord>, StorageError> {
        if any_id.is_empty() {
            return Ok(None);
        }
        self.with_reader(|conn| {
            conn.query_row(
                r#"
                SELECT
                    bot_key, thread_id, sender_uid, sender_name,
                    cli_msg_id, msg_id, global_msg_id, msg_type, payload_json,
                    created_at_ms, expires_at_ms
                FROM message_cache
                WHERE bot_key = ?1
                  AND expires_at_ms > ?2
                  AND (cli_msg_id = ?3 OR msg_id = ?3 OR global_msg_id = ?3)
                ORDER BY id DESC
                LIMIT 1
                "#,
                params![bot_key, now_ms, any_id],
                |r| {
                    let p: String = r.get(8)?;
                    Ok(CachedMessageRecord {
                        bot_key: r.get(0)?,
                        thread_id: r.get(1)?,
                        sender_uid: r.get(2)?,
                        sender_name: r.get(3)?,
                        cli_msg_id: r.get(4)?,
                        msg_id: r.get(5)?,
                        global_msg_id: r.get(6)?,
                        msg_type: r.get(7)?,
                        payload: serde_json::from_str(&p).unwrap_or_else(|_| json!({})),
                        created_at_ms: r.get(9)?,
                        expires_at_ms: r.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn prune_expired_messages(&self, now_ms: i64) -> Result<usize, StorageError> {
        self.with_writer(|conn| {
            Ok(conn.execute("DELETE FROM message_cache WHERE expires_at_ms <= ?1", params![now_ms])?)
        })
    }

    pub fn increment_locmem_batch(&self, deltas: &[LocmemDayRow]) -> Result<(), StorageError> {
        if deltas.is_empty() {
            return Ok(());
        }
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    r#"
                    INSERT INTO locmem_daily (
                        bot_key, thread_id, date_ict, user_uid, msg_count, react_count, join_actions, last_seen_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    ON CONFLICT(bot_key, thread_id, date_ict, user_uid) DO UPDATE SET
                        msg_count = locmem_daily.msg_count + excluded.msg_count,
                        react_count = locmem_daily.react_count + excluded.react_count,
                        join_actions = locmem_daily.join_actions + excluded.join_actions,
                        last_seen_ms = MAX(locmem_daily.last_seen_ms, excluded.last_seen_ms)
                    "#,
                )?;
                for d in deltas {
                    stmt.execute(params![
                        d.bot_key,
                        d.thread_id,
                        d.date_ict,
                        d.user_uid,
                        d.msg_count as i64,
                        d.react_count as i64,
                        d.join_actions as i64,
                        d.last_seen_ms,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn query_locmem_range(
        &self,
        bot_key: &str,
        thread_id: &str,
        from_date_ict: &str,
        to_date_ict: &str,
    ) -> Result<Vec<(String, u64, u64, u64)>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT user_uid, SUM(msg_count), SUM(react_count), SUM(join_actions)
                FROM locmem_daily
                WHERE bot_key = ?1 AND thread_id = ?2 AND date_ict >= ?3 AND date_ict <= ?4
                GROUP BY user_uid
                "#,
            )?;
            let rows = stmt
                .query_map(params![bot_key, thread_id, from_date_ict, to_date_ict], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?.max(0) as u64,
                        r.get::<_, i64>(2)?.max(0) as u64,
                        r.get::<_, i64>(3)?.max(0) as u64,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn prune_locmem_before(&self, cutoff_date_ict: &str) -> Result<usize, StorageError> {
        self.with_writer(|conn| {
            let n1 = conn.execute(
                "DELETE FROM locmem_daily WHERE date_ict < ?1",
                params![cutoff_date_ict],
            )?;
            let _ = conn.execute(
                "DELETE FROM locmem_coverage WHERE date_ict < ?1",
                params![cutoff_date_ict],
            )?;
            Ok(n1)
        })
    }

    pub fn get_locmem_coverage_days(
        &self,
        bot_key: &str,
        thread_id: &str,
        days: &[String],
    ) -> Result<Vec<String>, StorageError> {
        self.with_reader(|conn| {
            let mut complete = Vec::new();
            for d in days {
                let has_cov: bool = conn
                    .query_row(
                        "SELECT 1 FROM locmem_coverage WHERE bot_key = ?1 AND date_ict = ?2 AND coverage_state = 'complete' LIMIT 1",
                        params![bot_key, d],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if has_cov {
                    complete.push(d.clone());
                    continue;
                }
                let has_daily: bool = conn
                    .query_row(
                        "SELECT 1 FROM locmem_daily WHERE bot_key = ?1 AND thread_id = ?2 AND date_ict = ?3 LIMIT 1",
                        params![bot_key, thread_id, d],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if has_daily {
                    complete.push(d.clone());
                }
            }
            Ok(complete)
        })
    }

    pub fn record_locmem_coverage(
        &self,
        bot_key: &str,
        date_ict: &str,
        coverage_state: &str,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO locmem_coverage (bot_key, date_ict, coverage_state, first_seen_ms, last_seen_ms)
                VALUES (?1, ?2, ?3, 0, 0)
                ON CONFLICT(bot_key, date_ict) DO UPDATE SET coverage_state = excluded.coverage_state
                "#,
                params![bot_key, date_ict, coverage_state],
            )?;
            Ok(())
        })
    }

    // -------------------------------------------------------------------------
    // Trial Ledger, Custom Commands, Learned QA, Provider Secrets & Audit Logs
    // -------------------------------------------------------------------------

    pub fn upsert_trial_ledger(&self, row: &TrialLedgerRow) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO trial_ledger (owner_uid, iso_week, used_seconds, bot_key, granted_at, expires_at, status)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(owner_uid, iso_week) DO UPDATE SET
                    used_seconds = excluded.used_seconds,
                    bot_key = excluded.bot_key,
                    granted_at = excluded.granted_at,
                    expires_at = excluded.expires_at,
                    status = excluded.status
                "#,
                params![
                    row.owner_uid,
                    row.iso_week,
                    row.used_seconds,
                    row.bot_key,
                    row.granted_at,
                    row.expires_at,
                    row.status,
                ],
            )?;
            Ok(())
        })
    }

    pub fn get_trial_ledger(
        &self,
        owner_uid: &str,
        iso_week: &str,
    ) -> Result<Option<TrialLedgerRow>, StorageError> {
        self.with_reader(|conn| {
            conn.query_row(
                "SELECT owner_uid, iso_week, used_seconds, bot_key, granted_at, expires_at, status FROM trial_ledger WHERE owner_uid = ?1 AND iso_week = ?2",
                params![owner_uid, iso_week],
                |r| {
                    Ok(TrialLedgerRow {
                        owner_uid: r.get(0)?,
                        iso_week: r.get(1)?,
                        used_seconds: r.get(2)?,
                        bot_key: r.get(3)?,
                        granted_at: r.get(4)?,
                        expires_at: r.get(5)?,
                        status: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn reset_trial_ledger(&self, owner_uid: &str) -> Result<usize, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM trial_ledger WHERE owner_uid = ?1",
                params![owner_uid],
            )?;
            Ok(n)
        })
    }

    pub fn set_provider_secret(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let mut hasher = Sha256::new();
        hasher.update(value.as_bytes());
        let sha = hex::encode(hasher.finalize());
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO provider_secrets (secret_key, secret_value, value_sha256, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(secret_key) DO UPDATE SET
                    secret_value = excluded.secret_value,
                    value_sha256 = excluded.value_sha256,
                    updated_at = excluded.updated_at
                "#,
                params![key, value, sha, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn get_provider_secret(&self, key: &str) -> Result<Option<String>, StorageError> {
        self.with_reader(|conn| {
            conn.query_row(
                "SELECT secret_value FROM provider_secrets WHERE secret_key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    pub fn list_provider_secrets_redacted(&self) -> Result<Vec<ProviderSecretMeta>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT secret_key, secret_value, value_sha256, updated_at FROM provider_secrets WHERE secret_key NOT LIKE '__dashboard_%' ORDER BY secret_key ASC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    let val: String = r.get(1)?;
                    let sha: String = r.get(2)?;
                    Ok(ProviderSecretMeta {
                        secret_key: r.get(0)?,
                        configured: !val.trim().is_empty(),
                        fingerprint_prefix: sha.chars().take(8).collect(),
                        updated_at: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Exports a safe, secret-redacted configuration backup snapshot for Dashboard 1-click download.
    pub fn export_redacted_backup_json(&self) -> Result<Value, StorageError> {
        let bots: Vec<Value> = self
            .list_bots()?
            .into_iter()
            .map(|b| {
                let admins = self.list_bot_admins(&b.bot_key).unwrap_or_default();
                let mut summary = b.to_redacted_summary();
                if let Some(obj) = summary.as_object_mut() {
                    obj.insert("admins".into(), json!(admins));
                }
                summary
            })
            .collect();
        let groups = self.load_all_group_settings()?;
        let studio_layers = self.load_all_studio_layers()?;
        let custom_commands = self.list_custom_commands(None)?;
        let provider_meta = self.list_provider_secrets_redacted()?;

        Ok(json!({
            "schema": "mybot-v4-backup",
            "version": 4,
            "exportedAt": Utc::now().to_rfc3339(),
            "bots": bots,
            "groupSettings": groups,
            "commandStudioLayers": studio_layers,
            "customCommands": custom_commands,
            "providerSecretsRedacted": provider_meta,
        }))
    }

    pub fn upsert_custom_command(
        &self,
        bot_key: &str,
        trigger_name: &str,
        definition: &Value,
        enabled: bool,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO custom_commands (bot_key, trigger_name, definition_json, enabled, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(bot_key, trigger_name) DO UPDATE SET
                    definition_json = excluded.definition_json,
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
                "#,
                params![
                    bot_key,
                    trigger_name,
                    serde_json::to_string(definition)?,
                    i32::from(enabled),
                    Utc::now().to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn list_custom_commands(&self, bot_key: Option<&str>) -> Result<Vec<(String, String, Value, bool)>, StorageError> {
        self.with_reader(|conn| {
            let mut out = Vec::new();
            if let Some(bk) = bot_key {
                let mut stmt = conn.prepare(
                    "SELECT bot_key, trigger_name, definition_json, enabled FROM custom_commands WHERE bot_key = ?1 OR bot_key = '' ORDER BY trigger_name ASC",
                )?;
                let rows = stmt.query_map(params![bk], |r| {
                    let raw: String = r.get(2)?;
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
                        r.get::<_, i32>(3)? != 0,
                    ))
                })?;
                for item in rows {
                    out.push(item?);
                }
            } else {
                let mut stmt = conn.prepare(
                    "SELECT bot_key, trigger_name, definition_json, enabled FROM custom_commands ORDER BY bot_key ASC, trigger_name ASC",
                )?;
                let rows = stmt.query_map([], |r| {
                    let raw: String = r.get(2)?;
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        serde_json::from_str(&raw).unwrap_or_else(|_| json!({})),
                        r.get::<_, i32>(3)? != 0,
                    ))
                })?;
                for item in rows {
                    out.push(item?);
                }
            }
            Ok(out)
        })
    }

    pub fn upsert_learned_qa(
        &self,
        bot_key: &str,
        thread_id: &str,
        question_norm: &str,
        answers: &[String],
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO learned_qa (bot_key, thread_id, question_norm, answers_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(bot_key, thread_id, question_norm) DO UPDATE SET
                    answers_json = excluded.answers_json,
                    updated_at = excluded.updated_at
                "#,
                params![
                    bot_key,
                    thread_id,
                    question_norm,
                    serde_json::to_string(answers)?,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(())
        })
    }

    pub fn lookup_learned_qa(
        &self,
        bot_key: &str,
        thread_id: &str,
        question_norm: &str,
    ) -> Result<Option<Vec<String>>, StorageError> {
        self.with_reader(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    r#"
                    SELECT answers_json FROM learned_qa
                    WHERE question_norm = ?1 AND (
                        (bot_key = ?2 AND thread_id = ?3)
                        OR (bot_key = ?2 AND thread_id = '')
                        OR (bot_key = '' AND thread_id = ?3)
                        OR (bot_key = '' AND thread_id = '')
                    )
                    ORDER BY (bot_key != '') DESC, (thread_id != '') DESC
                    LIMIT 1
                    "#,
                    params![question_norm, bot_key, thread_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
        })
    }

    pub fn append_audit_log(
        &self,
        actor: &str,
        action: &str,
        target: &str,
        detail: &Value,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT INTO audit_logs (actor, action, target, detail_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    actor,
                    action,
                    target,
                    serde_json::to_string(detail)?,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(())
        })
    }

    /// Bulk-toggles `enable_bot` for all known groups of a bot (or all bots if `bot_key` is empty).
    pub fn set_all_groups_enable_bot(
        &self,
        bot_key: &str,
        enabled: bool,
    ) -> Result<Vec<GroupSettingsRecord>, StorageError> {
        let mut all = self.load_all_group_settings()?;
        let mut updated = Vec::new();
        let now = Utc::now().to_rfc3339();
        for rec in &mut all {
            if bot_key.is_empty() || rec.bot_key == bot_key {
                rec.enable_bot = enabled;
                if let Some(obj) = rec.settings.as_object_mut() {
                    obj.insert("enableBot".into(), Value::Bool(enabled));
                    obj.insert("activeBot".into(), Value::Bool(enabled));
                } else {
                    rec.settings = json!({
                        "enableBot": enabled,
                        "activeBot": enabled,
                    });
                }
                rec.updated_at = now.clone();
                updated.push(rec.clone());
            }
        }
        if !updated.is_empty() {
            self.upsert_group_settings_batch(&updated)?;
        }
        Ok(updated)
    }

    pub fn delete_custom_command(&self, bot_key: &str, trigger_name: &str) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM custom_commands WHERE (bot_key = ?1 OR bot_key = '') AND trigger_name = ?2",
                params![bot_key, trigger_name],
            )?;
            Ok(n > 0)
        })
    }

    pub fn delete_learned_qa(
        &self,
        bot_key: &str,
        thread_id: &str,
        question_norm: &str,
    ) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM learned_qa WHERE question_norm = ?1 AND (bot_key = ?2 OR bot_key = '') AND (thread_id = ?3 OR thread_id = '')",
                params![question_norm, bot_key, thread_id],
            )?;
            Ok(n > 0)
        })
    }

    pub fn list_learned_qa_for_thread(
        &self,
        bot_key: &str,
        thread_id: &str,
    ) -> Result<Vec<(String, Vec<String>)>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT question_norm, answers_json FROM learned_qa
                WHERE (bot_key = ?1 OR bot_key = '') AND (thread_id = ?2 OR thread_id = '')
                ORDER BY question_norm ASC
                "#,
            )?;
            let rows = stmt
                .query_map(params![bot_key, thread_id], |r| {
                    let q: String = r.get(0)?;
                    let raw: String = r.get(1)?;
                    let ans: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
                    Ok((q, ans))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    // -------------------------------------------------------------------------
    // Reminders (`!nhacnho`)
    // -------------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn insert_reminder(
        &self,
        bot_key: &str,
        thread_id: &str,
        thread_type: u8,
        target_uid: &str,
        creator_uid: &str,
        content: &str,
        due_at_ms: i64,
        repeat_mode: &str,
    ) -> Result<i64, StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO reminders (bot_key, thread_id, thread_type, target_uid, creator_uid, content, due_at_ms, repeat_mode, delivered, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)
                "#,
                params![
                    bot_key,
                    thread_id,
                    i32::from(thread_type),
                    target_uid,
                    creator_uid,
                    content,
                    due_at_ms,
                    repeat_mode,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn list_reminders_for_thread(
        &self,
        bot_key: &str,
        thread_id: &str,
    ) -> Result<Vec<ReminderRecord>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, bot_key, thread_id, thread_type, target_uid, creator_uid, content, due_at_ms, repeat_mode, delivered, created_at
                FROM reminders
                WHERE bot_key = ?1 AND thread_id = ?2 AND delivered = 0
                ORDER BY due_at_ms ASC
                "#,
            )?;
            let rows = stmt
                .query_map(params![bot_key, thread_id], |r| {
                    Ok(ReminderRecord {
                        id: r.get(0)?,
                        bot_key: r.get(1)?,
                        thread_id: r.get(2)?,
                        thread_type: r.get::<_, i32>(3)? as u8,
                        target_uid: r.get(4)?,
                        creator_uid: r.get(5)?,
                        content: r.get(6)?,
                        due_at_ms: r.get(7)?,
                        repeat_mode: r.get(8)?,
                        delivered: r.get::<_, i32>(9)? != 0,
                        created_at: r.get(10)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn delete_reminder(&self, bot_key: &str, thread_id: &str, id: i64) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM reminders WHERE id = ?1 AND bot_key = ?2 AND thread_id = ?3",
                params![id, bot_key, thread_id],
            )?;
            Ok(n > 0)
        })
    }

    /// Atomically fetches due reminders and either advances `due_at_ms` (for repeating reminders) or marks `delivered = 1`.
    pub fn claim_due_reminders(&self, now_ms: i64) -> Result<Vec<ReminderRecord>, StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction()?;
            let due_items = {
                let mut stmt = tx.prepare(
                    r#"
                    SELECT id, bot_key, thread_id, thread_type, target_uid, creator_uid, content, due_at_ms, repeat_mode, delivered, created_at
                    FROM reminders
                    WHERE delivered = 0 AND due_at_ms <= ?1
                    ORDER BY due_at_ms ASC
                    LIMIT 64
                    "#,
                )?;
                stmt
                    .query_map(params![now_ms], |r| {
                        Ok(ReminderRecord {
                            id: r.get(0)?,
                            bot_key: r.get(1)?,
                            thread_id: r.get(2)?,
                            thread_type: r.get::<_, i32>(3)? as u8,
                            target_uid: r.get(4)?,
                            creator_uid: r.get(5)?,
                            content: r.get(6)?,
                            due_at_ms: r.get(7)?,
                            repeat_mode: r.get(8)?,
                            delivered: r.get::<_, i32>(9)? != 0,
                            created_at: r.get(10)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };

            for item in &due_items {
                let next_due = match item.repeat_mode.as_str() {
                    "daily" => Some(item.due_at_ms + 86_400_000),
                    "weekly" => Some(item.due_at_ms + 7 * 86_400_000),
                    "monthly" => Some(item.due_at_ms + 30 * 86_400_000),
                    _ => None,
                };
                if let Some(mut next_ts) = next_due {
                    while next_ts <= now_ms {
                        next_ts += 86_400_000;
                    }
                    tx.execute(
                        "UPDATE reminders SET due_at_ms = ?1 WHERE id = ?2",
                        params![next_ts, item.id],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE reminders SET delivered = 1 WHERE id = ?1",
                        params![item.id],
                    )?;
                }
            }
            tx.commit()?;
            Ok(due_items)
        })
    }

    // -------------------------------------------------------------------------
    // Saved Bank Accounts (`!mybank`)
    // -------------------------------------------------------------------------

    pub fn insert_bank_account(
        &self,
        bot_key: &str,
        bin_bank: u32,
        bank_short_name: &str,
        account_number: &str,
        account_name: &str,
    ) -> Result<i64, StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO bot_bank_accounts (bot_key, bin_bank, bank_short_name, account_number, account_name, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    bot_key,
                    i64::from(bin_bank),
                    bank_short_name,
                    account_number,
                    account_name.to_uppercase(),
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn list_bank_accounts(&self, bot_key: &str) -> Result<Vec<BankAccountRecord>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, bot_key, bin_bank, bank_short_name, account_number, account_name, created_at
                FROM bot_bank_accounts
                WHERE bot_key = ?1
                ORDER BY id ASC
                "#,
            )?;
            let rows = stmt
                .query_map(params![bot_key], |r| {
                    Ok(BankAccountRecord {
                        id: r.get(0)?,
                        bot_key: r.get(1)?,
                        bin_bank: r.get::<_, i64>(2)? as u32,
                        bank_short_name: r.get(3)?,
                        account_number: r.get(4)?,
                        account_name: r.get(5)?,
                        created_at: r.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn delete_bank_account(&self, bot_key: &str, id: i64) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM bot_bank_accounts WHERE id = ?1 AND bot_key = ?2",
                params![id, bot_key],
            )?;
            Ok(n > 0)
        })
    }

    // -------------------------------------------------------------------------
    // Global Bot Blacklist (`!ban`, `!unban`, `!blockbot`, `!unblockbot`, `!listblockbot`)
    // -------------------------------------------------------------------------

    pub fn upsert_blocked_user(
        &self,
        bot_key: &str,
        user_uid: &str,
        user_name: &str,
        reason: &str,
        blocked_by: &str,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO global_blocked_users (bot_key, user_uid, user_name, reason, blocked_by, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(bot_key, user_uid) DO UPDATE SET
                    user_name = CASE WHEN excluded.user_name != '' THEN excluded.user_name ELSE global_blocked_users.user_name END,
                    reason = excluded.reason,
                    blocked_by = excluded.blocked_by
                "#,
                params![bot_key, user_uid, user_name, reason, blocked_by, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn remove_blocked_user(&self, bot_key: &str, user_uid: &str) -> Result<bool, StorageError> {
        self.with_writer(|conn| {
            let n = conn.execute(
                "DELETE FROM global_blocked_users WHERE user_uid = ?1 AND (bot_key = ?2 OR bot_key = '')",
                params![user_uid, bot_key],
            )?;
            Ok(n > 0)
        })
    }

    pub fn is_user_blocked_globally(&self, bot_key: &str, user_uid: &str) -> Result<bool, StorageError> {
        self.with_reader(|conn| {
            let found: Option<i32> = conn
                .query_row(
                    "SELECT 1 FROM global_blocked_users WHERE user_uid = ?1 AND (bot_key = ?2 OR bot_key = '') LIMIT 1",
                    params![user_uid, bot_key],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(found.is_some())
        })
    }

    pub fn list_blocked_users(&self, bot_key: &str) -> Result<Vec<BlockedUserRecord>, StorageError> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                r#"
                SELECT bot_key, user_uid, user_name, reason, blocked_by, created_at
                FROM global_blocked_users
                WHERE bot_key = ?1 OR bot_key = ''
                ORDER BY created_at DESC
                "#,
            )?;
            let rows = stmt
                .query_map(params![bot_key], |r| {
                    Ok(BlockedUserRecord {
                        bot_key: r.get(0)?,
                        user_uid: r.get(1)?,
                        user_name: r.get(2)?,
                        reason: r.get(3)?,
                        blocked_by: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    // -------------------------------------------------------------------------
    // 7-Day Link Platform Cache (`link_platform_cache`)
    // -------------------------------------------------------------------------

    pub fn get_link_cache(&self, cache_key: &str, now_ms: i64) -> Result<Option<Value>, StorageError> {
        self.with_reader(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT resolved_json FROM link_platform_cache WHERE cache_key = ?1 AND expires_at_ms > ?2",
                    params![cache_key, now_ms],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
        })
    }

    pub fn upsert_link_cache(
        &self,
        cache_key: &str,
        platform: &str,
        resolved: &Value,
        ttl_ms: i64,
    ) -> Result<(), StorageError> {
        let now_ms = Utc::now().timestamp_millis();
        let expires_at_ms = now_ms.saturating_add(ttl_ms);
        self.with_writer(|conn| {
            conn.execute(
                r#"
                INSERT INTO link_platform_cache (cache_key, platform, resolved_json, expires_at_ms, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(cache_key) DO UPDATE SET
                    platform = excluded.platform,
                    resolved_json = excluded.resolved_json,
                    expires_at_ms = excluded.expires_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                "#,
                params![
                    cache_key,
                    platform,
                    serde_json::to_string(resolved)?,
                    expires_at_ms,
                    now_ms
                ],
            )?;
            Ok(())
        })
    }
}
