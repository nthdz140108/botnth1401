//! High-speed Message Protection Engine: Mute Gate, `aho-corasick` BadWord Automaton,
//! all 17 Ordered Moderation Rules (`src/automations/message-protection.js` parity),
//! Per-User Sequential Strike Escalation, and `!antiundo` Recall Recovery.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, LazyLock};

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use arc_swap::ArcSwap;
use chrono::{TimeZone, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use dashmap::DashMap;
use mybot_storage::{CachedMessageRecord, GroupSettingsRecord};
use mybot_types::{InboundMessage, MessageContent, PermissionTier, ThreadType, UndoEvent};
use regex::{Regex, RegexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Linear-time boundary-safe URL detector replacing V3's backtracking `(?<!\w)` regex.
static LINK_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:https?://|www\.)\S+|\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|vn|com\.vn|info|biz|io|xyz|me|tv|online|store|club|site|app|blog|dev|tech|cloud|game|shop|click|space|asia|fun|tokyo|website|zpg\.vn|zalo\.me|t\.me|bit\.ly|tinyurl\.com|co|gov|edu)(?:/\S*)?\b",
    )
    .expect("valid LINK_REGEX")
});

/// Vietnamese & international phone number detector (`09xx`, `+84xx`, spaced/dotted digits).
static PHONE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\+?84|0)(?:[\s.\-_]*\d){8,10}\b").expect("valid PHONE_REGEX")
});

/// Ordered identifiers of all 17 message protection rules plus `mute` and `antiBadWord`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProtectionRuleId {
    Mute,
    AntiBadWord,
    AntiBot,
    OnlyText,
    AntiPhotoVideo,
    AntiVideo,
    AntiAllEffectGif,
    AntiVoice,
    AntiText,
    AntiFile,
    AntiForward,
    AntiLink,
    AntiPhoneNumber,
    AntiTag,
    AntiSpam,
    AntiNude,
    AntiStickerEffect,
    AntiEffectSticker,
    AntiAllEffectSticker,
}

impl ProtectionRuleId {
    pub const ORDERED_17: [Self; 17] = [
        Self::AntiBot,
        Self::OnlyText,
        Self::AntiPhotoVideo,
        Self::AntiVideo,
        Self::AntiAllEffectGif,
        Self::AntiVoice,
        Self::AntiText,
        Self::AntiFile,
        Self::AntiForward,
        Self::AntiLink,
        Self::AntiPhoneNumber,
        Self::AntiTag,
        Self::AntiSpam,
        Self::AntiNude,
        Self::AntiStickerEffect,
        Self::AntiEffectSticker,
        Self::AntiAllEffectSticker,
    ];

