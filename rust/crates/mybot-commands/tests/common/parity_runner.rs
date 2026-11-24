//! Deterministic V3 <-> Rust Parity Test Harness Runner
//!
//! Provides deterministic mock context, recorded outbound sink,
//! character-level text comparison, envelope inspection (TTL, mentions, quote, style),
//! and SHA-256 attachment verification.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use hex;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use zalo_sdk::OutboundMessage;

use mybot_commands::{CommandRuntimeBundle, build_full_command_registry};
use mybot_core::{
    BotExecutionMeta, BotStyleProfile, CommandOutcome, DispatchReport, FastPathDispatcher,
    ProtectionEngine, StudioEngine, WorkloadBroker,
};
use mybot_storage::{HotStorageCaches, StorageEngine};
use mybot_types::{EventSource, InboundMessage, MessageContent, PermissionTier, ThreadType, ZaloId};

/// Helper to locate the repository root across test environments.
pub fn find_repo_root() -> PathBuf {
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

/// Computes a hex-encoded SHA-256 digest of arbitrary bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Specifications for checking outbound envelope fields.
#[derive(Debug, Default, Clone)]
pub struct EnvelopeExpectation {
    pub has_quote: Option<bool>,
    pub expected_ttl_ms: Option<u64>,
    pub min_mentions: Option<usize>,
    pub has_style: Option<bool>,
    pub has_attachments: Option<bool>,
}

/// Result of a single deterministic command execution via ParityRunner.
#[allow(dead_code)]
pub struct ParityExecutionResult {
    pub report: DispatchReport,
    pub outbounds: Vec<OutboundMessage>,
    pub duration: std::time::Duration,
}

#[allow(dead_code)]
impl ParityExecutionResult {
    /// Returns the primary text from the last outbound message, or reply_text from Handled outcome.
    pub fn primary_text(&self) -> String {
        if let Some(last) = self.outbounds.last() {
            return last.text.clone();
        }
        match &self.report {
            DispatchReport::CommandExecuted {
                outcome: CommandOutcome::Handled { reply_text, summary, .. },
                ..
            } => reply_text.clone().unwrap_or_else(|| summary.clone()),
            DispatchReport::CommandExecuted {
                outcome: CommandOutcome::Denied { message, .. },
                ..
            } => message.clone(),
            _ => String::new(),
        }
    }

    /// Exact character-by-character text equality check (unicode, whitespace, emoji preserved).
    pub fn assert_text_exact(&self, expected: &str) {
        let actual = self.primary_text();
        assert_eq!(
            actual, expected,
            "Parity text mismatch!\nExpected: {:?}\nActual:   {:?}",
            expected, actual
        );
    }

    /// Substring assertion.
    pub fn assert_text_contains(&self, substr: &str) {
        let actual = self.primary_text();
        assert!(
            actual.contains(substr),
            "Expected text to contain {:?}, but got:\n{:?}",
            substr, actual
        );
    }

    /// Envelope verification (TTL, quote, mentions, style, attachments).
    pub fn assert_envelope(&self, expect: &EnvelopeExpectation) {
        let last = self
            .outbounds
            .last()
            .expect("Expected at least one OutboundMessage in sink to verify envelope");

        if let Some(quote_req) = expect.has_quote {
            assert_eq!(
                last.quote.is_some(),
                quote_req,
                "Quote expectation failed: expected={}, got={}",
                quote_req,
                last.quote.is_some()
            );
        }

        if let Some(expected_ttl) = expect.expected_ttl_ms {
            assert_eq!(
                last.ttl_ms, expected_ttl,
                "TTL expectation failed: expected={}ms, got={}ms",
                expected_ttl, last.ttl_ms
            );
        }

        if let Some(min_mentions) = expect.min_mentions {
            assert!(
                last.mentions.len() >= min_mentions,
                "Mentions count expectation failed: expected >= {}, got {}",
                min_mentions,
                last.mentions.len()
            );
        }

        if let Some(has_style) = expect.has_style {
            assert_eq!(
                last.style.is_some(),
                has_style,
                "Style expectation failed: expected={}, got={}",
                has_style,
                last.style.is_some()
            );
        }

        if let Some(has_att) = expect.has_attachments {
            assert_eq!(
                !last.attachments.is_empty(),
                has_att,
                "Attachments expectation failed: expected={}, got={}",
                has_att,
                !last.attachments.is_empty()
            );
        }
    }

    /// Verifies that any attachment in the message matches the expected SHA-256 hash.
    pub fn assert_attachment_sha256(&self, expected_sha256: &str) {
        let last = self
            .outbounds
            .last()
            .expect("Expected at least one OutboundMessage to check attachment hash");
        assert!(
            !last.attachments.is_empty(),
            "Outbound message has no attachments to hash"
        );
        let found = last.attachments.iter().any(|path| {
            if let Ok(bytes) = std::fs::read(path) {
                sha256_hex(&bytes).eq_ignore_ascii_case(expected_sha256)
            } else {
                false
            }
        });
        assert!(
            found,
            "No attachment matched expected SHA-256: {}",
            expected_sha256
        );
    }
}

/// Parity Test Harness runner providing mock deterministic clock, seed, and network sink.
#[allow(dead_code)]
pub struct ParityRunner {
    pub repo_root: PathBuf,
    pub caches: HotStorageCaches,
    pub runtime_bundle: Arc<CommandRuntimeBundle>,
    pub dispatcher: Arc<FastPathDispatcher>,
    pub studio: Arc<StudioEngine>,
    pub outbound_sink: Arc<Mutex<Vec<OutboundMessage>>>,
    pub default_prefix: String,
    pub default_bot_key: String,
    pub default_self_uid: String,
}

#[allow(dead_code)]
impl ParityRunner {
    /// Creates a fully initialized deterministic Parity test harness.
    pub fn new() -> Self {
        let repo_root = find_repo_root();
        let engine = StorageEngine::open_in_memory().expect("open in-memory storage");
        let caches = HotStorageCaches::load_from_engine(engine).expect("load storage caches");
        let runtime_bundle = Arc::new(CommandRuntimeBundle::new(&repo_root, caches.clone()));
        let registry = build_full_command_registry(runtime_bundle.clone())
            .expect("registry builds with zero collisions");

        let studio = Arc::new(StudioEngine::new(registry, caches.clone()));
        let dispatcher = Arc::new(FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio.clone(),
            WorkloadBroker::default(),
            128,
        ));

        let outbound_sink = Arc::new(Mutex::new(Vec::new()));

        // Enable bot in test group by default
        caches.update_group_settings("main", "grp_test_parity_1", |rec| {
            rec.enable_bot = true;
            rec.settings = serde_json::json!({ "activeBot": true });
        });

        Self {
            repo_root,
            caches,
            runtime_bundle,
            dispatcher,
            studio,
            outbound_sink,
            default_prefix: "!".into(),
            default_bot_key: "main".into(),
            default_self_uid: "bot_main_test_uid".into(),
        }
    }

    /// Clears the recorded outbound sink.
    pub fn clear_sink(&self) {
        self.outbound_sink.lock().clear();
    }

    /// Builds a deterministic InboundMessage.
    pub fn build_inbound(
        &self,
        text: &str,
        thread_type: ThreadType,
        thread_id: &str,
        sender_uid: &str,
        sender_name: &str,
    ) -> InboundMessage {
        InboundMessage {
            bot_key: self.default_bot_key.clone().into(),
            msg_id: ZaloId::new("msg_parity_1001"),
            cli_msg_id: ZaloId::new("cli_parity_1001"),
            global_msg_id: ZaloId::new("global_parity_1001"),
            thread_id: ZaloId::new(thread_id),
            thread_type,
            sender_uid: ZaloId::new(sender_uid),
            sender_name: sender_name.to_string(),
            is_self: false,
            msg_type: "webchat".into(),
            timestamp_ms: 1_700_000_000_000, // Deterministic mock timestamp
            ws_received_at_ms: 1_700_000_000_005,
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

    /// Builds a deterministic BotExecutionMeta.
    pub fn build_meta(&self, sender_tier: PermissionTier) -> BotExecutionMeta {
        BotExecutionMeta {
            bot_key: self.default_bot_key.clone(),
            is_main_bot: true,
            self_uid: ZaloId::new(&self.default_self_uid),
            prefix: self.default_prefix.clone(),
            self_listen: true,
            identity_pending: false,
            sender_tier,
            zalo: None,
            assets_root: self.repo_root.join("assets"),
            style_profile: BotStyleProfile::default(),
            chat_policy_group: true,
            chat_policy_private: true,
            fleet: None,
            outbound_sink: Some(self.outbound_sink.clone()),
        }
    }

    /// Executes a command in a Group context with the specified caller permission tier.
    pub async fn execute_group_cmd(
        &self,
        command_text: &str,
        tier: PermissionTier,
    ) -> ParityExecutionResult {
        self.clear_sink();
        let msg = self.build_inbound(
            command_text,
            ThreadType::Group,
            "grp_test_parity_1",
            "caller_user_uid_1",
            "Caller Tester",
        );
        let meta = self.build_meta(tier);
        let t_start = Instant::now();
        let report = self.dispatcher.dispatch_inbound(meta, msg).await;
        let duration = t_start.elapsed();
        let outbounds = self.outbound_sink.lock().clone();
        ParityExecutionResult {
            report,
            outbounds,
            duration,
        }
    }

    /// Executes a command in a Private (DM) context with the specified caller permission tier.
    pub async fn execute_dm_cmd(
        &self,
        command_text: &str,
        tier: PermissionTier,
    ) -> ParityExecutionResult {
        self.clear_sink();
        let msg = self.build_inbound(
            command_text,
            ThreadType::User,
            "dm_test_parity_1",
            "dm_user_uid_1",
            "DM Caller",
        );
        let meta = self.build_meta(tier);
        let t_start = Instant::now();
        let report = self.dispatcher.dispatch_inbound(meta, msg).await;
        let duration = t_start.elapsed();
        let outbounds = self.outbound_sink.lock().clone();
        ParityExecutionResult {
            report,
            outbounds,
            duration,
        }
    }
}
