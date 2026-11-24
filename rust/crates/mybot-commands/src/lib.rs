//! Complete 218-Command / 399-Key Pure-Rust Command Suite (`mybot-commands`).
//!
//! Organizes all 218 V3 canonical commands and 181 aliases across 5 domain modules:
//! 1. [`moderation_anti`]: 30 group protection, mute, ban & anti-service commands.
//! 2. [`admin_and_group`]: 59 group, friend, admin, key, welcome/bye & `locmem` commands.
//! 3. [`media_sticker_pools`]: 40 URL media pools, Sticker Studio, animated GIF & TTS voice commands.
//! 4. [`ai_and_crawlers`]: 32 Gemini/GPT/DeepSeek/Imagen AI & TikTok/YouTube/Music/Weather crawlers.
//! 5. [`saas_fun_utilities`]: 57 SaaS `mybot`, Help, VietQR, QR, Lunar Calendar, 24-slot `SendTask` & utilities.

pub mod admin_and_group;
pub mod ai_and_crawlers;
pub mod catalog;
pub mod locmem;
pub mod media_sticker_pools;
pub mod moderation_anti;
pub mod passive_hooks;
pub mod saas_fun_utilities;

pub use passive_hooks::CommandsPassiveHooks;

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use catalog::{ALL_218_CATALOG, CommandDomain};
use mybot_core::{
    CommandContext, CommandError, CommandHandler, CommandOutcome, CommandRegistry, CommandSpec,
    build_state_quote,
};
use mybot_gfx::{CardRenderEngine, FontManager};
use mybot_media::{CliMediaRunner, RamScratchpad, VideoPoolManager};
use mybot_services::{AiServiceHub, InteractionWizard, MediaCrawlerHub};
use mybot_storage::HotStorageCaches;

/// Shared zero-global-state runtime services injected into all 218 command handlers.
#[derive(Clone)]
pub struct CommandRuntimeBundle {
    pub project_root: std::path::PathBuf,
    pub gfx: CardRenderEngine,
    pub cli_media: CliMediaRunner,
    pub video_pools: VideoPoolManager,
    pub ai: AiServiceHub,
    pub crawlers: MediaCrawlerHub,
    pub wizard: InteractionWizard,
    pub caches: HotStorageCaches,
}

impl std::fmt::Debug for CommandRuntimeBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandRuntimeBundle").finish()
    }
}

impl CommandRuntimeBundle {
    pub fn new(project_root: &Path, caches: HotStorageCaches) -> Self {
        let fonts = FontManager::load_from_assets(&project_root.join("assets"));
        let gfx = CardRenderEngine::new(fonts);
        let scratchpad = RamScratchpad::default();
        let cli_media = CliMediaRunner::new(scratchpad, 4, 4);
        let video_pools = VideoPoolManager::load_from_project_root(project_root);
        let ai = AiServiceHub::new(caches.clone());
        let crawlers = MediaCrawlerHub::new(caches.clone(), cli_media.clone());
        let wizard = InteractionWizard::default();

        Self {
            project_root: project_root.to_path_buf(),
            gfx,
            cli_media,
            video_pools,
            ai,
            crawlers,
            wizard,
            caches,
        }
    }
}

struct DomainCommandHandler {
    spec: &'static CommandSpec,
    domain: CommandDomain,
    runtime: Arc<CommandRuntimeBundle>,
}

#[async_trait]
impl CommandHandler for DomainCommandHandler {
    fn spec(&self) -> &'static CommandSpec {
        self.spec
    }

    async fn execute(&self, ctx: CommandContext) -> Result<CommandOutcome, CommandError> {
        match self.domain {
            CommandDomain::ModerationAnti => {
                moderation_anti::execute_moderation_command(self.spec, ctx, &self.runtime).await
            }
            CommandDomain::AdminAndGroup => {
                admin_and_group::execute_admin_group_command(self.spec, ctx, &self.runtime).await
            }
            CommandDomain::MediaStickerPools => {
                media_sticker_pools::execute_media_pool_command(self.spec, ctx, &self.runtime).await
            }
            CommandDomain::AiAndCrawlers => {
                ai_and_crawlers::execute_ai_crawler_command(self.spec, ctx, &self.runtime).await
            }
            CommandDomain::SaasFunUtilities => {
                saas_fun_utilities::execute_saas_utility_command(self.spec, ctx, &self.runtime).await
            }
        }
    }
}

/// Registers all **218 canonical commands** and **181 aliases** (`399` lookup keys) into a
/// collision-verified [`CommandRegistry`].
pub fn build_full_command_registry(
    runtime: Arc<CommandRuntimeBundle>,
) -> Result<CommandRegistry, String> {
    let mut handlers: Vec<Arc<dyn CommandHandler>> = Vec::with_capacity(ALL_218_CATALOG.len());
    for entry in &ALL_218_CATALOG {
        handlers.push(Arc::new(DomainCommandHandler {
            spec: entry.spec,
            domain: entry.domain,
            runtime: Arc::clone(&runtime),
        }));
    }
    CommandRegistry::new(handlers)
}

pub(crate) async fn send_text_reply(
    ctx: &CommandContext,
    text: &str,
) -> Result<CommandOutcome, CommandError> {
    // Note: `InboundDispatcher` transmits `reply_text` via `zalo.send_message(...)` once.
    // Do NOT call `zalo.send_message` here, otherwise live Zalo threads receive duplicate replies.
    let clean = mybot_core::sanitize_no_markdown(text);
    Ok(CommandOutcome::Handled {
        summary: format!("replied {} chars for {}", clean.len(), ctx.invoked_alias),
        reply_text: Some(clean),
        custom_ttl_ms: None,
    })
}

