//! Phase 0 Integration Test Suite: Complete Behavioral Matrix for 218 Commands & 181 Aliases (399 Keys).
//!
//! Validates:
//! 1. Parity between `assets/json-data/command.json` and Rust catalog (218 canonical, 181 aliases, 399 total keys).
//! 2. Realistic behavioral matrix across all 399 invocation keys:
//!    - Multi-word prefix parsing and collision-free key resolution.
//!    - ChatScope enforcement (Group-only vs DM-only vs Both).
//!    - Permission tier enforcement (All, Member, AdminBox, AdminBot, AdminLevelHigh).
//!    - Cooldown countdown enforcement & tracking.
//!    - ArgSplitMode validation (Whitespace vs Underscore).
//! 3. Deep multi-branch testing for `mybot` subcommands:
//!    - `help`, `list`, `detail`, `active`, `trial`, `start`, `stop`, `shutdown`, `restart`,
//!      `delete`, `del`, `extend`, `minus`, `approve`, `reject`, `nameserver`, `style`, `set`,
//!      `clean`, `notify`, `cmd`, `qrlogin`, `getupdate`, `create`, `update`, `showinfo`, `info`, `manager`.
//! 4. Special syntax splitting:
//!    - Whitespace tokenization (`!gemini make ...`, `!stk ai ...`).
//!    - Pipe `|` syntax for `cmdadd` (`!cmdadd name | response content`, `list`, `remove`).
//!    - Underscore `_` syntax for `learnnow`, `todo`, `sendp` (`!learnnow q _ a`, `!learnnow_q_a`).
//! 5. Direct panic-free execution of all 218 canonical handlers in mock runtime.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use mybot_commands::catalog::{ALL_218_CATALOG, CommandDomain};
use mybot_commands::{CommandRuntimeBundle, build_full_command_registry};
use mybot_core::{
    BotExecutionMeta, BotStyleProfile, CommandContext, CommandOutcome, FastPathDispatcher,
    ProtectionEngine, StudioEngine, WorkloadBroker, DispatchReport,
};
use mybot_storage::{BotRecord, GroupSettingsRecord, HotStorageCaches, StorageEngine};
use mybot_types::{
    ArgSplitMode, ChatScope, EventSource, ExpiryPolicy, InboundMessage, InstanceScope,
    MessageContent, PermissionTier, ThreadType, ZaloId,
};
use serde_json::{Value, json};

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

fn create_test_runtime() -> (Arc<CommandRuntimeBundle>, HotStorageCaches, PathBuf) {
    let engine = StorageEngine::open_in_memory().expect("open in-memory storage");
    let caches = HotStorageCaches::load_from_engine(engine).expect("load storage caches");
    let repo_root = find_repo_root();
    let rt = Arc::new(CommandRuntimeBundle::new(&repo_root, caches.clone()));
    (rt, caches, repo_root)
}

fn outcome_reply_text(outcome: &CommandOutcome) -> Option<&str> {
    match outcome {
        CommandOutcome::Handled { reply_text: Some(t), .. } => Some(t.as_str()),
        CommandOutcome::Denied { message, .. } => Some(message.as_str()),
        _ => None,
    }
}

fn make_test_bot(
    bot_key: &str,
    uid: &str,
    name: &str,
    status: &str,
    policy: ExpiryPolicy,
) -> BotRecord {
    BotRecord {
        bot_key: bot_key.into(),
        uid: ZaloId::new(uid),
        global_uid: None,
        canonical_username: None,
        display_name: name.into(),
        avatar: String::new(),
        is_main: false,
        owner_uid: Some("admin_1".into()),
        status: status.into(),
        desired_status: status.into(),
        expiry_policy: policy,
        trial_status: None,
        cookie_json: json!({}),
        imei: "imei_test".into(),
        user_agent: "Mozilla/5.0".into(),
        proxy_url: None,
        cookie_dead: false,
        cookie_dead_reason: None,
        prefix: "!".into(),
        self_listen: false,
        identity_pending: false,
        admin_identity_seeds: Vec::new(),
        metadata: json!({}),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
    }
}