    pub const fn as_v3_name(self) -> &'static str {
        match self {
            Self::Mute => "mute",
            Self::AntiBadWord => "antiBadWord",
            Self::AntiBot => "antiBot",
            Self::OnlyText => "onlyText",
            Self::AntiPhotoVideo => "antiPhotoVideo",
            Self::AntiVideo => "antiVideo",
            Self::AntiAllEffectGif => "antiAllEffectGif",
            Self::AntiVoice => "antiVoice",
            Self::AntiText => "antiText",
            Self::AntiFile => "antiFile",
            Self::AntiForward => "antiForward",
            Self::AntiLink => "antiLink",
            Self::AntiPhoneNumber => "antiPhoneNumber",
            Self::AntiTag => "antiTag",
            Self::AntiSpam => "antiSpam",
            Self::AntiNude => "antiNude",
            Self::AntiStickerEffect => "antiStickerEffect",
            Self::AntiEffectSticker => "antiEffectSticker",
            Self::AntiAllEffectSticker => "antiAllEffectSticker",
        }
    }

    pub const fn reason_vi(self) -> &'static str {
        match self {
            Self::Mute => "Đang trong danh sách cấm chat (mute)",
            Self::AntiBadWord => "Sử dụng từ ngữ vi phạm trong nhóm",
            Self::AntiBot => "Phát hiện hành vi bot tự động",
            Self::OnlyText => "Nhóm hiện chỉ cho phép nhắn văn bản",
            Self::AntiPhotoVideo => "Nhóm đang chặn gửi ảnh và video",
            Self::AntiVideo => "Nhóm đang chặn gửi video",
            Self::AntiAllEffectGif => "Nhóm đang chặn gửi ảnh động GIF",
            Self::AntiVoice => "Nhóm đang chặn gửi tin nhắn thoại",
            Self::AntiText => "Nhóm đang tạm khóa nhắn văn bản",
            Self::AntiFile => "Nhóm đang chặn gửi tệp đính kèm",
            Self::AntiForward => "Nhóm đang chặn chuyển tiếp tin nhắn",
            Self::AntiLink => "Nhóm đang chặn gửi liên kết / danh thiếp",
            Self::AntiPhoneNumber => "Nhóm đang chặn gửi số điện thoại",
            Self::AntiTag => "Nhóm đang chặn tag @All hoặc tag quá nhiều thành viên",
            Self::AntiSpam => "Nhắn tin quá nhanh (spam)",
            Self::AntiNude => "Phát hiện hình ảnh/video nhạy cảm (NSFW)",
            Self::AntiStickerEffect => "Nhóm đang chặn sticker hiệu ứng nằm trong danh sách cấm",
            Self::AntiEffectSticker => "Nhóm đang chặn sticker hiệu ứng âm thanh/động",
            Self::AntiAllEffectSticker => "Nhóm đang chặn toàn bộ sticker",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModerationDecision {
    Allow,
    DeleteOnly {
        rule: ProtectionRuleId,
        reason: String,
    },
    WarnAndDelete {
        rule: ProtectionRuleId,
        strike: u32,
        threshold: u32,
        matched_term: Option<String>,
        warning_text: String,
    },
    KickAndDelete {
        rule: ProtectionRuleId,
        strike: u32,
        threshold: u32,
        matched_term: Option<String>,
        kick_text: String,
    },
}

impl ModerationDecision {
    pub fn is_blocked(&self) -> bool {
        !matches!(self, Self::Allow)
    }
}

struct BadWordSnapshot {
    words: Vec<String>,
    automaton: Option<AhoCorasick>,
    regex_set: Option<RegexSet>,
}

/// Hot-reloadable `aho-corasick` + `RegexSet` automaton (`~150ns` scan per chat message).
#[derive(Clone)]
pub struct CompiledBadWordSet {
    inner: Arc<ArcSwap<BadWordSnapshot>>,
}

impl Default for CompiledBadWordSet {
    fn default() -> Self {
        Self::new(
            &["địt", "đụ", "lồn", "cặc", "đéo", "vãi lồn", "đm", "vcl"],
            &[] as &[&str],
        )
    }
}

impl CompiledBadWordSet {
    pub fn new(words: &[impl AsRef<str>], regex_patterns: &[impl AsRef<str>]) -> Self {
        let snap = Self::compile_snapshot(words, regex_patterns);
        Self {
            inner: Arc::new(ArcSwap::from_pointee(snap)),
        }
    }

    pub fn reload(&self, words: &[impl AsRef<str>], regex_patterns: &[impl AsRef<str>]) {
        let snap = Self::compile_snapshot(words, regex_patterns);
        self.inner.store(Arc::new(snap));
    }

    fn compile_snapshot(
        words: &[impl AsRef<str>],
        regex_patterns: &[impl AsRef<str>],
    ) -> BadWordSnapshot {
        let mut clean_words: Vec<String> = words
            .iter()
            .map(|w| w.as_ref().trim().to_lowercase())
            .filter(|w| !w.is_empty())
            .collect();
        clean_words.sort();
        clean_words.dedup();

        let automaton = if clean_words.is_empty() {
            None
        } else {
            AhoCorasickBuilder::new()
                .ascii_case_insensitive(true)
                .match_kind(MatchKind::LeftmostLongest)
                .build(&clean_words)
                .ok()
        };

        let valid_regexes: Vec<String> = regex_patterns
            .iter()
            .map(|p| p.as_ref().trim().to_string())
            .filter(|p| !p.is_empty() && Regex::new(p).is_ok())
            .collect();
        let regex_set = if valid_regexes.is_empty() {
            None
        } else {
            RegexSet::new(&valid_regexes).ok()
        };

        BadWordSnapshot {
            words: clean_words,
            automaton,
            regex_set,
        }
    }

    pub fn words(&self) -> Vec<String> {
        self.inner.load().words.clone()
    }

    /// Scans `text` on word boundaries so short badwords never false-positive inside normal words.
    pub fn find_violation(&self, text: &str) -> Option<String> {
        if text.trim().is_empty() {
            return None;
        }
        let lowered = text.to_lowercase();
        let guard = self.inner.load();

        if let Some(ac) = &guard.automaton {
            for mat in ac.find_iter(&lowered) {
                let start = mat.start();
                let end = mat.end();
                let left_ok = start == 0
                    || lowered[..start]
                        .chars()
                        .next_back()
                        .is_none_or(|c| !c.is_alphanumeric());
                let right_ok = end == lowered.len()
                    || lowered[end..]
                        .chars()
                        .next()
                        .is_none_or(|c| !c.is_alphanumeric());
                if left_ok && right_ok {
                    return guard.words.get(mat.pattern().as_usize()).cloned();
                }
            }
        }

        if let Some(rs) = &guard.regex_set
            && let Some(idx) = rs.matches(&lowered).into_iter().next()
        {
            return Some(format!("regex#{idx}"));
        }

        None
    }
}

#[derive(Default)]
struct UserStrikeState {
    strikes: u32,
    last_violation_ms: i64,
    recent_msg_timestamps_ms: VecDeque<i64>,
}

/// Optional async NSFW image/video scorer trait so `mybot-media` (`ort`) can plug into `mybot-core`.
#[async_trait::async_trait]
pub trait NsfwScorer: Send + Sync + 'static {
    async fn score_media_url(&self, url: &str, is_video: bool) -> Option<f32>;
}

