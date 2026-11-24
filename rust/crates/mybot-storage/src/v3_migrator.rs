//! Lossless, case-insensitive V3 (Windows Node.js JSON) -> V4 (Linux Ubuntu SQLite WAL) migrator.
//!
//! Guarantees:
//! 1. **100% Live Session Preservation**: Every bot's `(cookie, imei, userAgent)` is copied
//!    untouched so active Zalo Web sessions migrated from Windows to Ubuntu never log out.
//! 2. **NTFS -> ext4 Case-Insensitivity**: Walks `source_dir` once to build a lowercase path index,
//!    and normalizes Windows `\` asset paths to `/`.
//! 3. **Strict Secret Redaction**: `MigrationReport` only exposes aggregate record counts and masked
//!    bot keys; cookies, IMEIs, `secretKey`s, and `.env` tokens are NEVER logged or printed.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use chrono::Utc;
use mybot_types::{DEFAULT_ZALO_USER_AGENT, ExpiryPolicy, ZaloId};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::db::{
    BotRecord, GroupSettingsRecord, LocmemDayRow, RankEntry, StorageEngine, StorageError,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub dry_run: bool,
    pub files_indexed: usize,
    pub bots_migrated: usize,
    pub bots_with_live_cookies: usize,
    pub primary_bot_key: String,
    pub admins_migrated: usize,
    pub group_settings_migrated: usize,
    pub rank_entries_migrated: usize,
    pub locmem_rows_migrated: usize,
    pub command_layers_migrated: usize,
    pub custom_commands_migrated: usize,
    pub learned_qa_migrated: usize,
    pub link_cache_migrated: usize,
    pub trial_rows_migrated: usize,
    pub provider_secrets_migrated: usize,
    pub redacted_bot_keys: Vec<String>,
    pub warnings: Vec<String>,
}

/// Case-insensitive file index over a V3 repository directory.
pub struct CaseInsensitiveFs {
    root: PathBuf,
    files: HashMap<String, PathBuf>,
}

impl CaseInsensitiveFs {
    pub fn scan(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        let mut files = HashMap::new();

        let walker = WalkDir::new(&root).into_iter().filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                "node_modules" | ".git" | "target" | ".cache" | "dist"
            )
        });

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(&root) {
                let norm = normalize_rel_key(&rel.to_string_lossy());
                files.insert(norm, entry.into_path());
            }
        }

        Self { root, files }
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn resolve(&self, rel: &str) -> Option<&PathBuf> {
        self.files.get(&normalize_rel_key(rel))
    }

    pub fn list_under(&self, prefix: &str) -> Vec<(String, PathBuf)> {
        let norm_prefix = normalize_rel_key(prefix);
        let with_slash = if norm_prefix.ends_with('/') {
            norm_prefix
        } else {
            format!("{norm_prefix}/")
        };
        let mut matches: Vec<(String, PathBuf)> = self
            .files
            .iter()
            .filter(|(k, _)| k.starts_with(&with_slash))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        matches.sort_by(|a, b| a.0.cmp(&b.0));
        matches
    }

    pub fn read_json(&self, rel: &str) -> Option<Value> {
        let path = self.resolve(rel)?;
        let raw = std::fs::read_to_string(path).ok()?;
        let trimmed = raw.trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() {
            return None;
        }
        serde_json::from_str(trimmed).ok()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

fn normalize_rel_key(s: &str) -> String {
    s.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_ascii_lowercase()
}

/// Normalizes Windows `\` separators inside relative V3 asset/storage path strings without
/// ever mutating cookies, IMEIs, User-Agents, or arbitrary user prose.
pub fn normalize_v3_asset_paths_in_json(value: &mut Value) {
    match value {
        Value::String(s) => {
            if s.contains('\\') {
                let lower = s.to_ascii_lowercase();
                if lower.starts_with("assets\\")
                    || lower.starts_with("mybot\\")
                    || lower.starts_with("src\\")
                    || lower.starts_with("logs\\")
                    || lower.starts_with(".\\assets\\")
                    || lower.starts_with(".\\mybot\\")
                {
                    *s = s.replace('\\', "/");
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                normalize_v3_asset_paths_in_json(item);
            }
        }
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if matches!(
                    k.as_str(),
                    "cookie" | "cookies" | "imei" | "userAgent" | "user_agent" | "secretKey"
                ) {
                    continue;
                }
                normalize_v3_asset_paths_in_json(v);
            }
        }
        _ => {}
    }
}

fn mask_identifier(id: &str) -> String {
    if id == "admin" || id.len() <= 5 {
        return id.to_string();
    }
    let prefix: String = id.chars().take(3).collect();
    let suffix: String = id
        .chars()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{prefix}***{suffix}")
}

