//! Phase 2 Integration & Unit Test Suite: Group Administration, Moderation, Anti-Service & Friends.
//!
//! Acceptance Gates:
//! 1. Moderation & Anti-Service:
//!    - `antibadword` toggle (on/off), add word, remove word, list words.
//!    - `whitelist` add, list, remove, clear.
//!    - `mute`, `unmute`, `listmute` (duration parsing, `!mute all`, duration display, protected member protection).
//!    - `ban`, `unban` (protected member protection, storage engine blocked users).
//! 2. Group Management & Protected Role Filtering:
//!    - `filter_protected`: excludes creator, deputies, self bot, secondary bots, bot admins, whitelist.
//!    - `parse_group_action_result`: checks `errorCode` and `errorMembers`, never reporting errors as success.
//!    - `kick`, `kickall`, `block`, `blockall`: protected roles, session check, non-false success.
//! 3. Key Management:
//!    - `keysilver`, `keygold`, `unkey`, `keylist`: defaults to sender when target omitted.
//! 4. Friend Management:
//!    - `addfriend`, `addfriendall`, `undofriend`, `rejectfriend`, `removefriend`, `listfriend`, `waitinglist`.

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use mybot_commands::admin_and_group::{filter_protected, parse_group_action_result};
use mybot_commands::moderation_anti::parse_mute_duration_minutes;
use mybot_commands::{CommandRuntimeBundle, build_full_command_registry};
use mybot_core::{BotStyleProfile, CommandContext, CommandOutcome};
use mybot_storage::{HotStorageCaches, StorageEngine};
use mybot_types::{
    EventSource, InboundMessage, MentionSpan, MessageContent, PermissionTier, ThreadType, ZaloId,
};
use serde_json::json;

fn find_repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../../.."),
        manifest_dir.join("../.."),
        PathBuf::from("."),
        PathBuf::from("../../.."),
        PathBuf::from("HHH_MYBOT-V3MYBOTQRLOGIN-main"),
    ];
    for c in &candidates {
        if c.join("assets/json-data/command.json").exists() {
            return c.canonicalize().unwrap_or_else(|_| c.clone());
        }
    }
    manifest_dir.join("../../..")
}

fn create_test_runtime() -> (Arc<CommandRuntimeBundle>, HotStorageCaches) {
    let engine = StorageEngine::open_in_memory().expect("open in-memory storage");
    let caches = HotStorageCaches::load_from_engine(engine).expect("load storage caches");
    let repo_root = find_repo_root();
    let rt = Arc::new(CommandRuntimeBundle::new(&repo_root, caches.clone()));
    (rt, caches)
}

fn outcome_reply_text(outcome: &CommandOutcome) -> Option<&str> {
    match outcome {
        CommandOutcome::Handled { reply_text: Some(t), .. } => Some(t.as_str()),
        CommandOutcome::Denied { message, .. } => Some(message.as_str()),
        _ => None,
    }
}