type UserStrikeKey = (String, String, String);
type SharedUserStrikeState = Arc<tokio::sync::Mutex<UserStrikeState>>;

#[derive(Clone)]
pub struct ProtectionEngine {
    bad_words: CompiledBadWordSet,
    banned_sticker_ids: Arc<ArcSwap<HashSet<u64>>>,
    banned_sticker_cates: Arc<ArcSwap<HashSet<u64>>>,
    /// Per `(bot_key, thread_id, sender_uid)` sequential mutex preventing concurrent strike races.
    user_states: Arc<DashMap<UserStrikeKey, SharedUserStrikeState>>,
    nsfw_scorer: Option<Arc<dyn NsfwScorer>>,
}

impl Default for ProtectionEngine {
    fn default() -> Self {
        Self::new(CompiledBadWordSet::default(), None)
    }
}

impl ProtectionEngine {
    pub fn new(bad_words: CompiledBadWordSet, nsfw_scorer: Option<Arc<dyn NsfwScorer>>) -> Self {
        Self {
            bad_words,
            banned_sticker_ids: Arc::new(ArcSwap::from_pointee(HashSet::new())),
            banned_sticker_cates: Arc::new(ArcSwap::from_pointee(HashSet::new())),
            user_states: Arc::new(DashMap::new()),
            nsfw_scorer,
        }
    }

    /// Loads `badWords` from V3 `src/service-debug/anti-service/config-anti.json` and banned
    /// effect stickers from `src/service-debug/anti-service/data-sticker/list.json` if present.
    pub fn load_from_v3_assets(project_root: &Path, nsfw_scorer: Option<Arc<dyn NsfwScorer>>) -> Self {
        let engine = Self::new(CompiledBadWordSet::default(), nsfw_scorer);

        let anti_cfg_path = project_root.join("src/service-debug/anti-service/config-anti.json");
        if let Ok(raw) = std::fs::read_to_string(&anti_cfg_path)
            && let Ok(val) = serde_json::from_str::<Value>(&raw)
            && let Some(arr) = val.get("badWords").and_then(Value::as_array)
        {
            let words: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect();
            if !words.is_empty() {
                engine.bad_words.reload(&words, &Vec::<String>::new());
            }
        }

        let sticker_list_path =
            project_root.join("src/service-debug/anti-service/data-sticker/list.json");
        if let Ok(raw) = std::fs::read_to_string(&sticker_list_path)
            && let Ok(val) = serde_json::from_str::<Value>(&raw)
        {
            let mut ids = HashSet::new();
            let mut cates = HashSet::new();
            if let Some(arr) = val.as_array() {
                for item in arr {
                    if let Some(id) = item
                        .get("id")
                        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
                    {
                        ids.insert(id);
                    }
                    if let Some(cid) = item
                        .get("cateId")
                        .or_else(|| item.get("catId"))
                        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
                    {
                        cates.insert(cid);
                    }
                }
            }
            engine.set_banned_stickers(ids, cates);
        }

        engine
    }