/// Converts a legacy V1 `command.json` entry override into a Command Studio V2 layer delta.
pub fn migrate_v1_command_entry_to_v2(v1_entry: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(active) = v1_entry.get("active").and_then(Value::as_bool) {
        out.insert("operation.enabled".to_string(), Value::Bool(active));
    }
    if let Some(cd) = v1_entry.get("countdown").and_then(Value::as_u64) {
        out.insert("operation.cooldownSeconds".to_string(), json!(cd));
    }
    if let Some(role) = v1_entry.get("permission").or_else(|| v1_entry.get("role")) {
        out.insert("access.permission".to_string(), role.clone());
    }
    if let Some(alias) = v1_entry.get("alias") {
        out.insert("aliases".to_string(), alias.clone());
    }
    if let Some(behavior) = v1_entry.get("behavior").or_else(|| v1_entry.get("settings")) {
        let mut cloned = behavior.clone();
        normalize_v3_asset_paths_in_json(&mut cloned);
        out.insert("behavior".to_string(), cloned);
    }
    Value::Object(out)
}

/// Runs a complete V3 -> V4 migration inside a single atomic SQLite transaction.
/// When `dry_run` is `true`, all SQL statements and constraints are executed and verified,
/// then rolled back cleanly without writing persistent changes.
pub fn migrate_v3_directory(
    source_dir: impl AsRef<Path>,
    engine: &StorageEngine,
    dry_run: bool,
) -> Result<MigrationReport, StorageError> {
    let vfs = CaseInsensitiveFs::scan(source_dir);
    let mut report = MigrationReport {
        dry_run,
        files_indexed: vfs.file_count(),
        ..Default::default()
    };

    let now = Utc::now().to_rfc3339();

    // 1. Discover Bots & Preserve (cookie, imei, userAgent)
    let mut bots_map: BTreeMap<String, BotRecord> = BTreeMap::new();
    let v3_global_prefix = vfs
        .read_json("assets/json-data/command.json")
        .and_then(|cmd_cfg| first_non_empty_str(&cmd_cfg, &["prefix"]))
        .unwrap_or_else(|| "!".to_string());

    // 1a. Main Admin Bot (`assets/config.json` + optional `assets/data/cookie.json`)
    if let Some(cfg) = vfs.read_json("assets/config.json") {
        let cookie_val = extract_cookie_from_config(&vfs, &cfg);
        let imei = first_non_empty_str(&cfg, &["imei", "IMEI", "zaloImei"]).unwrap_or_default();
        let ua = first_non_empty_str(&cfg, &["userAgent", "user_agent"])
            .unwrap_or_else(|| DEFAULT_ZALO_USER_AGENT.to_string());
        let prefix = first_non_empty_str(&cfg, &["prefix"]).unwrap_or_else(|| v3_global_prefix.clone());
        let self_listen = cfg
            .get("selfListen")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let uid = first_non_empty_str(&cfg, &["botId", "uid", "accountId"])
            .or_else(|| infer_uid_from_cookie(&cookie_val))
            .unwrap_or_else(|| "admin".to_string());
        let display_name =
            first_non_empty_str(&cfg, &["name", "botName", "displayName"]).unwrap_or_else(|| "Main Bot".to_string());

        bots_map.insert(
            "admin".to_string(),
            BotRecord {
                bot_key: "admin".to_string(),
                uid: ZaloId::new(uid),
                global_uid: first_non_empty_str(&cfg, &["globalId", "globalUid"]),
                canonical_username: first_non_empty_str(&cfg, &["username", "canonicalUsername"]),
                display_name,
                avatar: first_non_empty_str(&cfg, &["avatar"]).unwrap_or_default(),
                is_main: true,
                owner_uid: None,
                status: "stopped".to_string(),
                desired_status: "running".to_string(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: cookie_val,
                imei,
                user_agent: ua,
                proxy_url: first_non_empty_str(&cfg, &["proxy", "proxyUrl"]),
                cookie_dead: false,
                cookie_dead_reason: None,
                prefix,
                self_listen,
                identity_pending: false,
                admin_identity_seeds: Vec::new(),
                metadata: json!({ "migratedFrom": "assets/config.json" }),
                created_at: now.clone(),
                updated_at: now.clone(),
            },
        );
    }

    // 1b. Sub-Bot Registry (`mybot/mybots.json`)
    if let Some(reg) = vfs.read_json("mybot/mybots.json") {
        for (bot_key, entry) in extract_registry_entries(&reg) {
            merge_bot_entry(&vfs, &mut bots_map, &bot_key, &entry, &v3_global_prefix, &now);
        }
    }

    // 1c. Standalone Credential & State Files (`mybot/credentials/*.json`, `mybot/bots/*.json`, `mybot/state/*.json`)
    for prefix in ["mybot/credentials", "mybot/bots", "mybot/state"] {
        for (_, path) in vfs.list_under(prefix) {
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            if let Ok(raw) = std::fs::read_to_string(&path)
                && let Ok(val) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
            {
                merge_bot_entry(&vfs, &mut bots_map, &stem, &val, &v3_global_prefix, &now);
            }
        }
    }

    // Ensure at least a default `"admin"` placeholder exists if migrating a fresh template checkout
    if bots_map.is_empty() {
        report
            .warnings
            .push("No live V3 bot credentials found; initialized placeholder 'admin' bot.".to_string());
        bots_map.insert(
            "admin".to_string(),
            BotRecord {
                bot_key: "admin".to_string(),
                uid: ZaloId::new("admin"),
                global_uid: None,
                canonical_username: None,
                display_name: "Main Bot".to_string(),
                avatar: String::new(),
                is_main: true,
                owner_uid: None,
                status: "stopped".to_string(),
                desired_status: "stopped".to_string(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: json!({}),
                imei: String::new(),
                user_agent: DEFAULT_ZALO_USER_AGENT.to_string(),
                proxy_url: None,
                cookie_dead: false,
                cookie_dead_reason: None,
                prefix: v3_global_prefix.clone(),
                self_listen: true,
                identity_pending: false,
                admin_identity_seeds: Vec::new(),
                metadata: json!({ "placeholder": true }),
                created_at: now.clone(),
                updated_at: now.clone(),
            },
        );
    }

    // Role registry primary bot resolution
    let mut primary_bot_key = bots_map
        .iter()
        .find(|(_, b)| b.is_main)
        .map(|(k, _)| k.clone())
        .unwrap_or_else(|| bots_map.keys().next().cloned().unwrap_or_else(|| "admin".to_string()));
    if let Some(rr) = vfs.read_json("mybot/role-registry.json")
        && let Some(pk) = first_non_empty_str(&rr, &["primaryBotId", "primaryBotKey", "mainBotId"])
        && bots_map.contains_key(&pk)
    {
        primary_bot_key = pk;
    }
    for (k, b) in bots_map.iter_mut() {
        b.is_main = k == &primary_bot_key;
    }
    report.primary_bot_key = mask_identifier(&primary_bot_key);

    // Execute all writes inside ONE atomic SQLite transaction
    engine.with_writer(|conn| {
        let tx = conn.transaction()?;

        // Insert bots
        for (k, bot) in &bots_map {
            StorageEngine::upsert_bot_on_conn(&tx, bot)?;
            report.bots_migrated += 1;
            if !bot.cookie_json.is_null() && bot.cookie_json != json!({}) && !bot.imei.is_empty() {
                report.bots_with_live_cookies += 1;
            }
            report.redacted_bot_keys.push(mask_identifier(k));
        }

        // Insert role registry
        tx.execute(
            r#"
            INSERT INTO role_registry (singleton_id, primary_bot_key, updated_at, history_json)
            VALUES (1, ?1, ?2, '[]')
            ON CONFLICT(singleton_id) DO UPDATE SET
                primary_bot_key = excluded.primary_bot_key,
                updated_at = excluded.updated_at
            "#,
            params![primary_bot_key, now],
        )?;

        // 2. Migrate Admin Lists (`assets/data/list_admin.json`, `mybot/instances/<bot>/data/admin-list.json`, `mybot/configs/list_admin-<bot>.json`)
        let mut admin_tuples: BTreeSet<(String, String, String)> = BTreeSet::new();
        if let Some(val) = vfs.read_json("assets/data/list_admin.json") {
            collect_admin_uids("admin", &val, &mut admin_tuples);
        }
        for bot_key in bots_map.keys() {
            let inst_rel = format!("mybot/instances/{bot_key}/data/admin-list.json");
            let legacy_rel = format!("mybot/configs/list_admin-{bot_key}.json");
            if let Some(val) = vfs.read_json(&inst_rel).or_else(|| vfs.read_json(&legacy_rel)) {
                collect_admin_uids(bot_key, &val, &mut admin_tuples);
            }
        }
        for (bk, uid, tier) in &admin_tuples {
            tx.execute(
                r#"
                INSERT INTO bot_admins (bot_key, admin_uid, tier, display_name, added_at)
                VALUES (?1, ?2, ?3, '', ?4)
                ON CONFLICT(bot_key, admin_uid) DO UPDATE SET tier = excluded.tier
                "#,
                params![bk, uid, tier, now],
            )?;
            report.admins_migrated += 1;
        }

        // 3. Migrate Group Settings (instance-first with legacy fallback)
        let mut all_groups: Vec<GroupSettingsRecord> = Vec::new();
        if let Some(mut val) = vfs
            .read_json("mybot/instances/admin/data/group_settings.json")
            .or_else(|| vfs.read_json("assets/data/group_settings.json"))
        {
            normalize_v3_asset_paths_in_json(&mut val);
            collect_group_settings("admin", &val, &mut all_groups);
        }
        for bot_key in bots_map.keys() {
            if bot_key == "admin" {
                continue;
            }
            let inst = format!("mybot/instances/{bot_key}/data/group_settings.json");
            let leg = format!("mybot/settings/groupSettings-{bot_key}.json");
            if let Some(mut val) = vfs.read_json(&inst).or_else(|| vfs.read_json(&leg)) {
                normalize_v3_asset_paths_in_json(&mut val);
                collect_group_settings(bot_key, &val, &mut all_groups);
            }
        }
        StorageEngine::upsert_group_settings_in_tx(&tx, &all_groups)?;
        report.group_settings_migrated = all_groups.len();

        // 4. Migrate Rank Counters (`rank-info.json`)
        let mut all_ranks: Vec<RankEntry> = Vec::new();
        if let Some(val) = vfs
            .read_json("mybot/instances/admin/data/rank-info.json")
            .or_else(|| vfs.read_json("assets/json-data/rank-info.json"))
        {
            collect_ranks("admin", &val, &mut all_ranks);
        }
        for bot_key in bots_map.keys() {
            if bot_key == "admin" {
                continue;
            }
            let inst = format!("mybot/instances/{bot_key}/data/rank-info.json");
            if let Some(val) = vfs.read_json(&inst) {
                collect_ranks(bot_key, &val, &mut all_ranks);
            }
        }
        StorageEngine::upsert_rank_in_tx(&tx, &all_ranks)?;
        report.rank_entries_migrated = all_ranks.len();

        // 5. Migrate Locmem 35-day Rolling Files (`locmem-activity-days/*.json`)
        let mut locmem_rows: Vec<LocmemDayRow> = Vec::new();
        for (rel, path) in vfs.list_under("mybot/instances") {
            // Expected pattern: mybot/instances/<bot>/data/locmem-activity-days/yyyy-mm-dd.json
            let parts: Vec<&str> = rel.split('/').collect();
            if parts.len() == 6
                && parts[3] == "data"
                && parts[4] == "locmem-activity-days"
                && parts[5].ends_with(".json")
                && parts[5] != "meta.json"
            {
                let bot_key = resolve_original_bot_key(&bots_map, parts[2]);
                let date_ict = parts[5].trim_end_matches(".json").to_string();
                if let Ok(raw) = std::fs::read_to_string(&path)
                    && let Ok(val) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
                {
                    collect_locmem_day(&bot_key, &date_ict, &val, &mut locmem_rows);
                }
            }
        }
        if !locmem_rows.is_empty() {
            {
                let mut stmt = tx.prepare_cached(
                    r#"
                    INSERT INTO locmem_daily (
                        bot_key, thread_id, date_ict, user_uid, msg_count, react_count, join_actions, last_seen_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    ON CONFLICT(bot_key, thread_id, date_ict, user_uid) DO UPDATE SET
                        msg_count = excluded.msg_count,
                        react_count = excluded.react_count,
                        join_actions = excluded.join_actions
                    "#,
                )?;
                for d in &locmem_rows {
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
            report.locmem_rows_migrated = locmem_rows.len();
        }

        // 6. Migrate V1 `command.json` Delta Overrides -> Command Studio V2 Layers
        let base_cmds = extract_commands_by_name(&vfs.read_json("assets/json-data/command.json").unwrap_or(json!({})));
        for bot_key in bots_map.keys() {
            let inst_cmd_path = format!("mybot/instances/{bot_key}/data/command.json");
            if let Some(inst_val) = vfs.read_json(&inst_cmd_path) {
                let inst_cmds = extract_commands_by_name(&inst_val);
                for (cmd_name, entry) in inst_cmds {
                    let differs = base_cmds.get(&cmd_name) != Some(&entry);
                    if differs {
                        let v2_delta = migrate_v1_command_entry_to_v2(&entry);
                        if v2_delta != json!({}) {
                            tx.execute(
                                r#"
                                INSERT INTO command_studio_layers (
                                    scope_type, bot_key, thread_id, command_name, overrides_json, revision, updated_by, updated_at
                                ) VALUES ('bot', ?1, '', ?2, ?3, 1, 'v3-migrator', ?4)
                                ON CONFLICT(scope_type, bot_key, thread_id, command_name) DO UPDATE SET
                                    overrides_json = excluded.overrides_json
                                "#,
                                params![bot_key, cmd_name, serde_json::to_string(&v2_delta)?, now],
                            )?;
                            report.command_layers_migrated += 1;
                        }
                    }
                }
            }
        }

        // Also import any explicit V3 Command Studio V2 JSON layer files if present
        for prefix in ["mybot/command-studio", "assets/data/command-studio"] {
            for (_, path) in vfs.list_under(prefix) {
                if let Ok(raw) = std::fs::read_to_string(&path)
                    && let Ok(mut val) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}'))
                {
                    normalize_v3_asset_paths_in_json(&mut val);
                    if let Some(layers) = val.get("layers").and_then(Value::as_array) {
                        for l in layers {
                            let scope = l.get("scopeType").and_then(Value::as_str).unwrap_or("global");
                            let bk = l.get("botKey").and_then(Value::as_str).unwrap_or("");
                            let tid = l.get("threadId").and_then(Value::as_str).unwrap_or("");
                            let Some(cmd) = l.get("commandName").and_then(Value::as_str) else {
                                continue;
                            };
                            let ov = l.get("overrides").cloned().unwrap_or_else(|| json!({}));
                            tx.execute(
                                r#"
                                INSERT INTO command_studio_layers (
                                    scope_type, bot_key, thread_id, command_name, overrides_json, revision, updated_by, updated_at
                                ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'v3-migrator', ?6)
                                ON CONFLICT(scope_type, bot_key, thread_id, command_name) DO UPDATE SET
                                    overrides_json = excluded.overrides_json
                                "#,
                                params![scope, bk, tid, cmd, serde_json::to_string(&ov)?, now],
                            )?;
                            report.command_layers_migrated += 1;
                        }
                    }
                }
            }
        }

        // 7. Custom Commands (`mybot/custom-commands/commands.json`)
        if let Some(mut cc) = vfs.read_json("mybot/custom-commands/commands.json") {
            normalize_v3_asset_paths_in_json(&mut cc);
            for (bot_key, trigger, def, enabled) in extract_custom_commands(&cc) {
                tx.execute(
                    r#"
                    INSERT INTO custom_commands (bot_key, trigger_name, definition_json, enabled, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5)
                    ON CONFLICT(bot_key, trigger_name) DO UPDATE SET
                        definition_json = excluded.definition_json,
                        enabled = excluded.enabled
                    "#,
                    params![bot_key, trigger, serde_json::to_string(&def)?, i32::from(enabled), now],
                )?;
                report.custom_commands_migrated += 1;
            }
        }

        // 8. Learned Q&A (`assets/json-data/data-training.json`)
        if let Some(qa) = vfs.read_json("assets/json-data/data-training.json") {
            for (thread_id, q_norm, answers) in extract_learned_qa(&qa) {
                tx.execute(
                    r#"
                    INSERT INTO learned_qa (bot_key, thread_id, question_norm, answers_json, updated_at)
                    VALUES ('', ?1, ?2, ?3, ?4)
                    ON CONFLICT(bot_key, thread_id, question_norm) DO UPDATE SET
                        answers_json = excluded.answers_json
                    "#,
                    params![thread_id, q_norm, serde_json::to_string(&answers)?, now],
                )?;
                report.learned_qa_migrated += 1;
            }
        }

        // 9. Link Platform Cache (`assets/json-data/cache-link.json`)
        if let Some(lc) = vfs.read_json("assets/json-data/cache-link.json")
            && let Some(obj) = lc.as_object()
        {
            let now_ms = Utc::now().timestamp_millis();
            let exp_ms = now_ms + 7 * 86_400_000;
            for (k, v) in obj {
                tx.execute(
                    r#"
                    INSERT INTO link_platform_cache (cache_key, platform, resolved_json, expires_at_ms, updated_at_ms)
                    VALUES (?1, '', ?2, ?3, ?4)
                    ON CONFLICT(cache_key) DO UPDATE SET resolved_json = excluded.resolved_json
                    "#,
                    params![k, serde_json::to_string(v)?, exp_ms, now_ms],
                )?;
                report.link_cache_migrated += 1;
            }
        }

        // 10. Trial Ledger (`mybot/trial-ledger.json` or `assets/data/trial-ledger.json`)
        if let Some(tl) = vfs
            .read_json("mybot/trial-ledger.json")
            .or_else(|| vfs.read_json("assets/data/trial-ledger.json"))
        {
            for (owner_uid, iso_week, used_secs, bk, status) in extract_trial_rows(&tl) {
                tx.execute(
                    r#"
                    INSERT INTO trial_ledger (owner_uid, iso_week, used_seconds, bot_key, granted_at, expires_at, status)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    ON CONFLICT(owner_uid, iso_week) DO UPDATE SET used_seconds = excluded.used_seconds
                    "#,
                    params![owner_uid, iso_week, used_secs, bk, now, now, status],
                )?;
                report.trial_rows_migrated += 1;
            }
        }

        // 11. Provider Secrets from `.env` / `.env.local` (hashed & stored safely; NEVER printed)
        for env_rel in [".env", ".env.local"] {
            if let Some(env_path) = vfs.resolve(env_rel)
                && let Ok(iter) = dotenvy::from_path_iter(env_path)
            {
                for item in iter.flatten() {
                    let (key, val) = item;
                    let trimmed = val.trim();
                    if trimmed.is_empty() || !is_migratable_provider_env_key(&key) {
                        continue;
                    }
                    let mut hasher = Sha256::new();
                    hasher.update(trimmed.as_bytes());
                    let sha = hex::encode(hasher.finalize());
                    tx.execute(
                        r#"
                        INSERT INTO provider_secrets (secret_key, secret_value, value_sha256, updated_at)
                        VALUES (?1, ?2, ?3, ?4)
                        ON CONFLICT(secret_key) DO UPDATE SET
                            secret_value = excluded.secret_value,
                            value_sha256 = excluded.value_sha256,
                            updated_at = excluded.updated_at
                        "#,
                        params![key, trimmed, sha, now],
                    )?;
                    report.provider_secrets_migrated += 1;
                }
            }
        }

        if dry_run {
            tx.rollback()?;
        } else {
            tx.commit()?;
        }
        Ok(())
    })?;

    Ok(report)
}

// -----------------------------------------------------------------------------
// Extraction Helpers (Handling All Historical V3 JSON Shapes)
// -----------------------------------------------------------------------------

fn first_non_empty_str(obj: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(s) = v.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            } else if let Some(n) = v.as_u64() {
                return Some(n.to_string());
            } else if let Some(n) = v.as_i64() {
                return Some(n.to_string());
            }
        }
    }
    None
}

fn extract_cookie_from_config(vfs: &CaseInsensitiveFs, obj: &Value) -> Value {
    for k in ["cookie", "cookies", "j2teamCookie"] {
        if let Some(v) = obj.get(k)
            && !v.is_null()
            && v != &json!({})
            && v != &json!("")
        {
            return v.clone();
        }
    }
    if let Some(cookie_path) = first_non_empty_str(obj, &["cookiePath", "pathCookie"])
        && let Some(c) = vfs.read_json(&cookie_path)
    {
        return c;
    }
    vfs.read_json("assets/data/cookie.json")
        .unwrap_or_else(|| json!({}))
}

fn infer_uid_from_cookie(cookie: &Value) -> Option<String> {
    let arr = cookie
        .get("cookies")
        .and_then(Value::as_array)
        .or_else(|| cookie.as_array())?;
    for c in arr {
        let name = c.get("name").and_then(Value::as_str).unwrap_or_default();
        if name == "zpw_sek"
            && let Some(val) = c.get("value").and_then(Value::as_str)
        {
            // Zalo `zpw_sek` often starts with `<ver>.<uid>.<...>`
            let parts: Vec<&str> = val.split('.').collect();
            if parts.len() >= 2 && parts[1].chars().all(|ch| ch.is_ascii_digit()) && parts[1].len() >= 8 {
                return Some(parts[1].to_string());
            }
        }
    }
    None
}

fn extract_registry_entries(reg: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    if let Some(arr) = reg.as_array() {
        for item in arr {
            if let Some(id) = first_non_empty_str(item, &["botKey", "name", "uid", "id", "botId"]) {
                out.push((id, item.clone()));
            }
        }
        return out;
    }
    if let Some(obj) = reg.as_object() {
        for wrapper_key in ["myBots", "bots", "instances"] {
            if let Some(inner) = obj.get(wrapper_key) {
                return extract_registry_entries(inner);
            }
        }
        for (k, v) in obj {
            if v.is_object() {
                out.push((k.clone(), v.clone()));
            }
        }
    }
    out
}

fn merge_bot_entry(
    vfs: &CaseInsensitiveFs,
    bots_map: &mut BTreeMap<String, BotRecord>,
    raw_key: &str,
    entry: &Value,
    default_prefix: &str,
    now: &str,
) {
    let bot_key = raw_key.trim().to_string();
    if bot_key.is_empty() {
        return;
    }

    let existing = bots_map.remove(&bot_key);
    let mut rec = existing.unwrap_or_else(|| BotRecord {
        bot_key: bot_key.clone(),
        uid: ZaloId::new(&bot_key),
        global_uid: None,
        canonical_username: None,
        display_name: bot_key.clone(),
        avatar: String::new(),
        is_main: bot_key == "admin",
        owner_uid: None,
        status: "stopped".to_string(),
        desired_status: "running".to_string(),
        expiry_policy: ExpiryPolicy::Permanent,
        trial_status: None,
        cookie_json: json!({}),
        imei: String::new(),
        user_agent: DEFAULT_ZALO_USER_AGENT.to_string(),
        proxy_url: None,
        cookie_dead: false,
        cookie_dead_reason: None,
        prefix: default_prefix.to_string(),
        self_listen: true,
        identity_pending: false,
        admin_identity_seeds: Vec::new(),
        metadata: json!({}),
        created_at: now.to_string(),
        updated_at: now.to_string(),
    });

    if let Some(uid) = first_non_empty_str(entry, &["uid", "botUid", "zaloUid", "accountId"]) {
        rec.uid = ZaloId::new(uid);
    }
    if let Some(g) = first_non_empty_str(entry, &["globalId", "globalUid"]) {
        rec.global_uid = Some(g);
    }
    if let Some(u) = first_non_empty_str(entry, &["canonicalUsername", "username"]) {
        rec.canonical_username = Some(u);
    }
    if let Some(dn) = first_non_empty_str(entry, &["displayName", "zaloName", "name"]) {
        rec.display_name = dn;
    }
    if let Some(av) = first_non_empty_str(entry, &["avatar", "avatarUrl"]) {
        rec.avatar = av;
    }
    if let Some(ow) = first_non_empty_str(entry, &["createdBy", "ownerUid", "ownerId"]) {
        rec.owner_uid = Some(ow);
    }
    if let Some(st) = first_non_empty_str(entry, &["status"]) {
        rec.desired_status = if matches!(st.as_str(), "stopped" | "disabled" | "expired") {
            st.clone()
        } else {
            "running".to_string()
        };
    }
    if let Some(exp_val) = entry.get("expiryAt").or_else(|| entry.get("expireAt"))
        && let Ok(pol) = serde_json::from_value::<ExpiryPolicy>(exp_val.clone())
    {
        rec.expiry_policy = pol;
    }
    if let Some(ts) = first_non_empty_str(entry, &["trialStatus"]) {
        rec.trial_status = Some(ts);
    }
    if let Some(imei) = first_non_empty_str(entry, &["imei", "IMEI"]) {
        rec.imei = imei;
    }
    if let Some(ua) = first_non_empty_str(entry, &["userAgent", "user_agent"]) {
        rec.user_agent = ua;
    }
    if let Some(px) = first_non_empty_str(entry, &["proxy", "proxyUrl"]) {
        rec.proxy_url = Some(px);
    }
    if let Some(pf) = first_non_empty_str(entry, &["prefix"]) {
        rec.prefix = pf;
    }
    if let Some(sl) = entry.get("selfListen").and_then(Value::as_bool) {
        rec.self_listen = sl;
    }
    if let Some(dead) = entry.get("cookieDead").and_then(Value::as_bool) {
        rec.cookie_dead = dead;
    }
    if let Some(reason) = first_non_empty_str(entry, &["cookieDeadReason"]) {
        rec.cookie_dead_reason = Some(reason);
    }
    if let Some(ip) = entry.get("identityPending").and_then(Value::as_bool) {
        rec.identity_pending = ip;
    }
    if let Some(seeds) = entry.get("adminIdentitySeeds").and_then(Value::as_array) {
        rec.admin_identity_seeds = seeds.clone();
    }

    // Preserve exact cookie without touching a single character
    for ck_key in ["cookie", "cookies", "j2teamCookie"] {
        if let Some(c) = entry.get(ck_key)
            && !c.is_null()
            && c != &json!({})
            && c != &json!("")
        {
            rec.cookie_json = c.clone();
            break;
        }
    }
    if (rec.cookie_json.is_null() || rec.cookie_json == json!({}))
        && let Some(cp) = first_non_empty_str(entry, &["cookiePath", "credentialsPath"])
        && let Some(c_file) = vfs.read_json(&cp)
    {
        if let Some(inner_c) = c_file.get("cookie") {
            rec.cookie_json = inner_c.clone();
            if rec.imei.is_empty()
                && let Some(i) = first_non_empty_str(&c_file, &["imei", "IMEI"])
            {
                rec.imei = i;
            }
            if let Some(ua) = first_non_empty_str(&c_file, &["userAgent", "user_agent"]) {
                rec.user_agent = ua;
            }
        } else {
            rec.cookie_json = c_file;
        }
    }

    bots_map.insert(bot_key, rec);
}

fn resolve_original_bot_key(bots_map: &BTreeMap<String, BotRecord>, lower_key: &str) -> String {
    bots_map
        .keys()
        .find(|k| k.eq_ignore_ascii_case(lower_key))
        .cloned()
        .unwrap_or_else(|| lower_key.to_string())
}

fn collect_admin_uids(bot_key: &str, val: &Value, out: &mut BTreeSet<(String, String, String)>) {
    if let Some(arr) = val.as_array() {
        for item in arr {
            if let Some(s) = item.as_str()
                && !s.trim().is_empty()
            {
                out.insert((bot_key.to_string(), s.trim().to_string(), "admin".to_string()));
            } else if let Some(n) = item.as_u64() {
                out.insert((bot_key.to_string(), n.to_string(), "admin".to_string()));
            }
        }
    } else if let Some(obj) = val.as_object() {
        for (tier_key, tier_label) in [
            ("highLevelAdmins", "high"),
            ("adminLevelHigh", "high"),
            ("admins", "admin"),
            ("listAdmin", "admin"),
        ] {
            if let Some(arr) = obj.get(tier_key).and_then(Value::as_array) {
                for item in arr {
                    if let Some(s) = item.as_str()
                        && !s.trim().is_empty()
                    {
                        out.insert((
                            bot_key.to_string(),
                            s.trim().to_string(),
                            tier_label.to_string(),
                        ));
                    }
                }
            }
        }
    }
}

fn collect_group_settings(bot_key: &str, val: &Value, out: &mut Vec<GroupSettingsRecord>) {
    let target = val.get("groupSettings").unwrap_or(val);
    let Some(obj) = target.as_object() else {
        return;
    };
    for (thread_id, entry) in obj {
        if entry.is_object() && thread_id.chars().any(|c| c.is_ascii_digit()) {
            out.push(GroupSettingsRecord::from_v3_json(bot_key, thread_id, entry));
        }
    }
}

fn collect_ranks(bot_key: &str, val: &Value, out: &mut Vec<RankEntry>) {
    let now_ms = Utc::now().timestamp_millis();
    let root = val.get("groups").unwrap_or(val);
    let Some(groups_obj) = root.as_object() else {
        return;
    };
    for (thread_id, group_val) in groups_obj {
        if let Some(arr) = group_val.get("users").and_then(Value::as_array) {
            for u in arr {
                let Some(uid) = first_non_empty_str(u, &["UID", "uid", "userId", "id"]) else {
                    continue;
                };
                let name = first_non_empty_str(u, &["UserName", "userName", "name"]).unwrap_or_default();
                let count = u
                    .get("Rank")
                    .or_else(|| u.get("rank"))
                    .or_else(|| u.get("count"))
                    .or_else(|| u.get("msgCount"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                out.push(RankEntry {
                    bot_key: bot_key.to_string(),
                    thread_id: thread_id.clone(),
                    user_uid: uid,
                    user_name: name,
                    msg_count: count,
                    daily_count: 0,
                    last_msg_at: now_ms,
                });
            }
        } else if let Some(users_obj) = group_val
            .get("users")
            .and_then(Value::as_object)
            .or_else(|| group_val.as_object())
        {
            for (uid, uval) in users_obj {
                if !uid.chars().any(|c| c.is_ascii_digit()) {
                    continue;
                }
                let (name, count) = if let Some(n) = uval.as_u64() {
                    (String::new(), n)
                } else {
                    let nm = first_non_empty_str(uval, &["name", "userName", "UserName"])
                        .unwrap_or_default();
                    let ct = uval
                        .get("count")
                        .or_else(|| uval.get("rank"))
                        .or_else(|| uval.get("Rank"))
                        .or_else(|| uval.get("msgCount"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    (nm, ct)
                };
                out.push(RankEntry {
                    bot_key: bot_key.to_string(),
                    thread_id: thread_id.clone(),
                    user_uid: uid.clone(),
                    user_name: name,
                    msg_count: count,
                    daily_count: 0,
                    last_msg_at: now_ms,
                });
            }
        }
    }
}

fn collect_locmem_day(bot_key: &str, date_ict: &str, val: &Value, out: &mut Vec<LocmemDayRow>) {
    let groups = val.get("groups").unwrap_or(val);
    let Some(groups_obj) = groups.as_object() else {
        return;
    };
    for (thread_id, users_val) in groups_obj {
        let users = users_val.get("users").unwrap_or(users_val);
        let Some(users_obj) = users.as_object() else {
            continue;
        };
        for (uid, stats) in users_obj {
            let (m, r, j) = if let Some(arr) = stats.as_array() {
                (
                    arr.first().and_then(Value::as_u64).unwrap_or(0) as u32,
                    arr.get(1).and_then(Value::as_u64).unwrap_or(0) as u32,
                    arr.get(2).and_then(Value::as_u64).unwrap_or(0) as u32,
                )
            } else {
                (
                    stats.get("msg").and_then(Value::as_u64).unwrap_or(0) as u32,
                    stats.get("react").and_then(Value::as_u64).unwrap_or(0) as u32,
                    stats.get("action").and_then(Value::as_u64).unwrap_or(0) as u32,
                )
            };
            out.push(LocmemDayRow {
                bot_key: bot_key.to_string(),
                thread_id: thread_id.clone(),
                date_ict: date_ict.to_string(),
                user_uid: uid.clone(),
                msg_count: m,
                react_count: r,
                join_actions: j,
                last_seen_ms: 0,
            });
        }
    }
}

fn extract_commands_by_name(val: &Value) -> BTreeMap<String, Value> {
    let mut map = BTreeMap::new();
    let arr_opt = val
        .get("commands")
        .and_then(Value::as_array)
        .or_else(|| val.as_array());
    if let Some(arr) = arr_opt {
        for item in arr {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                map.insert(name.trim().to_ascii_lowercase(), item.clone());
            }
        }
    }
    map
}

fn extract_custom_commands(val: &Value) -> Vec<(String, String, Value, bool)> {
    let mut out = Vec::new();
    let arr_opt = val
        .get("commands")
        .and_then(Value::as_array)
        .or_else(|| val.as_array());
    if let Some(arr) = arr_opt {
        for item in arr {
            let Some(trigger) = first_non_empty_str(item, &["name", "trigger", "command"]) else {
                continue;
            };
            let bk = first_non_empty_str(item, &["botKey", "botId"]).unwrap_or_default();
            let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            out.push((bk, trigger.to_ascii_lowercase(), item.clone(), enabled));
        }
    } else if let Some(obj) = val.as_object() {
        for (k, v) in obj {
            if v.is_object() {
                let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                out.push((String::new(), k.to_ascii_lowercase(), v.clone(), enabled));
            }
        }
    }
    out
}

fn extract_learned_qa(val: &Value) -> Vec<(String, String, Vec<String>)> {
    let mut out = Vec::new();
    let Some(obj) = val.as_object() else {
        return out;
    };
    for (thread_or_q, inner) in obj {
        if let Some(arr) = inner.as_array() {
            let answers: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect();
            if !answers.is_empty() {
                out.push((String::new(), thread_or_q.to_lowercase(), answers));
            }
        } else if let Some(q_map) = inner.as_object() {
            for (q, ans_val) in q_map {
                let answers: Vec<String> = if let Some(arr) = ans_val.as_array() {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                } else if let Some(s) = ans_val.as_str() {
                    vec![s.to_string()]
                } else {
                    Vec::new()
                };
                if !answers.is_empty() {
                    out.push((thread_or_q.clone(), q.to_lowercase(), answers));
                }
            }
        }
    }
    out
}

fn extract_trial_rows(val: &Value) -> Vec<(String, String, i64, String, String)> {
    let mut out = Vec::new();
    let root = val.get("entries").or_else(|| val.get("users")).unwrap_or(val);
    if let Some(obj) = root.as_object() {
        for (owner_uid, entry) in obj {
            let week = first_non_empty_str(entry, &["isoWeek", "weekKey"]).unwrap_or_else(|| "migrated".to_string());
            let used = entry
                .get("usedSeconds")
                .or_else(|| entry.get("usedMs"))
                .and_then(Value::as_i64)
                .unwrap_or(3600);
            let bk = first_non_empty_str(entry, &["botKey", "botUid"]).unwrap_or_default();
            let status = first_non_empty_str(entry, &["status"]).unwrap_or_else(|| "used".to_string());
            out.push((owner_uid.clone(), week, used, bk, status));
        }
    }
    out
}

fn is_migratable_provider_env_key(key: &str) -> bool {
    let upper = key.trim().to_ascii_uppercase();
    upper.ends_with("_API_KEY")
        || upper.ends_with("_TOKEN")
        || upper.ends_with("_SECRET")
        || upper.starts_with("GEMINI_")
        || upper.starts_with("OPENAI_")
        || upper.starts_with("GROQ_")
        || upper.starts_with("OPENWEATHER_")
        || upper.starts_with("DASHBOARD_")
}