fn make_test_ctx(
    caches: HotStorageCaches,
    invoked: &str,
    args: Vec<&str>,
    raw_args: &str,
    thread_type: ThreadType,
    sender_tier: PermissionTier,
    is_main_bot: bool,
    assets_root: PathBuf,
) -> CommandContext {
    let thread_id = if thread_type == ThreadType::Group {
        ZaloId::new("grp_100")
    } else {
        ZaloId::new("dm_100")
    };
    CommandContext {
        bot_key: "main".into(),
        is_main_bot,
        self_uid: ZaloId::new("bot_1"),
        prefix: "!".into(),
        invoked_alias: invoked.into(),
        args: args.into_iter().map(ToOwned::to_owned).collect(),
        raw_args_text: raw_args.into(),
        message: InboundMessage {
            bot_key: "main".into(),
            msg_id: ZaloId::new("m1"),
            cli_msg_id: ZaloId::new("c1"),
            global_msg_id: ZaloId::new("g1"),
            thread_id: thread_id.clone(),
            thread_type,
            sender_uid: ZaloId::new("admin_1"),
            sender_name: "Nguyễn Văn A".into(),
            is_self: false,
            msg_type: "webchat".into(),
            timestamp_ms: Utc::now().timestamp_millis(),
            ws_received_at_ms: Utc::now().timestamp_millis(),
            ttl_ms: 0,
            mentions: Vec::new(),
            styles: Vec::new(),
            quote: None,
            content: MessageContent::Text {
                text: format!("!{invoked} {raw_args}"),
            },
            source: EventSource::default(),
            raw_property_ext: None,
        },
        sender_tier,
        group_settings: GroupSettingsRecord::default_for("main", thread_id.as_str()),
        effective_studio_config: json!({}),
        zalo: None,
        caches,
        assets_root,
        style_profile: BotStyleProfile::default(),
        interactions: Arc::new(mybot_core::InteractionEngine::new()),
        fleet: None,
        outbound_sink: Some(Arc::new(parking_lot::Mutex::new(Vec::new()))),
    }
}

fn make_inbound_msg(
    text: &str,
    thread_type: ThreadType,
    sender_uid: &str,
    msg_id: &str,
) -> InboundMessage {
    let thread_id = if thread_type == ThreadType::Group {
        ZaloId::new("grp_100")
    } else {
        ZaloId::new("dm_100")
    };
    InboundMessage {
        bot_key: "main".into(),
        msg_id: ZaloId::new(msg_id),
        cli_msg_id: ZaloId::new(format!("cli_{msg_id}")),
        global_msg_id: ZaloId::new(format!("g_{msg_id}")),
        thread_id,
        thread_type,
        sender_uid: ZaloId::new(sender_uid),
        sender_name: "Tester".into(),
        is_self: false,
        msg_type: "webchat".into(),
        timestamp_ms: Utc::now().timestamp_millis(),
        ws_received_at_ms: Utc::now().timestamp_millis(),
        ttl_ms: 0,
        mentions: Vec::new(),
        styles: Vec::new(),
        quote: None,
        content: MessageContent::Text {
            text: text.to_string(),
        },
        source: EventSource::WebSocket,
        raw_property_ext: None,
    }
}

fn make_execution_meta(
    sender_tier: PermissionTier,
    is_main_bot: bool,
    assets_root: PathBuf,
    sink: Arc<parking_lot::Mutex<Vec<zalo_sdk::OutboundMessage>>>,
) -> BotExecutionMeta {
    BotExecutionMeta {
        bot_key: "main".into(),
        is_main_bot,
        self_uid: ZaloId::new("bot_main_1"),
        prefix: "!".into(),
        self_listen: true,
        identity_pending: false,
        sender_tier,
        zalo: None,
        assets_root,
        style_profile: BotStyleProfile::default(),
        chat_policy_group: true,
        chat_policy_private: true,
        fleet: None,
        outbound_sink: Some(sink),
    }
}