    pub fn bad_words(&self) -> &CompiledBadWordSet {
        &self.bad_words
    }

    pub fn set_banned_stickers(&self, sticker_ids: HashSet<u64>, cate_ids: HashSet<u64>) {
        self.banned_sticker_ids.store(Arc::new(sticker_ids));
        self.banned_sticker_cates.store(Arc::new(cate_ids));
    }

    pub fn clear_strikes(&self, bot_key: &str, thread_id: &str, sender_uid: &str) {
        self.user_states.remove(&(
            bot_key.to_string(),
            thread_id.to_string(),
            sender_uid.to_string(),
        ));
    }

    /// Evaluates Mute Gate -> BadWord Automaton -> all 17 Ordered Protection Rules sequentially
    /// under the user's strike lock so concurrent spam messages escalate `1 -> 2 -> 3` cleanly.
    pub async fn inspect_inbound(
        &self,
        bot_key: &str,
        msg: &InboundMessage,
        group: &GroupSettingsRecord,
        sender_tier: PermissionTier,
    ) -> ModerationDecision {
        // Group moderation only applies in Group threads when the bot is enabled for the group
        if msg.thread_type != ThreadType::Group || !group.enable_bot || msg.is_self {
            return ModerationDecision::Allow;
        }
        // Group admins, bot admins, and explicitly whitelisted members bypass moderation
        if sender_tier >= PermissionTier::AdminBox || is_user_whitelisted(group, &msg.sender_uid) {
            return ModerationDecision::Allow;
        }

        let now_ms = if msg.timestamp_ms > 0 {
            msg.timestamp_ms
        } else {
            Utc::now().timestamp_millis()
        };

        // Acquire per-(bot, group, user) mutex so burst messages serialize strike counting
        let state_arc = self
            .user_states
            .entry((
                bot_key.to_string(),
                msg.thread_id.as_str().to_string(),
                msg.sender_uid.as_str().to_string(),
            ))
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(UserStrikeState::default())))
            .clone();
        let mut user_state = state_arc.lock().await;

        // Maintain sliding 4-second spam window
        let spam_window_ms = group
            .settings
            .get("spamWindowMs")
            .and_then(Value::as_i64)
            .unwrap_or(4_000);
        while let Some(&front) = user_state.recent_msg_timestamps_ms.front() {
            if now_ms.saturating_sub(front) > spam_window_ms {
                user_state.recent_msg_timestamps_ms.pop_front();
            } else {
                break;
            }
        }
        user_state.recent_msg_timestamps_ms.push_back(now_ms);
        let burst_count = user_state.recent_msg_timestamps_ms.len();

        // 0a. Mute Gate (silent immediate deletion)
        if is_user_muted(group, &msg.sender_uid, now_ms) {
            return ModerationDecision::DeleteOnly {
                rule: ProtectionRuleId::Mute,
                reason: ProtectionRuleId::Mute.reason_vi().to_string(),
            };
        }

        // 0b. `antiBadWord` check (global Aho-Corasick + group custom badwords)
        let text = msg.content.text_or_caption();
        if group.anti_bad_word
            && let Some(term) = self.check_bad_word(text, group)
        {
            return self.escalate_strike(
                &mut user_state,
                now_ms,
                group,
                &msg.sender_name,
                ProtectionRuleId::AntiBadWord,
                Some(term),
            );
        }

        // 1..17 Exact Ordered Protection Rules (`message-protection.js` parity)
        for rule in ProtectionRuleId::ORDERED_17 {
            let violated = match rule {
                ProtectionRuleId::AntiBot => group.anti_bot && is_suspected_bot_message(msg, group),
                ProtectionRuleId::OnlyText => {
                    group.only_text && !matches!(msg.content, MessageContent::Text { .. })
                }
                ProtectionRuleId::AntiPhotoVideo => {
                    group.anti_photo_video
                        && matches!(
                            msg.content,
                            MessageContent::Photo { .. } | MessageContent::Video { .. }
                        )
                }
                ProtectionRuleId::AntiVideo => {
                    setting_bool(group, "antiVideo")
                        && matches!(msg.content, MessageContent::Video { .. })
                }
                ProtectionRuleId::AntiAllEffectGif => {
                    (group.anti_gif || setting_bool(group, "antiAllEffectGif"))
                        && matches!(msg.content, MessageContent::Gif { .. })
                }
                ProtectionRuleId::AntiVoice => {
                    group.anti_voice && matches!(msg.content, MessageContent::Voice { .. })
                }
                ProtectionRuleId::AntiText => {
                    group.anti_text && matches!(msg.content, MessageContent::Text { .. })
                }
                ProtectionRuleId::AntiFile => {
                    group.anti_file && matches!(msg.content, MessageContent::File { .. })
                }
                ProtectionRuleId::AntiForward => group.anti_forward && is_forwarded_message(msg),
                ProtectionRuleId::AntiLink => {
                    (group.anti_link && has_disallowed_link(msg, group))
                        || (group.anti_card && matches!(msg.content, MessageContent::Card { .. }))
                }
                ProtectionRuleId::AntiPhoneNumber => {
                    setting_bool(group, "antiPhoneNumber") && PHONE_REGEX.is_match(text)
                }
                ProtectionRuleId::AntiTag => {
                    (group.anti_mention || setting_bool(group, "antiTag"))
                        && has_abusive_mentions(msg, group)
                }
                ProtectionRuleId::AntiSpam => {
                    let max_burst = group
                        .settings
                        .get("spamMaxMessages")
                        .and_then(Value::as_u64)
                        .unwrap_or(5) as usize;
                    group.anti_spam && burst_count >= max_burst
                }
                ProtectionRuleId::AntiNude => {
                    group.anti_nude && self.check_nsfw_media(msg, group).await
                }
                ProtectionRuleId::AntiStickerEffect => {
                    group.anti_sticker_effect && self.is_banned_effect_sticker(msg)
                }
                ProtectionRuleId::AntiEffectSticker => {
                    (group.anti_sticker || setting_bool(group, "antiEffectSticker"))
                        && is_animated_effect_sticker(msg)
                }
                ProtectionRuleId::AntiAllEffectSticker => {
                    group.anti_all_effect_sticker
                        && matches!(msg.content, MessageContent::Sticker { .. })
                }
                ProtectionRuleId::Mute | ProtectionRuleId::AntiBadWord => false,
            };

            if violated {
                return self.escalate_strike(
                    &mut user_state,
                    now_ms,
                    group,
                    &msg.sender_name,
                    rule,
                    None,
                );
            }
        }

        ModerationDecision::Allow
    }

    fn check_bad_word(&self, text: &str, group: &GroupSettingsRecord) -> Option<String> {
        if let Some(hit) = self.bad_words.find_violation(text) {
            return Some(hit);
        }
        if let Some(custom_arr) = group.settings.get("badWordCustom").and_then(Value::as_array) {
            let lowered = text.to_lowercase();
            for item in custom_arr {
                if let Some(w) = item.as_str() {
                    let clean = w.trim().to_lowercase();
                    if !clean.is_empty() && lowered.contains(&clean) {
                        return Some(clean);
                    }
                }
            }
        }
        None
    }

    fn is_banned_effect_sticker(&self, msg: &InboundMessage) -> bool {
        let MessageContent::Sticker {
            id,
            cate_id,
            sticker_type,
            ..
        } = &msg.content
        else {
            return false;
        };
        if *sticker_type >= 7 {
            return true;
        }
        self.banned_sticker_ids.load().contains(id)
            || self.banned_sticker_cates.load().contains(cate_id)
    }

    async fn check_nsfw_media(&self, msg: &InboundMessage, group: &GroupSettingsRecord) -> bool {
        let threshold = group
            .settings
            .get("nsfwThreshold")
            .and_then(Value::as_f64)
            .unwrap_or(0.80) as f32;

        let (url, is_video) = match &msg.content {
            MessageContent::Photo { url, .. } | MessageContent::Gif { url, .. } => {
                (url.as_str(), false)
            }
            MessageContent::Video {
                url, thumb_url, ..
            } => (
                thumb_url.as_deref().unwrap_or(url.as_str()),
                true,
            ),
            _ => return false,
        };
        if url.is_empty() {
            return false;
        }

        if let Some(scorer) = &self.nsfw_scorer
            && let Some(score) = scorer.score_media_url(url, is_video).await
        {
            return score >= threshold;
        }
        false
    }

    fn escalate_strike(
        &self,
        state: &mut UserStrikeState,
        now_ms: i64,
        group: &GroupSettingsRecord,
        sender_name: &str,
        rule: ProtectionRuleId,
        matched_term: Option<String>,
    ) -> ModerationDecision {
        // Decay strikes if last violation was more than 1 hour ago
        if state.last_violation_ms > 0 && now_ms.saturating_sub(state.last_violation_ms) > 3_600_000
        {
            state.strikes = 0;
        }
        state.strikes += 1;
        state.last_violation_ms = now_ms;

        let threshold = group
            .settings
            .get("strikeThreshold")
            .and_then(Value::as_u64)
            .unwrap_or(3)
            .max(1) as u32;
        let display = if sender_name.trim().is_empty() {
            "Thành viên"
        } else {
            sender_name.trim()
        };

        if state.strikes >= threshold {
            let final_strike = state.strikes;
            state.strikes = 0;
            ModerationDecision::KickAndDelete {
                rule,
                strike: final_strike,
                threshold,
                matched_term,
                kick_text: format!(
                    "🚫 {display} đã vi phạm quy định nhóm ({final_strike}/{threshold}): {} -> Mời rời nhóm!",
                    rule.reason_vi()
                ),
            }
        } else {
            ModerationDecision::WarnAndDelete {
                rule,
                strike: state.strikes,
                threshold,
                matched_term,
                warning_text: format!(
                    "⚠️ Cảnh cáo {display} ({}/{threshold}): {}",
                    state.strikes,
                    rule.reason_vi()
                ),
            }
        }
    }
}

