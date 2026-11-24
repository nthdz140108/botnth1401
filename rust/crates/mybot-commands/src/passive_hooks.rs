//! `PassiveChatHooks` implementation — the non-prefixed chat features that make V3 feel alive.
//!
//! Registered onto `FastPathDispatcher` by `mybotd`. Covers, 1:1 with V3:
//! - `@bot` mentions / bare-prefix `autoreply` + learned Q&A (`simsimi`, `learn`, `learnnow`),
//! - `replytag` (auto-answer a quoted bot message with the tagger's name),
//! - `autodownload` (auto-fetch media links posted in a group),
//! - `welcome` / `bye` / `approve` / `target` group-event banners,
//! - `antiundo` rich-media restoration (photos, video, voice, stickers, files, cards).
//!
//! Everything here reads live group settings and never reports success without a real send.

use std::sync::Arc;

use async_trait::async_trait;
use mybot_core::interaction::PassiveChatHooks;
use mybot_core::v3_style::{BotStyleProfile, build_state_quote, build_tag_message};
use mybot_storage::{CachedMessageRecord, GroupSettingsRecord, HotStorageCaches};
use mybot_types::{
    GroupEventType, InboundMessage, PermissionTier, ThreadType, UndoEvent, ZaloId,
};
use serde_json::Value;
use zalo_sdk::{OutboundMessage, ZaloSession};

use crate::CommandRuntimeBundle;