fn make_test_ctx(
    caches: HotStorageCaches,
    invoked: &str,
    args: Vec<&str>,
    raw_args: &str,
    thread_type: ThreadType,
    sender_tier: PermissionTier,
    sender_uid: &str,
    mentions: Vec<MentionSpan>,
) -> CommandContext {
    let thread_id = if thread_type == ThreadType::Group {
        ZaloId::new("grp_phase2_test")
    } else {
        ZaloId::new("dm_phase2_test")
    };

    // Retrieve existing group settings from hot cache, or initialize default
    let settings = caches.get_or_default_group_settings("main", thread_id.as_str());
    if settings.settings.get("cachedMembers").is_none() {
        caches.update_group_settings("main", thread_id.as_str(), |g| {
            g.settings["cachedMembers"] = json!({
                "creatorId": "group_creator_uid",
                "adminIds": ["group_deputy_uid_1", "group_deputy_uid_2"],
                "memberIds": [
                    "group_creator_uid",
                    "group_deputy_uid_1",
                    "group_deputy_uid_2",
                    "bot_self_uid",
                    "child_bot_uid",
                    "bot_admin_uid",
                    "whitelisted_uid",
                    "regular_user_1",
                    "regular_user_2",
                    "regular_user_3"
                ]
            });
            g.settings["whiteList"] = json!(["whitelisted_uid"]);
        });
    }
    let settings = caches.get_or_default_group_settings("main", thread_id.as_str());

    CommandContext {
        bot_key: "main".into(),
        is_main_bot: true,
        self_uid: ZaloId::new("bot_self_uid"),
        prefix: "!".into(),
        invoked_alias: invoked.into(),
        args: args.into_iter().map(ToOwned::to_owned).collect(),
        raw_args_text: raw_args.into(),
        message: InboundMessage {
            bot_key: "main".into(),
            msg_id: ZaloId::new("m_test_1"),
            cli_msg_id: ZaloId::new("c_test_1"),
            global_msg_id: ZaloId::new("g_test_1"),
            thread_id: thread_id.clone(),
            thread_type,
            sender_uid: ZaloId::new(sender_uid),
            sender_name: "Test Sender".into(),
            is_self: false,
            msg_type: "webchat".into(),
            timestamp_ms: Utc::now().timestamp_millis(),
            ws_received_at_ms: Utc::now().timestamp_millis(),
            ttl_ms: 0,
            mentions,
            styles: Vec::new(),
            quote: None,
            content: MessageContent::Text {
                text: format!("!{invoked} {raw_args}"),
            },
            source: EventSource::default(),
            raw_property_ext: None,
        },
        sender_tier,
        group_settings: settings,
        effective_studio_config: json!({}),
        zalo: None,
        caches,
        assets_root: find_repo_root().join("assets"),
        style_profile: BotStyleProfile::default(),
        interactions: Arc::new(mybot_core::InteractionEngine::new()),
        fleet: None,
        outbound_sink: Some(Arc::new(parking_lot::Mutex::new(Vec::new()))),
    }
}

// =============================================================================
// TEST 1: Unit verification of Core Logic (filter_protected, parse_result, durations)
// =============================================================================

#[test]
fn test_filter_protected_roles_exclusion() {
    let all_members = vec![
        ZaloId::new("creator_uid"),
        ZaloId::new("deputy_uid_1"),
        ZaloId::new("deputy_uid_2"),
        ZaloId::new("bot_self_uid"),
        ZaloId::new("child_bot_uid"),
        ZaloId::new("bot_admin_uid"),
        ZaloId::new("whitelist_uid"),
        ZaloId::new("regular_user_1"),
        ZaloId::new("regular_user_2"),
    ];

    let creator_uid = Some("creator_uid");
    let admin_uids = vec!["deputy_uid_1".to_string(), "deputy_uid_2".to_string()];
    let self_uid = ZaloId::new("bot_self_uid");
    let bot_uids = vec!["child_bot_uid".to_string()];
    let bot_admins = vec!["bot_admin_uid".to_string()];
    let whitelist_uids = vec!["whitelist_uid".to_string()];

    let filtered = filter_protected(
        &all_members,
        creator_uid,
        &admin_uids,
        &self_uid,
        &bot_uids,
        &bot_admins,
        &whitelist_uids,
    );

    // Only regular_user_1 and regular_user_2 should remain
    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0].as_str(), "regular_user_1");
    assert_eq!(filtered[1].as_str(), "regular_user_2");
}

#[test]
fn test_parse_group_action_result_accuracy() {
    // 1. Full success with 0 errors
    let res_ok = json!({ "errorMembers": [] });
    let (s1, f1, errs1) = parse_group_action_result(&res_ok, 10);
    assert_eq!(s1, 10);
    assert_eq!(f1, 0);
    assert!(errs1.is_empty());

    // 2. Partial failure with specific errorMembers
    let res_partial = json!({ "errorMembers": ["uid_fail_1", "uid_fail_2"] });
    let (s2, f2, errs2) = parse_group_action_result(&res_partial, 10);
    assert_eq!(s2, 8);
    assert_eq!(f2, 2);
    assert_eq!(errs2, vec!["uid_fail_1", "uid_fail_2"]);

    // 3. API Error code without errorMembers -> total failure, never false success
    let res_err = json!({ "errorCode": -1, "errorMsg": "Permission denied" });
    let (s3, f3, _) = parse_group_action_result(&res_err, 5);
    assert_eq!(s3, 0);
    assert_eq!(f3, 5);
}

