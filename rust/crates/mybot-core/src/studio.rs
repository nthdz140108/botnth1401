//! Command Registry, Static `CommandHandler` Trait, and Command Studio V2 Engine.
//!
//! Replaces `src/commands/command-registry.js`, `src/commands/command-router.js`, and
//! `src/commands/studio/*` with zero dynamic `import()` closures or `__handlerRef` reflection:
//! - Multi-word longest-match command resolution (`"gemini make"`, `"sticker ai"`, `"stk ai"`).
//! - Underscore `_` argument splitting for `todo`, `learnnow`, `sendp`.
//! - Synthesizes 100%-compatible `CommandStudioContractV2` JSON (7 standard tabs + 9 tabs with
//!   24 `:05` hourly schedules in `Asia/Ho_Chi_Minh` for `sendtask`).
//! - 4-layer sparse config resolver (`default -> global -> bot -> group`) with field provenance
//!   and atomic `409 REVISION_CONFLICT` optimistic concurrency via `HotStorageCaches`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mybot_storage::{CommandStudioHistoryItem, GroupSettingsRecord, HotStorageCaches, StorageError};
use mybot_types::{
    ArgSplitMode, ChatScope, ExecutionLane, InboundMessage, InstanceScope, PermissionTier, ZaloId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use zalo_sdk::{OutboundMessage, ZaloSession};

use crate::interaction::{BotFleetController, InteractionEngine};
use crate::v3_style::{
    BotStyleProfile, build_complete, build_complete_request, build_failed, build_from_sql,
    build_insufficient_authority, build_processing_request, build_query, build_state_quote,
    build_tag_message, build_warning, build_warning_request, sanitize_no_markdown,
};

pub const STUDIO_CONTRACT_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandSpec {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub phase: u8,
    pub legacy_type: u8,
    pub description: &'static str,
    pub syntax: &'static str,
    pub permission: PermissionTier,
    pub scope: ChatScope,
    pub instance_scope: InstanceScope,
    pub lane: ExecutionLane,
    pub default_cooldown_secs: u32,
    pub min_args: usize,
    pub arg_split_mode: ArgSplitMode,
    pub is_high_risk: bool,
    pub is_mass_command: bool,
    pub requires_db: bool,
    pub required_runtime_deps: &'static [&'static str],
    pub required_secrets: &'static [&'static [&'static str]],
    pub handler_module: &'static str,
    pub handler_export: &'static str,
}

#[derive(Clone)]
pub struct CommandContext {
    pub bot_key: String,
    pub is_main_bot: bool,
    pub self_uid: ZaloId,
    pub prefix: String,
    pub invoked_alias: String,
    pub args: Vec<String>,
    pub raw_args_text: String,
    pub message: InboundMessage,
    pub sender_tier: PermissionTier,
    pub group_settings: GroupSettingsRecord,
    pub effective_studio_config: Value,
    pub zalo: Option<Arc<ZaloSession>>,
    pub caches: HotStorageCaches,
    pub assets_root: PathBuf,
    pub style_profile: BotStyleProfile,
    pub interactions: Arc<InteractionEngine>,
    pub fleet: Option<Arc<dyn BotFleetController>>,
    pub outbound_sink: Option<Arc<parking_lot::Mutex<Vec<OutboundMessage>>>>,
}

impl CommandContext {
    /// Transmits an `OutboundMessage` over live Zalo (if connected) and/or records it in
    /// `outbound_sink` for deterministic V3-parity verification tests.
    pub async fn send_outbound(&self, mut out: OutboundMessage) -> Result<Value, CommandError> {
        out.text = sanitize_no_markdown(&out.text);
        if let Some(ref sink) = self.outbound_sink {
            sink.lock().push(out.clone());
        }
        if let Some(ref zalo) = self.zalo {
            let receipt = zalo
                .send_message(out, &self.message.thread_id, self.message.thread_type)
                .await?;
            Ok(receipt)
        } else {
            Ok(json!({
                "msgId": "sim_msg_id",
                "cliMsgId": "sim_cli_msg_id",
            }))
        }
    }

    pub async fn reply_complete(
        &self,
        caption: impl AsRef<str>,
        has_state: bool,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_complete(&self.style_profile, &self.message, &cap, has_state);
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn reply_failed(
        &self,
        caption: impl AsRef<str>,
        has_state: bool,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_failed(&self.style_profile, &self.message, &cap, has_state);
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn reply_warning(
        &self,
        caption: impl AsRef<str>,
        has_state: bool,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_warning(&self.style_profile, &self.message, &cap, has_state);
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn reply_query(
        &self,
        caption: impl AsRef<str>,
        has_state: bool,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_query(&self.style_profile, &self.message, &cap, has_state);
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn reply_insufficient_authority(
        &self,
        caption: impl AsRef<str>,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_insufficient_authority(&self.style_profile, &self.message, &cap, true);
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn reply_state_quote(
        &self,
        caption: impl AsRef<str>,
        state: bool,
        ttl_ms: u64,
        on_state: bool,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_state_quote(
            &self.style_profile,
            &self.message,
            &cap,
            state,
            ttl_ms,
            on_state,
        );
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn reply_from_sql(
        &self,
        success: bool,
        caption: impl AsRef<str>,
        has_state: bool,
        ttl_ms: u64,
    ) -> Result<CommandOutcome, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_from_sql(
            &self.style_profile,
            &self.message,
            success,
            &cap,
            has_state,
            ttl_ms,
        );
        self.send_outbound(out).await?;
        Ok(CommandOutcome::Handled {
            summary: cap,
            reply_text: None,
            custom_ttl_ms: None,
        })
    }

    pub async fn send_warning_request(
        &self,
        caption: impl AsRef<str>,
        image_path: Option<PathBuf>,
        ttl_ms: u64,
    ) -> Result<Value, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_warning_request(
            &self.style_profile,
            &self.message,
            &cap,
            image_path,
            ttl_ms,
        );
        self.send_outbound(out).await
    }

    pub async fn send_processing_request(
        &self,
        caption: impl AsRef<str>,
        image_path: Option<PathBuf>,
        ttl_ms: u64,
    ) -> Result<Value, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_processing_request(
            &self.style_profile,
            &self.message,
            &cap,
            image_path,
            ttl_ms,
        );
        self.send_outbound(out).await
    }

    pub async fn send_complete_request(
        &self,
        caption: impl AsRef<str>,
        image_path: Option<PathBuf>,
        ttl_ms: u64,
    ) -> Result<Value, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_complete_request(
            &self.style_profile,
            &self.message,
            &cap,
            image_path,
            ttl_ms,
        );
        self.send_outbound(out).await
    }

    pub async fn send_tag_message(
        &self,
        caption: impl AsRef<str>,
        extra_mentions: &[mybot_types::MentionSpan],
        image_path: Option<PathBuf>,
        ttl_ms: u64,
    ) -> Result<Value, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let out = build_tag_message(
            &self.style_profile,
            &self.message,
            &cap,
            extra_mentions,
            image_path,
            ttl_ms,
        );
        self.send_outbound(out).await
    }

    // -------------------------------------------------------------------------
    // Unified Interactive Session Bridge (single source of truth for menus)
    // -------------------------------------------------------------------------

    /// Sends a numbered/selection menu **and** binds a reply-wizard to the bot's *own* sent
    /// message id (from the real Zalo receipt) — so `quote`-replies and bare numeric selections
    /// are both consumable. This replaces the previous split where `InteractionWizard` stored the
    /// *user's* `msg_id` and `InteractionEngine` never received a prompt reference at all.
    #[allow(clippy::too_many_arguments)]
    pub async fn send_interactive_menu(
        &self,
        caption: impl AsRef<str>,
        ttl: std::time::Duration,
        require_quote: bool,
        show_clock: bool,
        recall_on_consume: bool,
        on_reply: Arc<crate::interaction::ReplyCallbackFn>,
        on_expire: Option<Arc<crate::interaction::ExpireCallbackFn>>,
    ) -> Result<crate::interaction::BotMessageRef, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let ttl_ms = ttl.as_millis().min(u64::MAX as u128) as u64;
        let out = build_state_quote(&self.style_profile, &self.message, &cap, true, ttl_ms, true);
        let receipt = self.send_outbound(out).await?;
        let prompt_ref = crate::interaction::extract_receipt_ref(
            &receipt,
            &self.message.thread_id,
            self.message.thread_type,
            &self.self_uid,
        );
        let key = format!(
            "menu:{}:{}:{}:{}",
            self.bot_key,
            self.message.thread_id.as_str(),
            self.message.sender_uid.as_str(),
            prompt_ref.msg_id.as_str()
        );
        self.interactions.register_reply_wizard(
            crate::interaction::InteractiveReplySpec {
                key,
                bot_key: self.bot_key.clone(),
                thread_id: self.message.thread_id.clone(),
                sender_uid: self.message.sender_uid.clone(),
                prompt_ref: prompt_ref.clone(),
                require_quote,
                ttl,
                recall_on_consume,
                recall_on_expire: true,
                show_clock,
                on_reply,
                on_expire,
            },
            self.zalo.clone(),
        );
        Ok(prompt_ref)
    }

    /// Sends a confirmation prompt and binds a reaction-wait session (V3 `❤️` confirm flows: `join`, `autojoin`, `locmem`).
    /// In V3 parity, any high-level admin can confirm by reacting, and permission is re-evaluated in the callback.
    pub async fn send_reaction_menu(
        &self,
        caption: impl AsRef<str>,
        ttl: std::time::Duration,
        accepted_icons: Vec<String>,
        on_reaction: Arc<crate::interaction::ReactionCallbackFn>,
        on_expire: Option<Arc<crate::interaction::ExpireCallbackFn>>,
    ) -> Result<crate::interaction::BotMessageRef, CommandError> {
        self.send_reaction_menu_with_filter(caption, ttl, accepted_icons, None, on_reaction, on_expire).await
    }

    /// Sends a confirmation prompt and binds a reaction-wait session with an optional sender filter.
    pub async fn send_reaction_menu_with_filter(
        &self,
        caption: impl AsRef<str>,
        ttl: std::time::Duration,
        accepted_icons: Vec<String>,
        allowed_sender_uid: Option<ZaloId>,
        on_reaction: Arc<crate::interaction::ReactionCallbackFn>,
        on_expire: Option<Arc<crate::interaction::ExpireCallbackFn>>,
    ) -> Result<crate::interaction::BotMessageRef, CommandError> {
        let cap = sanitize_no_markdown(caption.as_ref());
        let ttl_ms = ttl.as_millis().min(u64::MAX as u128) as u64;
        let out = build_state_quote(&self.style_profile, &self.message, &cap, true, ttl_ms, true);
        let receipt = self.send_outbound(out).await?;
        let prompt_ref = crate::interaction::extract_receipt_ref(
            &receipt,
            &self.message.thread_id,
            self.message.thread_type,
            &self.self_uid,
        );
        let uid_part = allowed_sender_uid.as_ref().map(|u| u.as_str()).unwrap_or("any");
        let key = format!(
            "react:{}:{}:{}:{}",
            self.bot_key,
            self.message.thread_id.as_str(),
            uid_part,
            prompt_ref.msg_id.as_str()
        );
        self.interactions.register_reaction_wait(
            crate::interaction::InteractiveReactionSpec {
                key,
                bot_key: self.bot_key.clone(),
                thread_id: self.message.thread_id.clone(),
                allowed_sender_uid,
                prompt_ref: prompt_ref.clone(),
                accepted_icons,
                ttl,
                recall_on_consume: false,
                recall_on_expire: true,
                show_clock: true,
                on_reaction,
                on_expire,
            },
            self.zalo.clone(),
        );
        Ok(prompt_ref)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommandOutcome {
    Handled {
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_ttl_ms: Option<u64>,
    },
    Accepted {
        job_id: String,
        lane: ExecutionLane,
    },
    Denied {
        reason_code: String,
        message: String,
    },
}

impl CommandOutcome {
    pub fn handled(summary: impl Into<String>, reply_text: Option<String>) -> Self {
        Self::Handled {
            summary: summary.into(),
            reply_text,
            custom_ttl_ms: None,
        }
    }

    pub fn handled_with_ttl(
        summary: impl Into<String>,
        reply_text: Option<String>,
        custom_ttl_ms: Option<u64>,
    ) -> Self {
        Self::Handled {
            summary: summary.into(),
            reply_text,
            custom_ttl_ms,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("zalo api error: {0}")]
    Zalo(#[from] zalo_sdk::ZaloApiError),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("missing argument: {0}")]
    MissingArgument(String),
    #[error("handler error: {0}")]
    Internal(String),
}

#[async_trait]
pub trait CommandHandler: Send + Sync + 'static {
    fn spec(&self) -> &'static CommandSpec;
    async fn execute(&self, ctx: CommandContext) -> Result<CommandOutcome, CommandError>;
}

#[derive(Clone)]
pub struct ParsedInvocation {
    pub handler: Arc<dyn CommandHandler>,
    pub matched_key: String,
    pub args: Vec<String>,
    pub raw_args_text: String,
}

impl std::fmt::Debug for ParsedInvocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedInvocation")
            .field("command", &self.handler.spec().name)
            .field("matched_key", &self.matched_key)
            .field("args", &self.args)
            .finish()
    }
}

/// Thread-safe, zero-reflection registry of all 218 canonical commands and 181 aliases (399 lookup keys).
#[derive(Clone)]
pub struct CommandRegistry {
    handlers: Arc<Vec<Arc<dyn CommandHandler>>>,
    by_canonical: Arc<HashMap<String, Arc<dyn CommandHandler>>>,
    lookup: Arc<HashMap<String, Arc<dyn CommandHandler>>>,
    /// Keys sorted by descending word count, then descending byte length (`"gemini make"` before `"gemini"`).
    sorted_keys: Arc<Vec<String>>,
}

impl CommandRegistry {
    pub fn new(handlers: Vec<Arc<dyn CommandHandler>>) -> Result<Self, String> {
        let mut by_canonical = HashMap::with_capacity(handlers.len());
        let mut lookup = HashMap::with_capacity(handlers.len() * 2);

        for h in &handlers {
            let spec = h.spec();
            let canon = normalize_command_key(spec.name);
            if canon.is_empty() {
                return Err("empty command name in registry".to_string());
            }
            if by_canonical.contains_key(&canon) {
                return Err(format!("COMMAND_REGISTRY_COLLISION on canonical `{canon}`"));
            }
            by_canonical.insert(canon.clone(), Arc::clone(h));

            for key_raw in std::iter::once(&spec.name).chain(spec.aliases.iter()) {
                let norm = normalize_command_key(key_raw);
                if norm.is_empty() {
                    continue;
                }
                if let Some(prev) = lookup.insert(norm.clone(), Arc::clone(h))
                    && prev.spec().name != spec.name
                {
                    return Err(format!(
                        "COMMAND_REGISTRY_COLLISION on key `{norm}` between `{}` and `{}`",
                        prev.spec().name,
                        spec.name
                    ));
                }
            }
        }

        let mut sorted_keys: Vec<String> = lookup.keys().cloned().collect();
        sorted_keys.sort_by(|a, b| {
            let words_a = a.split_whitespace().count();
            let words_b = b.split_whitespace().count();
            words_b.cmp(&words_a).then_with(|| b.len().cmp(&a.len())).then_with(|| a.cmp(b))
        });

        Ok(Self {
            handlers: Arc::new(handlers),
            by_canonical: Arc::new(by_canonical),
            lookup: Arc::new(lookup),
            sorted_keys: Arc::new(sorted_keys),
        })
    }

    pub fn empty() -> Self {
        Self::new(Vec::new()).expect("empty registry")
    }

    pub fn canonical_count(&self) -> usize {
        self.by_canonical.len()
    }

    pub fn lookup_key_count(&self) -> usize {
        self.lookup.len()
    }

    pub fn handlers(&self) -> &[Arc<dyn CommandHandler>] {
        &self.handlers
    }

    pub fn get_canonical(&self, name: &str) -> Option<Arc<dyn CommandHandler>> {
        self.by_canonical.get(&normalize_command_key(name)).cloned()
    }

    pub fn get_by_any_key(&self, key: &str) -> Option<Arc<dyn CommandHandler>> {
        self.lookup.get(&normalize_command_key(key)).cloned()
    }

    /// Parses a prefixed chat line (e.g. `"!gemini make a cat"`, `"!todo viec1_viec2"`) using
    /// longest multi-word key matching and command-specific argument splitting.
    pub fn parse_prefixed_line(&self, text: &str, prefix: &str) -> Option<ParsedInvocation> {
        let trimmed = text.trim();
        if prefix.is_empty() || !trimmed.starts_with(prefix) {
            return None;
        }
        let body = trimmed[prefix.len()..].trim();
        if body.is_empty() {
            return None;
        }

        let words: Vec<&str> = body.split_whitespace().collect();
        let norm_words: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
        let norm_body = body.to_lowercase();

        for key in self.sorted_keys.iter() {
            let Some(handler) = self.lookup.get(key).cloned() else {
                continue;
            };

            // Support underscore argument separator (e.g. `!todo_viec1_2`, `!sendp_msg_1_@tag`, `!learnnow_q_a`)
            if handler.spec().arg_split_mode == ArgSplitMode::Underscore {
                let underscore_prefix = format!("{key}_");
                if norm_body.starts_with(&underscore_prefix) {
                    let rest = &body[underscore_prefix.len()..];
                    let raw_args_text = rest.trim().to_string();
                    let args = if raw_args_text.is_empty() {
                        Vec::new()
                    } else {
                        raw_args_text
                            .split('_')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    };
                    return Some(ParsedInvocation {
                        handler,
                        matched_key: key.clone(),
                        args,
                        raw_args_text,
                    });
                }
            }

            let key_parts: Vec<&str> = key.split(' ').collect();
            if key_parts.len() > norm_words.len() {
                continue;
            }
            let matches = key_parts
                .iter()
                .zip(norm_words.iter())
                .all(|(kp, nw)| *kp == nw.as_str());
            if !matches {
                continue;
            }

            // Extract raw remainder after the matched command tokens
            let mut rest = body;
            for _ in 0..key_parts.len() {
                rest = rest.trim_start();
                let tok_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                rest = &rest[tok_end..];
            }
            let raw_args_text = rest.trim().to_string();

            let args = match handler.spec().arg_split_mode {
                ArgSplitMode::Underscore => {
                    if raw_args_text.is_empty() {
                        Vec::new()
                    } else {
                        raw_args_text
                            .split('_')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    }
                }
                ArgSplitMode::Whitespace => {
                    if raw_args_text.is_empty() {
                        Vec::new()
                    } else {
                        raw_args_text
                            .split_whitespace()
                            .map(ToOwned::to_owned)
                            .collect()
                    }
                }
            };

            return Some(ParsedInvocation {
                handler,
                matched_key: key.clone(),
                args,
                raw_args_text,
            });
        }

        None
    }
}

pub fn normalize_command_key(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// =============================================================================
// Command Studio V2 Contract Synthesis & 4-Layer Sparse Resolver
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStudioConfig {
    pub command_name: String,
    pub values: Value,
    pub provenance: BTreeMap<String, String>,
    pub revisions: BTreeMap<String, i64>,
}

pub struct StudioEngine {
    registry: CommandRegistry,
    caches: HotStorageCaches,
}

impl StudioEngine {
    pub fn new(registry: CommandRegistry, caches: HotStorageCaches) -> Self {
        Self { registry, caches }
    }

    pub fn registry(&self) -> &CommandRegistry {
        &self.registry
    }

    /// Parses a prefixed line against both static 399 registry keys and dynamic runtime aliases
    /// stored via `!alias add` in Studio global/bot layers (`aliases` array).
    pub fn parse_prefixed_with_dynamic_aliases(
        &self,
        text: &str,
        prefix: &str,
        bot_key: Option<&str>,
    ) -> Option<ParsedInvocation> {
        if let Some(static_hit) = self.registry.parse_prefixed_line(text, prefix) {
            return Some(static_hit);
        }
        let trimmed = text.trim();
        if prefix.is_empty() || !trimmed.starts_with(prefix) {
            return None;
        }
        let body = trimmed[prefix.len()..].trim();
        if body.is_empty() {
            return None;
        }
        let first_tok_end = body.find(char::is_whitespace).unwrap_or(body.len());
        let first_tok = body[..first_tok_end].to_lowercase();
        let rest_raw = body[first_tok_end..].trim().to_string();

        for h in self.registry.handlers() {
            let cname = h.spec().name;
            let has_dynamic_alias = [
                self.caches.get_studio_layer_hot("global", "", "", cname),
                bot_key.and_then(|b| self.caches.get_studio_layer_hot("bot", b, "", cname)),
            ]
            .into_iter()
            .flatten()
            .any(|layer| {
                layer
                    .overrides
                    .get("aliases")
                    .and_then(Value::as_array)
                    .is_some_and(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .any(|a| normalize_command_key(a) == first_tok)
                    })
            });

            if has_dynamic_alias {
                let args = match h.spec().arg_split_mode {
                    ArgSplitMode::Underscore => {
                        if rest_raw.is_empty() {
                            Vec::new()
                        } else {
                            rest_raw
                                .split('_')
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        }
                    }
                    ArgSplitMode::Whitespace => {
                        if rest_raw.is_empty() {
                            Vec::new()
                        } else {
                            rest_raw.split_whitespace().map(ToOwned::to_owned).collect()
                        }
                    }
                };
                return Some(ParsedInvocation {
                    handler: Arc::clone(h),
                    matched_key: first_tok,
                    args,
                    raw_args_text: rest_raw,
                });
            }
        }
        None
    }

    pub fn build_contract_for(&self, command_name: &str) -> Option<Value> {
        let h = self.registry.get_canonical(command_name)?;
        Some(synthesize_studio_contract(h.spec()))
    }

    pub fn catalog(&self) -> Value {
        let mut items = Vec::with_capacity(self.registry.canonical_count());
        for h in self.registry.handlers() {
            let s = h.spec();
            let adapter = if s.name == "sendtask" {
                "sendtask-scheduler"
            } else {
                "default-config"
            };
            items.push(json!({
                "name": s.name,
                "commandName": s.name,
                "aliases": s.aliases,
                "permission": permission_to_v3_str(s.permission),
                "scope": scope_to_v3_str(s.scope),
                "countdown": s.default_cooldown_secs,
                "type": s.legacy_type,
                "phase": s.phase,
                "coverage": "FULL",
                "adapter": adapter,
                "enabled": true,
            }));
        }
        json!({
            "version": STUDIO_CONTRACT_VERSION,
            "total": items.len(),
            "commands": items,
        })
    }

    pub fn coverage(&self) -> Value {
        let total = self.registry.canonical_count();
        json!({
            "total": total,
            "full": total,
            "partial": 0,
            "missing": 0,
            "percentage": 100.0,
        })
    }

    /// Resolves effective Studio V2 config across `default -> global -> bot -> group`.
    pub fn resolve_config(
        &self,
        command_name: &str,
        bot_id: Option<&str>,
        thread_id: Option<&str>,
    ) -> Result<ResolvedStudioConfig, StorageError> {
        let Some(handler) = self.registry.get_canonical(command_name) else {
            return Err(StorageError::NotFound(format!("command `{command_name}`")));
        };
        let contract = synthesize_studio_contract(handler.spec());
        let field_defs = extract_contract_fields(&contract);

        let mut values_map = Map::new();
        let mut provenance = BTreeMap::new();
        for (k, def) in &field_defs {
            let dv = def.get("default").cloned().unwrap_or(Value::Null);
            values_map.insert(k.clone(), dv);
            provenance.insert(k.clone(), "default".to_string());
        }

        let mut revisions = BTreeMap::new();

        // Layer 1: global
        if let Some(gl) = self.caches.get_studio_layer_hot("global", "", "", handler.spec().name) {
            revisions.insert("global".to_string(), gl.revision);
            apply_sparse_layer("global", &gl.overrides, &field_defs, &mut values_map, &mut provenance);
        } else {
            revisions.insert("global".to_string(), 0);
        }

        // Layer 2: bot
        if let Some(bid) = bot_id.filter(|s| !s.is_empty()) {
            if let Some(bl) = self.caches.get_studio_layer_hot("bot", bid, "", handler.spec().name) {
                revisions.insert("bot".to_string(), bl.revision);
                apply_sparse_layer("bot", &bl.overrides, &field_defs, &mut values_map, &mut provenance);
            } else {
                revisions.insert("bot".to_string(), 0);
            }
        }

        // Layer 3: group
        if let (Some(bid), Some(tid)) = (
            bot_id.filter(|s| !s.is_empty()),
            thread_id.filter(|s| !s.is_empty()),
        ) {
            if let Some(grl) = self.caches.get_studio_layer_hot("group", bid, tid, handler.spec().name) {
                revisions.insert("group".to_string(), grl.revision);
                apply_sparse_layer("group", &grl.overrides, &field_defs, &mut values_map, &mut provenance);
            } else {
                revisions.insert("group".to_string(), 0);
            }
        }

        // Redact sensitive `secrets.*` values when returning to UI
        for (k, def) in &field_defs {
            if def.get("sensitive").and_then(Value::as_bool) == Some(true)
                && let Some(v) = values_map.get_mut(k)
                && let Some(s) = v.as_str()
                && !s.is_empty()
            {
                *v = Value::String("••••••••".to_string());
            }
        }

        Ok(ResolvedStudioConfig {
            command_name: handler.spec().name.to_string(),
            values: Value::Object(values_map),
            provenance,
            revisions,
        })
    }

    pub fn validate_layer_values(
        &self,
        command_name: &str,
        scope: &str,
        values: &Value,
    ) -> Value {
        let Some(handler) = self.registry.get_canonical(command_name) else {
            return json!({
                "ok": false,
                "errors": [{ "path": "commandName", "message": "Unknown command" }]
            });
        };
        let contract = synthesize_studio_contract(handler.spec());
        let field_defs = extract_contract_fields(&contract);
        let mut errors = Vec::new();

        if let Some(obj) = values.as_object() {
            for (k, v) in obj {
                let Some(def) = field_defs.get(k) else {
                    errors.push(json!({ "path": k, "message": "Unknown field key" }));
                    continue;
                };
                if def.get("readOnly").and_then(Value::as_bool) == Some(true) {
                    errors.push(json!({ "path": k, "message": "Field is readOnly" }));
                    continue;
                }
                let allowed_scopes = def
                    .get("allowedScopes")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                    .unwrap_or_default();
                if !allowed_scopes.contains(&scope) {
                    errors.push(json!({
                        "path": k,
                        "message": format!("Field `{k}` is not allowed at `{scope}` scope")
                    }));
                    continue;
                }
                if v.is_null() && def.get("nullable").and_then(Value::as_bool) != Some(true) {
                    errors.push(json!({ "path": k, "message": "Field is not nullable" }));
                }
            }
        } else {
            errors.push(json!({ "path": "", "message": "values must be a JSON object" }));
        }

        json!({
            "ok": errors.is_empty(),
            "errors": errors,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_layer(
        &self,
        command_name: &str,
        scope: &str,
        bot_id: &str,
        thread_id: &str,
        values: &Value,
        expected_revision: Option<i64>,
        actor: &str,
    ) -> Result<Value, StorageError> {
        let Some(handler) = self.registry.get_canonical(command_name) else {
            return Err(StorageError::NotFound(format!("command `{command_name}`")));
        };
        let norm_bot = if scope == "global" { "" } else { bot_id };
        let norm_thread = if scope == "group" { thread_id } else { "" };

        let saved = self.caches.save_studio_layer_cas(
            scope,
            norm_bot,
            norm_thread,
            handler.spec().name,
            values,
            expected_revision,
            actor,
            "studio.apply",
        )?;

        // Persist global `secrets.*` into `provider_secrets` if non-empty and unmasked
        if scope == "global"
            && let Some(obj) = values.as_object()
        {
            for (k, v) in obj {
                if let Some(env_name) = k.strip_prefix("secrets.")
                    && let Some(secret_str) = v.as_str()
                    && !secret_str.is_empty()
                    && !secret_str.contains('•')
                {
                    let _ = self.caches.engine().set_provider_secret(env_name, secret_str);
                }
            }
        }

        Ok(json!({
            "applied": true,
            "commandName": saved.command_name,
            "scope": saved.scope_type,
            "botId": saved.bot_key,
            "threadId": saved.thread_id,
            "revision": saved.revision,
            "updatedAt": saved.updated_at,
        }))
    }

    pub fn rollback_latest(
        &self,
        command_name: &str,
        scope: &str,
        bot_id: &str,
        thread_id: &str,
        actor: &str,
    ) -> Result<Value, StorageError> {
        let norm_bot = if scope == "global" { "" } else { bot_id };
        let norm_thread = if scope == "group" { thread_id } else { "" };
        let hist: Vec<CommandStudioHistoryItem> = self
            .caches
            .engine()
            .list_studio_history(scope, norm_bot, norm_thread, command_name, 1)?;
        let Some(latest) = hist.first() else {
            return Err(StorageError::NotFound("ROLLBACK_TARGET_NOT_FOUND".to_string()));
        };
        let saved = self.caches.save_studio_layer_cas(
            scope,
            norm_bot,
            norm_thread,
            command_name,
            &latest.previous,
            None,
            actor,
            "studio.rollback",
        )?;
        Ok(json!({
            "rolledBack": true,
            "revision": saved.revision,
            "restoredFromRevision": latest.revision,
        }))
    }
}

fn apply_sparse_layer(
    scope: &str,
    overrides: &Value,
    field_defs: &HashMap<String, Value>,
    values_map: &mut Map<String, Value>,
    provenance: &mut BTreeMap<String, String>,
) {
    let Some(obj) = overrides.as_object() else {
        return;
    };
    for (k, v) in obj {
        if let Some(def) = field_defs.get(k) {
            let allowed = def
                .get("allowedScopes")
                .and_then(Value::as_array)
                .map(|a| a.iter().any(|x| x.as_str() == Some(scope)))
                .unwrap_or(false);
            if !allowed {
                continue;
            }
            values_map.insert(k.clone(), v.clone());
            provenance.insert(k.clone(), scope.to_string());
        }
    }
}

fn extract_contract_fields(contract: &Value) -> HashMap<String, Value> {
    let mut map = HashMap::new();
    if let Some(tabs) = contract.get("tabs").and_then(Value::as_array) {
        for tab in tabs {
            if let Some(fields) = tab.get("fields").and_then(Value::as_array) {
                for f in fields {
                    if let Some(k) = f.get("key").and_then(Value::as_str) {
                        map.insert(k.to_string(), f.clone());
                    }
                }
            }
        }
    }
    map
}

/// Renders a Command Studio template (`{prefix}`, `{command}`, `{user}`, `{userId}`, `{thread}`,
/// `{remaining}`, `{reason}`, `{state}`, `{param:<key>}`).
pub fn render_studio_template(template: &str, vars: &Value) -> String {
    let mut out = template.to_string();
    if let Some(obj) = vars.as_object() {
        for (k, v) in obj {
            if k == "params"
                && let Some(p_obj) = v.as_object()
            {
                for (pk, pv) in p_obj {
                    let token = format!("{{param:{pk}}}");
                    let repl = value_to_plain_str(pv);
                    out = out.replace(&token, &repl);
                }
                continue;
            }
            let token = format!("{{{k}}}");
            let repl = value_to_plain_str(v);
            out = out.replace(&token, &repl);
        }
    }
    out
}

fn value_to_plain_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn permission_to_v3_str(p: PermissionTier) -> &'static str {
    match p {
        PermissionTier::All => "all",
        PermissionTier::AdminBox => "adminBox",
        PermissionTier::AdminBot => "adminBot",
        PermissionTier::AdminLevelHigh => "adminLevelHigh",
    }
}

pub fn scope_to_v3_str(s: ChatScope) -> &'static str {
    match s {
        ChatScope::Both => "both",
        ChatScope::Group => "group",
        ChatScope::Private => "private",
    }
}

fn read_only_field(key: &str, label: &str, value: impl ToString, description: &str) -> Value {
    json!({
        "key": key,
        "label": label,
        "type": "string",
        "default": value.to_string(),
        "allowedScopes": ["global"],
        "readOnly": true,
        "sensitive": false,
        "apply": "config",
        "description": description,
    })
}

/// Synthesizes a 100%-compatible `CommandStudioContractV2` JSON schema for `spec`
/// (7 tabs for standard commands; 9 tabs with 24 `:05` cron schedules in `Asia/Ho_Chi_Minh` for `sendtask`).
pub fn synthesize_studio_contract(spec: &CommandSpec) -> Value {
    let risk_str = if spec.is_high_risk { "high" } else { "normal" };
    let perm_str = permission_to_v3_str(spec.permission);
    let scope_str = scope_to_v3_str(spec.scope);

    let mut secret_fields = Vec::new();
    for group in spec.required_secrets {
        for (idx, env_name) in group.iter().enumerate() {
            let suffix = if group.len() > 1 {
                format!(" (phương án {})", idx + 1)
            } else {
                String::new()
            };
            secret_fields.push(json!({
                "key": format!("secrets.{env_name}"),
                "label": format!("{env_name}{suffix}"),
                "type": "string",
                "default": "",
                "allowedScopes": ["global"],
                "sensitive": true,
                "apply": "config",
                "description": format!("Biến môi trường {env_name} dùng bởi handler. Giá trị trống = dùng env hiện tại."),
            }));
        }
    }

    let mut operation_fields = vec![
        json!({ "key": "operation.enabled", "label": "Bật lệnh", "type": "boolean", "default": true, "allowedScopes": ["global", "bot", "group"], "apply": "config", "description": "Tắt sẽ chặn dispatch qua behavior gate (kill switch)." }),
        json!({ "key": "operation.cooldownMode", "label": "Chế độ cooldown", "type": "select", "options": ["perUser", "perThread", "global"], "default": null, "nullable": true, "allowedScopes": ["global", "bot"], "apply": "config" }),
        json!({ "key": "operation.cooldownSeconds", "label": "Cooldown (giây)", "type": "number", "min": 0, "max": 86400, "default": null, "nullable": true, "allowedScopes": ["global", "bot"], "apply": "config" }),
        json!({ "key": "operation.maxUsesPerHour", "label": "Giới hạn lượt/giờ", "type": "number", "min": 0, "max": 100000, "default": null, "nullable": true, "allowedScopes": ["global", "bot"], "apply": "config" }),
    ];
    if spec.required_runtime_deps.contains(&"ffmpeg") {
        operation_fields.push(json!({
            "key": "operation.requireFfmpeg",
            "label": "Yêu cầu ffmpeg",
            "type": "boolean",
            "default": true,
            "allowedScopes": ["global"],
            "apply": "config",
            "readOnly": true,
        }));
    }

    let mut response_fields = vec![
        json!({ "key": "responses.useCustomTemplates", "label": "Dùng template riêng", "type": "boolean", "default": false, "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
        json!({ "key": "responses.templates.onSuccess", "label": "Template thành công", "type": "template", "default": "", "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
        json!({ "key": "responses.templates.onCooldown", "label": "Template cooldown", "type": "template", "default": "", "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
        json!({ "key": "responses.templates.onPermissionDenied", "label": "Template thiếu quyền", "type": "template", "default": "", "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
        json!({ "key": "responses.templates.onScopeDenied", "label": "Template sai phạm vi", "type": "template", "default": "", "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
        json!({ "key": "responses.templates.onError", "label": "Template lỗi", "type": "template", "default": "", "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
        json!({ "key": "responses.templates.onKillSwitch", "label": "Template kill switch", "type": "template", "default": "", "allowedScopes": ["global", "bot", "group"], "apply": "config" }),
    ];

    let providers: Vec<&str> = spec
        .required_secrets
        .iter()
        .flat_map(|g| g.iter().copied())
        .collect();
    let deps_joined = if spec.required_runtime_deps.is_empty() {
        "(không có ngoài zaloSession)".to_string()
    } else {
        spec.required_runtime_deps.join(", ")
    };
    let providers_joined = if providers.is_empty() {
        "(không gọi provider cấu hình)".to_string()
    } else {
        providers.join(", ")
    };
    let flow_desc = format!(
        "Dispatch -> Rust static handler {}::{} -> ZaloSession phản hồi vào thread.",
        spec.handler_module, spec.handler_export
    );

    if spec.name == "sendtask" {
        operation_fields.push(json!({ "key": "operation.retry.maxRetries", "label": "Số lần retry", "type": "number", "min": 0, "max": 5, "default": 2, "allowedScopes": ["global", "bot"], "apply": "scheduler" }));
        operation_fields.push(json!({ "key": "operation.retry.backoffMs", "label": "Backoff giữa retry (ms)", "type": "number", "min": 0, "max": 30000, "default": 1500, "allowedScopes": ["global", "bot"], "apply": "scheduler" }));
        operation_fields.push(json!({ "key": "operation.retry.disableOnMissingGroup", "label": "Tắt nhóm khi không tồn tại", "type": "boolean", "default": true, "allowedScopes": ["global", "bot", "group"], "apply": "scheduler" }));

        response_fields.push(json!({ "key": "responses.messages.on", "label": "Phản hồi khi bật", "type": "template", "default": "Đã bật chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!", "allowedScopes": ["global", "bot", "group"], "apply": "config" }));
        response_fields.push(json!({ "key": "responses.messages.off", "label": "Phản hồi khi tắt", "type": "template", "default": "Đã tắt chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!", "allowedScopes": ["global", "bot", "group"], "apply": "config" }));
        response_fields.push(json!({ "key": "responses.messages.toggle", "label": "Phản hồi khi toggle ({state})", "type": "template", "default": "Đã {state} chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!", "allowedScopes": ["global", "bot", "group"], "apply": "config" }));
    }

    let mut tabs = vec![
        json!({
            "id": "overview",
            "title": "Tổng quan",
            "fields": [
                read_only_field("meta.description", "Mô tả", spec.description, ""),
                read_only_field("meta.type", "Kiểu lệnh (type)", spec.legacy_type, ""),
                read_only_field("meta.scope", "Phạm vi chat", scope_str, ""),
                read_only_field("meta.active", "Đang bật trong registry", "true", ""),
                read_only_field("meta.phase", "Phase migrate", spec.phase, ""),
                read_only_field("meta.risk", "Mức rủi ro", risk_str, ""),
                read_only_field("meta.minArgs", "Số đối số tối thiểu", spec.min_args, ""),
                read_only_field("meta.requiresDb", "Cần database", spec.requires_db, ""),
            ]
        }),
        json!({
            "id": "handler",
            "title": "Handler & luồng",
            "fields": [
                read_only_field("handler.module", "Module handler", spec.handler_module, ""),
                read_only_field("handler.export", "Export handler", spec.handler_export, ""),
                read_only_field("handler.dependencies", "Dependency bắt buộc", deps_joined, ""),
                read_only_field("handler.providers", "Provider/API ngoài", providers_joined, ""),
                read_only_field("handler.flow", "Luồng xử lý", &flow_desc, ""),
            ]
        }),
    ];

    if spec.name == "sendtask" {
        tabs.push(json!({
            "id": "schedules",
            "title": "Lịch gửi",
            "fields": [
                { "key": "schedules.enabled", "label": "Bật scheduler", "type": "boolean", "default": true, "allowedScopes": ["global", "bot"], "apply": "scheduler" },
                { "key": "schedules.timezone", "label": "Múi giờ mặc định", "type": "string", "default": "Asia/Ho_Chi_Minh", "allowedScopes": ["global", "bot"], "apply": "scheduler" },
                { "key": "schedules.items", "label": "24 lịch gửi theo giờ", "type": "table", "default": build_default_sendtask_schedules(), "allowedScopes": ["global", "bot"], "apply": "scheduler", "itemPanel": true }
            ]
        }));
        tabs.push(json!({
            "id": "sources",
            "title": "Nguồn",
            "fields": [
                read_only_field("sources.girlVideo", "Flow 1: Girl video", "Category: default / sexy / cosplay / anime / sex", ""),
                read_only_field("sources.tiktokSearch", "Flow 2: TikTok search", "Query template, {{timestamp}} để chống cache", ""),
                read_only_field("sources.zingChart", "Flow 3: Zing chart music", "Bài hát ngẫu nhiên từ bảng xếp hạng Zing", ""),
                { "key": "sources.tiktokQueryFallback", "label": "Query TikTok dự phòng", "type": "template", "default": "nhạc chill cảnh đẹp {{timestamp}}", "allowedScopes": ["global", "bot"], "apply": "scheduler" }
            ]
        }));
    }

    tabs.push(json!({ "id": "operation", "title": "Vận hành", "fields": operation_fields }));
    tabs.push(json!({ "id": "responses", "title": "Phản hồi", "fields": response_fields }));
    tabs.push(json!({
        "id": "permissions",
        "title": "Quyền & giới hạn",
        "fields": [
            { "key": "access.permission", "label": "Quyền tối thiểu", "type": "select", "options": ["all", "adminBox", "adminBot", "adminLevelHigh"], "default": perm_str, "allowedScopes": ["global", "bot", "group"], "apply": "config" },
            { "key": "aliases", "label": "Bí danh bổ sung", "type": "table", "default": spec.aliases, "allowedScopes": ["global", "bot"], "apply": "config" },
            { "key": "restrictions.mode", "label": "Chế độ giới hạn", "type": "select", "options": ["all", "whitelist", "blacklist"], "default": "all", "allowedScopes": ["global", "bot", "group"], "apply": "config" },
            { "key": "restrictions.allowedThreads", "label": "Thread trong whitelist", "type": "table", "default": [], "allowedScopes": ["global", "bot", "group"], "apply": "config" },
            { "key": "restrictions.blockedThreads", "label": "Thread bị chặn", "type": "table", "default": [], "allowedScopes": ["global", "bot", "group"], "apply": "config" },
            { "key": "restrictions.allowedUsers", "label": "User trong whitelist", "type": "table", "default": [], "allowedScopes": ["global", "bot", "group"], "apply": "config" },
            read_only_field("permissions.registryPermission", "Quyền mặc định registry", perm_str, ""),
            read_only_field("permissions.countdown", "Countdown mặc định", spec.default_cooldown_secs, ""),
        ]
    }));
    tabs.push(json!({ "id": "secrets", "title": "Secrets", "fields": secret_fields }));
    tabs.push(json!({ "id": "history", "title": "Lịch sử", "fields": [] }));

    let adapter = if spec.name == "sendtask" {
        "sendtask-scheduler"
    } else {
        "default-config"
    };

    json!({
        "version": STUDIO_CONTRACT_VERSION,
        "commandName": spec.name,
        "aliases": spec.aliases,
        "permission": perm_str,
        "scope": scope_str,
        "countdown": spec.default_cooldown_secs,
        "status": "active",
        "phase": spec.phase,
        "risk": risk_str,
        "requiresDb": spec.requires_db,
        "adapter": adapter,
        "handlerRef": {
            "module": spec.handler_module,
            "export": spec.handler_export,
            "source": spec.handler_module,
            "dependencies": spec.required_runtime_deps,
            "providers": providers,
            "flow": flow_desc,
        },
        "tabs": tabs,
    })
}

/// Builds the 24 default `:05` hourly schedules (`00:05`..`23:05` in `Asia/Ho_Chi_Minh`)
/// matching `src/commands/studio/sendtask-defaults.js`.
pub fn build_default_sendtask_schedules() -> Value {
    let mut rows = Vec::with_capacity(24);
    for hour in 0u8..24 {
        let id = format!("hour-{hour:02}");
        let cron = format!("5 {hour} * * *");
        let (kind, category, query_tpl, ttl_min) = match hour {
            3 => ("zing-chart", "", None, 180),
            4 | 9 => ("tiktok-search", "", Some("nhạc chill cảnh đẹp {{timestamp}}"), 180),
            6 => ("tiktok-search", "", Some("ngắm bình minh chill {{timestamp}}"), 180),
            17 => ("tiktok-search", "", Some("ngắm hoàng hôn chill {{timestamp}}"), 120),
            19 => ("tiktok-search", "", Some("âm nhạc nhẹ nhàng"), 60),
            20 => ("zing-chart", "", None, 120),
            22 => ("zing-chart", "", None, 300),
            1 | 8 | 12 | 16 | 23 => ("girl-video", "cosplay", None, 60),
            5 | 7 | 13 => ("girl-video", "anime", None, 60),
            10 | 14 => ("girl-video", "default", None, 60),
            _ => ("girl-video", "sexy", None, 60),
        };
        rows.push(json!({
            "id": id,
            "enabled": true,
            "cron": cron,
            "timezone": "Asia/Ho_Chi_Minh",
            "kind": kind,
            "category": category,
            "queryTemplate": query_tpl,
            "fallbackKind": "girl-video",
            "fallbackCategory": "default",
            "caption": format!("> SendTask {hour:02}:05 <\nChúc các bạn nhiều năng lượng tích cực!"),
            "ttlMinutes": ttl_min,
        }));
    }
    Value::Array(rows)
}