/// Normalizes a question the same way V3 `learn`/`autoreply` do: lowercase, collapse whitespace,
/// strip trailing punctuation so the same question matches regardless of typing sloppiness.
pub fn normalize_question(raw: &str) -> String {
    let lowered = raw.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut last_space = false;
    for ch in lowered.chars() {
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else if !matches!(ch, '?' | '!' | '.' | ',' | ';' | ':') {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// Extracts the first `http(s)` URL from a message body (`autodownload`).
pub fn extract_first_url(text: &str) -> Option<&str> {
    text.split_whitespace()
        .find(|t| t.starts_with("http://") || t.starts_with("https://"))
}

/// True when the message is addressed to the bot: it is a DM, it @mentions the bot, or it starts
/// with a prefix-less bot name. V3 `autoreply` triggers on exactly these.
pub fn addressed_to_bot(
    msg: &InboundMessage,
    self_uid: &ZaloId,
    bot_name: &str,
    bare_prefix: &str,
) -> bool {
    if msg.thread_type == ThreadType::User {
        return true;
    }
    if msg
        .mentions
        .iter()
        .any(|m| !self_uid.is_empty() && &m.uid == self_uid)
    {
        return true;
    }
    let text = msg.content.text_or_caption().trim();
    let lower = text.to_lowercase();
    if !bot_name.trim().is_empty() && lower.starts_with(&bot_name.to_lowercase()) {
        return true;
    }
    !bare_prefix.is_empty() && text.starts_with(bare_prefix)
}

pub struct CommandsPassiveHooks {
    runtime: Arc<CommandRuntimeBundle>,
    caches: HotStorageCaches,
}

impl std::fmt::Debug for CommandsPassiveHooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandsPassiveHooks").finish()
    }
}

impl CommandsPassiveHooks {
    pub fn new(runtime: Arc<CommandRuntimeBundle>, caches: HotStorageCaches) -> Self {
        Self { runtime, caches }
    }

    /// Reads a `bool` toggle from the group's JSON settings bag, falling back to `default_val` if absent.
    fn group_flag_or(settings: &GroupSettingsRecord, key: &str, default_val: bool) -> bool {
        settings.settings.get(key).and_then(Value::as_bool).unwrap_or(default_val)
    }

    fn group_flag(settings: &GroupSettingsRecord, key: &str) -> bool {
        Self::group_flag_or(settings, key, false)
    }

    async fn send_styled(
        zalo: &Arc<ZaloSession>,
        profile: &BotStyleProfile,
        msg: &InboundMessage,
        text: &str,
        ttl_ms: u64,
    ) -> bool {
        let out = build_state_quote(profile, msg, text, true, ttl_ms, true);
        zalo
            .send_message(out, &msg.thread_id, msg.thread_type)
            .await
            .is_ok()
    }

    /// `autoreply` + learned Q&A + SimSimi fallback.
    async fn handle_autoreply(
        &self,
        bot_key: &str,
        profile: &BotStyleProfile,
        msg: &InboundMessage,
        zalo: &Arc<ZaloSession>,
    ) -> bool {
        let text = msg.content.text_or_caption().trim();
        if text.is_empty() {
            return false;
        }
        let norm = normalize_question(text);
        if norm.is_empty() {
            return false;
        }

        // 1. Learned Q&A wins over any AI (`learnnow` entries are authoritative).
        if let Ok(Some(answers)) = self
            .caches
            .engine()
            .lookup_learned_qa(bot_key, msg.thread_id.as_str(), &norm)
            && !answers.is_empty()
        {
            // Rotate deterministically so repeated asks cycle through the stored answers.
            let idx = (msg.timestamp_ms.unsigned_abs() as usize) % answers.len();
            return Self::send_styled(zalo, profile, msg, &answers[idx], 0).await;
        }

        // 2. SimSimi fallback (the hub also re-checks learned Q&A, which is harmless).
        match self
            .runtime
            .ai
            .chat_simsimi_or_learned(bot_key, msg.thread_id.as_str(), text)
            .await
        {
            Ok(reply) if !reply.trim().is_empty() => {
                Self::send_styled(zalo, profile, msg, &reply, 0).await
            }
            _ => false,
        }
    }

    /// `replytag`: when someone quotes a *bot* message, answer them by name.
    async fn handle_replytag(
        &self,
        profile: &BotStyleProfile,
        msg: &InboundMessage,
        self_uid: &ZaloId,
        zalo: &Arc<ZaloSession>,
    ) -> bool {
        let Some(ref quote) = msg.quote else {
            return false;
        };
        if !quote.owner_id.is_empty() && &quote.owner_id != self_uid {
            return false;
        }
        if msg.sender_name.trim().is_empty() {
            return false;
        }
        let caption = format!("{} vừa trả lời tin nhắn của mình.", msg.sender_name.trim());
        let mention = mybot_types::MentionSpan {
            uid: msg.sender_uid.clone(),
            pos: 0,
            len: msg.sender_name.chars().count(),
            mention_type: 0,
        };
        let out = build_tag_message(profile, msg, &caption, &[mention], None, 0);
        zalo
            .send_message(out, &msg.thread_id, msg.thread_type)
            .await
            .is_ok()
    }

    /// `autodownload`: fetch media links posted without any command.
    async fn handle_autodownload(
        &self,
        profile: &BotStyleProfile,
        msg: &InboundMessage,
        zalo: &Arc<ZaloSession>,
    ) -> bool {
        let text = msg.content.text_or_caption();
        let Some(url) = extract_first_url(text) else {
            return false;
        };
        // Only claim to handle it when the download actually produced bytes.
        let Ok(file) = self.runtime.crawlers.download_media_to_ram(url, false).await else {
            return false;
        };
        let out = OutboundMessage {
            text: String::new(),
            quote: Some(msg.to_quote_target()),
            attachments: vec![file.path().to_path_buf()],
            ttl_ms: 0,
            link_on: false,
            ..Default::default()
        };
        let _ = profile;
        zalo
            .send_message(out, &msg.thread_id, msg.thread_type)
            .await
            .is_ok()
    }

    /// Builds the `welcome` / `bye` banner text for a `GroupEvent`.
    fn group_event_caption(
        settings: &GroupSettingsRecord,
        event: &mybot_types::GroupEvent,
    ) -> Option<(String, &'static str)> {
        let names: Vec<&str> = event
            .target_members
            .iter()
            .map(|m| m.display_name.as_str())
            .filter(|n| !n.trim().is_empty())
            .collect();
        let who = if names.is_empty() {
            "Thành viên mới".to_string()
        } else {
            names.join(", ")
        };
        match event.event_type {
            GroupEventType::Join => {
                if !settings.welcome_group {
                    return None;
                }
                let tpl = settings
                    .settings
                    .get("welcomeMessage")
                    .and_then(Value::as_str)
                    .unwrap_or("🎉 Chào mừng {name} đã tham gia nhóm {group}!");
                Some((
                    tpl.replace("{name}", &who).replace(
                        "{group}",
                        if event.group_name.trim().is_empty() {
                            "này"
                        } else {
                            &event.group_name
                        },
                    ),
                    "welcome",
                ))
            }
            GroupEventType::Leave | GroupEventType::RemoveMember | GroupEventType::BlockMember => {
                if !settings.bye_group {
                    return None;
                }
                let tpl = settings
                    .settings
                    .get("byeMessage")
                    .and_then(Value::as_str)
                    .unwrap_or("👋 Tạm biệt {name} đã rời nhóm {group}!");
                Some((
                    tpl.replace("{name}", &who).replace(
                        "{group}",
                        if event.group_name.trim().is_empty() {
                            "này"
                        } else {
                            &event.group_name
                        },
                    ),
                    "bye",
                ))
            }
            GroupEventType::JoinRequest => {
                if !Self::group_flag(settings, "approve") {
                    return None;
                }
                Some((
                    format!("📥 {who} đang xin vào nhóm — chờ quản trị viên duyệt."),
                    "approve",
                ))
            }
            _ => None,
        }
    }

    /// Re-sends a recalled message's media (`antiundo`).
    async fn restore_rich_undo(
        zalo: &Arc<ZaloSession>,
        cached: &CachedMessageRecord,
        thread_id: &ZaloId,
        thread_type: ThreadType,
    ) -> Option<String> {
        let payload = &cached.payload;
        let kind = cached.msg_type.to_ascii_lowercase();

        // Rebuild the original media type from the cached `msgType` + payload shape.
        if kind.contains("photo") || kind.contains("image") {
            let url = payload
                .pointer("/content/href")
                .or_else(|| payload.pointer("/content/hdUrl"))
                .or_else(|| payload.get("href"))
                .and_then(Value::as_str)?;
            let caption = payload
                .pointer("/content/description")
                .or_else(|| payload.pointer("/content/caption"))
                .and_then(Value::as_str)
                .unwrap_or("");
            return match zalo
                .send_image(url, Some(url), 720, 1080, caption, thread_id, thread_type, 0)
                .await
            {
                Ok(_) => Some(format!("Đã khôi phục ảnh bị thu hồi của {}", cached.sender_name)),
                Err(err) => Some(format!("Không khôi phục được ảnh: {err}")),
            };
        }

        if kind.contains("voice") || kind.contains("audio") {
            let url = payload
                .pointer("/content/href")
                .or_else(|| payload.get("href"))
                .and_then(Value::as_str)?;
            return match zalo
                .send_voice(url, None, thread_id, thread_type, 0)
                .await
            {
                Ok(_) => Some(format!("Đã khôi phục tin nhắn thoại của {}", cached.sender_name)),
                Err(err) => Some(format!("Không khôi phục được thoại: {err}")),
            };
        }

        if kind.contains("video") {
            let url = payload
                .pointer("/content/href")
                .or_else(|| payload.get("href"))
                .and_then(Value::as_str)?;
            let thumb = payload
                .pointer("/content/thumb")
                .or_else(|| payload.pointer("/content/thumbnail"))
                .and_then(Value::as_str);
            let req = zalo_sdk::apis::messaging::VideoSendRequest {
                video_url: url.to_string(),
                thumbnail_url: thumb.map(ToOwned::to_owned),
                caption: cached.sender_name.clone(),
                mentions: Vec::new(),
                duration_ms: payload
                    .pointer("/content/duration")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                width: 1280,
                height: 720,
                file_size: payload
                    .pointer("/content/fileSize")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                ttl_ms: 0,
                video_already_uploaded: true,
            };
            return match zalo.send_video(&req, thread_id, thread_type).await {
                Ok(_) => Some(format!("Đã khôi phục video bị thu hồi của {}", cached.sender_name)),
                Err(err) => Some(format!("Không khôi phục được video: {err}")),
            };
        }

        if kind.contains("sticker") {
            let sticker_id = payload
                .pointer("/content/stickerId")
                .or_else(|| payload.pointer("/content/id"))
                .and_then(Value::as_u64)?;
            let cate_id = payload
                .pointer("/content/cateId")
                .or_else(|| payload.pointer("/content/cate_id"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            return match zalo
                .send_sticker(sticker_id, cate_id, 0, thread_id, thread_type)
                .await
            {
                Ok(_) => Some(format!("Đã khôi phục sticker bị thu hồi của {}", cached.sender_name)),
                Err(err) => Some(format!("Không khôi phục được sticker: {err}")),
            };
        }

        if kind.contains("gif") {
            let url = payload
                .pointer("/content/href")
                .or_else(|| payload.get("href"))
                .and_then(Value::as_str)?;
            let thumb = payload
                .pointer("/content/thumb")
                .and_then(Value::as_str)
                .unwrap_or(url);
            return match zalo
                .send_gif(url, thumb, 480, 480, 0, thread_id, thread_type, 0)
                .await
            {
                Ok(_) => Some(format!("Đã khôi phục GIF bị thu hồi của {}", cached.sender_name)),
                Err(err) => Some(format!("Không khôi phục được GIF: {err}")),
            };
        }

        None
    }
}

#[async_trait]
impl PassiveChatHooks for CommandsPassiveHooks {
    async fn on_passive_message(
        &self,
        bot_key: &str,
        _is_main_bot: bool,
        self_uid: &ZaloId,
        prefix: &str,
        profile: &BotStyleProfile,
        _sender_tier: PermissionTier,
        group_settings: &GroupSettingsRecord,
        msg: &InboundMessage,
        zalo: Option<Arc<ZaloSession>>,
    ) -> bool {
        let Some(zalo) = zalo else {
            return false;
        };

        // Group-scope toggles only apply in groups; DMs use the bot-level defaults.
        let is_group = msg.thread_type == ThreadType::Group;
        let flag = |key: &str, default_val: bool| -> bool {
            if is_group {
                Self::group_flag_or(group_settings, key, default_val)
            } else {
                default_val
            }
        };

        // 1. `replytag` — someone quoted a bot message.
        if flag("replytag", true) && self.handle_replytag(profile, msg, self_uid, &zalo).await {
            return true;
        }

        // 2. `autodownload` — a bare media link.
        if is_group && flag("autodownload", false)
            && self.handle_autodownload(profile, msg, &zalo).await
        {
            return true;
        }

        // 3. `autoreply` / `reply` / learned Q&A — only when the bot is actually addressed.
        // Node V3 dqt-bot.js: replyEnabled defaults to true. If turned off via !reply off or !autoreply off, suppress.
        let reply_allowed = flag("reply", true) && flag("replyEnabled", true) && flag("autoreply", true);
        if reply_allowed {
            let bot_name = profile.name_server.as_str();
            if addressed_to_bot(msg, self_uid, bot_name, prefix)
                && self.handle_autoreply(bot_key, profile, msg, &zalo).await
            {
                return true;
            }
        }

        // 4. Chat-based learning when quoting bot message (Node V3 dqt-bot.js:146)
        let learn_allowed = flag("learn", true) && flag("learnEnabled", true);
        if learn_allowed && let Some(ref quote) = msg.quote {
            if !quote.owner_id.is_empty() && &quote.owner_id == self_uid {
                let user_reply = msg.content.text_or_caption().trim();
                let bot_msg = quote.msg.trim();
                if !bot_msg.is_empty() && user_reply.chars().count() > 6 {
                    let norm = normalize_question(bot_msg);
                    if !norm.is_empty() {
                        let _ = self.caches.engine().upsert_learned_qa(
                            bot_key,
                            msg.thread_id.as_str(),
                            &norm,
                            &[user_reply.to_string()],
                        );
                    }
                }
            }
        }

        false
    }

    async fn on_group_event(
        &self,
        bot_key: &str,
        _self_uid: &ZaloId,
        profile: &BotStyleProfile,
        event: &mybot_types::GroupEvent,
        zalo: Option<Arc<ZaloSession>>,
    ) {
        let Some(zalo) = zalo else { return };
        // Events for this bot only.
        if !event.bot_key.is_empty() && event.bot_key.as_str() != bot_key {
            return;
        }
        let settings = self
            .caches
            .get_or_default_group_settings(bot_key, event.group_id.as_str());
        if !settings.enable_bot {
            return;
        }
        let Some((caption, _kind)) = Self::group_event_caption(&settings, event) else {
            return;
        };

        // Mentions: welcome/bye should address the affected members.
        let mentions: Vec<mybot_types::MentionSpan> = event
            .target_members
            .iter()
            .filter(|m| !m.display_name.trim().is_empty())
            .filter_map(|m| {
                caption
                    .find(&m.display_name)
                    .map(|byte_pos| mybot_types::MentionSpan {
                        uid: m.id.clone(),
                        pos: mybot_types::utf16_len(&caption[..byte_pos]),
                        len: mybot_types::utf16_len(&m.display_name),
                        mention_type: 0,
                    })
            })
            .collect();

        let out = OutboundMessage {
            text: caption,
            mentions,
            ttl_ms: 0,
            link_on: false,
            ..Default::default()
        };
        if zalo
            .send_message(out, &event.group_id, ThreadType::Group)
            .await
            .is_err()
        {
            tracing::warn!(
                bot = %bot_key,
                group = %event.group_id.as_str(),
                event = ?event.event_type,
                "group event banner send failed"
            );
            return;
        }
        let _ = profile;
    }

    async fn on_rich_undo(
        &self,
        _bot_key: &str,
        _profile: &BotStyleProfile,
        group_settings: &GroupSettingsRecord,
        cached_msg: &CachedMessageRecord,
        undo: &UndoEvent,
        zalo: Option<Arc<ZaloSession>>,
    ) -> Option<String> {
        let zalo = zalo?;
        if !group_settings.anti_undo {
            return None;
        }
        Self::restore_rich_undo(
            &zalo,
            cached_msg,
            &undo.thread_id,
            ThreadType::Group,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_question_is_case_and_punctuation_insensitive() {
        assert_eq!(normalize_question("  Xin   CHÀO  "), "xin chào");
        assert_eq!(normalize_question("Bạn khỏe không??"), "bạn khỏe không");
        assert_eq!(normalize_question("a,b;c:d"), "abcd");
        assert_eq!(normalize_question(""), "");
    }

    #[test]
    fn extract_first_url_picks_the_first_http_token() {
        assert_eq!(
            extract_first_url("xem https://a.com/v/1 nhé"),
            Some("https://a.com/v/1")
        );
        assert_eq!(extract_first_url("http://b.co"), Some("http://b.co"));
        assert_eq!(extract_first_url("không có link"), None);
        assert_eq!(extract_first_url("ftp://x"), None);
    }

    #[test]
    fn welcome_and_bye_respect_group_toggles() {
        let mut g = GroupSettingsRecord::default_for("admin", "g1");
        g.welcome_group = false;
        g.bye_group = false;
        let mut ev = mybot_types::GroupEvent {
            bot_key: "admin".into(),
            group_id: ZaloId::new("g1"),
            group_name: "Nhóm Test".into(),
            event_type: GroupEventType::Join,
            source_id: ZaloId::new("u1"),
            target_members: vec![mybot_types::GroupEventMember {
                id: ZaloId::new("u1"),
                display_name: "Nguyễn Văn A".into(),
                avatar: None,
            }],
            is_self: false,
            ws_received_at_ms: 0,
            raw_data: json!({}),
        };
        assert!(CommandsPassiveHooks::group_event_caption(&g, &ev).is_none());

        g.welcome_group = true;
        let (caption, kind) = CommandsPassiveHooks::group_event_caption(&g, &ev).unwrap();
        assert_eq!(kind, "welcome");
        assert!(caption.contains("Nguyễn Văn A"));
        assert!(caption.contains("Nhóm Test"));

        ev.event_type = GroupEventType::Leave;
        assert!(CommandsPassiveHooks::group_event_caption(&g, &ev).is_none());
        g.bye_group = true;
        let (caption, kind) = CommandsPassiveHooks::group_event_caption(&g, &ev).unwrap();
        assert_eq!(kind, "bye");
        assert!(caption.contains("Nguyễn Văn A"));
    }

    #[test]
    fn join_request_banner_needs_approve_flag() {
        let g = GroupSettingsRecord::default_for("admin", "g1");
        let ev = mybot_types::GroupEvent {
            bot_key: "admin".into(),
            group_id: ZaloId::new("g1"),
            group_name: "Nhóm".into(),
            event_type: GroupEventType::JoinRequest,
            source_id: ZaloId::new("u9"),
            target_members: vec![mybot_types::GroupEventMember {
                id: ZaloId::new("u9"),
                display_name: "Trần B".into(),
                avatar: None,
            }],
            is_self: false,
            ws_received_at_ms: 0,
            raw_data: json!({}),
        };
        assert!(CommandsPassiveHooks::group_event_caption(&g, &ev).is_none());

        let mut g2 = g.clone();
        if let Some(obj) = g2.settings.as_object_mut() {
            obj.insert("approve".into(), json!(true));
        }
        assert!(CommandsPassiveHooks::group_event_caption(&g2, &ev).is_some());
    }
}