/// Formats the `!antiundo` recall recovery alert using the cached pre-undo message record.
pub fn build_anti_undo_alert(cached: &CachedMessageRecord, undo: &UndoEvent) -> String {
    let ts_ict = Utc
        .timestamp_millis_opt(undo.timestamp_ms)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&Ho_Chi_Minh)
        .format("%H:%M:%S %d/%m/%Y");

    let name = if cached.sender_name.trim().is_empty() {
        undo.sender_uid.as_str()
    } else {
        cached.sender_name.as_str()
    };

    let raw_content = cached
        .payload
        .get("content")
        .cloned()
        .unwrap_or_else(|| cached.payload.clone());
    let body = if let Ok(content) = serde_json::from_value::<MessageContent>(raw_content) {
        match content {
            MessageContent::Text { text } => format!("💬 Nội dung: {text}"),
            MessageContent::Photo { url, caption, .. } => {
                if caption.is_empty() {
                    format!("🖼️ Ảnh thu hồi: {url}")
                } else {
                    format!("🖼️ Ảnh thu hồi ({caption}): {url}")
                }
            }
            MessageContent::Video { url, caption, .. } => {
                if caption.is_empty() {
                    format!("🎬 Video thu hồi: {url}")
                } else {
                    format!("🎬 Video thu hồi ({caption}): {url}")
                }
            }
            MessageContent::Voice { url, .. } => format!("🎤 Voice thu hồi: {url}"),
            MessageContent::File { file_name, url, .. } => {
                format!("📎 Tệp thu hồi ({file_name}): {url}")
            }
            MessageContent::Sticker { id, .. } => format!("🏷️ Sticker thu hồi (ID: {id})"),
            MessageContent::Gif { url, .. } => format!("🎞️ GIF thu hồi: {url}"),
            MessageContent::Link { url, .. } => format!("🔗 Liên kết thu hồi: {url}"),
            MessageContent::Card { title, .. } => format!("🪪 Danh thiếp thu hồi: {title}"),
            MessageContent::System { msg_type, .. } => format!("⚙️ Tin hệ thống ({msg_type})"),
        }
    } else {
        format!("💬 Nội dung: {}", cached.payload)
    };

    format!("🔎 Phát hiện {name} vừa thu hồi tin nhắn lúc {ts_ict}\n{body}")
}