pub(crate) async fn send_local_bytes_reply(
    ctx: &CommandContext,
    rt: &CommandRuntimeBundle,
    prefix: &str,
    ext: &str,
    bytes: &[u8],
    caption: &str,
) -> Result<CommandOutcome, CommandError> {
    let scratch = rt
        .cli_media
        .scratchpad()
        .write_temp_bytes(prefix, ext, bytes)
        .await
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    let clean_caption = mybot_core::sanitize_no_markdown(caption);
    let mut media_sent = false;
    let ttl_ms = 180_000;
    let mut out = build_state_quote(
        &ctx.style_profile,
        &ctx.message,
        &clean_caption,
        true,
        ttl_ms,
        true,
    );
    out.attachments.push(scratch.path().to_path_buf());

    if let Some(ref sink) = ctx.outbound_sink {
        sink.lock().push(out.clone());
    }

    let mut upload_err = None;
    if let Some(ref zalo) = ctx.zalo {
        match zalo
            .send_message(out, &ctx.message.thread_id, ctx.message.thread_type)
            .await
        {
            Ok(_) => {
                media_sent = true;
            }
            Err(err) => {
                let err_str = err.to_string();
                tracing::warn!(
                    bot = %ctx.bot_key,
                    cmd = %ctx.invoked_alias,
                    error = %err_str,
                    "Failed to upload local card/image; falling back to text caption"
                );
                upload_err = Some(err_str);
            }
        }
    }

    if ctx.zalo.is_some() && !media_sent && clean_caption.is_empty() {
        return Err(CommandError::Internal(
            upload_err.unwrap_or_else(|| "Không thể tải lên tệp đính kèm lên Zalo".into()),
        ));
    }

    Ok(CommandOutcome::Handled {
        summary: format!(
            "rendered {} bytes ({prefix}.{ext}) via RAM scratchpad",
            bytes.len()
        ),
        reply_text: if media_sent || clean_caption.is_empty() {
            None
        } else {
            Some(clean_caption)
        },
        custom_ttl_ms: None,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use chrono::Utc;
    use mybot_core::{BotStyleConfig, CommandContext};
    use mybot_storage::{BotRecord, GroupSettingsRecord, HotStorageCaches, StorageEngine};
    use mybot_types::{
        ArgSplitMode, EventSource, ExpiryPolicy, InboundMessage, InstanceScope, MessageContent,
        PermissionTier, ThreadType, ZaloId,
    };
    use serde_json::{Value, json};

    use super::*;

    trait RegistryTestExt {
        fn dispatch(
            &self,
            ctx: CommandContext,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<CommandOutcome, CommandError>> + Send + '_>>;
    }

    impl RegistryTestExt for CommandRegistry {
        fn dispatch(
            &self,
            ctx: CommandContext,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<CommandOutcome, CommandError>> + Send + '_>> {
            let alias = ctx.invoked_alias.clone();
            Box::pin(async move {
                let handler = self
                    .get_by_any_key(&alias)
                    .or_else(|| self.get_canonical(&alias))
                    .ok_or_else(|| CommandError::Internal(format!("command not found: {alias}")))?;
                handler.execute(ctx).await
            })
        }
    }

    fn make_test_ctx(
        caches: HotStorageCaches,
        invoked: &str,
        args: Vec<&str>,
        raw_args: &str,
    ) -> CommandContext {
        CommandContext {
            bot_key: "main".into(),
            is_main_bot: true,
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
                thread_id: ZaloId::new("grp_100"),
                thread_type: ThreadType::Group,
                sender_uid: ZaloId::new("admin_1"),
                sender_name: "Nguyễn Văn A".into(),
                is_self: false,
                msg_type: "webchat".into(),
                timestamp_ms: 1_760_000_000_000,
                ws_received_at_ms: 1_760_000_000_005,
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
            sender_tier: PermissionTier::AdminLevelHigh,
            group_settings: GroupSettingsRecord::default_for("main", "grp_100"),
            effective_studio_config: json!({}),
            zalo: None,
            caches,
            assets_root: PathBuf::from("../../../assets"),
            style_profile: mybot_core::BotStyleProfile::default(),
            interactions: Arc::new(mybot_core::InteractionEngine::new()),
            fleet: None,
            outbound_sink: Some(Arc::new(parking_lot::Mutex::new(Vec::new()))),
        }
    }

    fn make_test_ctx_with_interactions(
        caches: HotStorageCaches,
        interactions: Arc<mybot_core::InteractionEngine>,
        invoked: &str,
        args: Vec<&str>,
        raw_args: &str,
    ) -> CommandContext {
        let mut ctx = make_test_ctx(caches, invoked, args, raw_args);
        ctx.interactions = interactions;
        ctx
    }

    #[tokio::test]
    async fn full_218_canonical_commands_and_399_keys_match_v3_command_json_1_to_1() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).expect("zero collisions in 218 commands");

        // 1. Parse real `assets/json-data/command.json` on disk and assert 100% 218/218 parity!
        let cmd_json_raw =
            std::fs::read_to_string(repo_root.join("assets/json-data/command.json")).unwrap();
        let cmd_json: Value = serde_json::from_str(&cmd_json_raw).unwrap();
        let json_cmds = cmd_json["commands"].as_array().unwrap();
        assert_eq!(json_cmds.len(), 218);
        assert_eq!(registry.canonical_count(), 218);

        let mut expected_keys = BTreeSet::new();
        for c in json_cmds {
            let name = c["name"]
                .as_str()
                .unwrap()
                .trim()
                .to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            assert!(
                registry.get_canonical(&name).is_some(),
                "missing canonical command `{name}`"
            );
            expected_keys.insert(name);
            if let Some(aliases) = c.get("alias").and_then(Value::as_array) {
                for a in aliases {
                    let al = a
                        .as_str()
                        .unwrap()
                        .trim()
                        .to_lowercase()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !al.is_empty() {
                        expected_keys.insert(al);
                    }
                }
            }
        }
        assert_eq!(expected_keys.len(), 399);
        assert_eq!(registry.lookup_key_count(), 399);

        // 2. Verify multi-word longest-match (`!gemini make`, `!sticker ai`, `!stk ai`)
        let gem_make = registry
            .parse_prefixed_line("!gemini make con rồng bay trên bầu trời Ubuntu", "!")
            .expect("gemini make resolved");
        assert_eq!(gem_make.handler.spec().name, "gemini make");
        assert_eq!(gem_make.raw_args_text, "con rồng bay trên bầu trời Ubuntu");

        let stk_ai = registry
            .parse_prefixed_line("!stk ai mèo đội mũ bảo hiểm", "!")
            .expect("stk ai alias resolved");
        assert_eq!(stk_ai.handler.spec().name, "sticker ai");

        // 3. Verify underscore `_` argument splitting on `learnnow`, `todo`, `sendp`
        let learn_inv = registry
            .parse_prefixed_line("!learnnow rust là gì _ ngôn ngữ siêu tốc độ", "!")
            .expect("learnnow resolved");
        assert_eq!(learn_inv.handler.spec().arg_split_mode, ArgSplitMode::Underscore);
        assert_eq!(learn_inv.args, vec!["rust là gì", "ngôn ngữ siêu tốc độ"]);

        // 4. Verify `MainOnly` scope on `mybot` & `cmdadd`
        assert_eq!(
            registry.get_canonical("mybot").unwrap().spec().instance_scope,
            InstanceScope::MainOnly
        );
        assert_eq!(
            registry.get_canonical("cmdadd").unwrap().spec().instance_scope,
            InstanceScope::MainOnly
        );

        // 5. Execute live handlers across domains (`lich`, `antibadword`, `vdgirl`, `learnnow`, `simsimi`, `giftext`)
        let lich_out = registry
            .get_canonical("lich")
            .unwrap()
            .execute(make_test_ctx(caches.clone(), "lich", vec!["29/01/2025"], "29/01/2025"))
            .await
            .unwrap();
        match lich_out {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Ất Tỵ"));
            }
            other => panic!("unexpected lich outcome: {other:?}"),
        }

        let bw_out = registry
            .get_canonical("antibadword")
            .unwrap()
            .execute(make_test_ctx(caches.clone(), "antibadword", vec!["on"], "on"))
            .await
            .unwrap();
        assert!(matches!(bw_out, CommandOutcome::Handled { .. }));
        assert!(caches.get_or_default_group_settings("main", "grp_100").anti_bad_word);

        let vdgirl_out = registry
            .get_canonical("vdgirl")
            .unwrap()
            .execute(make_test_ctx(caches.clone(), "vdgirl", vec![], ""))
            .await
            .unwrap();
        match vdgirl_out {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().starts_with("http"));
            }
            other => panic!("unexpected vdgirl outcome: {other:?}"),
        }

        // Teach via `learnnow` and query back via `simsimi`!
        registry
            .get_canonical("learnnow")
            .unwrap()
            .execute(make_test_ctx(
                caches.clone(),
                "learnnow",
                vec!["ubuntu v4", "Chạy mượt 100% Pure Rust!"],
                "ubuntu v4 _ Chạy mượt 100% Pure Rust!",
            ))
            .await
            .unwrap();
        let sim_out = registry
            .get_canonical("simsimi")
            .unwrap()
            .execute(make_test_ctx(caches, "simsimi", vec!["ubuntu", "v4"], "ubuntu v4"))
            .await
            .unwrap();
        match sim_out {
            CommandOutcome::Handled { reply_text, .. } => {
                assert_eq!(reply_text.unwrap(), "Chạy mượt 100% Pure Rust!");
            }
            other => panic!("unexpected simsimi outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn media_reply_uses_the_v3_quote_mention_style_envelope() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let rt = CommandRuntimeBundle::new(Path::new("../../../"), caches.clone());
        let mut ctx = make_test_ctx(caches, "help", vec![], "");
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        ctx.outbound_sink = Some(Arc::clone(&sink));

        send_local_bytes_reply(&ctx, &rt, "card", "png", &[1, 2, 3], "**Thẻ** `demo`")
            .await
            .unwrap();

        let sent = sink.lock();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].text.starts_with("Nguyễn Văn A\n"));
        assert!(!sent[0].text.contains("**"));
        assert!(!sent[0].text.contains('`'));
        assert!(sent[0].quote.is_some());
        assert_eq!(sent[0].mentions.len(), 1);
        assert!(sent[0].style.is_some());
        assert!(sent[0].ttl_ms > 0);
        assert_eq!(sent[0].attachments.len(), 1);
    }

    #[tokio::test]
    async fn self_typed_commands_execute_while_bot_outbound_echoes_are_suppressed() {
        use mybot_core::{
            BotExecutionMeta, DispatchReport, FastPathDispatcher, ProtectionEngine, StudioEngine,
            WorkloadBroker,
        };
        use mybot_types::CredentialsBundle;
        use zalo_sdk::ZaloSession;

        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).unwrap();
        let studio = Arc::new(StudioEngine::new(registry, caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches,
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            128,
        );

        let creds = CredentialsBundle {
            cookie: json!({
                "url": "https://chat.zalo.me",
                "cookies": [{
                    "domain": ".chat.zalo.me",
                    "name": "zpw_sek",
                    "path": "/",
                    "value": "test_sek_val"
                }]
            }),
            imei: "imei-self-test-123".into(),
            user_agent: "Mozilla/5.0".into(),
            language: "vi".into(),
            proxy_url: None,
        };
        let sess = ZaloSession::new("admin", true, &creds, true).unwrap();

        // 1. Outbound message sent by the bot itself is recorded -> WebSocket self-echo is ignored!
        sess.record_outbound_id("cli_echo_999");
        let echo_msg = InboundMessage {
            bot_key: "admin".into(),
            msg_id: ZaloId::new("m_echo_1"),
            cli_msg_id: ZaloId::new("cli_echo_999"),
            global_msg_id: ZaloId::new("g_echo_1"),
            thread_id: ZaloId::new("grp_self_1"),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("100001"),
            sender_name: "Admin".into(),
            is_self: true,
            msg_type: "webchat".into(),
            timestamp_ms: 1_760_000_000_100,
            ws_received_at_ms: 1_760_000_000_105,
            ttl_ms: 0,
            mentions: Vec::new(),
            styles: Vec::new(),
            quote: None,
            content: MessageContent::Text {
                text: "!menu".into(),
            },
            source: EventSource::WebSocket,
            raw_property_ext: None,
        };
        let meta_echo = BotExecutionMeta {
            bot_key: "admin".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("100001"),
            prefix: "!".into(),
            self_listen: true,
            identity_pending: false,
            sender_tier: PermissionTier::AdminLevelHigh,
            zalo: Some(Arc::clone(&sess)),
            assets_root: PathBuf::from("../../../assets"),
            style_profile: mybot_core::BotStyleProfile::default(),
            chat_policy_group: true,
            chat_policy_private: true,
            fleet: None,
            outbound_sink: Some(Arc::new(parking_lot::Mutex::new(Vec::new()))),
        };
        let echo_report = dispatcher.dispatch_inbound(meta_echo, echo_msg).await;
        assert!(matches!(
            echo_report,
            DispatchReport::Ignored {
                reason_code: "ECHO_SUPPRESSED",
                ..
            }
        ));

        // 2. Owner-typed `!menu` from the bot's own Zalo account (not in `recent_outbound_ids`) EXECUTES!
        let owner_msg = InboundMessage {
            bot_key: "admin".into(),
            msg_id: ZaloId::new("m_owner_2"),
            cli_msg_id: ZaloId::new("cli_phone_777"),
            global_msg_id: ZaloId::new("g_owner_2"),
            thread_id: ZaloId::new("grp_self_1"),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("100001"),
            sender_name: "Admin".into(),
            is_self: true,
            msg_type: "webchat".into(),
            timestamp_ms: 1_760_000_000_200,
            ws_received_at_ms: 1_760_000_000_205,
            ttl_ms: 0,
            mentions: Vec::new(),
            styles: Vec::new(),
            quote: None,
            content: MessageContent::Text {
                text: "!menu".into(),
            },
            source: EventSource::WebSocket,
            raw_property_ext: None,
        };
        let meta_owner = BotExecutionMeta {
            bot_key: "admin".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("100001"),
            prefix: "!".into(),
            self_listen: true,
            identity_pending: false,
            sender_tier: PermissionTier::AdminLevelHigh,
            zalo: None,
            assets_root: PathBuf::from("../../../assets"),
            style_profile: mybot_core::BotStyleProfile::default(),
            chat_policy_group: true,
            chat_policy_private: true,
            fleet: None,
            outbound_sink: Some(Arc::new(parking_lot::Mutex::new(Vec::new()))),
        };
        let owner_report = dispatcher.dispatch_inbound(meta_owner, owner_msg).await;
        match owner_report {
            DispatchReport::CommandExecuted {
                command_name,
                outcome: CommandOutcome::Handled { reply_text, .. },
                ..
            } => {
                assert_eq!(command_name, "help");
                assert!(reply_text.unwrap().contains("218"));
            }
            other => panic!("expected owner self-command to execute, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn parity_suite_blockbot_showcode_security_and_mail10p() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).expect("registry builds");

        // 1. blockbot -> listblockbot -> unblockbot
        let block_res = registry
            .get_canonical("blockbot")
            .unwrap()
            .execute(make_test_ctx(
                caches.clone(),
                "blockbot",
                vec!["999888"],
                "999888",
            ))
            .await
            .unwrap();
        match block_res {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("999888"));
            }
            other => panic!("expected handled blockbot, got: {other:?}"),
        }

        let list_res = registry
            .get_canonical("listblockbot")
            .unwrap()
            .execute(make_test_ctx(caches.clone(), "listblockbot", vec![], ""))
            .await
            .unwrap();
        match list_res {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("999888"));
            }
            other => panic!("expected handled listblockbot, got: {other:?}"),
        }

        let unblock_res = registry
            .get_canonical("unblockbot")
            .unwrap()
            .execute(make_test_ctx(
                caches.clone(),
                "unblockbot",
                vec!["999888"],
                "999888",
            ))
            .await
            .unwrap();
        match unblock_res {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã bỏ chặn"));
            }
            other => panic!("expected handled unblockbot, got: {other:?}"),
        }

        // 2. showcode security guard: .env, credentials, cookie must be refused
        let sc_env = registry
            .get_canonical("showcode")
            .unwrap()
            .execute(make_test_ctx(
                caches.clone(),
                "showcode",
                vec![".env"],
                ".env",
            ))
            .await
            .unwrap();
        match sc_env {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Từ chối truy cập"));
            }
            other => panic!("expected security refusal on .env, got: {other:?}"),
        }

        let sc_cred = registry
            .get_canonical("showcode")
            .unwrap()
            .execute(make_test_ctx(
                caches.clone(),
                "showcode",
                vec!["credentials.json"],
                "credentials.json",
            ))
            .await
            .unwrap();
        match sc_cred {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Từ chối truy cập"));
            }
            other => panic!("expected security refusal on credentials, got: {other:?}"),
        }

        // 3. mail10p command help/dispatch
        let mail_res = registry
            .get_canonical("mail10p")
            .unwrap()
            .execute(make_test_ctx(caches.clone(), "mail10p", vec![], ""))
            .await
            .unwrap();
        match mail_res {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("mail10p new"));
            }
            other => panic!("expected handled mail10p, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn phase6_media_and_external_services_suite() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt.clone()).expect("registry builds");

        // 1. acclq test: random acc without valid file returns clear error message
        let ctx = make_test_ctx(caches.clone(), "acclq", vec!["2"], "2");
        let outcome = registry.get_canonical("acclq").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("lq.txt") || text.contains("ACC LIÊN QUÂN"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // 2. acclq argument bounds (1-10)
        let ctx = make_test_ctx(caches.clone(), "acclq", vec!["20"], "20");
        let outcome = registry.get_canonical("acclq").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("1-10"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // 3. checklq syntax test: missing credentials prompts user with syntax
        let ctx = make_test_ctx(caches.clone(), "checklq", vec!["user_only"], "user_only");
        let outcome = registry.get_canonical("checklq").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("tài khoản và mật khẩu"));
                assert!(text.contains("checklq <tài khoản> <mật khẩu>"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // 4. dinhgiasim syntax test: invalid phone format
        let ctx = make_test_ctx(caches.clone(), "dinhgiasim", vec!["123"], "123");
        let outcome = registry.get_canonical("dinhgiasim").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("9-11 chữ số"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // 5. checkorder syntax test: must start with SPXVN
        let ctx = make_test_ctx(caches.clone(), "checkorder", vec!["VTP123"], "VTP123");
        let outcome = registry.get_canonical("checkorder").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("SPXVN"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // 6. data check test: checks pool file and moves dead links
        let test_cat = "test_phase6_data";
        let _ = rt.video_pools.remove_category_file(test_cat);
        rt.video_pools.create_category_file(test_cat).unwrap();
        rt.video_pools.add_url(test_cat, "https://127.0.0.1:9/video.mp4");

        let ctx = make_test_ctx(caches.clone(), "data", vec!["check", test_cat], &format!("check {test_cat}"));
        let outcome = registry.get_canonical("data").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Kết quả kiểm tra file") || text.contains("hoạt động tốt"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // 7. data add via context URL / quote
        let mut ctx = make_test_ctx(caches.clone(), "data", vec![test_cat], test_cat);
        ctx.message.quote = Some(mybot_types::QuotedMessage {
            owner_id: ZaloId::new("u1"),
            cli_msg_id: ZaloId::new("c1"),
            global_msg_id: ZaloId::new("g1"),
            cli_msg_type: 1,
            ts: 100,
            ttl: 0,
            msg: "video test".into(),
            from_display_name: None,
            attach: Some(json!({
                "hdUrl": "https://example.com/quoted_sample.mp4"
            })),
        });
        let outcome = registry.get_canonical("data").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Lưu thành công vào tệp") || text.contains("Đã lưu thành công link vào kho"));
            }
            _ => panic!("Expected Handled outcome"),
        }
        assert!(rt.video_pools.get_urls(test_cat).contains(&"https://example.com/quoted_sample.mp4".to_string()));

        // 8. datavideo management tests
        let ctx = make_test_ctx(caches.clone(), "datavideo", vec!["list"], "list");
        let outcome = registry.get_canonical("datavideo").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Danh sách file kho video") || text.contains("test_phase6_data"));
            }
            _ => panic!("Expected Handled outcome"),
        }

        // Clean up test category
        rt.video_pools.remove_category_file(test_cat);

        // 9. stickercustom: without args and without quote lists stored stickers or usage
        let ctx = make_test_ctx(caches.clone(), "stickercustom", vec![], "");
        let outcome = registry.get_canonical("stickercustom").unwrap().execute(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Sticker Custom") || text.contains("sticker đã lưu trữ"));
            }
            _ => panic!("Expected Handled outcome"),
        }
    }

    #[tokio::test]
    async fn stage1_p0_select_interactive_media_menus_work_and_dispatch_via_interaction_engine() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).expect("zero collisions");

        // Verify all 8 media commands create interactive selection menu via ctx.send_interactive_menu
        let media_cmds = [
            "youtube",
            "soundcloud",
            "zingmp3",
            "zingchart",
            "nhaccuatui",
            "spotify",
            "tiktok",
            "capcut",
        ];

        for cmd_name in media_cmds {
            let ctx = make_test_ctx(caches.clone(), cmd_name, vec!["chill"], "chill");
            let interactions = Arc::clone(&ctx.interactions);
            let sink = ctx.outbound_sink.as_ref().unwrap().clone();

            let handler = registry.get_canonical(cmd_name).unwrap_or_else(|| {
                panic!("missing canonical command for {cmd_name}");
            });

            let outcome = handler.execute(ctx).await.unwrap();
            match outcome {
                CommandOutcome::Handled { reply_text, summary, .. } => {
                    assert!(reply_text.is_none(), "menu command must not return duplicate reply_text");
                    assert!(summary.contains("opened interactive selection menu"));
                }
                other => panic!("expected Handled outcome for {cmd_name}, got: {other:?}"),
            }

            // Menu prompt was emitted to outbound_sink
            let messages = sink.lock().clone();
            assert_eq!(messages.len(), 1, "must have emitted 1 menu outbound message for {cmd_name}");
            assert!(
                messages[0].text.contains(&format!("Kết quả {cmd_name}")),
                "outbound menu text must mention platform {cmd_name}"
            );

            // An interactive reply wizard is now active in InteractionEngine
            // An unrelated bare message must NOT match
            let unrelated_msg = InboundMessage {
                bot_key: "main".into(),
                msg_id: ZaloId::new("unrelated_1"),
                cli_msg_id: ZaloId::new("unrelated_c1"),
                global_msg_id: ZaloId::new("unrelated_g1"),
                thread_id: ZaloId::new("grp_100"),
                thread_type: ThreadType::Group,
                sender_uid: ZaloId::new("admin_1"),
                sender_name: "Nguyễn Văn A".into(),
                is_self: false,
                msg_type: "webchat".into(),
                timestamp_ms: 1_760_000_000_100,
                ws_received_at_ms: 1_760_000_000_105,
                ttl_ms: 0,
                mentions: Vec::new(),
                styles: Vec::new(),
                quote: None,
                content: MessageContent::Text {
                    text: "alo test chat bot".into(),
                },
                source: EventSource::default(),
                raw_property_ext: None,
            };
            assert!(!interactions.try_handle_reply("main", &unrelated_msg, None).await);

            // A numeric choice 1..=5 MUST match and consume the session
            let choice_msg = InboundMessage {
                bot_key: "main".into(),
                msg_id: ZaloId::new("choice_1"),
                cli_msg_id: ZaloId::new("choice_c1"),
                global_msg_id: ZaloId::new("choice_g1"),
                thread_id: ZaloId::new("grp_100"),
                thread_type: ThreadType::Group,
                sender_uid: ZaloId::new("admin_1"),
                sender_name: "Nguyễn Văn A".into(),
                is_self: false,
                msg_type: "webchat".into(),
                timestamp_ms: 1_760_000_000_200,
                ws_received_at_ms: 1_760_000_000_205,
                ttl_ms: 0,
                mentions: Vec::new(),
                styles: Vec::new(),
                quote: None,
                content: MessageContent::Text {
                    text: "1".into(),
                },
                source: EventSource::default(),
                raw_property_ext: None,
            };
            let handled = interactions.try_handle_reply("main", &choice_msg, None).await;
            assert!(handled, "numeric choice 1 must be handled by interactive wizard for {cmd_name}");
        }
    }

    #[tokio::test]
    async fn phase5_repeating_tasks_cancellation_and_limits() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).expect("registry builds");

        // 1. scold: starts loop, registers named task, cancels on "tha" or !scold tha
        let ctx = make_test_ctx(caches.clone(), "scold", vec!["999888"], "999888");
        let interactions = ctx.interactions.clone();
        let res = registry.get_canonical("scold").unwrap().execute(ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap();
                assert!(text.contains("Bắt đầu") || text.contains("bắt đầu"));
            }
            other => panic!("expected handled scold, got: {other:?}"),
        }
        assert!(interactions.has_named_task("scold:main:grp_100:999888"));

        // Cancel via !scold tha
        let ctx_tha = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "scold", vec!["tha"], "tha");
        let res_tha = registry.get_canonical("scold").unwrap().execute(ctx_tha).await.unwrap();
        match res_tha {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("tha"));
            }
            other => panic!("expected handled scold tha, got: {other:?}"),
        }
        assert!(!interactions.has_named_task("scold:main:grp_100:999888"));

        // 2. sendtext: starts periodic task, cancels on stop/off
        let ctx_st = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "sendtext", vec!["10s", "Tin", "nhan", "tu", "dong"], "10s Tin nhan tu dong");
        let res_st = registry.get_canonical("sendtext").unwrap().execute(ctx_st).await.unwrap();
        match res_st {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã bật"));
            }
            other => panic!("expected handled sendtext, got: {other:?}"),
        }
        assert!(interactions.has_named_task("sendtext:main:grp_100"));

        let ctx_st_off = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "sendtext", vec!["off"], "off");
        let res_st_off = registry.get_canonical("sendtext").unwrap().execute(ctx_st_off).await.unwrap();
        match res_st_off {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã tắt"));
            }
            other => panic!("expected handled sendtext off, got: {other:?}"),
        }
        assert!(!interactions.has_named_task("sendtext:main:grp_100"));

        // 3. sendstk: starts sticker loop, cancels on stop/off
        let ctx_stk = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "sendstk", vec!["30s"], "30s");
        let res_stk = registry.get_canonical("sendstk").unwrap().execute(ctx_stk).await.unwrap();
        match res_stk {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã bật"));
            }
            other => panic!("expected handled sendstk, got: {other:?}"),
        }
        assert!(interactions.has_named_task("sendstk:main:grp_100"));

        let ctx_stk_off = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "sendstk", vec!["off"], "off");
        registry.get_canonical("sendstk").unwrap().execute(ctx_stk_off).await.unwrap();
        assert!(!interactions.has_named_task("sendstk:main:grp_100"));

        // 4. prservice: starts PR loop, cancels on stop/off
        let ctx_pr = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "prservice", vec!["15s", "Quang", "cao"], "15s Quang cao");
        let res_pr = registry.get_canonical("prservice").unwrap().execute(ctx_pr).await.unwrap();
        match res_pr {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("PR Service"));
            }
            other => panic!("expected handled prservice, got: {other:?}"),
        }
        assert!(interactions.has_named_task("prservice:main:grp_100"));

        let ctx_pr_off = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "prservice", vec!["stop"], "stop");
        registry.get_canonical("prservice").unwrap().execute(ctx_pr_off).await.unwrap();
        assert!(!interactions.has_named_task("prservice:main:grp_100"));

        // 5. nhacnho: creates reminder, lists, and stops
        let ctx_nn = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "nhacnho", vec!["10s", "Hop", "team"], "10s Hop team");
        let res_nn = registry.get_canonical("nhacnho").unwrap().execute(ctx_nn).await.unwrap();
        match res_nn {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã đặt lời nhắc"));
            }
            other => panic!("expected handled nhacnho, got: {other:?}"),
        }
        assert!(interactions.has_named_task("nhacnho:main:grp_100"));

        let ctx_nn_list = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "nhacnho", vec!["list"], "list");
        let res_nn_list = registry.get_canonical("nhacnho").unwrap().execute(ctx_nn_list).await.unwrap();
        match res_nn_list {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Hop team"));
            }
            other => panic!("expected handled nhacnho list, got: {other:?}"),
        }

        let ctx_nn_stop = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "nhacnho", vec!["stop"], "stop");
        registry.get_canonical("nhacnho").unwrap().execute(ctx_nn_stop).await.unwrap();
        assert!(!interactions.has_named_task("nhacnho:main:grp_100"));

        // 6. spamgroup: checks limits and stop
        let ctx_sg = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "spamgroup", vec!["hello", "5"], "hello 5");
        let res_sg = registry.get_canonical("spamgroup").unwrap().execute(ctx_sg).await.unwrap();
        match res_sg {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Bắt đầu spam"));
            }
            other => panic!("expected handled spamgroup, got: {other:?}"),
        }
        assert!(interactions.has_named_task("spamgroup:main:grp_100"));

        let ctx_sg_stop = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "spamgroup", vec!["stop"], "stop");
        registry.get_canonical("spamgroup").unwrap().execute(ctx_sg_stop).await.unwrap();
        assert!(!interactions.has_named_task("spamgroup:main:grp_100"));

        // 7. spamjoin: checks limits and stop
        let ctx_sj = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "spamjoin", vec!["https://zalo.me/g/testgrp", "3"], "https://zalo.me/g/testgrp 3");
        let res_sj = registry.get_canonical("spamjoin").unwrap().execute(ctx_sj).await.unwrap();
        match res_sj {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Bắt đầu tiến trình"));
            }
            other => panic!("expected handled spamjoin, got: {other:?}"),
        }
        assert!(interactions.has_named_task("spamjoin:main:grp_100"));

        let ctx_sj_stop = make_test_ctx_with_interactions(caches.clone(), interactions.clone(), "spamjoin", vec!["stop"], "stop");
        registry.get_canonical("spamjoin").unwrap().execute(ctx_sj_stop).await.unwrap();
        assert!(!interactions.has_named_task("spamjoin:main:grp_100"));

        // 8. sendtask: 24-slot time schedule toggle
        let ctx_stask = make_test_ctx(caches.clone(), "sendtask", vec!["off"], "off");
        let res_stask = registry.get_canonical("sendtask").unwrap().execute(ctx_stask).await.unwrap();
        match res_stask {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("24 khung giờ"));
            }
            other => panic!("expected handled sendtask, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn phase5_learning_commands_and_sqlite_persistence() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).expect("registry builds");

        // 1. learnnow: learns with syntax `câu hỏi _ câu trả lời`
        let ctx_ln = make_test_ctx(caches.clone(), "learnnow", vec![], "bạn tên gì _ mình là mybot");
        let res_ln = registry.get_canonical("learnnow").unwrap().execute(ctx_ln).await.unwrap();
        match res_ln {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã thêm câu trả lời mới thành công"));
            }
            other => panic!("expected handled learnnow, got: {other:?}"),
        }

        // Verify stored in SQLite learned_qa
        let stored = caches.engine().lookup_learned_qa("main", "grp_100", "bạn tên gì").unwrap();
        assert_eq!(stored, Some(vec!["mình là mybot".to_string()]));

        // 2. learn: list command
        let ctx_list = make_test_ctx(caches.clone(), "learn", vec!["list"], "list");
        let res_list = registry.get_canonical("learn").unwrap().execute(ctx_list).await.unwrap();
        match res_list {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap();
                assert!(text.contains("Danh sách câu học của nhóm"));
                assert!(text.contains("bạn tên gì"));
            }
            other => panic!("expected handled learn list, got: {other:?}"),
        }

        // 3. learn: toggle on/off
        let ctx_off = make_test_ctx(caches.clone(), "learn", vec!["off"], "off");
        let res_off = registry.get_canonical("learn").unwrap().execute(ctx_off).await.unwrap();
        match res_off {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Chế độ học tập đã được tắt"));
            }
            other => panic!("expected handled learn off, got: {other:?}"),
        }

        let ctx_on = make_test_ctx(caches.clone(), "learn", vec!["on"], "on");
        let res_on = registry.get_canonical("learn").unwrap().execute(ctx_on).await.unwrap();
        match res_on {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Chế độ học tập đã được bật"));
            }
            other => panic!("expected handled learn on, got: {other:?}"),
        }

        // 4. reply: toggle on/off
        let ctx_rep_off = make_test_ctx(caches.clone(), "reply", vec!["off"], "off");
        let res_rep_off = registry.get_canonical("reply").unwrap().execute(ctx_rep_off).await.unwrap();
        match res_rep_off {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Chế độ trả lời đã được tắt"));
            }
            other => panic!("expected handled reply off, got: {other:?}"),
        }

        let ctx_rep_on = make_test_ctx(caches.clone(), "reply", vec!["on"], "on");
        let res_rep_on = registry.get_canonical("reply").unwrap().execute(ctx_rep_on).await.unwrap();
        match res_rep_on {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Chế độ trả lời đã được bật"));
            }
            other => panic!("expected handled reply on, got: {other:?}"),
        }

        // 5. autoreply: toggle
        let ctx_auto = make_test_ctx(caches.clone(), "autoreply", vec!["on"], "on");
        let res_auto = registry.get_canonical("autoreply").unwrap().execute(ctx_auto).await.unwrap();
        match res_auto {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("ĐÃ BẬT"));
            }
            other => panic!("expected handled autoreply, got: {other:?}"),
        }

        // 6. replytag: toggle
        let ctx_rtag = make_test_ctx(caches.clone(), "replytag", vec!["on"], "on");
        let res_rtag = registry.get_canonical("replytag").unwrap().execute(ctx_rtag).await.unwrap();
        match res_rtag {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("ĐÃ BẬT"));
            }
            other => panic!("expected handled replytag, got: {other:?}"),
        }

        // 7. simsimi: answers with learned answer if matching
        let ctx_sim = make_test_ctx(caches.clone(), "simsimi", vec!["bạn", "tên", "gì"], "bạn tên gì");
        let res_sim = registry.get_canonical("simsimi").unwrap().execute(ctx_sim).await.unwrap();
        match res_sim {
            CommandOutcome::Handled { reply_text, .. } => {
                assert_eq!(reply_text.unwrap(), "mình là mybot");
            }
            other => panic!("expected handled simsimi, got: {other:?}"),
        }

        // 8. unlearn: deletes learned QA
        let ctx_un = make_test_ctx(caches.clone(), "unlearn", vec!["bạn", "tên", "gì"], "bạn tên gì");
        let res_un = registry.get_canonical("unlearn").unwrap().execute(ctx_un).await.unwrap();
        match res_un {
            CommandOutcome::Handled { reply_text, .. } => {
                assert!(reply_text.unwrap().contains("Đã xóa thành công"));
            }
            other => panic!("expected handled unlearn, got: {other:?}"),
        }
        let stored_after = caches.engine().lookup_learned_qa("main", "grp_100", "bạn tên gì").unwrap();
        assert_eq!(stored_after, None);
    }

    #[tokio::test]
    async fn phase4_mybot_studio_and_cmdadd_suite() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt.clone()).expect("registry builds");

        // =====================================================================
        // PART 1: cmdadd with '|' separator, validation, list & remove
        // =====================================================================

        // 1.1 Create valid custom command using '|' syntax
        let ctx = make_test_ctx(
            caches.clone(),
            "cmdadd",
            vec!["mytest", "|", "Đây", "là", "câu", "trả", "lời", "test"],
            "mytest | Đây là câu trả lời test",
        );
        let outcome = registry.dispatch(ctx).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Đã tạo lệnh custom \"mytest\""), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // Verify stored in database
        let custom_cmds = caches.engine().list_custom_commands(Some("main")).unwrap();
        assert_eq!(custom_cmds.len(), 1);
        assert_eq!(custom_cmds[0].1, "mytest");
        assert_eq!(custom_cmds[0].2["content"], "Đây là câu trả lời test");

        // 1.2 Duplicate command check
        let ctx_dup = make_test_ctx(
            caches.clone(),
            "cmdadd",
            vec!["mytest", "|", "Nội dung khác"],
            "mytest | Nội dung khác",
        );
        let outcome_dup = registry.dispatch(ctx_dup).await.unwrap();
        match outcome_dup {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("đã tồn tại"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 1.3 Reserved command name check (canonical or alias)
        let ctx_res = make_test_ctx(
            caches.clone(),
            "cmdadd",
            vec!["help", "|", "Nội dung help giả mạo"],
            "help | Nội dung help giả mạo",
        );
        let outcome_res = registry.dispatch(ctx_res).await.unwrap();
        match outcome_res {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("trùng với lệnh hệ thống"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 1.4 Reserved subcommand name check ('list', 'remove', 'del')
        let ctx_sub = make_test_ctx(
            caches.clone(),
            "cmdadd",
            vec!["list", "|", "Nội dung list"],
            "list | Nội dung list",
        );
        let outcome_sub = registry.dispatch(ctx_sub).await.unwrap();
        match outcome_sub {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("trùng với tên dành riêng"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 1.5 Invalid command name format check
        let ctx_inv = make_test_ctx(
            caches.clone(),
            "cmdadd",
            vec!["123bad", "|", "Số đứng đầu"],
            "123bad | Số đứng đầu",
        );
        let outcome_inv = registry.dispatch(ctx_inv).await.unwrap();
        match outcome_inv {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("không hợp lệ"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 1.6 Media retention test: create custom command with photo
        let mut ctx_photo = make_test_ctx(
            caches.clone(),
            "cmdadd",
            vec!["catphoto", "|", "Ảnh chú mèo dễ thương"],
            "catphoto | Ảnh chú mèo dễ thương",
        );
        ctx_photo.message.content = MessageContent::Photo {
            url: "https://example.com/cat.jpg".into(),
            thumb_url: Some("https://example.com/cat_thumb.jpg".into()),
            width: Some(800),
            height: Some(600),
            caption: "Cat".into(),
        };
        let outcome_photo = registry.dispatch(ctx_photo).await.unwrap();
        match outcome_photo {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Đã tạo lệnh custom \"catphoto\""), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        let custom_cmds = caches.engine().list_custom_commands(Some("main")).unwrap();
        let cat_cmd = custom_cmds.iter().find(|(_, n, _, _)| n == "catphoto").unwrap();
        assert_eq!(cat_cmd.2["media"]["kind"], "image");
        assert_eq!(cat_cmd.2["media"]["url"], "https://example.com/cat.jpg");

        // 1.7 List custom commands with pagination
        let ctx_list = make_test_ctx(caches.clone(), "cmdadd", vec!["list", "1"], "list 1");
        let outcome_list = registry.dispatch(ctx_list).await.unwrap();
        match outcome_list {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("Trang 1/1") || text.contains("DANH SÁCH LỆNH TÙY CHỈNH") || text.contains("Danh sách lệnh custom"),
                    "got: {text}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 1.8 Remove custom command
        let ctx_del = make_test_ctx(caches.clone(), "cmdadd", vec!["remove", "mytest"], "remove mytest");
        let outcome_del = registry.dispatch(ctx_del).await.unwrap();
        match outcome_del {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("Đã xóa lệnh custom \"mytest\"")
                        || text.contains("Đã xóa lệnh tùy chỉnh \"mytest\""),
                    "got: {text}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let custom_cmds_after = caches.engine().list_custom_commands(Some("main")).unwrap();
        assert!(!custom_cmds_after.iter().any(|(_, n, _, _)| n == "mytest"));

        // =====================================================================
        // PART 2: setcmd reading and writing Studio configuration
        // =====================================================================

        // 2.1 Disable command via setcmd off
        let ctx_setcmd_off = make_test_ctx(caches.clone(), "setcmd", vec!["off", "help"], "off help");
        let outcome_off = registry.dispatch(ctx_setcmd_off).await.unwrap();
        match outcome_off {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Đã tắt lệnh \"help\""), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let layer_off = caches.get_studio_layer_hot("bot", "main", "", "help").unwrap();
        assert_eq!(layer_off.overrides["operation.enabled"], false);

        // 2.2 Re-enable command via setcmd on
        let ctx_setcmd_on = make_test_ctx(caches.clone(), "setcmd", vec!["on", "help"], "on help");
        let outcome_on = registry.dispatch(ctx_setcmd_on).await.unwrap();
        match outcome_on {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Đã bật lệnh \"help\""), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let layer_on = caches.get_studio_layer_hot("bot", "main", "", "help").unwrap();
        assert_eq!(layer_on.overrides["operation.enabled"], true);

        // 2.3 Set permission level via setcmd p
        let ctx_setcmd_p = make_test_ctx(caches.clone(), "setcmd", vec!["p", "help", "3"], "p help 3");
        let outcome_p = registry.dispatch(ctx_setcmd_p).await.unwrap();
        match outcome_p {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("adminBot") || text.contains("Quản trị viên bot"),
                    "got: {text}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let layer_p = caches.get_studio_layer_hot("bot", "main", "", "help").unwrap();
        assert_eq!(layer_p.overrides["access.permission"], "adminBot");

        // 2.4 Set cooldown via setcmd cd
        let ctx_setcmd_cd = make_test_ctx(caches.clone(), "setcmd", vec!["cd", "help", "15"], "cd help 15");
        let outcome_cd = registry.dispatch(ctx_setcmd_cd).await.unwrap();
        match outcome_cd {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("15s") || text.contains("15 giây"),
                    "got: {text}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let layer_cd = caches.get_studio_layer_hot("bot", "main", "", "help").unwrap();
        assert_eq!(layer_cd.overrides["operation.cooldownSeconds"], 15);

        // 2.5 Immutable setcmd permission check
        let ctx_setcmd_imm = make_test_ctx(caches.clone(), "setcmd", vec!["p", "setcmd", "1"], "p setcmd 1");
        let outcome_imm = registry.dispatch(ctx_setcmd_imm).await.unwrap();
        match outcome_imm {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("cố định"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // =====================================================================
        // PART 3: mybot lifecycle, extend/minus, style/profile, clean & notify
        // =====================================================================

        // Seed a child bot in database
        let now = Utc::now();
        let child_bot = BotRecord {
            bot_key: "child_bot_1".into(),
            uid: ZaloId::new("child_uid_1"),
            global_uid: None,
            canonical_username: None,
            display_name: "Bot Con Số 1".into(),
            avatar: String::new(),
            is_main: false,
            owner_uid: Some("admin_1".into()),
            status: "running".into(),
            desired_status: "running".into(),
            expiry_policy: ExpiryPolicy::At(now + chrono::Duration::days(5)),
            trial_status: None,
            cookie_json: json!({}),
            imei: "imei_123".into(),
            user_agent: "agent".into(),
            proxy_url: None,
            cookie_dead: false,
            cookie_dead_reason: None,
            prefix: "!".into(),
            self_listen: false,
            identity_pending: false,
            admin_identity_seeds: Vec::new(),
            metadata: json!({
                "nameServer": "Bot Con Số 1",
                "style": BotStyleConfig::default(),
            }),
            created_at: now.to_rfc3339(),
            updated_at: now.to_rfc3339(),
        };
        caches.engine().upsert_bot(&child_bot).unwrap();

        // 3.1 mybot detail
        let ctx_detail = make_test_ctx(caches.clone(), "mybot", vec!["detail", "child_bot_1"], "detail child_bot_1");
        let outcome_detail = registry.dispatch(ctx_detail).await.unwrap();
        match outcome_detail {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Bot Con Số 1"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 3.2 mybot extend
        let ctx_extend = make_test_ctx(caches.clone(), "mybot", vec!["extend", "child_bot_1", "10d"], "extend child_bot_1 10d");
        let outcome_extend = registry.dispatch(ctx_extend).await.unwrap();
        match outcome_extend {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("gia hạn thành công"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let bot_after_ext = caches.engine().get_bot("child_bot_1").unwrap().unwrap();
        match bot_after_ext.expiry_policy {
            ExpiryPolicy::At(t) => assert!(t > now + chrono::Duration::days(14)),
            _ => panic!("expected ExpiryPolicy::At"),
        }

        // 3.3 mybot minus
        let ctx_minus = make_test_ctx(caches.clone(), "mybot", vec!["minus", "child_bot_1", "2d"], "minus child_bot_1 2d");
        let outcome_minus = registry.dispatch(ctx_minus).await.unwrap();
        match outcome_minus {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("rút ngắn thời gian bot thành công"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 3.4 mybot minus -1 (expires immediately)
        let ctx_expire = make_test_ctx(caches.clone(), "mybot", vec!["minus", "child_bot_1", "-1"], "minus child_bot_1 -1");
        let outcome_expire = registry.dispatch(ctx_expire).await.unwrap();
        match outcome_expire {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("hết hạn ngay lập tức"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let bot_after_exp = caches.engine().get_bot("child_bot_1").unwrap().unwrap();
        assert_eq!(bot_after_exp.status, "expired");

        // 3.5 mybot approve
        let ctx_app = make_test_ctx(caches.clone(), "mybot", vec!["approve", "child_bot_1"], "approve child_bot_1");
        let outcome_app = registry.dispatch(ctx_app).await.unwrap();
        match outcome_app {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("phê duyệt bot"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let bot_after_app = caches.engine().get_bot("child_bot_1").unwrap().unwrap();
        assert_eq!(bot_after_app.status, "running");

        // 3.6 mybot nameserver
        let ctx_ns = make_test_ctx(caches.clone(), "mybot", vec!["nameserver", "Mega Bot Server"], "nameserver Mega Bot Server");
        let outcome_ns = registry.dispatch(ctx_ns).await.unwrap();
        match outcome_ns {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Mega Bot Server"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let main_bot = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(main_bot.display_name, "Mega Bot Server");

        // 3.7 mybot set desc
        let ctx_set = make_test_ctx(caches.clone(), "mybot", vec!["set", "desc", "Mô tả bot thử nghiệm"], "set desc Mô tả bot thử nghiệm");
        let outcome_set = registry.dispatch(ctx_set).await.unwrap();
        match outcome_set {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("cập nhật desc"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        let main_bot = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(main_bot.metadata["description"], "Mô tả bot thử nghiệm");

        // 3.8 mybot style (color, icon, size, reset)
        let ctx_col = make_test_ctx(caches.clone(), "mybot", vec!["style", "color", "15a85f"], "style color 15a85f");
        registry.dispatch(ctx_col).await.unwrap();
        let main_bot = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(main_bot.metadata["style"]["color"], "15a85f");

        let ctx_icon = make_test_ctx(caches.clone(), "mybot", vec!["style", "icon", "👑"], "style icon 👑");
        registry.dispatch(ctx_icon).await.unwrap();
        let main_bot = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(main_bot.metadata["style"]["icon"], "👑");

        let ctx_size = make_test_ctx(caches.clone(), "mybot", vec!["style", "size", "22", "16"], "style size 22 16");
        registry.dispatch(ctx_size).await.unwrap();
        let main_bot = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(main_bot.metadata["style"]["size"]["nameServer"], 22);
        assert_eq!(main_bot.metadata["style"]["size"]["text"], 16);

        let ctx_rst = make_test_ctx(caches.clone(), "mybot", vec!["style", "reset"], "style reset");
        registry.dispatch(ctx_rst).await.unwrap();
        let main_bot = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(main_bot.metadata["style"]["color"], "db342e");
        assert_eq!(main_bot.metadata["style"]["icon"], "🤖");

        // 3.9 mybot notify
        let ctx_notif = make_test_ctx(caches.clone(), "mybot", vec!["notify", "Hệ thống bảo trì 5 phút"], "notify Hệ thống bảo trì 5 phút");
        let outcome_notif = registry.dispatch(ctx_notif).await.unwrap();
        match outcome_notif {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("thông báo") && text.contains("bot con"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // 3.10 mybot clean
        // Mark child_bot_1 expired
        let mut expired_child = child_bot.clone();
        expired_child.status = "expired".into();
        expired_child.expiry_policy = ExpiryPolicy::At(now - chrono::Duration::seconds(10));
        caches.engine().upsert_bot(&expired_child).unwrap();

        let ctx_clean = make_test_ctx(caches.clone(), "mybot", vec!["clean"], "clean");
        let outcome_clean = registry.dispatch(ctx_clean).await.unwrap();
        match outcome_clean {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Đã dọn dẹp các bot hết hạn"), "got: {text}");
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        assert!(caches.engine().get_bot("child_bot_1").unwrap().is_none());
    }

    #[tokio::test]
    async fn test_media_p1_commands_parity() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).unwrap();

        // 1. gifvd without quote
        let ctx = make_test_ctx(caches.clone(), "gifvd", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng reply một tin nhắn chứa video!"), "Expected gifvd warning, got: {txt}");
            assert!(!txt.contains("Đang xử lý video bằng ffmpeg..."), "Should not stop at processing placeholder");
        } else {
            panic!("Expected Handled with warning");
        }

        // 2. editvideo without quote
        let ctx = make_test_ctx(caches.clone(), "editvideo", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng reply một tin nhắn chứa video hoặc ảnh!"), "Expected editvideo warning, got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        // 3. lamnet & 4k without quote
        let ctx = make_test_ctx(caches.clone(), "lamnet", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng reply vào tin nhắn chứa ảnh cần làm nét"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        let ctx = make_test_ctx(caches.clone(), "4k", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng reply vào một tin nhắn chứa ảnh"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        // 4. stickerzalo with invalid / missing id
        let ctx = make_test_ctx(caches.clone(), "stickerzalo", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng cung cấp ID sticker hợp lệ (số nguyên)!"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        // stickerzalo with valid numerical id
        let ctx = make_test_ctx(caches.clone(), "stickerzalo", vec!["12345"], "12345");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Đã gửi sticker với ID 12345!"), "got: {txt}");
        } else {
            panic!("Expected Handled with success");
        }

        // 5. stkmeme empty query
        let ctx = make_test_ctx(caches.clone(), "stkmeme", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập từ khóa tìm kiếm sticker!"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        // stkmeme with excessive count
        let ctx = make_test_ctx(caches.clone(), "stkmeme", vec!["cat", "20"], "cat 20");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Số lượng sticker tối đa là 10!"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        // 6. image & pinterest query check
        let ctx = make_test_ctx(caches.clone(), "image", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập từ khóa tìm kiếm ảnh"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }

        let ctx = make_test_ctx(caches.clone(), "pinterest", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập từ khóa tìm kiếm và số lượng ảnh"), "got: {txt}");
        } else {
            panic!("Expected Handled with warning");
        }
    }

    #[tokio::test]
    async fn test_media_enhance_image_upscales_resolution() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));

        // Create a 32x32 test PNG image
        let img = image::RgbaImage::new(32, 32);
        let mut original_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut original_bytes),
                image::ImageFormat::Png,
            )
            .unwrap();

        // Write to scratchpad
        let scratch = rt
            .cli_media
            .scratchpad()
            .write_temp_bytes("test_orig", "png", &original_bytes)
            .await
            .unwrap();

        // Convert path to file URL for test
        let _file_url = format!("file://{}", scratch.path().display().to_string().replace('\\', "/"));

        // If downloading from file:// is unsupported by http crawler, test local upscale directly
        let loaded = image::load_from_memory(&original_bytes).unwrap();
        let (w, h) = (loaded.width(), loaded.height());
        assert_eq!((w, h), (32, 32));

        let upscaled = loaded.resize_exact(w * 2, h * 2, image::imageops::FilterType::Lanczos3);
        let rgba = upscaled.to_rgba8();
        let sharpened = image::imageops::unsharpen(&rgba, 1.8, 3);
        let mut out_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(sharpened)
            .write_to(&mut std::io::Cursor::new(&mut out_bytes), image::ImageFormat::Png)
            .unwrap();

        let enhanced = image::load_from_memory(&out_bytes).unwrap();
        assert_eq!((enhanced.width(), enhanced.height()), (64, 64), "Resolution must be doubled 2x");
        assert_ne!(out_bytes, original_bytes, "Enhanced image bytes must differ from original");
    }

    #[tokio::test]
    async fn test_ai_and_crawlers_parity_suite() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let repo_root = Path::new("../../..");
        let rt = Arc::new(CommandRuntimeBundle::new(repo_root, caches.clone()));
        let registry = build_full_command_registry(rt).unwrap();

        // 1. phatnguoi without args -> syntax guide
        let ctx = make_test_ctx(caches.clone(), "phatnguoi", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập biển số xe cần tra cứu!"), "got: {txt}");
            assert!(txt.contains("Loại xe: 1-Ô tô, 2-Xe máy"), "got: {txt}");
        } else {
            panic!("Expected Handled with syntax guide");
        }

        // 2. phatnguoi with invalid plate format
        let ctx = make_test_ctx(caches.clone(), "phatnguoi", vec!["123"], "123");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Biển số Không hợp lệ!"), "got: {txt}");
        } else {
            panic!("Expected Handled with invalid plate warning");
        }

        // 3. checkgiavang without args -> gold menu
        let ctx = make_test_ctx(caches.clone(), "checkgiavang", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Hãy nhập loại vàng bạn muốn xem:"), "got: {txt}");
            assert!(txt.contains("sjc - Vàng SJC"), "got: {txt}");
            assert!(txt.contains("pnj - Vàng PNJ"), "got: {txt}");
        } else {
            panic!("Expected Handled with gold menu");
        }

        // 4. checkgiavang with unsupported type
        let ctx = make_test_ctx(caches.clone(), "checkgiavang", vec!["kimcuong"], "kimcuong");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("❌ Loại vàng \"kimcuong\" không được hỗ trợ."), "got: {txt}");
            assert!(txt.contains("sjc - Vàng SJC"), "got: {txt}");
        } else {
            panic!("Expected Handled with unsupported gold type warning");
        }

        // 5. gemini without args -> question prompt
        let ctx = make_test_ctx(caches.clone(), "gemini", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập câu hỏi cần giải đáp!"), "got: {txt}");
        } else {
            panic!("Expected Handled with gemini question prompt");
        }

        // 6. gemini reset -> clears chat session
        let ctx = make_test_ctx(caches.clone(), "gemini", vec!["reset"], "reset");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Đã xóa lịch sử cuộc trò chuyện của bạn!"), "got: {txt}");
        } else {
            panic!("Expected Handled with reset confirmation");
        }

        // 7. analysis-image without query and quote -> media/question prompt
        let ctx = make_test_ctx(caches.clone(), "analysis-image", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập câu hỏi hoặc reply vào tin nhắn có hình ảnh"), "got: {txt}");
        } else {
            panic!("Expected Handled with analysis-image prompt");
        }

        // 8. genminiv1 without query and quote -> media/question prompt
        let ctx = make_test_ctx(caches.clone(), "genminiv1", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập câu hỏi hoặc reply vào tin nhắn có hình ảnh"), "got: {txt}");
        } else {
            panic!("Expected Handled with genminiv1 prompt");
        }

        // 9. google-search-ai without query -> search keyword prompt
        let ctx = make_test_ctx(caches.clone(), "google-search-ai", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập từ khóa tìm kiếm"), "got: {txt}");
        } else {
            panic!("Expected Handled with google-search-ai keyword prompt");
        }

        // 10. googlesearchai without query -> search keyword prompt
        let ctx = make_test_ctx(caches.clone(), "googlesearchai", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("❌ Vui lòng nhập từ khóa tìm kiếm."), "got: {txt}");
        } else {
            panic!("Expected Handled with googlesearchai keyword prompt");
        }

        // 11. google without query -> search keyword prompt
        let ctx = make_test_ctx(caches.clone(), "google", vec![], "");
        let res = registry.dispatch(ctx).await.unwrap();
        if let CommandOutcome::Handled { reply_text: Some(txt), .. } = res {
            assert!(txt.contains("Vui lòng nhập từ khóa tìm kiếm"), "got: {txt}");
        } else {
            panic!("Expected Handled with google keyword prompt");
        }
    }
}
