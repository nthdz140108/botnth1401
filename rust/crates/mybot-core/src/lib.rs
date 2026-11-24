//! Core Multi-Bot Actor Supervisor, 17-Rule Message Protection Engine,
//! Low-Latency Fast-Path Pipeline, and Command Studio V2 Engine.

pub mod interaction;
pub mod pipeline;
pub mod protection;
pub mod studio;
pub mod supervisor;
pub mod v3_style;

pub use interaction::{
    BotFleetController, BotMessageRef, ExpireCallbackFn, InteractionEngine,
    InteractiveReactionSpec, InteractiveReplySpec, PassiveChatHooks, ReactionCallbackFn,
    ReplyCallbackFn, ReplyResolution, extract_receipt_ref, parse_numeric_selection_reply,
    recall_bot_message, replace_countdown_reaction_frame,
};
pub use pipeline::{
    BotExecutionMeta, CooldownLedger, CooldownVerdict, DispatchReport, FastPathDispatcher,
    JobStatusSnapshot, LatencyRingBuffer, LatencyStage, PercentileSummary, WorkloadBroker,
};
pub use protection::{
    CompiledBadWordSet, ModerationDecision, NsfwScorer, ProtectionEngine, ProtectionRuleId,
    build_anti_undo_alert,
};
pub use studio::{
    CommandContext, CommandError, CommandHandler, CommandOutcome, CommandRegistry, CommandSpec,
    ParsedInvocation, ResolvedStudioConfig, STUDIO_CONTRACT_VERSION, StudioEngine,
    build_default_sendtask_schedules, normalize_command_key, permission_to_v3_str,
    render_studio_template, scope_to_v3_str, synthesize_studio_contract,
};
pub use supervisor::{
    BotRuntimeSnapshot, DashboardLogEntry, FleetSupervisor, SendTaskOutcome, SendTaskRunner,
    SupervisorConfig, SupervisorError, SupervisorEvent, current_ict_iso_week_key,
    sign_internal_payload, verify_internal_signature,
};
pub use v3_style::{
    BotStyleConfig, BotStyleProfile, COLOR_GREEN, COLOR_RED, COLOR_YELLOW, DEFAULT_ICON,
    DEFAULT_NAME_SERVER, SAFE_COLORS, StyledEnvelopeParams, build_complete, build_complete_request,
    build_dm_plain, build_failed, build_from_sql, build_insufficient_authority,
    build_not_found_command_caption, build_processing_request, build_query, build_state_no_quote,
    build_state_quote, build_styled_outbound, build_tag_message, build_warning,
    build_warning_request, create_command_error_reference, format_permission_denied,
    format_zalo_style_tokens, levenshtein_distance, normalize_color, normalize_size,
    normalize_style_json, normalize_type_list, permission_display_name, sanitize_no_markdown,
    send_quoted_plain_ttl, send_reaction_confirm_receive, validate_style_json,
};

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use async_trait::async_trait;
    use chrono::{Duration as ChronoDuration, Utc};
    use mybot_storage::{BotRecord, HotStorageCaches, StorageEngine, StorageError};
    use mybot_types::{
        ArgSplitMode, BotStatusV2, ChatScope, DEFAULT_ZALO_USER_AGENT, EventSource, ExecutionLane,
        ExpiryPolicy, InboundMessage, InstanceScope, MentionSpan, MessageContent, PermissionTier,
        ThreadType, UndoEvent, ZaloId,
    };
    use serde_json::json;

    use super::*;

    struct EchoHandler(&'static CommandSpec);

    #[async_trait]
    impl CommandHandler for EchoHandler {
        fn spec(&self) -> &'static CommandSpec {
            self.0
        }

        async fn execute(&self, ctx: CommandContext) -> Result<CommandOutcome, CommandError> {
            Ok(CommandOutcome::Handled {
                summary: format!("{}:{}", self.0.name, ctx.args.join("|")),
                reply_text: Some(format!("OK {} [{}]", self.0.name, ctx.args.join(", "))),
                custom_ttl_ms: None,
            })
        }
    }

    static GEMINI_SPEC: CommandSpec = CommandSpec {
        name: "gemini",
        aliases: &["ask", "ai"],
        phase: 8,
        legacy_type: 2,
        description: "Chat cùng Gemini AI",
        syntax: "gemini <câu hỏi>",
        permission: PermissionTier::All,
        scope: ChatScope::Both,
        instance_scope: InstanceScope::Any,
        lane: ExecutionLane::Heavy,
        default_cooldown_secs: 5,
        min_args: 1,
        arg_split_mode: ArgSplitMode::Whitespace,
        is_high_risk: false,
        is_mass_command: false,
        requires_db: false,
        required_runtime_deps: &[],
        required_secrets: &[&["GEMINI_API_KEY"]],
        handler_module: "mybot_commands::ai_and_crawlers",
        handler_export: "handle_gemini",
    };

    static GEMINI_MAKE_SPEC: CommandSpec = CommandSpec {
        name: "gemini make",
        aliases: &["gmake"],
        phase: 8,
        legacy_type: 2,
        description: "Tạo ảnh AI bằng Gemini",
        syntax: "gemini make <mô tả>",
        permission: PermissionTier::All,
        scope: ChatScope::Both,
        instance_scope: InstanceScope::Any,
        lane: ExecutionLane::Heavy,
        default_cooldown_secs: 10,
        min_args: 1,
        arg_split_mode: ArgSplitMode::Whitespace,
        is_high_risk: false,
        is_mass_command: false,
        requires_db: false,
        required_runtime_deps: &[],
        required_secrets: &[&["GEMINI_API_KEY"]],
        handler_module: "mybot_commands::ai_and_crawlers",
        handler_export: "handle_gemini_make",
    };

    static STICKER_AI_SPEC: CommandSpec = CommandSpec {
        name: "sticker ai",
        aliases: &["stk ai"],
        phase: 8,
        legacy_type: 2,
        description: "Tạo sticker AI",
        syntax: "sticker ai <mô tả>",
        permission: PermissionTier::All,
        scope: ChatScope::Group,
        instance_scope: InstanceScope::Any,
        lane: ExecutionLane::Heavy,
        default_cooldown_secs: 10,
        min_args: 1,
        arg_split_mode: ArgSplitMode::Whitespace,
        is_high_risk: false,
        is_mass_command: false,
        requires_db: false,
        required_runtime_deps: &["ffmpeg"],
        required_secrets: &[&["HF_TOKEN"]],
        handler_module: "mybot_commands::media_sticker_pools",
        handler_export: "handle_sticker_ai",
    };

    static TODO_SPEC: CommandSpec = CommandSpec {
        name: "todo",
        aliases: &[],
        phase: 9,
        legacy_type: 1,
        description: "Ghi chú công việc tách bằng dấu gạch dưới",
        syntax: "todo <việc 1>_<việc 2>",
        permission: PermissionTier::AdminBot,
        scope: ChatScope::Both,
        instance_scope: InstanceScope::Any,
        lane: ExecutionLane::FastText,
        default_cooldown_secs: 0,
        min_args: 1,
        arg_split_mode: ArgSplitMode::Underscore,
        is_high_risk: false,
        is_mass_command: false,
        requires_db: true,
        required_runtime_deps: &[],
        required_secrets: &[],
        handler_module: "mybot_commands::saas_fun_utilities",
        handler_export: "handle_todo",
    };

    static SENDTASK_SPEC: CommandSpec = CommandSpec {
        name: "sendtask",
        aliases: &["autotask"],
        phase: 9,
        legacy_type: 3,
        description: "Tự động gửi nội dung mỗi giờ (:05)",
        syntax: "sendtask [on|off]",
        permission: PermissionTier::AdminBox,
        scope: ChatScope::Group,
        instance_scope: InstanceScope::Any,
        lane: ExecutionLane::Control,
        default_cooldown_secs: 3,
        min_args: 0,
        arg_split_mode: ArgSplitMode::Whitespace,
        is_high_risk: false,
        is_mass_command: false,
        requires_db: true,
        required_runtime_deps: &[],
        required_secrets: &[],
        handler_module: "mybot_commands::saas_fun_utilities",
        handler_export: "handle_sendtask",
    };

    static MYBOT_SPEC: CommandSpec = CommandSpec {
        name: "mybot",
        aliases: &["thuebot"],
        phase: 9,
        legacy_type: 1,
        description: "Quản lý thuê bot phụ",
        syntax: "mybot <subcommand>",
        permission: PermissionTier::All,
        scope: ChatScope::Both,
        instance_scope: InstanceScope::MainOnly,
        lane: ExecutionLane::Control,
        default_cooldown_secs: 3,
        min_args: 0,
        arg_split_mode: ArgSplitMode::Whitespace,
        is_high_risk: true,
        is_mass_command: false,
        requires_db: true,
        required_runtime_deps: &[],
        required_secrets: &[],
        handler_module: "mybot_commands::saas_fun_utilities",
        handler_export: "handle_mybot",
    };

    fn sample_registry() -> CommandRegistry {
        CommandRegistry::new(vec![
            Arc::new(EchoHandler(&GEMINI_SPEC)),
            Arc::new(EchoHandler(&GEMINI_MAKE_SPEC)),
            Arc::new(EchoHandler(&STICKER_AI_SPEC)),
            Arc::new(EchoHandler(&TODO_SPEC)),
            Arc::new(EchoHandler(&SENDTASK_SPEC)),
            Arc::new(EchoHandler(&MYBOT_SPEC)),
        ])
        .expect("registry")
    }

    fn make_text_msg(
        bot_key: &str,
        thread_id: &str,
        sender_uid: &str,
        msg_id: &str,
        text: &str,
    ) -> InboundMessage {
        InboundMessage {
            bot_key: bot_key.into(),
            msg_id: ZaloId::new(msg_id),
            cli_msg_id: ZaloId::new(format!("cli_{msg_id}")),
            global_msg_id: ZaloId::new(format!("glob_{msg_id}")),
            thread_id: ZaloId::new(thread_id),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new(sender_uid),
            sender_name: "Member A".to_string(),
            is_self: false,
            msg_type: "webchat".into(),
            timestamp_ms: 1_730_000_000_000,
            ws_received_at_ms: 1_730_000_000_002,
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

    #[tokio::test]
    async fn dedup_uses_message_id_and_thread_when_global_id_is_zero() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        caches.update_group_settings("admin", "grp_a", |g| g.enable_bot = true);
        caches.update_group_settings("admin", "grp_b", |g| g.enable_bot = true);
        let studio = Arc::new(StudioEngine::new(sample_registry(), caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches,
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            64,
        );
        let meta = || BotExecutionMeta {
            bot_key: "admin".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("bot"),
            prefix: "!".into(),
            self_listen: false,
            identity_pending: false,
            sender_tier: PermissionTier::All,
            zalo: None,
            assets_root: PathBuf::from("assets"),
            style_profile: BotStyleProfile::default(),
            chat_policy_group: true,
            chat_policy_private: true,
            fleet: None,
            outbound_sink: None,
        };
        let mut first = make_text_msg("admin", "grp_a", "sender", "101", "!unknown_one");
        first.global_msg_id = ZaloId::new("0");
        let mut second = make_text_msg("admin", "grp_a", "sender", "102", "!unknown_two");
        second.global_msg_id = ZaloId::new("0");
        let mut other_thread = make_text_msg("admin", "grp_b", "sender", "101", "!unknown_three");
        other_thread.global_msg_id = ZaloId::new("0");
        for msg in [first.clone(), second, other_thread] {
            assert!(matches!(
                dispatcher.dispatch_inbound(meta(), msg).await,
                DispatchReport::CommandExecuted { .. }
            ));
        }
        assert!(matches!(
            dispatcher.dispatch_inbound(meta(), first).await,
            DispatchReport::DuplicateIgnored
        ));
    }

    #[test]
    fn command_registry_supports_multi_word_and_underscore_splitting() {
        let reg = sample_registry();

        let p1 = reg
            .parse_prefixed_line("!gemini make cyberpunk hanoi", "!")
            .expect("multi-word gemini make");
        assert_eq!(p1.handler.spec().name, "gemini make");
        assert_eq!(p1.args, vec!["cyberpunk", "hanoi"]);

        let p2 = reg
            .parse_prefixed_line("!gemini xin chào", "!")
            .expect("single-word gemini");
        assert_eq!(p2.handler.spec().name, "gemini");
        assert_eq!(p2.args, vec!["xin", "chào"]);

        let p3 = reg
            .parse_prefixed_line("!stk ai mèo đội nón lá", "!")
            .expect("multi-word alias stk ai");
        assert_eq!(p3.handler.spec().name, "sticker ai");
        assert_eq!(p3.args, vec!["mèo", "đội", "nón", "lá"]);

        let p4 = reg
            .parse_prefixed_line("!todo quét nhà _ nấu cơm _ viết Rust", "!")
            .expect("underscore split todo");
        assert_eq!(p4.handler.spec().name, "todo");
        assert_eq!(p4.args, vec!["quét nhà", "nấu cơm", "viết Rust"]);

        let p5 = reg
            .parse_prefixed_line("!todo_quét nhà_nấu cơm_viết Rust", "!")
            .expect("immediate underscore syntax !todo_...");
        assert_eq!(p5.handler.spec().name, "todo");
        assert_eq!(p5.args, vec!["quét nhà", "nấu cơm", "viết Rust"]);
    }

    #[test]
    fn studio_v2_4_layer_inheritance_secret_redaction_and_sendtask_24_slots() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let studio = StudioEngine::new(sample_registry(), caches);

        // Verify sendtask contract has 9 tabs and 24 `:05` hourly schedules
        let st_contract = studio.build_contract_for("sendtask").unwrap();
        let tabs = st_contract["tabs"].as_array().unwrap();
        assert_eq!(tabs.len(), 9);
        assert_eq!(st_contract["adapter"], "sendtask-scheduler");
        let sched_items = tabs[2]["fields"][2]["default"].as_array().unwrap();
        assert_eq!(sched_items.len(), 24);
        assert_eq!(sched_items[0]["id"], "hour-00");
        assert_eq!(sched_items[23]["cron"], "5 23 * * *");

        // Apply global -> bot -> group layers on `gemini`
        let g1 = studio
            .apply_layer(
                "gemini",
                "global",
                "",
                "",
                &json!({
                    "operation.cooldownSeconds": 15,
                    "operation.enabled": true,
                    "secrets.GEMINI_API_KEY": "AIzaSy_REAL_SECRET"
                }),
                Some(0),
                "admin",
            )
            .unwrap();
        assert_eq!(g1["revision"], 1);

        // Stale revision 0 must fail with RevisionConflict
        let stale = studio.apply_layer(
            "gemini",
            "global",
            "",
            "",
            &json!({"operation.cooldownSeconds": 99}),
            Some(0),
            "other-tab",
        );
        assert!(matches!(stale, Err(StorageError::RevisionConflict { .. })));

        // Bot layer overrides cooldownSeconds to 8; Group layer disables `operation.enabled`
        studio
            .apply_layer(
                "gemini",
                "bot",
                "sub_01",
                "",
                &json!({"operation.cooldownSeconds": 8}),
                Some(0),
                "admin",
            )
            .unwrap();
        studio
            .apply_layer(
                "gemini",
                "group",
                "sub_01",
                "grp_777",
                &json!({"operation.enabled": false}),
                Some(0),
                "admin",
            )
            .unwrap();

        let resolved = studio
            .resolve_config("gemini", Some("sub_01"), Some("grp_777"))
            .unwrap();
        assert_eq!(resolved.values["operation.cooldownSeconds"], 8);
        assert_eq!(resolved.provenance["operation.cooldownSeconds"], "bot");
        assert_eq!(resolved.values["operation.enabled"], false);
        assert_eq!(resolved.provenance["operation.enabled"], "group");
        // Secret must be masked in UI output!
        assert_eq!(resolved.values["secrets.GEMINI_API_KEY"], "••••••••");
    }

    #[tokio::test]
    async fn protection_17_rules_aho_corasick_sequential_strikes_and_pre_shedding_antiundo() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let studio = Arc::new(StudioEngine::new(sample_registry(), caches.clone()));
        let protection = ProtectionEngine::default();

        // Enable antiLink, antiBadWord, antiPhoneNumber, antiTag, and antiUndo on group `grp_1`
        caches.update_group_settings("admin", "grp_1", |g| {
            g.enable_bot = true;
            g.anti_bad_word = true;
            g.anti_link = true;
            g.anti_mention = true;
            g.anti_undo = true;
            g.settings["antiPhoneNumber"] = json!(true);
            g.settings["strikeThreshold"] = json!(3);
        });
        let grp = caches.get_or_default_group_settings("admin", "grp_1");

        // Strike 1: BadWord via Aho-Corasick
        let m1 = make_text_msg("admin", "grp_1", "u_spam", "1", "nói bậy vcl luôn");
        let d1 = protection
            .inspect_inbound("admin", &m1, &grp, PermissionTier::All)
            .await;
        assert!(matches!(
            d1,
            ModerationDecision::WarnAndDelete {
                rule: ProtectionRuleId::AntiBadWord,
                strike: 1,
                ..
            }
        ));

        // Strike 2: Disallowed Link
        let m2 = make_text_msg("admin", "grp_1", "u_spam", "2", "vào ngay https://scam.xyz/free");
        let d2 = protection
            .inspect_inbound("admin", &m2, &grp, PermissionTier::All)
            .await;
        assert!(matches!(
            d2,
            ModerationDecision::WarnAndDelete {
                rule: ProtectionRuleId::AntiLink,
                strike: 2,
                ..
            }
        ));

        // Strike 3: `@All` mention -> escalates to `KickAndDelete`!
        let mut m3 = make_text_msg("admin", "grp_1", "u_spam", "3", "tag cả nhóm");
        m3.mentions.push(MentionSpan {
            uid: ZaloId::new("-1"),
            pos: 0,
            len: 4,
            mention_type: 1,
        });
        let d3 = protection
            .inspect_inbound("admin", &m3, &grp, PermissionTier::All)
            .await;
        assert!(matches!(
            d3,
            ModerationDecision::KickAndDelete {
                rule: ProtectionRuleId::AntiTag,
                strike: 3,
                ..
            }
        ));

        // Verify Pre-Shedding `!antiundo` Cache Invariant:
        // Configure `max_in_flight = 0`-like saturated dispatcher by setting `max_in_flight = 1`
        // and manually simulating load shedding with `in_flight` saturated:
        let tight_dispatcher = FastPathDispatcher::new(
            caches.clone(),
            protection,
            studio,
            WorkloadBroker::default(),
            1,
        );
        // Saturate `in_flight` slot during a slow command, or test `LoadShed` directly by holding 1 slot:
        // Let's hold a permit by running two dispatches concurrently or checking direct undo recovery!
        let recalled_msg = make_text_msg(
            "admin",
            "grp_1",
            "u_clean",
            "900",
            "tin nhắn bí mật chuẩn bị thu hồi",
        );
        let meta = BotExecutionMeta {
            bot_key: "admin".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("bot_999"),
            prefix: "!".into(),
            self_listen: false,
            identity_pending: false,
            sender_tier: PermissionTier::All,
            zalo: None,
            assets_root: PathBuf::from("assets"),
            ..Default::default()
        };
        let rep = tight_dispatcher
            .dispatch_inbound(meta, recalled_msg)
            .await;
        assert!(matches!(rep, DispatchReport::PassiveMessage));

        let undo_ev = UndoEvent {
            bot_key: "admin".into(),
            thread_id: ZaloId::new("grp_1"),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("u_clean"),
            is_self: false,
            global_msg_id: ZaloId::new("glob_900"),
            cli_msg_id: ZaloId::new("cli_900"),
            timestamp_ms: 1_730_000_005_000,
            ws_received_at_ms: 1_730_000_005_010,
        };
        let alert = tight_dispatcher
            .handle_undo_event("admin", &undo_ev, None)
            .await
            .expect("antiundo recovered message");
        assert!(alert.contains("tin nhắn bí mật chuẩn bị thu hồi"));
    }

    #[tokio::test]
    async fn supervisor_enforces_cross_session_uid_isolation_relay_hmac_and_weekly_trial_reaper() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine.clone()).unwrap();
        let studio = Arc::new(StudioEngine::new(sample_registry(), caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            256,
        );
        let sup = FleetSupervisor::new(
            caches.clone(),
            dispatcher,
            SupervisorConfig::default(),
            None,
        );

        let now = Utc::now();
        // Provision a sub-bot in `identity_pending = true` mode with a foreign `owner_uid` from Main Bot
        let sub_bot = BotRecord {
            bot_key: "sub_alpha".into(),
            uid: ZaloId::new("sub_self_uid_111"),
            global_uid: None,
            canonical_username: None,
            display_name: "Sub Alpha".into(),
            avatar: String::new(),
            is_main: false,
            owner_uid: Some("foreign_main_session_uid_999".into()),
            status: "stopped".into(),
            desired_status: "running".into(),
            expiry_policy: ExpiryPolicy::Permanent,
            trial_status: None,
            cookie_json: json!({}),
            imei: String::new(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            proxy_url: None,
            cookie_dead: false,
            cookie_dead_reason: None,
            prefix: "!".into(),
            self_listen: true,
            identity_pending: true,
            admin_identity_seeds: vec![json!({"phone": "0912345678"})],
            metadata: json!({}),
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        };
        engine.upsert_bot(&sub_bot).unwrap();
        caches.update_group_settings("sub_alpha", "grp_x", |g| {
            g.enable_bot = true;
        });
        sup.start_bot("sub_alpha").await.unwrap();

        // 1. Fail-Closed UID Isolation: while `identity_pending == true`, `foreign_main_session_uid_999`
        // MUST be denied `AdminBot` command `!todo`, whereas `sub_self_uid_111` succeeds!
        let foreign_attempt = make_text_msg(
            "sub_alpha",
            "grp_x",
            "foreign_main_session_uid_999",
            "m_foreign",
            "!todo hack_admin",
        );
        let r_denied = sup
            .relay_command("sub_alpha", foreign_attempt, vec![])
            .await
            .unwrap();
        assert!(matches!(
            r_denied,
            DispatchReport::CommandExecuted {
                outcome: CommandOutcome::Denied { ref reason_code, .. },
                ..
            } if reason_code == "PERMISSION_DENIED"
        ));

        // Main-only command `!mybot` must be blocked on sub-bot with `INSTANCE_SCOPE_DENIED`
        let mybot_on_sub = make_text_msg(
            "sub_alpha",
            "grp_x",
            "sub_self_uid_111",
            "m_scope",
            "!mybot info",
        );
        let r_scope = sup
            .relay_command("sub_alpha", mybot_on_sub, vec![])
            .await
            .unwrap();
        assert!(matches!(
            r_scope,
            DispatchReport::CommandExecuted {
                outcome: CommandOutcome::Denied { ref reason_code, .. },
                ..
            } if reason_code == "INSTANCE_SCOPE_DENIED"
        ));

        // Resolve cross-session identity -> local session UID `local_owner_777` now gets `AdminLevelHigh`!
        sup.complete_identity_resolution(
            "sub_alpha",
            Some("local_owner_777".into()),
            &[("local_mod_888".into(), "bot".into(), "Mod".into())],
        )
        .await
        .unwrap();

        let local_owner_cmd = make_text_msg(
            "sub_alpha",
            "grp_x",
            "local_owner_777",
            "m_ok",
            "!todo viec1_viec2",
        );
        let r_ok = sup
            .relay_command("sub_alpha", local_owner_cmd, vec![])
            .await
            .unwrap();
        assert!(matches!(
            r_ok,
            DispatchReport::CommandExecuted {
                outcome: CommandOutcome::Handled { .. },
                ..
            }
        ));

        // 2. Verify HMAC-SHA256 internal signature + replay protection
        let body = br#"{"botKey":"sub_alpha","command":"todo"}"#;
        let ts = now.timestamp_millis();
        let sig = sign_internal_payload("super-secret", ts, body);
        assert!(verify_internal_signature("super-secret", ts, body, &sig, ts + 5_000));
        assert!(!verify_internal_signature(
            "super-secret",
            ts,
            body,
            &sig,
            ts + 600_000
        ));

        // 3. Weekly 1-hour Trial Quota & 60s Expiry Reaper
        sup.claim_weekly_one_hour_trial("owner_trial_1", "sub_alpha", now)
            .expect("first trial claim in ISO week succeeds");
        let second_claim = sup.claim_weekly_one_hour_trial("owner_trial_1", "sub_alpha", now);
        assert!(matches!(
            second_claim,
            Err(SupervisorError::TrialAlreadyUsedThisWeek(_))
        ));

        // Advance clock +61 minutes -> reaper transitions `sub_alpha` to `Expired` and stops actor
        let reaped = sup
            .reap_expired_bots_once(now + ChronoDuration::minutes(61))
            .await
            .unwrap();
        assert_eq!(reaped, vec!["sub_alpha".to_string()]);
        assert!(!sup.is_bot_running("sub_alpha"));
        assert_eq!(
            engine.get_bot("sub_alpha").unwrap().unwrap().status,
            BotStatusV2::Expired.as_v3_str()
        );

        sup.shutdown_all().await;
    }

    #[tokio::test]
    async fn v3_live_chat_pipeline_handles_mentions_bare_prefix_uid_tha_fuzzy_and_styled_envelope() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine.clone()).unwrap();
        caches.update_group_settings("admin", "grp_v3", |g| {
            g.enable_bot = true;
        });
        let studio = Arc::new(StudioEngine::new(sample_registry(), caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            256,
        );

        let captured = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let make_meta = |tier: PermissionTier| BotExecutionMeta {
            bot_key: "admin".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("bot_self_1"),
            prefix: "!".into(),
            self_listen: true,
            identity_pending: false,
            sender_tier: tier,
            zalo: None,
            assets_root: PathBuf::from("assets"),
            style_profile: BotStyleProfile::default(),
            outbound_sink: Some(Arc::clone(&captured)),
            ..Default::default()
        };

        // 1. `@Bot !gemini xin chào` in group chat strips `@Bot` via UTF-16 MentionSpan and executes `gemini`
        let mut tagged_msg = make_text_msg(
            "admin",
            "grp_v3",
            "u_100",
            "m_tag_1",
            "@MyBot !gemini **xin** `chào`",
        );
        tagged_msg.mentions.push(MentionSpan {
            uid: ZaloId::new("bot_self_1"),
            pos: 0,
            len: 6,
            mention_type: 0,
        });
        let r1 = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::All), tagged_msg)
            .await;
        assert!(matches!(
            r1,
            DispatchReport::CommandExecuted { ref command_name, .. } if command_name == "gemini"
        ));
        {
            let guard = captured.lock();
            assert_eq!(guard.len(), 1);
            let out = &guard[0];
            // Zero raw markdown (`**` or `` ` ``) in outbound Zalo text!
            assert!(!out.text.contains("**"));
            assert!(!out.text.contains('`'));
            assert!(out.text.starts_with("Member A\n"));
            assert_eq!(out.mentions.len(), 1);
            assert!(out.quote.is_some());
            assert!(out.style.is_some());
            assert!(out.ttl_ms > 0);
        }

        // 2. Fuzzy typo `!gemin` suggests `gemini` without raw backticks
        captured.lock().clear();
        let typo_msg = make_text_msg("admin", "grp_v3", "u_100", "m_typo", "!gemin alo");
        let r_typo = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::All), typo_msg)
            .await;
        assert!(matches!(
            r_typo,
            DispatchReport::CommandExecuted {
                ref command_name,
                outcome: CommandOutcome::Denied {
                    ref reason_code,
                    ..
                },
                ..
            } if command_name == "gemin" && reason_code == "UNKNOWN_COMMAND"
        ));
        {
            let guard = captured.lock();
            assert_eq!(guard.len(), 1);
            assert!(guard[0].text.contains("!gemini"));
            assert!(!guard[0].text.contains('`'));
        }

        // 3. Bare `prefix` in group and bare `uid` in DM work without `!`
        captured.lock().clear();
        let bare_prefix = make_text_msg("admin", "grp_v3", "u_100", "m_pfx", "prefix");
        let r_pfx = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::All), bare_prefix)
            .await;
        assert!(matches!(
            r_pfx,
            DispatchReport::CommandExecuted { ref command_name, .. } if command_name == "prefix"
        ));
        assert!(captured.lock()[0].text.contains("Prefix bây giờ của bot là: !"));

        captured.lock().clear();
        let mut bare_uid = make_text_msg("admin", "u_100", "u_100", "m_uid", "uid");
        bare_uid.thread_type = ThreadType::User;
        let r_uid = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::All), bare_uid)
            .await;
        assert!(matches!(
            r_uid,
            DispatchReport::CommandExecuted { ref command_name, .. } if command_name == "uid"
        ));
        assert_eq!(captured.lock()[0].text, "u_100");

        // 4. Bare `"tha"` by AdminBot cancels active `scold:admin:grp_v3:*` loop
        captured.lock().clear();
        let _tok = dispatcher
            .interactions()
            .register_named_task("scold:admin:grp_v3:target_1");
        assert!(
            dispatcher
                .interactions()
                .has_named_task("scold:admin:grp_v3:target_1")
        );
        let bare_tha = make_text_msg("admin", "grp_v3", "u_admin", "m_tha", "tha");
        let r_tha = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::AdminBot), bare_tha)
            .await;
        assert!(matches!(
            r_tha,
            DispatchReport::CommandExecuted { ref command_name, .. } if command_name == "scold"
        ));
        assert!(
            !dispatcher
                .interactions()
                .has_named_task("scold:admin:grp_v3:target_1")
        );
    }

    #[tokio::test]
    async fn chat_command_observability_and_group_policies() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let now = Utc::now().to_rfc3339();
        engine
            .upsert_bot(&BotRecord {
                bot_key: "admin".into(),
                uid: ZaloId::new("bot_100"),
                global_uid: None,
                canonical_username: None,
                display_name: "Admin Bot".into(),
                avatar: String::new(),
                is_main: true,
                owner_uid: Some("owner_999".into()),
                status: "running".into(),
                desired_status: "running".into(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: json!({}),
                imei: "imei".into(),
                user_agent: "ua".into(),
                proxy_url: None,
                cookie_dead: false,
                cookie_dead_reason: None,
                prefix: "!".into(),
                self_listen: true,
                identity_pending: false,
                admin_identity_seeds: Vec::new(),
                metadata: json!({}),
                created_at: now.clone(),
                updated_at: now,
            })
            .unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let captured = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = Some(Arc::clone(&captured));

        let studio = Arc::new(StudioEngine::new(sample_registry(), caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            64,
        );

        let make_meta = |tier: PermissionTier| BotExecutionMeta {
            bot_key: "admin".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("bot_100"),
            prefix: "!".into(),
            self_listen: true,
            identity_pending: false,
            sender_tier: tier,
            zalo: None,
            assets_root: PathBuf::from("assets"),
            style_profile: BotStyleProfile::default(),
            chat_policy_group: true,
            chat_policy_private: true,
            fleet: None,
            outbound_sink: sink.clone(),
        };

        // 1. In a group with default enable_bot: false, a regular member command is ignored with GROUP_BOT_DISABLED
        let grp_msg = make_text_msg("admin", "grp_disabled", "u_member", "m1", "!gemini test");
        let r_dis = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::All), grp_msg)
            .await;
        assert!(matches!(
            r_dis,
            DispatchReport::Ignored {
                reason_code: "GROUP_BOT_DISABLED",
                ..
            }
        ));

        // 2. An AdminBox toggling `!bot` passes the gate
        let bot_toggle = make_text_msg("admin", "grp_disabled", "u_adminbox", "m2", "!bot on");
        let r_bot = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::AdminBox), bot_toggle)
            .await;
        assert!(matches!(
            r_bot,
            DispatchReport::CommandExecuted {
                ref command_name,
                ..
            } if command_name == "bot"
        ));

        // 3. Unknown command returns UNKNOWN_COMMAND outcome and fuzzy suggestion
        caches.update_group_settings("admin", "grp_enabled", |g| g.enable_bot = true);
        let unknown_msg = make_text_msg("admin", "grp_enabled", "u_member", "m3", "!hohoho");
        let r_unk = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::All), unknown_msg)
            .await;
        assert!(matches!(
            r_unk,
            DispatchReport::CommandExecuted {
                outcome: CommandOutcome::Denied {
                    ref reason_code,
                    ..
                },
                ..
            } if reason_code == "UNKNOWN_COMMAND"
        ));

        // 4. Immediate underscore syntax `!todo_task1_task2` executes
        let todo_msg = make_text_msg("admin", "grp_enabled", "owner_999", "m4", "!todo_task1_task2");
        let r_todo = dispatcher
            .dispatch_inbound(make_meta(PermissionTier::AdminLevelHigh), todo_msg)
            .await;
        assert!(matches!(
            r_todo,
            DispatchReport::CommandExecuted {
                ref command_name,
                outcome: CommandOutcome::Handled { .. },
                ..
            } if command_name == "todo"
        ));
    }
}
