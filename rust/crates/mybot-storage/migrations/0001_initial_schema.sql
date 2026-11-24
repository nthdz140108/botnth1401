-- V4 Engine Initial SQLite Schema (WAL + High-Throughput Pragmas)

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
    bot_key TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    global_uid TEXT,
    canonical_username TEXT,
    display_name TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    is_main INTEGER NOT NULL DEFAULT 0,
    owner_uid TEXT,
    status TEXT NOT NULL DEFAULT 'stopped',
    desired_status TEXT NOT NULL DEFAULT 'running',
    expiry_policy TEXT NOT NULL DEFAULT '-1',
    trial_status TEXT,
    cookie_json TEXT NOT NULL DEFAULT '{}',
    imei TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    proxy_url TEXT,
    cookie_dead INTEGER NOT NULL DEFAULT 0,
    cookie_dead_reason TEXT,
    prefix TEXT NOT NULL DEFAULT '!',
    self_listen INTEGER NOT NULL DEFAULT 0,
    identity_pending INTEGER NOT NULL DEFAULT 0,
    admin_identity_seeds_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_uid ON bots (uid);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots (owner_uid);

CREATE TABLE IF NOT EXISTS role_registry (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    primary_bot_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    history_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS bot_admins (
    bot_key TEXT NOT NULL,
    admin_uid TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'admin',
    display_name TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    PRIMARY KEY (bot_key, admin_uid)
);

CREATE TABLE IF NOT EXISTS group_settings (
    bot_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '',
    anti_bot INTEGER NOT NULL DEFAULT 0,
    only_text INTEGER NOT NULL DEFAULT 0,
    anti_photo_video INTEGER NOT NULL DEFAULT 0,
    anti_voice INTEGER NOT NULL DEFAULT 0,
    anti_file INTEGER NOT NULL DEFAULT 0,
    anti_text INTEGER NOT NULL DEFAULT 0,
    anti_mention INTEGER NOT NULL DEFAULT 0,
    anti_sticker INTEGER NOT NULL DEFAULT 0,
    anti_sticker_effect INTEGER NOT NULL DEFAULT 0,
    anti_gif INTEGER NOT NULL DEFAULT 0,
    anti_forward INTEGER NOT NULL DEFAULT 0,
    anti_spam INTEGER NOT NULL DEFAULT 0,
    anti_bad_word INTEGER NOT NULL DEFAULT 0,
    anti_link INTEGER NOT NULL DEFAULT 0,
    anti_card INTEGER NOT NULL DEFAULT 0,
    anti_nude INTEGER NOT NULL DEFAULT 0,
    anti_all_effect_sticker INTEGER NOT NULL DEFAULT 0,
    anti_undo INTEGER NOT NULL DEFAULT 0,
    enable_bot INTEGER NOT NULL DEFAULT 1,
    welcome_group INTEGER NOT NULL DEFAULT 0,
    bye_group INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_key, thread_id)
);

CREATE TABLE IF NOT EXISTS command_studio_layers (
    scope_type TEXT NOT NULL,
    bot_key TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    command_name TEXT NOT NULL,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL DEFAULT 'system',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_type, bot_key, thread_id, command_name)
);

CREATE INDEX IF NOT EXISTS idx_studio_layers_cmd ON command_studio_layers (command_name, scope_type);

CREATE TABLE IF NOT EXISTS command_studio_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    bot_key TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    command_name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    previous_json TEXT NOT NULL,
    next_json TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_history_lookup
    ON command_studio_history (scope_type, bot_key, thread_id, command_name, id DESC);

CREATE TABLE IF NOT EXISTS command_studio_drafts (
    draft_key TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    bot_key TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    command_name TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    base_revision INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL DEFAULT 'dashboard',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rank_counters (
    bot_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    user_uid TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    msg_count INTEGER NOT NULL DEFAULT 0,
    daily_count INTEGER NOT NULL DEFAULT 0,
    last_msg_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_key, thread_id, user_uid)
);

