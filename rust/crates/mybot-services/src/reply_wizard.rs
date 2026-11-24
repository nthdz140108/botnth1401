//! Multi-turn Interactive Selection & Reply State Machine (`moka::sync::Cache`, 90s TTL).
//!
//! Powers numbered search menus (`!youtube`, `!zingmp3`, `!soundcloud`, `!spotify`, `!nhaccuatui`,
//! `!tiktok`, `!capcut`) and multi-step `mybot` / `sticker` interactive wizards without leaking memory.

use std::time::Duration;

use moka::sync::Cache;
use serde::{Deserialize, Serialize};

use crate::crawlers::MediaSearchItem;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WizardPayload {
    MediaSelection {
        platform: String,
        audio_only: bool,
        items: Vec<MediaSearchItem>,
    },
    CustomStep {
        command: String,
        step: String,
        state: serde_json::Value,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WizardSession {
    pub bot_key: String,
    pub thread_id: String,
    pub sender_uid: String,
    pub prompt_msg_id: Option<String>,
    pub payload: WizardPayload,
}

#[derive(Clone)]
pub struct InteractionWizard {
    sessions: Cache<String, WizardSession>,
}

impl std::fmt::Debug for InteractionWizard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InteractionWizard")
            .field("entry_count", &self.sessions.entry_count())
            .finish()
    }
}

impl Default for InteractionWizard {
    fn default() -> Self {
        Self::new(Duration::from_secs(90), 8_192)
    }
}

impl InteractionWizard {
    pub fn new(ttl: Duration, max_capacity: u64) -> Self {
        Self {
            sessions: Cache::builder()
                .max_capacity(max_capacity)
                .time_to_live(ttl)
                .build(),
        }
    }

    pub fn make_key(bot_key: &str, thread_id: &str, sender_uid: &str) -> String {
        format!("{bot_key}:{thread_id}:{sender_uid}")
    }

    pub fn register(&self, session: WizardSession) {
        let key = Self::make_key(&session.bot_key, &session.thread_id, &session.sender_uid);
        self.sessions.insert(key, session);
    }

    pub fn peek(&self, bot_key: &str, thread_id: &str, sender_uid: &str) -> Option<WizardSession> {
        let key = Self::make_key(bot_key, thread_id, sender_uid);
        self.sessions.get(&key)
    }

    /// Consumes a numeric choice (`1..=N`) if an active `MediaSelection` wizard exists for this user.
    pub fn try_consume_media_choice(
        &self,
        bot_key: &str,
        thread_id: &str,
        sender_uid: &str,
        raw_text: &str,
    ) -> Option<(String, bool, MediaSearchItem)> {
        let choice: usize = raw_text.trim().parse().ok()?;
        if choice == 0 {
            return None;
        }
        let key = Self::make_key(bot_key, thread_id, sender_uid);
        let session = self.sessions.get(&key)?;
        match session.payload {
            WizardPayload::MediaSelection {
                platform,
                audio_only,
                items,
            } => {
                let item = items.get(choice - 1)?.clone();
                self.sessions.invalidate(&key);
                Some((platform, audio_only, item))
            }
            WizardPayload::CustomStep { .. } => None,
        }
    }

    pub fn clear(&self, bot_key: &str, thread_id: &str, sender_uid: &str) {
        let key = Self::make_key(bot_key, thread_id, sender_uid);
        self.sessions.invalidate(&key);
    }
}
