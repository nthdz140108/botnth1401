//! High-throughput SQLite WAL persistence, `DashMap` hot caches, and V3 -> V4 migrator.

pub mod caches;
pub mod db;
pub mod v3_migrator;

pub use caches::{BatchFlushHandle, HotStorageCaches};
pub use db::{
    BankAccountRecord, BlockedUserRecord, BotRecord, CachedMessageRecord, CommandStudioHistoryItem,
    CommandStudioLayer, GroupSettingsRecord, LocmemDayRow, ProviderSecretMeta, RankEntry,
    ReminderRecord, StorageEngine, StorageError, TrialLedgerRow,
};
pub use v3_migrator::{
    CaseInsensitiveFs, MigrationReport, migrate_v1_command_entry_to_v2, migrate_v3_directory,
    normalize_v3_asset_paths_in_json,
};

#[cfg(test)]
mod tests {
    use super::*;
    use mybot_types::{
        EventSource, ExpiryPolicy, InboundMessage, MessageContent, ThreadType, ZaloId,
    };
    use serde_json::json;

    #[test]
    fn studio_cas_enforces_revision_conflict_and_records_history() {
        let engine = StorageEngine::open_in_memory().expect("open in-memory db");

        let l1 = engine
            .save_studio_layer_cas(
                "global",
                "",
                "",
                "help",
                &json!({"cooldownSecs": 5}),
                Some(0),
                "admin",
                "initial save",
            )
            .expect("first save");
        assert_eq!(l1.revision, 1);

        // Stale revision 0 must fail with RevisionConflict { expected: 0, actual: 1 }
        let conflict = engine.save_studio_layer_cas(
            "global",
            "",
            "",
            "help",
            &json!({"cooldownSecs": 10}),
            Some(0),
            "other-tab",
            "stale save",
        );
        assert!(matches!(
            conflict,
            Err(StorageError::RevisionConflict {
                expected: 0,
                actual: 1
            })
        ));

        // Matching revision 1 succeeds -> revision 2
        let l2 = engine
            .save_studio_layer_cas(
                "global",
                "",
                "",
                "help",
                &json!({"cooldownSecs": 12}),
                Some(1),
                "admin",
                "second save",
            )
            .expect("second save");
        assert_eq!(l2.revision, 2);

        let hist = engine
            .list_studio_history("global", "", "", "help", 10)
            .expect("history");
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0].revision, 2);
        assert_eq!(hist[1].revision, 1);
    }

    #[test]
    fn hot_caches_flush_ranks_groups_locmem_and_three_key_undo_lookup() {
        let engine = StorageEngine::open_in_memory().expect("open in-memory db");
        let caches = HotStorageCaches::load_from_engine(engine.clone()).expect("warm caches");

        caches.update_group_settings("admin", "999888", |g| {
            g.anti_link = true;
            g.anti_bad_word = true;
        });
        assert_eq!(caches.increment_rank("admin", "999888", "1001", "Alice"), 1);
        assert_eq!(caches.increment_rank("admin", "999888", "1001", "Alice"), 2);
        caches.record_locmem_activity("admin", "999888", "1001", 3, 1, 0);

        let inbound = InboundMessage {
            bot_key: "admin".into(),
            source: EventSource::WebSocket,
            thread_id: ZaloId::new("999888"),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("1001"),
            sender_name: "Alice".to_string(),
            msg_id: ZaloId::new("msg_55"),
            cli_msg_id: ZaloId::new("cli_66"),
            global_msg_id: ZaloId::new("glob_77"),
            msg_type: "webchat".into(),
            timestamp_ms: 1_700_000_000_000,
            ws_received_at_ms: 1_700_000_000_005,
            ttl_ms: 0,
            is_self: false,
            content: MessageContent::Text {
                text: "secret text before undo".to_string(),
            },
            mentions: Vec::new(),
            styles: Vec::new(),
            quote: None,
            raw_property_ext: None,
        };
        caches.cache_inbound_message("admin", &inbound);

        // Hot lookup works via any of the 3 IDs
        assert!(caches.lookup_undo_target("admin", "cli_66", "", None).is_some());
        assert!(caches.lookup_undo_target("admin", "", "msg_55", None).is_some());
        assert!(caches.lookup_undo_target("admin", "", "", Some("glob_77")).is_some());

        caches.flush_all_sync().expect("flush all");

        // Reload cold caches from SQLite WAL and verify everything persisted
        let reloaded = HotStorageCaches::load_from_engine(engine).expect("reload");
        let gs = reloaded.get_or_default_group_settings("admin", "999888");
        assert!(gs.anti_link && gs.anti_bad_word);
        let top = reloaded.top_ranks_hot("admin", "999888", 5, false);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].msg_count, 2);

        // Cold SQLite fallback for `!antiundo` works even after daemon restart!
        let cold_undo = reloaded
            .lookup_undo_target("admin", "", "", Some("glob_77"))
            .expect("cold undo hit");
        assert_eq!(cold_undo.sender_name, "Alice");
    }

    #[test]
    fn v3_migrator_preserves_live_cookies_case_insensitively_and_redacts_report() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        // Mixed-case NTFS directories (`Assets`, `MyBot\Credentials`) + Windows backslashes
        std::fs::create_dir_all(root.join("Assets/Data")).unwrap();
        std::fs::create_dir_all(root.join("MyBot/Credentials")).unwrap();
        std::fs::create_dir_all(root.join("MyBot/Instances/84912345678/Data/locmem-activity-days")).unwrap();
        std::fs::create_dir_all(root.join("MyBot/Custom-Commands")).unwrap();

        let exact_cookie = json!({
            "url": "https://chat.zalo.me",
            "cookies": [
                {"name": "zpw_sek", "value": "v2.84912345678.SUPER_SECRET_TOKEN_XYZ\\KEEP_SLASH"}
            ]
        });
        let exact_imei = "b4f1e290-9911-4abc-8def-112233445566-9f8e7d6c5b4a";
        let exact_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CustomZaloUA/1.0";

        std::fs::write(
            root.join("Assets/Config.json"),
            serde_json::to_string_pretty(&json!({
                "name": "Admin Pro Bot",
                "uid": "111222333",
                "imei": exact_imei,
                "userAgent": exact_ua,
                "cookie": exact_cookie
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            root.join("MyBot/mybots.json"),
            serde_json::to_string_pretty(&json!({
                "myBots": {
                    "84912345678": {
                        "displayName": "SubBot Alpha",
                        "uid": "84912345678",
                        "expiryAt": "-1",
                        "cookiePath": "mybot\\credentials\\84912345678.json"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            root.join("MyBot/Credentials/84912345678.json"),
            serde_json::to_string_pretty(&json!({
                "cookie": exact_cookie,
                "imei": exact_imei,
                "userAgent": exact_ua
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            root.join("MyBot/Instances/84912345678/Data/group_settings.json"),
            serde_json::to_string_pretty(&json!({
                "777666555": {
                    "nameGroup": "Rust Linux Group",
                    "antiLink": true,
                    "bannerPath": "assets\\images\\welcome\\bg.png"
                }
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            root.join("MyBot/Instances/84912345678/Data/locmem-activity-days/2026-11-02.json"),
            serde_json::to_string_pretty(&json!({
                "groups": {
                    "777666555": {
                        "users": {
                            "9001": [12, 4, 1]
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            root.join(".env.local"),
            "GEMINI_API_KEY=AIzaSy_SUPER_SECRET_TEST_KEY\nNON_SECRET_PORT=4173\n",
        )
        .unwrap();

        let engine = StorageEngine::open_in_memory().expect("open mem db");
        let report = migrate_v3_directory(root, &engine, false).expect("migrate");

        assert_eq!(report.bots_migrated, 2);
        assert_eq!(report.bots_with_live_cookies, 2);
        assert_eq!(report.group_settings_migrated, 1);
        assert_eq!(report.locmem_rows_migrated, 1);
        assert_eq!(report.provider_secrets_migrated, 1);

        // Verify report JSON contains ZERO leaked secrets
        let report_str = serde_json::to_string(&report).unwrap();
        assert!(!report_str.contains("SUPER_SECRET_TOKEN_XYZ"));
        assert!(!report_str.contains("AIzaSy_SUPER_SECRET_TEST_KEY"));
        assert!(!report_str.contains(exact_imei));

        // Verify sub-bot credentials survived 100% untouched (including backslash inside cookie!)
        let sub_bot = engine
            .get_bot("84912345678")
            .unwrap()
            .expect("sub-bot exists");
        assert_eq!(sub_bot.cookie_json, exact_cookie);
        assert_eq!(sub_bot.imei, exact_imei);
        assert_eq!(sub_bot.user_agent, exact_ua);
        assert_eq!(sub_bot.expiry_policy, ExpiryPolicy::Permanent);

        // Verify asset path inside group settings was normalized `\` -> `/`
        let groups = engine.load_all_group_settings().unwrap();
        assert_eq!(
            groups[0].settings["bannerPath"].as_str(),
            Some("assets/images/welcome/bg.png")
        );
    }

    #[test]
    fn v3_migrator_idempotence_and_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        std::fs::create_dir_all(root.join("assets/json-data")).unwrap();
        std::fs::create_dir_all(root.join("mybot/instances/admin/data")).unwrap();
        std::fs::create_dir_all(root.join("mybot/custom-commands")).unwrap();

        // 1. Base command.json and instance override
        std::fs::write(
            root.join("assets/json-data/command.json"),
            serde_json::to_string_pretty(&json!({
                "commands": [
                    { "name": "ping", "active": true, "countdown": 5 },
                    { "name": "menu", "active": true, "countdown": 10 }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        std::fs::write(
            root.join("mybot/instances/admin/data/command.json"),
            serde_json::to_string_pretty(&json!({
                "commands": [
                    { "name": "ping", "active": false, "countdown": 30 },
                    { "name": "menu", "active": true, "countdown": 10 }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        // 2. Custom commands
        std::fs::write(
            root.join("mybot/custom-commands/commands.json"),
            serde_json::to_string_pretty(&json!({
                "commands": [
                    { "name": "chao", "trigger": "chao", "reply": "Xin chao!", "enabled": true }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        // 3. Group settings
        std::fs::write(
            root.join("mybot/instances/admin/data/group_settings.json"),
            serde_json::to_string_pretty(&json!({
                "group_123": {
                    "nameGroup": "Test Box",
                    "antiSpam": true
                }
            }))
            .unwrap(),
        )
        .unwrap();

        // 4. Admin bot config
        std::fs::write(
            root.join("assets/config.json"),
            serde_json::to_string_pretty(&json!({
                "name": "Main Bot",
                "uid": "111222333"
            }))
            .unwrap(),
        )
        .unwrap();

        let engine = StorageEngine::open_in_memory().expect("open mem db");

        // First migration run
        let r1 = migrate_v3_directory(root, &engine, false).expect("migration 1");
        assert_eq!(r1.command_layers_migrated, 1); // Only "ping" differed
        assert_eq!(r1.custom_commands_migrated, 1);
        assert_eq!(r1.group_settings_migrated, 1);

        // Second migration run (idempotency verification)
        let r2 = migrate_v3_directory(root, &engine, false).expect("migration 2 idempotent");
        assert_eq!(r2.command_layers_migrated, 1);
        assert_eq!(r2.custom_commands_migrated, 1);
        assert_eq!(r2.group_settings_migrated, 1);

        // Verify custom commands table
        let custom_cmds = engine.list_custom_commands(None).expect("list custom cmds");
        assert_eq!(custom_cmds.len(), 1);
        assert_eq!(custom_cmds[0].1, "chao");
        assert!(custom_cmds[0].3);

        // Verify studio layer
        let layers = engine.load_all_studio_layers().expect("load studio layers");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].command_name, "ping");
        assert_eq!(layers[0].overrides["operation.enabled"], false);
        assert_eq!(layers[0].overrides["operation.cooldownSeconds"], 30);

        // Verify group settings
        let groups = engine.load_all_group_settings().expect("load groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].thread_id, "group_123");

        // Verify export_redacted_backup_json
        let backup = engine.export_redacted_backup_json().expect("export backup");
        assert_eq!(backup["schema"], "mybot-v4-backup");
        assert_eq!(backup["version"], 4);
        assert!(backup["commandStudioLayers"].as_array().unwrap().len() >= 1);
        assert!(backup["customCommands"].as_array().unwrap().len() >= 1);
        assert!(backup["groupSettings"].as_array().unwrap().len() >= 1);
    }
}