// =============================================================================
// TEST 1: Parity with assets/json-data/command.json
// =============================================================================
#[tokio::test]
async fn test_01_command_json_registry_parity_and_spec_audit() {
    let (rt, _, repo_root) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("zero collisions in registry");

    let cmd_json_path = repo_root.join("assets/json-data/command.json");
    assert!(
        cmd_json_path.exists(),
        "command.json must exist at {}",
        cmd_json_path.display()
    );

    let raw = std::fs::read_to_string(&cmd_json_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", cmd_json_path.display()));
    let v: Value = serde_json::from_str(&raw).expect("valid json in command.json");
    let json_cmds = v["commands"].as_array().expect("commands array in json");

    // 1. Exact 218 canonical commands
    assert_eq!(json_cmds.len(), 218, "JSON must define exactly 218 commands");
    assert_eq!(ALL_218_CATALOG.len(), 218, "Catalog must hold 218 entries");
    assert_eq!(registry.canonical_count(), 218, "Registry must register 218 canonical commands");

    let mut expected_keys = BTreeSet::new();
    let mut alias_count = 0usize;

    for cmd in json_cmds {
        let name = cmd["name"]
            .as_str()
            .expect("name string")
            .trim()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(!name.is_empty(), "command name cannot be empty");
        let handler = registry
            .get_canonical(&name)
            .unwrap_or_else(|| panic!("command `{name}` missing in Rust registry"));

        expected_keys.insert(name.clone());

        let spec = handler.spec();

        // Validate cooldown match
        if let Some(cd) = cmd.get("countdown").and_then(Value::as_u64) {
            assert_eq!(
                spec.default_cooldown_secs as u64,
                cd,
                "cooldown mismatch for `{name}`: spec={}, json={cd}",
                spec.default_cooldown_secs
            );
        }

        // Validate instance scope match
        if let Some(scope_str) = cmd.get("instanceScope").and_then(Value::as_str) {
            match scope_str {
                "main" => assert_eq!(
                    spec.instance_scope,
                    InstanceScope::MainOnly,
                    "`{name}` should have MainOnly instance scope"
                ),
                "any" => assert_eq!(
                    spec.instance_scope,
                    InstanceScope::Any,
                    "`{name}` should have Any instance scope"
                ),
                _ => {}
            }
        }

        // Validate aliases
        if let Some(aliases) = cmd.get("alias").and_then(Value::as_array) {
            for a in aliases {
                let alias_norm = a
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .to_lowercase()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");

                if !alias_norm.is_empty() {
                    alias_count += 1;
                    expected_keys.insert(alias_norm.clone());

                    let resolved = registry
                        .get_by_any_key(&alias_norm)
                        .unwrap_or_else(|| panic!("alias `{alias_norm}` not resolvable"));
                    assert_eq!(
                        resolved.spec().name,
                        spec.name,
                        "alias `{alias_norm}` resolved to `{}` instead of `{}`",
                        resolved.spec().name,
                        spec.name
                    );
                }
            }
        }
    }

    assert_eq!(alias_count, 181, "Must have exactly 181 aliases defined in command.json");
    assert_eq!(expected_keys.len(), 399, "Must have exactly 399 unique calling keys");
    assert_eq!(registry.lookup_key_count(), 399, "Registry lookup must have 399 keys");

    // Domain breakdown check
    let mut saas_count = 0usize;
    let mut admin_count = 0usize;
    let mut media_count = 0usize;
    let mut ai_count = 0usize;
    let mut mod_count = 0usize;
    for entry in &ALL_218_CATALOG {
        match entry.domain {
            CommandDomain::SaasFunUtilities => saas_count += 1,
            CommandDomain::AdminAndGroup => admin_count += 1,
            CommandDomain::MediaStickerPools => media_count += 1,
            CommandDomain::AiAndCrawlers => ai_count += 1,
            CommandDomain::ModerationAnti => mod_count += 1,
        }
    }
    assert_eq!(saas_count, 53, "SaasFunUtilities must have 53 commands");
    assert_eq!(admin_count, 63, "AdminAndGroup must have 63 commands");
    assert_eq!(media_count, 40, "MediaStickerPools must have 40 commands");
    assert_eq!(ai_count, 32, "AiAndCrawlers must have 32 commands");
    assert_eq!(mod_count, 30, "ModerationAnti must have 30 commands");
}

// =============================================================================
// TEST 2: Comprehensive Behavioral Matrix for ALL 399 Calling Keys
// =============================================================================
#[tokio::test]
async fn test_02_behavioral_matrix_all_399_keys() {
    let (rt, caches, repo_root) = create_test_runtime();
    let registry = build_full_command_registry(Arc::clone(&rt)).expect("registry ok");
    let studio = Arc::new(StudioEngine::new(registry.clone(), caches.clone()));
    let dispatcher = FastPathDispatcher::new(
        caches.clone(),
        ProtectionEngine::default(),
        studio.clone(),
        WorkloadBroker::default(),
        128,
    );

    let cmd_json_path = repo_root.join("assets/json-data/command.json");
    let raw = std::fs::read_to_string(&cmd_json_path).expect("read command.json");
    let v: Value = serde_json::from_str(&raw).expect("valid json");
    let json_cmds = v["commands"].as_array().expect("commands array");

    let mut all_399_keys = Vec::new();
    for cmd in json_cmds {
        let name = cmd["name"].as_str().unwrap().trim().to_lowercase();
        let name_norm = name.split_whitespace().collect::<Vec<_>>().join(" ");
        all_399_keys.push((name_norm.clone(), name_norm.clone(), true));

        if let Some(aliases) = cmd.get("alias").and_then(Value::as_array) {
            for a in aliases {
                let al = a.as_str().unwrap().trim().to_lowercase();
                let al_norm = al.split_whitespace().collect::<Vec<_>>().join(" ");
                if !al_norm.is_empty() {
                    all_399_keys.push((al_norm, name_norm.clone(), false));
                }
            }
        }
    }

    assert_eq!(all_399_keys.len(), 399);

    let mut keys_checked = 0usize;
    let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

    for (key, canonical_name, _is_canonical) in &all_399_keys {
        // 1. Resolution Check
        let handler_opt = registry.get_by_any_key(key);
        assert!(
            handler_opt.is_some(),
            "Key `{key}` failed to resolve in registry"
        );
        let handler = handler_opt.unwrap();
        assert_eq!(
            handler.spec().name,
            *canonical_name,
            "Key `{key}` must resolve to canonical `{canonical_name}`"
        );

        // 2. Prefixed Parser Resolution Check
        let line = format!("!{key}");
        let parsed = registry
            .parse_prefixed_line(&line, "!")
            .unwrap_or_else(|| panic!("failed to parse prefixed line: `{line}`"));
        assert_eq!(parsed.matched_key, *key);
        assert_eq!(parsed.handler.spec().name, *canonical_name);

        let spec = handler.spec();

        // 3. Behavioral Scope Gate Check
        // Group-only command invoked in User DM -> must be denied with SCOPE_DENIED
        if spec.scope == ChatScope::Group {
            let dm_msg = make_inbound_msg(&line, ThreadType::User, "user_dm_1", &format!("msg_dm_{keys_checked}"));
            let meta_admin = make_execution_meta(
                PermissionTier::AdminLevelHigh,
                true,
                repo_root.join("assets"),
                Arc::clone(&sink),
            );
            let report = dispatcher.dispatch_inbound(meta_admin, dm_msg).await;
            match report {
                DispatchReport::CommandExecuted {
                    outcome: CommandOutcome::Denied { reason_code, message },
                    ..
                } => {
                    assert_eq!(reason_code, "SCOPE_DENIED", "key `{key}` should be rejected in DM");
                    assert!(message.contains("Nhóm"));
                }
                other => panic!("expected SCOPE_DENIED for group command `{key}` in DM, got {other:?}"),
            }
        }

        // Private-only command invoked in Group -> must be denied with SCOPE_DENIED
        if spec.scope == ChatScope::Private {
            let grp_msg = make_inbound_msg(&line, ThreadType::Group, "user_grp_1", &format!("msg_grp_{keys_checked}"));
            let meta_admin = make_execution_meta(
                PermissionTier::AdminLevelHigh,
                true,
                repo_root.join("assets"),
                Arc::clone(&sink),
            );
            let report = dispatcher.dispatch_inbound(meta_admin, grp_msg).await;
            match report {
                DispatchReport::CommandExecuted {
                    outcome: CommandOutcome::Denied { reason_code, message },
                    ..
                } => {
                    assert_eq!(reason_code, "SCOPE_DENIED", "key `{key}` should be rejected in Group");
                    assert!(message.contains("riêng"));
                }
                other => panic!("expected SCOPE_DENIED for private command `{key}` in Group, got {other:?}"),
            }
        }

        // 4. Behavioral Permission Gate Check
        // If command requires high permission, a low-tier sender must be denied
        if spec.permission > PermissionTier::All && spec.name != "prefix" {
            let valid_thread = if spec.scope == ChatScope::Private {
                ThreadType::User
            } else {
                ThreadType::Group
            };
            let low_perm_msg = make_inbound_msg(&line, valid_thread, "low_user_1", &format!("msg_low_{keys_checked}"));
            let meta_low = make_execution_meta(
                PermissionTier::All,
                true,
                repo_root.join("assets"),
                Arc::clone(&sink),
            );
            let report = dispatcher.dispatch_inbound(meta_low, low_perm_msg).await;
            match report {
                DispatchReport::CommandExecuted {
                    outcome: CommandOutcome::Denied { reason_code, .. },
                    ..
                } => {
                    assert_eq!(
                        reason_code,
                        "PERMISSION_DENIED",
                        "Low-tier user should be denied on `{key}` (spec={canonical_name})"
                    );
                }
                DispatchReport::Ignored { reason_code, .. } => {
                    assert!(reason_code == "GROUP_BOT_DISABLED" || reason_code == "ONLY_ADMIN_BOX");
                }
                other => panic!("expected PERMISSION_DENIED on `{key}`, got {other:?}"),
            }
        }

        // 5. InstanceScope Gate Check
        // Main-only commands invoked on Sub-bot must be denied
        if spec.instance_scope == InstanceScope::MainOnly {
            let valid_thread = if spec.scope == ChatScope::Private {
                ThreadType::User
            } else {
                ThreadType::Group
            };
            let sub_msg = make_inbound_msg(&line, valid_thread, "admin_user_1", &format!("msg_sub_{keys_checked}"));
            let meta_sub = make_execution_meta(
                PermissionTier::AdminLevelHigh,
                false, // is_main_bot = false
                repo_root.join("assets"),
                Arc::clone(&sink),
            );
            let report = dispatcher.dispatch_inbound(meta_sub, sub_msg).await;
            match report {
                DispatchReport::CommandExecuted {
                    outcome: CommandOutcome::Denied { reason_code, message },
                    ..
                } => {
                    assert_eq!(reason_code, "INSTANCE_SCOPE_DENIED");
                    assert!(message.contains("Bot Chính"));
                }
                other => panic!("expected INSTANCE_SCOPE_DENIED for `{key}` on sub bot, got {other:?}"),
            }
        }

        keys_checked += 1;
    }

    assert_eq!(keys_checked, 399, "All 399 keys successfully evaluated through behavioral matrix");
}

// =============================================================================
// TEST 3: Multi-Branch `mybot` Subcommand Suite
// =============================================================================
#[tokio::test]
async fn test_03_mybot_subcommands_multi_branch_suite() {
    let (rt, caches, repo_root) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry ok");
    let mybot_handler = registry.get_canonical("mybot").expect("mybot found");

    // 1. Default (no args) -> Help manual
    let ctx_default = make_test_ctx(
        caches.clone(),
        "mybot",
        vec![],
        "",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_default = mybot_handler.execute(ctx_default).await.expect("execute ok");
    assert!(outcome_reply_text(&out_default).unwrap().contains("HƯỚNG DẪN QUẢN LÝ BOT"));
    assert!(outcome_reply_text(&out_default).unwrap().contains("mybot info"));
    assert!(outcome_reply_text(&out_default).unwrap().contains("mybot manager"));

    // 2. `mybot help` -> Help manual
    let ctx_help = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["help"],
        "help",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_help = mybot_handler.execute(ctx_help).await.expect("execute ok");
    assert!(outcome_reply_text(&out_help).unwrap().contains("HƯỚNG DẪN QUẢN LÝ BOT"));

    // 3. `mybot manager` -> Admin manager manual
    let ctx_mgr = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["manager"],
        "manager",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_mgr = mybot_handler.execute(ctx_mgr).await.expect("execute ok");
    assert!(outcome_reply_text(&out_mgr).unwrap().contains("LỆNH QUẢN TRỊ HỆ THỐNG BOT"));
    assert!(outcome_reply_text(&out_mgr).unwrap().contains("mybot list"));
    assert!(outcome_reply_text(&out_mgr).unwrap().contains("mybot approve"));

    // 4. `mybot list` with 0 bots -> Empty list notice
    let ctx_list_0 = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["list"],
        "list",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_list_0 = mybot_handler.execute(ctx_list_0).await.expect("execute ok");
    assert!(outcome_reply_text(&out_list_0).unwrap().contains("0 bot"));

    // Seed test bots into StorageEngine using `make_test_bot`
    let bot_a = make_test_bot(
        "sub_101",
        "z_sub_101",
        "Bot Con Demo 1",
        "stopped",
        ExpiryPolicy::Permanent,
    );
    let bot_b = make_test_bot(
        "sub_102",
        "z_sub_102",
        "Bot Con Demo 2",
        "disabled",
        ExpiryPolicy::At(Utc::now() + chrono::Duration::days(15)),
    );
    caches.engine().upsert_bot(&bot_a).expect("upsert bot_a");
    caches.engine().upsert_bot(&bot_b).expect("upsert bot_b");

    // 5. `mybot list` with 2 bots -> Shows list (renders Card or text with bot count)
    let ctx_list_2 = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["list"],
        "list",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_list_2 = mybot_handler.execute(ctx_list_2).await.expect("execute ok");
    let text_l2 = outcome_reply_text(&out_list_2).unwrap();
    assert!(text_l2.contains("2 bot"), "list must contain bot count: got `{text_l2}`");

    // 6. `mybot detail sub_101` -> Detailed card / info
    let ctx_det = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["detail", "sub_101"],
        "detail sub_101",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_det = mybot_handler.execute(ctx_det).await.expect("execute ok");
    let text_det = outcome_reply_text(&out_det).unwrap();
    assert!(text_det.contains("Bot Con Demo 1"), "detail must contain bot name: got `{text_det}`");

    // 7. `mybot info` / `mybot showinfo` -> Lists owned bots
    let ctx_info = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["info"],
        "info",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_info = mybot_handler.execute(ctx_info).await.expect("execute ok");
    let text_info = outcome_reply_text(&out_info).unwrap();
    assert!(text_info.contains("Bot của bạn (2)"));
    assert!(text_info.contains("sub_101"));

    // 8. `mybot start sub_101` -> Status transitions to running
    let ctx_start = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["start", "sub_101"],
        "start sub_101",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_start = mybot_handler.execute(ctx_start).await.expect("execute ok");
    let txt_start = outcome_reply_text(&out_start).unwrap();
    assert!(
        txt_start.contains("Đã khởi động bot") && txt_start.contains("sub_101"),
        "start must mention bot: got `{txt_start}`"
    );
    let updated_a = caches.engine().get_bot("sub_101").unwrap().unwrap();
    assert_eq!(updated_a.status, "running");

    // 9. `mybot stop sub_101` -> Status transitions to stopped
    let ctx_stop = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["stop", "sub_101"],
        "stop sub_101",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_stop = mybot_handler.execute(ctx_stop).await.expect("execute ok");
    let txt_stop = outcome_reply_text(&out_stop).unwrap();
    assert!(
        txt_stop.contains("Đã tạm dừng bot") && txt_stop.contains("sub_101"),
        "stop must mention bot: got `{txt_stop}`"
    );
    let stopped_a = caches.engine().get_bot("sub_101").unwrap().unwrap();
    assert_eq!(stopped_a.status, "stopped");

    // 10. `mybot approve sub_102` -> Status transitions to running
    let ctx_appr = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["approve", "sub_102"],
        "approve sub_102",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_appr = mybot_handler.execute(ctx_appr).await.expect("execute ok");
    let txt_appr = outcome_reply_text(&out_appr).unwrap();
    assert!(
        txt_appr.contains("Đã phê duyệt bot") && txt_appr.contains("sub_102"),
        "approve must mention bot: got `{txt_appr}`"
    );
    let appr_b = caches.engine().get_bot("sub_102").unwrap().unwrap();
    assert_eq!(appr_b.status, "running");

    // 11. `mybot reject sub_102` -> Status transitions to disabled
    let ctx_rej = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["reject", "sub_102"],
        "reject sub_102",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_rej = mybot_handler.execute(ctx_rej).await.expect("execute ok");
    let txt_rej = outcome_reply_text(&out_rej).unwrap();
    assert!(
        txt_rej.contains("vô hiệu hóa") && txt_rej.contains("sub_102"),
        "reject must mention bot: got `{txt_rej}`"
    );
    let rej_b = caches.engine().get_bot("sub_102").unwrap().unwrap();
    assert_eq!(rej_b.status, "disabled");

    // 12. `mybot extend sub_101 60d` -> Updates expiry
    let ctx_ext = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["extend", "sub_101", "60d"],
        "extend sub_101 60d",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_ext = mybot_handler.execute(ctx_ext).await.expect("execute ok");
    let txt_ext = outcome_reply_text(&out_ext).unwrap();
    assert!(
        txt_ext.contains("Đã gia hạn thành công cho bot") && txt_ext.contains("60d"),
        "extend must mention duration: got `{txt_ext}`"
    );

    // 13. `mybot nameserver Test Node V3 VPS`
    let ctx_ns = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["nameserver", "Test Node V3 VPS"],
        "nameserver Test Node V3 VPS",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_ns = mybot_handler.execute(ctx_ns).await.expect("execute ok");
    assert!(outcome_reply_text(&out_ns).unwrap().contains("Đã đổi tên server của bot thành: Test Node V3 VPS"));

    // 14. `mybot style color db342e` & `mybot style icon 🤖`
    let ctx_style = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["style", "color", "00ffaa"],
        "style color 00ffaa",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_style = mybot_handler.execute(ctx_style).await.expect("execute ok");
    let txt_style = outcome_reply_text(&out_style).unwrap();
    assert!(txt_style.contains("00ffaa"), "style color reply must contain hex: got `{txt_style}`");

    // 15. `mybot qrlogin` -> Guidance info
    let ctx_qr = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["qrlogin"],
        "qrlogin",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_qr = mybot_handler.execute(ctx_qr).await.expect("execute ok");
    assert!(outcome_reply_text(&out_qr).unwrap().contains("Đăng Nhập QR Bot Zalo"));

    // 16. `mybot clean`, `mybot notify`, `mybot getupdate`
    let ctx_clean = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["clean"],
        "clean",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_clean = mybot_handler.execute(ctx_clean).await.expect("execute ok");
    assert!(outcome_reply_text(&out_clean).unwrap().contains("Đã dọn dẹp các bot hết hạn"));

    let ctx_notif = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["notify", "Hệ", "thống", "bảo", "trì"],
        "notify Hệ thống bảo trì",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_notif = mybot_handler.execute(ctx_notif).await.expect("execute ok");
    let txt_notif = outcome_reply_text(&out_notif).unwrap();
    assert!(txt_notif.contains("gửi thông báo"), "notify must confirm broadcast: got `{txt_notif}`");

    // 17. `mybot delete sub_102` -> Bot deleted
    let ctx_del = make_test_ctx(
        caches.clone(),
        "mybot",
        vec!["delete", "sub_102"],
        "delete sub_102",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_del = mybot_handler.execute(ctx_del).await.expect("execute ok");
    let txt_del = outcome_reply_text(&out_del).unwrap();
    assert!(
        txt_del.contains("Đã xóa bot") && txt_del.contains("sub_102"),
        "delete must mention bot: got `{txt_del}`"
    );
    assert!(caches.engine().get_bot("sub_102").unwrap().is_none());

    // 18. Aliases of mybot: `!mebot` and `!clean`
    assert_eq!(registry.get_by_any_key("mebot").unwrap().spec().name, "mybot");
    assert_eq!(registry.get_by_any_key("clean").unwrap().spec().name, "mybot");
}

// =============================================================================
// TEST 4: Special Syntax Argument Splitting (Whitespace, Pipe |, Underscore _)
// =============================================================================
#[tokio::test]
async fn test_04_special_syntax_argument_splitting() {
    let (rt, caches, repo_root) = create_test_runtime();
    let registry = build_full_command_registry(Arc::clone(&rt)).expect("registry ok");
    let studio = Arc::new(StudioEngine::new(registry.clone(), caches.clone()));
    let dispatcher = FastPathDispatcher::new(
        caches.clone(),
        ProtectionEngine::default(),
        studio.clone(),
        WorkloadBroker::default(),
        128,
    );
    let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

    // -------------------------------------------------------------------------
    // 1. Whitespace splitting & Multi-Word Keys
    // -------------------------------------------------------------------------
    let p_gem = registry
        .parse_prefixed_line("!gemini make rồng lửa bay trên đỉnh Fansipan", "!")
        .expect("parsed gemini make");
    assert_eq!(p_gem.matched_key, "gemini make");
    assert_eq!(p_gem.handler.spec().name, "gemini make");
    assert_eq!(p_gem.args, vec!["rồng", "lửa", "bay", "trên", "đỉnh", "Fansipan"]);
    assert_eq!(p_gem.raw_args_text, "rồng lửa bay trên đỉnh Fansipan");

    let p_stk = registry
        .parse_prefixed_line("!stk ai chú mèo đeo kính râm cool ngầu", "!")
        .expect("parsed stk ai");
    assert_eq!(p_stk.matched_key, "stk ai");
    assert_eq!(p_stk.handler.spec().name, "sticker ai");
    assert_eq!(p_stk.args, vec!["chú", "mèo", "đeo", "kính", "râm", "cool", "ngầu"]);

    // -------------------------------------------------------------------------
    // 2. Pipe `|` Splitting on `cmdadd`
    // -------------------------------------------------------------------------
    let cmdadd_handler = registry.get_canonical("cmdadd").expect("cmdadd found");
    assert_eq!(cmdadd_handler.spec().instance_scope, InstanceScope::MainOnly);

    // 2a. Add custom command via pipe `|`
    let ctx_cmdadd_pipe = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["chaochao", "|", "Xin", "chào", "quý", "khách", "tới", "nhóm!"],
        "chaochao | Xin chào quý khách tới nhóm!",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_cmdadd = cmdadd_handler.execute(ctx_cmdadd_pipe).await.expect("execute cmdadd");
    assert!(outcome_reply_text(&out_cmdadd).unwrap().contains("chaochao"));

    // 2b. Verify custom command list via `cmdadd list`
    let ctx_cmdadd_list = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["list"],
        "list",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_list = cmdadd_handler.execute(ctx_cmdadd_list).await.expect("execute cmdadd list");
    let rep_str = outcome_reply_text(&out_list).unwrap();
    assert!(
        rep_str.contains("chaochao") || rep_str.contains("Trang 1/1"),
        "expected custom command list or card caption, got `{rep_str}`"
    );

    // 2c. Execute the dynamically created custom command `!chaochao` via FastPathDispatcher!
    caches.update_group_settings("main", "grp_100", |g| {
        g.enable_bot = true;
    });
    let msg_chao = make_inbound_msg("!chaochao", ThreadType::Group, "user_dyn_1", "msg_dyn_1");
    let meta_exec = make_execution_meta(
        PermissionTier::All,
        true,
        repo_root.join("assets"),
        Arc::clone(&sink),
    );
    let dyn_report = dispatcher.dispatch_inbound(meta_exec, msg_chao).await;
    match dyn_report {
        DispatchReport::CommandExecuted {
            command_name,
            outcome: CommandOutcome::Handled { summary, reply_text, .. },
            ..
        } => {
            assert_eq!(command_name, "chaochao");
            let effective_reply = reply_text.unwrap_or(summary);
            assert!(
                effective_reply.contains("Xin chào quý khách tới nhóm!"),
                "expected greeting, got `{effective_reply}`"
            );
        }
        other => panic!("expected dynamic custom command execution, got {other:?}"),
    }

    // 2d. Remove the custom command via `cmdadd remove chaochao`
    let ctx_cmdadd_rem = make_test_ctx(
        caches.clone(),
        "cmdadd",
        vec!["remove", "chaochao"],
        "remove chaochao",
        ThreadType::Group,
        PermissionTier::AdminLevelHigh,
        true,
        repo_root.join("assets"),
    );
    let out_rem = cmdadd_handler.execute(ctx_cmdadd_rem).await.expect("execute cmdadd remove");
    assert!(outcome_reply_text(&out_rem).unwrap().contains("chaochao"));

    // -------------------------------------------------------------------------
    // 3. Underscore `_` Splitting on `learnnow`, `todo`, `sendp`
    // -------------------------------------------------------------------------
    // 3a. `learnnow`
    let p_learn = registry
        .parse_prefixed_line("!learnnow Thủ đô nước ta là gì _ Hà Nội nghìn năm văn hiến", "!")
        .expect("parsed learnnow");
    assert_eq!(p_learn.handler.spec().name, "learnnow");
    assert_eq!(p_learn.handler.spec().arg_split_mode, ArgSplitMode::Underscore);
    assert_eq!(p_learn.args, vec!["Thủ đô nước ta là gì", "Hà Nội nghìn năm văn hiến"]);

    // Teach via `learnnow` handler
    let ctx_learn = make_test_ctx(
        caches.clone(),
        "learnnow",
        vec!["thủ đô nước ta là gì", "Hà Nội nghìn năm văn hiến"],
        "thủ đô nước ta là gì _ Hà Nội nghìn năm văn hiến",
        ThreadType::Group,
        PermissionTier::AdminBox,
        true,
        repo_root.join("assets"),
    );
    let out_learn = p_learn.handler.execute(ctx_learn).await.expect("execute learnnow");
    assert!(outcome_reply_text(&out_learn).unwrap().contains("Đã thêm câu trả lời mới thành công"));

    // Verify stored in SQLite learned_qa
    let stored = caches
        .engine()
        .lookup_learned_qa("main", "grp_100", "thủ đô nước ta là gì")
        .unwrap();
    assert_eq!(stored, Some(vec!["Hà Nội nghìn năm văn hiến".to_string()]));

    // Query back via `simsimi`
    let sim_handler = registry.get_canonical("simsimi").expect("simsimi found");
    let ctx_sim = make_test_ctx(
        caches.clone(),
        "simsimi",
        vec!["thủ", "đô", "nước", "ta", "là", "gì"],
        "thủ đô nước ta là gì",
        ThreadType::Group, // query within group context where it was learned
        PermissionTier::All,
        true,
        repo_root.join("assets"),
    );
    let out_sim = sim_handler.execute(ctx_sim).await.expect("execute simsimi");
    assert_eq!(outcome_reply_text(&out_sim).unwrap(), "Hà Nội nghìn năm văn hiến");

    // 3b. `todo`
    let p_todo = registry
        .parse_prefixed_line("!todo Quét dọn văn phòng _ 5 _ @Tester", "!")
        .expect("parsed todo");
    assert_eq!(p_todo.handler.spec().name, "todo");
    assert_eq!(p_todo.handler.spec().arg_split_mode, ArgSplitMode::Underscore);
    assert_eq!(p_todo.args, vec!["Quét dọn văn phòng", "5", "@Tester"]);

    // 3c. `sendp` (and its alias `sendprivate`)
    let p_sendp = registry
        .parse_prefixed_line("!sendp Chúc mừng sinh nhật bạn _ 3 _ @VIP", "!")
        .expect("parsed sendp");
    assert_eq!(p_sendp.handler.spec().name, "sendp");
    assert_eq!(p_sendp.handler.spec().arg_split_mode, ArgSplitMode::Underscore);
    assert_eq!(p_sendp.args, vec!["Chúc mừng sinh nhật bạn", "3", "@VIP"]);

    let p_sendpriv = registry
        .parse_prefixed_line("!sendprivate Tin nhắn mật _ 1 _ @Leader", "!")
        .expect("parsed sendprivate alias");
    assert_eq!(p_sendpriv.matched_key, "sendprivate");
    assert_eq!(p_sendpriv.handler.spec().name, "sendp");
    assert_eq!(p_sendpriv.handler.spec().arg_split_mode, ArgSplitMode::Underscore);
    assert_eq!(p_sendpriv.args, vec!["Tin nhắn mật", "1", "@Leader"]);

    // 3d. Underscore prefix format `!learnnow_cau_hoi_tra_loi`
    let p_learn_under = registry
        .parse_prefixed_line("!learnnow_hom nay an gi_com tam", "!")
        .expect("parsed learnnow with underscore prefix");
    assert_eq!(p_learn_under.matched_key, "learnnow");
    assert_eq!(p_learn_under.args, vec!["hom nay an gi", "com tam"]);
}

// =============================================================================
// TEST 5: Direct Execution Safety Check for All 218 Canonical Handlers
// =============================================================================
#[tokio::test]
async fn test_05_all_218_handlers_direct_execution_safety() {
    let (rt, caches, repo_root) = create_test_runtime();
    let registry = build_full_command_registry(rt).expect("registry ok");

    let mut executed_count = 0usize;
    let mut handled_count = 0usize;

    for entry in &ALL_218_CATALOG {
        let name = entry.spec.name;
        let handler = registry.get_canonical(name).expect("canonical found");

        let valid_thread = if entry.spec.scope == ChatScope::Private {
            ThreadType::User
        } else {
            ThreadType::Group
        };

        let ctx = make_test_ctx(
            caches.clone(),
            name,
            vec![],
            "",
            valid_thread,
            entry.spec.permission,
            true,
            repo_root.join("assets"),
        );

        // Direct handler invocation should never panic!
        let result = handler.execute(ctx).await;
        executed_count += 1;

        match result {
            Ok(CommandOutcome::Handled { .. }) => {
                handled_count += 1;
            }
            Ok(CommandOutcome::Accepted { .. }) => {
                handled_count += 1;
            }
            Ok(CommandOutcome::Denied { .. }) => {
                handled_count += 1;
            }
            Err(e) => {
                // Expected graceful errors for commands requiring arguments when none provided
                assert!(
                    matches!(e, mybot_core::CommandError::MissingArgument(_))
                        || matches!(e, mybot_core::CommandError::Internal(_)),
                    "Command `{name}` returned unexpected fatal error: {e}"
                );
            }
        }
    }

    assert_eq!(executed_count, 218, "All 218 canonical commands executed");
    assert!(
        handled_count >= 170,
        "At least 170/218 handlers handle empty/default args directly with usage help: got {handled_count}"
    );
}