CREATE INDEX IF NOT EXISTS idx_rank_top
    ON rank_counters (bot_key, thread_id, msg_count DESC);

CREATE TABLE IF NOT EXISTS message_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    sender_uid TEXT NOT NULL,
    sender_name TEXT NOT NULL DEFAULT '',
    cli_msg_id TEXT NOT NULL DEFAULT '',
    msg_id TEXT NOT NULL DEFAULT '',
    global_msg_id TEXT NOT NULL DEFAULT '',
    msg_type TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_cache_cli ON message_cache (bot_key, cli_msg_id);
CREATE INDEX IF NOT EXISTS idx_msg_cache_msg ON message_cache (bot_key, msg_id);
CREATE INDEX IF NOT EXISTS idx_msg_cache_global ON message_cache (bot_key, global_msg_id);
CREATE INDEX IF NOT EXISTS idx_msg_cache_exp ON message_cache (expires_at_ms);

CREATE TABLE IF NOT EXISTS locmem_daily (
    bot_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    date_ict TEXT NOT NULL,
    user_uid TEXT NOT NULL,
    msg_count INTEGER NOT NULL DEFAULT 0,
    react_count INTEGER NOT NULL DEFAULT 0,
    join_actions INTEGER NOT NULL DEFAULT 0,
    last_seen_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_key, thread_id, date_ict, user_uid)
);

CREATE INDEX IF NOT EXISTS idx_locmem_thread_date ON locmem_daily (bot_key, thread_id, date_ict);

CREATE TABLE IF NOT EXISTS locmem_coverage (
    bot_key TEXT NOT NULL,
    date_ict TEXT NOT NULL,
    coverage_state TEXT NOT NULL DEFAULT 'complete',
    first_seen_ms INTEGER NOT NULL DEFAULT 0,
    last_seen_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_key, date_ict)
);

CREATE TABLE IF NOT EXISTS trial_ledger (
    owner_uid TEXT NOT NULL,
    iso_week TEXT NOT NULL,
    used_seconds INTEGER NOT NULL DEFAULT 0,
    bot_key TEXT NOT NULL DEFAULT '',
    granted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    PRIMARY KEY (owner_uid, iso_week)
);

CREATE TABLE IF NOT EXISTS custom_commands (
    bot_key TEXT NOT NULL DEFAULT '',
    trigger_name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_key, trigger_name)
);

CREATE TABLE IF NOT EXISTS learned_qa (
    bot_key TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    question_norm TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_key, thread_id, question_norm)
);

CREATE TABLE IF NOT EXISTS link_platform_cache (
    cache_key TEXT PRIMARY KEY,
    platform TEXT NOT NULL DEFAULT '',
    resolved_json TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS video_source_health (
    pool_name TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    url TEXT NOT NULL,
    healthy INTEGER NOT NULL DEFAULT 1,
    status_code INTEGER NOT NULL DEFAULT 200,
    content_length INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (pool_name, url_hash)
);

CREATE TABLE IF NOT EXISTS provider_secrets (
    secret_key TEXT PRIMARY KEY,
    secret_value TEXT NOT NULL,
    value_sha256 TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_key TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_type INTEGER NOT NULL DEFAULT 1,
    target_uid TEXT NOT NULL,
    creator_uid TEXT NOT NULL,
    content TEXT NOT NULL,
    due_at_ms INTEGER NOT NULL,
    repeat_mode TEXT NOT NULL DEFAULT 'none',
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(delivered, due_at_ms);

CREATE TABLE IF NOT EXISTS bot_bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_key TEXT NOT NULL,
    bin_bank INTEGER NOT NULL,
    bank_short_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_bank_accounts_bot ON bot_bank_accounts(bot_key);

CREATE TABLE IF NOT EXISTS global_blocked_users (
    bot_key TEXT NOT NULL DEFAULT '',
    user_uid TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    blocked_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (bot_key, user_uid)
);