fn setting_bool(group: &GroupSettingsRecord, key: &str) -> bool {
    group
        .settings
        .get(key)
        .and_then(|v| v.as_bool().or_else(|| v.as_i64().map(|n| n != 0)))
        .unwrap_or(false)
}

fn is_user_whitelisted(group: &GroupSettingsRecord, uid: &str) -> bool {
    if let Some(wl) = group.settings.get("whiteList") {
        if let Some(obj) = wl.as_object() {
            return obj.contains_key(uid);
        }
        if let Some(arr) = wl.as_array() {
            return arr.iter().any(|x| x.as_str() == Some(uid));
        }
    }
    false
}

fn is_user_muted(group: &GroupSettingsRecord, uid: &str, now_ms: i64) -> bool {
    let Some(mute_entry) = group
        .settings
        .get("muteList")
        .and_then(Value::as_object)
        .and_then(|m| m.get(uid))
    else {
        return false;
    };

    let until_val = mute_entry.get("timeMute").unwrap_or(mute_entry);
    match until_val {
        Value::Bool(b) => *b,
        Value::String(s) => {
            if s == "-1" || s.eq_ignore_ascii_case("forever") {
                return true;
            }
            if let Ok(ts) = s.parse::<i64>() {
                let ts_ms = if ts < 1_000_000_000_000 { ts * 1000 } else { ts };
                return ts_ms > now_ms;
            }
            false
        }
        Value::Number(n) => {
            if let Some(ts) = n.as_i64() {
                if ts < 0 {
                    return true;
                }
                let ts_ms = if ts < 1_000_000_000_000 { ts * 1000 } else { ts };
                return ts_ms > now_ms;
            }
            false
        }
        _ => false,
    }
}