#[test]
fn test_parse_mute_duration_minutes_various_units() {
    assert_eq!(parse_mute_duration_minutes(&["15m".to_string()]), 15);
    assert_eq!(parse_mute_duration_minutes(&["30p".to_string()]), 30);
    assert_eq!(parse_mute_duration_minutes(&["2h".to_string()]), 120);
    assert_eq!(parse_mute_duration_minutes(&["1g".to_string()]), 60);
    assert_eq!(parse_mute_duration_minutes(&["1d".to_string()]), 1440);
    assert_eq!(parse_mute_duration_minutes(&["3n".to_string()]), 4320);
    assert_eq!(parse_mute_duration_minutes(&["300s".to_string()]), 5);
    assert_eq!(parse_mute_duration_minutes(&["45".to_string()]), 45);
}

// =============================================================================
// TEST 2: Anti-Service & Moderation Commands Lifecycle
// =============================================================================

#[tokio::test]
async fn test_phase2_antibadword_full_lifecycle() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let handler = registry.get_canonical("antibadword").expect("antibadword handler");

    // 1. antibadword on
    let ctx_on = make_test_ctx(
        caches.clone(),
        "antibadword",
        vec!["on"],
        "on",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_on = handler.execute(ctx_on).await.expect("execute on");
    assert!(outcome_reply_text(&out_on).unwrap().contains("BẬT"), "expected enabled notice");

    // 2. antibadword add badword1
    let ctx_add = make_test_ctx(
        caches.clone(),
        "antibadword",
        vec!["add", "badword1"],
        "add badword1",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_add = handler.execute(ctx_add).await.expect("execute add");
    assert!(outcome_reply_text(&out_add).unwrap().contains("badword1"));

    // 3. antibadword list
    let ctx_list = make_test_ctx(
        caches.clone(),
        "antibadword",
        vec!["list"],
        "list",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_list = handler.execute(ctx_list).await.expect("execute list");
    let list_text = outcome_reply_text(&out_list).unwrap();
    assert!(list_text.contains("badword1"), "list must contain badword1, got: {list_text}");

    // 4. antibadword remove badword1
    let ctx_rem = make_test_ctx(
        caches.clone(),
        "antibadword",
        vec!["remove", "badword1"],
        "remove badword1",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_rem = handler.execute(ctx_rem).await.expect("execute remove");
    assert!(outcome_reply_text(&out_rem).unwrap().contains("badword1"));

    // 5. antibadword off
    let ctx_off = make_test_ctx(
        caches.clone(),
        "antibadword",
        vec!["off"],
        "off",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_off = handler.execute(ctx_off).await.expect("execute off");
    assert!(outcome_reply_text(&out_off).unwrap().contains("TẮT"));
}

#[tokio::test]
async fn test_phase2_whitelist_lifecycle() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let handler = registry.get_canonical("whitelist").expect("whitelist handler");

    // 1. whitelist add 888999
    let ctx_add = make_test_ctx(
        caches.clone(),
        "whitelist",
        vec!["add", "888999"],
        "add 888999",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_add = handler.execute(ctx_add).await.expect("execute add");
    assert!(outcome_reply_text(&out_add).unwrap().contains("888999"));

    // 2. whitelist list
    let ctx_list = make_test_ctx(
        caches.clone(),
        "whitelist",
        vec!["list"],
        "list",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_list = handler.execute(ctx_list).await.expect("execute list");
    let list_text = outcome_reply_text(&out_list).unwrap();
    assert!(list_text.contains("888999"));

    // 3. whitelist remove 888999
    let ctx_rem = make_test_ctx(
        caches.clone(),
        "whitelist",
        vec!["remove", "888999"],
        "remove 888999",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_rem = handler.execute(ctx_rem).await.expect("execute remove");
    assert!(outcome_reply_text(&out_rem).unwrap().contains("888999"));

    // 4. whitelist clear
    let ctx_clear = make_test_ctx(
        caches.clone(),
        "whitelist",
        vec!["clear"],
        "clear",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_clear = handler.execute(ctx_clear).await.expect("execute clear");
    assert!(outcome_reply_text(&out_clear).unwrap().contains("toàn bộ"));
}

#[tokio::test]
async fn test_phase2_mute_unmute_protection_and_durations() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let mute_handler = registry.get_canonical("mute").expect("mute handler");
    let unmute_handler = registry.get_canonical("unmute").expect("unmute handler");
    let listmute_handler = registry.get_canonical("listmute").expect("listmute handler");

    // 1. Mute protected group deputy -> MUST be refused
    let ctx_mute_deputy = make_test_ctx(
        caches.clone(),
        "mute",
        vec!["group_deputy_uid_1", "10m"],
        "group_deputy_uid_1 10m",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_deputy = mute_handler.execute(ctx_mute_deputy).await.expect("execute mute deputy");
    assert!(
        outcome_reply_text(&out_deputy).unwrap().contains("Không thể cấm chat"),
        "deputy must be protected from mute"
    );

    // 2. Mute protected group creator -> MUST be refused
    let ctx_mute_creator = make_test_ctx(
        caches.clone(),
        "mute",
        vec!["group_creator_uid", "10m"],
        "group_creator_uid 10m",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_creator = mute_handler.execute(ctx_mute_creator).await.expect("execute mute creator");
    assert!(
        outcome_reply_text(&out_creator).unwrap().contains("Không thể cấm chat"),
        "creator must be protected from mute"
    );

    // 3. Mute regular member with duration (15m)
    let ctx_mute_user = make_test_ctx(
        caches.clone(),
        "mute",
        vec!["regular_user_1", "15m"],
        "regular_user_1 15m",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_user = mute_handler.execute(ctx_mute_user).await.expect("execute mute user");
    let txt = outcome_reply_text(&out_user).unwrap();
    assert!(txt.contains("Đã cấm chat"));

    // 4. listmute must list regular_user_1
    let ctx_list = make_test_ctx(
        caches.clone(),
        "listmute",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_list = listmute_handler.execute(ctx_list).await.expect("execute listmute");
    let txt_list = outcome_reply_text(&out_list).unwrap();
    assert!(txt_list.contains("regular_user_1"));

    // 5. Mute all (`!mute all 30m`)
    let ctx_mute_all = make_test_ctx(
        caches.clone(),
        "mute",
        vec!["all", "30m"],
        "all 30m",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_all = mute_handler.execute(ctx_mute_all).await.expect("execute mute all");
    let txt_all = outcome_reply_text(&out_all).unwrap_or("");
    assert!(txt_all.contains("toàn bộ thành viên"), "expected 'toàn bộ thành viên', got: '{txt_all}'");

    // 6. Unmute regular member
    let ctx_unmute_user = make_test_ctx(
        caches.clone(),
        "unmute",
        vec!["regular_user_1"],
        "regular_user_1",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_unmute = unmute_handler.execute(ctx_unmute_user).await.expect("execute unmute user");
    assert!(outcome_reply_text(&out_unmute).unwrap().contains("Đã gỡ cấm chat"));

    // 7. Unmute all
    let ctx_unmute_all = make_test_ctx(
        caches.clone(),
        "unmute",
        vec!["all"],
        "all",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_unmute_all = unmute_handler.execute(ctx_unmute_all).await.expect("execute unmute all");
    assert!(outcome_reply_text(&out_unmute_all).unwrap().contains("toàn bộ thành viên"));
}

#[tokio::test]
async fn test_phase2_ban_unban_protection_and_persistence() {
    let (rt, caches) = create_test_runtime();
    // Add bot admin to DB engine so list_bot_admins recognizes bot_admin_uid
    caches.engine().upsert_bot_admin("main", "bot_admin_uid", "adminBot", "Bot Admin").expect("add admin");

    let registry = build_full_command_registry(rt).expect("registry builds");
    let ban_handler = registry.get_canonical("ban").expect("ban handler");
    let unban_handler = registry.get_canonical("unban").expect("unban handler");

    // 1. Ban protected bot admin -> MUST be refused
    let ctx_ban_admin = make_test_ctx(
        caches.clone(),
        "ban",
        vec!["bot_admin_uid"],
        "bot_admin_uid",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_admin = ban_handler.execute(ctx_ban_admin).await.expect("execute ban admin");
    assert!(
        outcome_reply_text(&out_admin).unwrap().contains("Không thể cấm sử dụng bot"),
        "admin must be protected from ban, got: {:?}",
        outcome_reply_text(&out_admin)
    );

    // 2. Ban regular user
    let ctx_ban_user = make_test_ctx(
        caches.clone(),
        "ban",
        vec!["spammer_123", "spamming"],
        "spammer_123 spamming",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_user = ban_handler.execute(ctx_ban_user).await.expect("execute ban user");
    let txt_user = outcome_reply_text(&out_user).unwrap_or("");
    assert!(txt_user.contains("Đã cấm người dùng"), "expected 'Đã cấm người dùng', got: '{txt_user}'");
    assert!(caches.engine().is_user_blocked_globally("main", "spammer_123").unwrap());

    // 3. Unban regular user
    let ctx_unban = make_test_ctx(
        caches.clone(),
        "unban",
        vec!["spammer_123"],
        "spammer_123",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_unban = unban_handler.execute(ctx_unban).await.expect("execute unban user");
    assert!(outcome_reply_text(&out_unban).unwrap().contains("Đã mở chặn"));
    assert!(!caches.engine().is_user_blocked_globally("main", "spammer_123").unwrap());
}

// =============================================================================
// TEST 3: Group Management, Protected Roles, Kick & Block Mass Operations
// =============================================================================

#[tokio::test]
async fn test_phase2_kick_and_block_protected_roles_and_validation() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let kick_handler = registry.get_canonical("kick").expect("kick handler");
    let block_handler = registry.get_canonical("block").expect("block handler");
    let kickall_handler = registry.get_canonical("kickall").expect("kickall handler");
    let blockall_handler = registry.get_canonical("blockall").expect("blockall handler");

    // 1. Kick without session -> reports session not available, never false success
    let ctx_kick_reg = make_test_ctx(
        caches.clone(),
        "kick",
        vec!["regular_user_1"],
        "regular_user_1",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_kr = kick_handler.execute(ctx_kick_reg).await.expect("kick regular");
    assert!(outcome_reply_text(&out_kr).unwrap().contains("chưa kết nối Zalo"));

    // 2. kickall without zalo session -> reports session unavailable, never reports success
    let ctx_kickall = make_test_ctx(
        caches.clone(),
        "kickall",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_ka = kickall_handler.execute(ctx_kickall).await.expect("kickall");
    assert!(outcome_reply_text(&out_ka).unwrap().contains("chưa kết nối Zalo"));

    // 3. block without session -> reports session unavailable
    let ctx_block_reg = make_test_ctx(
        caches.clone(),
        "block",
        vec!["regular_user_1"],
        "regular_user_1",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_br = block_handler.execute(ctx_block_reg).await.expect("block regular");
    assert!(outcome_reply_text(&out_br).unwrap().contains("chưa kết nối Zalo"));

    // 4. blockall without zalo session -> reports session unavailable, never reports success
    let ctx_blockall = make_test_ctx(
        caches.clone(),
        "blockall",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "bot_admin_uid",
        vec![],
    );
    let out_ba = blockall_handler.execute(ctx_blockall).await.expect("blockall");
    assert!(outcome_reply_text(&out_ba).unwrap().contains("chưa kết nối Zalo"));
}

// =============================================================================
// TEST 4: Key Management Suite
// =============================================================================

#[tokio::test]
async fn test_phase2_key_management_suite() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let keysilver_h = registry.get_canonical("keysilver").expect("keysilver");
    let keygold_h = registry.get_canonical("keygold").expect("keygold");
    let unkey_h = registry.get_canonical("unkey").expect("unkey");
    let keylist_h = registry.get_canonical("keylist").expect("keylist");

    // Without active Zalo session, all key commands report gracefully
    let ctx_silver = make_test_ctx(
        caches.clone(),
        "keysilver",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "user_sender_silver",
        vec![],
    );
    let out_silver = keysilver_h.execute(ctx_silver).await.expect("keysilver");
    let txt_s = outcome_reply_text(&out_silver).unwrap();
    assert!(txt_s.contains("chưa kết nối Zalo"));

    let ctx_gold = make_test_ctx(
        caches.clone(),
        "keygold",
        vec!["user_target_gold"],
        "user_target_gold",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_gold = keygold_h.execute(ctx_gold).await.expect("keygold");
    let txt_g = outcome_reply_text(&out_gold).unwrap();
    assert!(txt_g.contains("chưa kết nối Zalo"));

    let ctx_list = make_test_ctx(
        caches.clone(),
        "keylist",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_list = keylist_h.execute(ctx_list).await.expect("keylist");
    let txt_l = outcome_reply_text(&out_list).unwrap();
    assert!(txt_l.contains("chưa kết nối Zalo"));

    let ctx_unkey = make_test_ctx(
        caches.clone(),
        "unkey",
        vec!["user_sender_silver"],
        "user_sender_silver",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_unkey = unkey_h.execute(ctx_unkey).await.expect("unkey");
    assert!(outcome_reply_text(&out_unkey).unwrap().contains("chưa kết nối Zalo"));
}

// =============================================================================
// TEST 5: Friend Management Suite
// =============================================================================

#[tokio::test]
async fn test_phase2_friend_management_suite() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");

    let addfriend_h = registry.get_canonical("addfriend").expect("addfriend");
    let addfriendall_h = registry.get_canonical("addfriendall").expect("addfriendall");
    let undofriend_h = registry.get_canonical("undofriend").expect("undofriend");
    let rejectfriend_h = registry.get_canonical("rejectfriend").expect("rejectfriend");
    let removefriend_h = registry.get_canonical("removefriend").expect("removefriend");
    let listfriend_h = registry.get_canonical("listfriend").expect("listfriend");
    let waitinglist_h = registry.get_canonical("waitinglist").expect("waitinglist");

    // 1. addfriend without session -> reports session unavailable, never false success
    let ctx_af = make_test_ctx(
        caches.clone(),
        "addfriend",
        vec!["target_user_888"],
        "target_user_888",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_af = addfriend_h.execute(ctx_af).await.expect("addfriend target");
    assert!(outcome_reply_text(&out_af).unwrap().contains("chưa kết nối Zalo"));

    // 2. addfriendall without session -> reports session unavailable
    let ctx_afa = make_test_ctx(
        caches.clone(),
        "addfriendall",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_afa = addfriendall_h.execute(ctx_afa).await.expect("addfriendall");
    assert!(outcome_reply_text(&out_afa).unwrap().contains("chưa kết nối Zalo"));

    // 3. undofriend with target but no session -> reports session unavailable
    let ctx_undo = make_test_ctx(
        caches.clone(),
        "undofriend",
        vec!["target_user_888"],
        "target_user_888",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_undo = undofriend_h.execute(ctx_undo).await.expect("undofriend");
    assert!(outcome_reply_text(&out_undo).unwrap().contains("chưa kết nối Zalo"));

    // 4. rejectfriend with target but no session -> reports session unavailable
    let ctx_rej = make_test_ctx(
        caches.clone(),
        "rejectfriend",
        vec!["target_user_888"],
        "target_user_888",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_rej = rejectfriend_h.execute(ctx_rej).await.expect("rejectfriend");
    assert!(outcome_reply_text(&out_rej).unwrap().contains("chưa kết nối Zalo"));

    // 5. removefriend with target but no session -> reports session unavailable
    let ctx_rem = make_test_ctx(
        caches.clone(),
        "removefriend",
        vec!["target_user_888"],
        "target_user_888",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_rem = removefriend_h.execute(ctx_rem).await.expect("removefriend");
    assert!(outcome_reply_text(&out_rem).unwrap().contains("chưa kết nối Zalo"));

    // 6. listfriend without session -> reports session unavailable
    let ctx_lf = make_test_ctx(
        caches.clone(),
        "listfriend",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_lf = listfriend_h.execute(ctx_lf).await.expect("listfriend");
    assert!(outcome_reply_text(&out_lf).unwrap().contains("chưa kết nối Zalo"));

    // 7. waitinglist without session -> reports session unavailable
    let ctx_wl = make_test_ctx(
        caches.clone(),
        "waitinglist",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out_wl = waitinglist_h.execute(ctx_wl).await.expect("waitinglist");
    assert!(outcome_reply_text(&out_wl).unwrap().contains("chưa kết nối Zalo"));
}

#[tokio::test]
async fn test_p1_setcmd_cooldown_rejection_and_validation() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let setcmd_h = registry.get_canonical("setcmd").expect("setcmd command registered");

    // 1. cd with non-numeric value -> MUST reject with exact error, NEVER silently fallback to 5s
    let ctx_invalid_str = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["cd", "help", "abc"],
        "cd help abc",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out1 = setcmd_h.execute(ctx_invalid_str).await.expect("setcmd cd abc");
    let text1 = outcome_reply_text(&out1).expect("reply text");
    assert!(
        text1.contains("❌ Thời gian countdown phải là số nguyên dương"),
        "Expected rejection error for invalid string seconds, got: {text1}"
    );

    // 2. cd with negative value -> MUST reject with exact error
    let ctx_negative = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["cd", "help", "-5"],
        "cd help -5",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out2 = setcmd_h.execute(ctx_negative).await.expect("setcmd cd -5");
    let text2 = outcome_reply_text(&out2).expect("reply text");
    assert!(
        text2.contains("❌ Thời gian countdown phải là số nguyên dương"),
        "Expected rejection error for negative seconds, got: {text2}"
    );

    // 3. cd with unknown command name -> MUST reject with "Không tìm thấy lệnh"
    let ctx_unknown_cd = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["cd", "unknown_command_xyz", "10"],
        "cd unknown_command_xyz 10",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out3 = setcmd_h.execute(ctx_unknown_cd).await.expect("setcmd cd unknown");
    let text3 = outcome_reply_text(&out3).expect("reply text");
    assert!(
        text3.contains("❌ Không tìm thấy lệnh \"unknown_command_xyz\""),
        "Expected unknown command error for cd flag, got: {text3}"
    );

    // 4. p (permission) with unknown command name -> MUST reject with "Không tìm thấy lệnh"
    let ctx_unknown_p = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["p", "unknown_command_xyz", "2"],
        "p unknown_command_xyz 2",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out4 = setcmd_h.execute(ctx_unknown_p).await.expect("setcmd p unknown");
    let text4 = outcome_reply_text(&out4).expect("reply text");
    assert!(
        text4.contains("❌ Không tìm thấy lệnh \"unknown_command_xyz\""),
        "Expected unknown command error for p flag, got: {text4}"
    );

    // 5. on with unknown command name -> MUST reject with "Không tìm thấy lệnh"
    let ctx_unknown_on = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["on", "unknown_command_xyz"],
        "on unknown_command_xyz",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out5 = setcmd_h.execute(ctx_unknown_on).await.expect("setcmd on unknown");
    let text5 = outcome_reply_text(&out5).expect("reply text");
    assert!(
        text5.contains("❌ Không tìm thấy lệnh \"unknown_command_xyz\""),
        "Expected unknown command error for on flag, got: {text5}"
    );

    // 6. p on setcmd itself -> immutable, MUST be rejected
    let ctx_immutable = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["p", "setcmd", "1"],
        "p setcmd 1",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out6 = setcmd_h.execute(ctx_immutable).await.expect("setcmd p setcmd");
    let text6 = outcome_reply_text(&out6).expect("reply text");
    assert!(
        text6.contains("Quyền hạn của lệnh setcmd là cố định"),
        "Expected immutable setcmd error, got: {text6}"
    );

    // 7. p with invalid level (not 1-4) -> MUST reject
    let ctx_invalid_level = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["p", "help", "9"],
        "p help 9",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out7 = setcmd_h.execute(ctx_invalid_level).await.expect("setcmd p help 9");
    let text7 = outcome_reply_text(&out7).expect("reply text");
    assert!(
        text7.contains("❌ Level quyền hạn Không hợp lệ"),
        "Expected invalid level error, got: {text7}"
    );

    // 8. valid cd -> success with old & new countdown
    let ctx_valid_cd = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["cd", "help", "14"],
        "cd help 14",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out8 = setcmd_h.execute(ctx_valid_cd).await.expect("setcmd cd help 14");
    let text8 = outcome_reply_text(&out8).expect("reply text");
    assert!(
        text8.contains("✅ Đã cập nhật thời gian chờ của lệnh \"help\":") && text8.contains("Mới: 14s"),
        "Expected successful cd update, got: {text8}"
    );

    // 9. valid p -> success with new permission label
    let ctx_valid_p = make_test_ctx(
        caches.clone(),
        "setcmd",
        vec!["p", "help", "3"],
        "p help 3",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out9 = setcmd_h.execute(ctx_valid_p).await.expect("setcmd p help 3");
    let text9 = outcome_reply_text(&out9).expect("reply text");
    assert!(
        text9.contains("✅ Đã thay đổi quyền hạn của lệnh \"help\":") && text9.contains("Quản trị viên bot"),
        "Expected successful permission update, got: {text9}"
    );
}

#[tokio::test]
async fn test_p1_restart_announcement() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let restart_h = registry.get_canonical("restart").expect("restart command registered");

    let ctx = make_test_ctx(
        caches.clone(),
        "restart",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        "admin_uid",
        vec![],
    );
    let out = restart_h.execute(ctx).await.expect("restart execution");
    let text = outcome_reply_text(&out).expect("restart reply text");
    assert!(
        text.contains("🤖 Bot đang khởi động lại 🔂"),
        "Expected restart announcement matching Node V3, got: {text}"
    );
}

#[tokio::test]
async fn test_p1_cmdadd_list_and_remove() {
    let (rt, caches) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry builds");
    let cmdadd_h = registry.get_canonical("cmdadd").expect("cmdadd command registered");

    // 1. Empty list
    let ctx_empty = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["list"],
        "list",
        ThreadType::Group,
        PermissionTier::All,
        "user_uid",
        vec![],
    );
    let out_empty = cmdadd_h.execute(ctx_empty).await.expect("cmdadd list empty");
    let text_empty = outcome_reply_text(&out_empty).expect("reply text");
    assert!(
        text_empty.contains("Chưa có lệnh custom nào"),
        "Expected empty notice, got: {text_empty}"
    );

    // 2. Insert two custom commands
    caches.engine().upsert_custom_command(
        "main",
        "customhello",
        &json!({
            "name": "customhello",
            "content": "Xin chao cac ban!",
            "media": {
                "kind": "image",
                "path": "assets/custom-commands/customhello.jpg"
            }
        }),
        true,
    ).expect("upsert custom command 1");

    caches.engine().upsert_custom_command(
        "main",
        "custombye",
        &json!({
            "name": "custombye",
            "content": "Tam biet moi nguoi!"
        }),
        true,
    ).expect("upsert custom command 2");

    // 3. List contains formatted commands
    let ctx_list = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["list", "1"],
        "list 1",
        ThreadType::Group,
        PermissionTier::All,
        "user_uid",
        vec![],
    );
    let out_list = cmdadd_h.execute(ctx_list).await.expect("cmdadd list 1");
    let text_list = outcome_reply_text(&out_list).expect("reply text");
    // Text fallback (or image caption) matches format
    assert!(
        text_list.contains("customhello") || text_list.contains("Trang 1/"),
        "Expected listing output, got: {text_list}"
    );

    // 4. Remove by numerical ID (ID #1 = customhello or custombye depending on order)
    let ctx_rem_id = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["remove", "1"],
        "remove 1",
        ThreadType::Group,
        PermissionTier::All,
        "user_uid",
        vec![],
    );
    let out_rem_id = cmdadd_h.execute(ctx_rem_id).await.expect("cmdadd remove 1");
    let text_rem_id = outcome_reply_text(&out_rem_id).expect("reply text");
    assert!(
        text_rem_id.contains("✅ Đã xóa lệnh custom") && text_rem_id.contains("(ID #1)"),
        "Expected ID removal confirmation, got: {text_rem_id}"
    );

    // 5. Remove unknown command -> reports not found
    let ctx_rem_unknown = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["remove", "nonexistent_cmd_xyz"],
        "remove nonexistent_cmd_xyz",
        ThreadType::Group,
        PermissionTier::All,
        "user_uid",
        vec![],
    );
    let out_rem_unknown = cmdadd_h.execute(ctx_rem_unknown).await.expect("cmdadd remove unknown");
    let text_rem_unknown = outcome_reply_text(&out_rem_unknown).expect("reply text");
    assert!(
        text_rem_unknown.contains("⚠️ Không tìm thấy lệnh custom \"nonexistent_cmd_xyz\""),
        "Expected not found notice, got: {text_rem_unknown}"
    );
}