fn is_suspected_bot_message(msg: &InboundMessage, group: &GroupSettingsRecord) -> bool {
    if let Some(bot_list) = group.settings.get("botList") {
        if let Some(obj) = bot_list.as_object()
            && obj.contains_key(msg.sender_uid.as_str())
        {
            return true;
        }
        if let Some(arr) = bot_list.as_array()
            && arr.iter().any(|v| v.as_str() == Some(msg.sender_uid.as_str()))
        {
            return true;
        }
    }
    if msg.ttl_ms > 0 && msg.ttl_ms <= 5_000 {
        return true;
    }
    if let Some(ext) = &msg.raw_property_ext
        && ext.get("isBot").and_then(Value::as_bool) == Some(true)
    {
        return true;
    }
    false
}

fn is_forwarded_message(msg: &InboundMessage) -> bool {
    let Some(ext) = &msg.raw_property_ext else {
        return false;
    };
    ext.get("isForward").and_then(Value::as_bool) == Some(true)
        || ext.get("forwardInfo").is_some()
        || ext.get("fwLvl").and_then(Value::as_u64).unwrap_or(0) > 0
        || ext.get("srcId").is_some()
}

fn has_disallowed_link(msg: &InboundMessage, group: &GroupSettingsRecord) -> bool {
    let candidate = match &msg.content {
        MessageContent::Link { url, .. } => url.as_str(),
        _ => msg.content.text_or_caption(),
    };
    if candidate.is_empty() {
        return false;
    }

    let allowed_domains: Vec<String> = group
        .settings
        .get("allowLinkDomains")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_lowercase())
                .collect()
        })
        .unwrap_or_default();

    for mat in LINK_REGEX.find_iter(candidate) {
        let hit = mat.as_str().to_lowercase();
        let whitelisted = allowed_domains.iter().any(|d| !d.is_empty() && hit.contains(d));
        if !whitelisted {
            return true;
        }
    }
    false
}

fn has_abusive_mentions(msg: &InboundMessage, group: &GroupSettingsRecord) -> bool {
    if msg
        .mentions
        .iter()
        .any(|m| m.mention_type == 1 || m.uid.as_str() == "-1" || m.uid.as_str() == "all")
    {
        return true;
    }
    let max_mentions = group
        .settings
        .get("maxMentions")
        .and_then(Value::as_u64)
        .unwrap_or(5) as usize;
    msg.mentions.len() >= max_mentions
}

fn is_animated_effect_sticker(msg: &InboundMessage) -> bool {
    matches!(
        msg.content,
        MessageContent::Sticker { sticker_type, .. } if sticker_type == 3 || sticker_type >= 5
    )
}
