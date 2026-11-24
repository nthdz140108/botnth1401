//! Shared strongly-typed domain primitives for the V4 Pure-Rust Multi-Bot Engine.
//!
//! Normalizes dynamic JavaScript/Zalo payloads at the JSON deserialization boundary:
//! - [`ZaloId`]: handles UIDs/MsgIDs sent interchangeably as JSON strings or 64-bit integers.
//! - [`ExpiryPolicy`]: preserves backward compatibility with V3 `"-1"` permanent markers and ISO timestamps.
//! - [`InboundMessage`] & [`MessageContent`]: unifies WebSocket, cross-bot relay, and scheduled events,
//!   including automatic unwrapping of double-JSON-encoded `quote.attach` fields.

use std::borrow::Borrow;
use std::fmt;
use std::ops::Deref;

use chrono::{DateTime, TimeZone, Utc};
use compact_str::CompactString;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Canonical Zalo API protocol constants (`zca-js` fork parity).
pub const ZALO_API_TYPE: u32 = 30;
pub const ZALO_API_VERSION: u32 = 671;
pub const DEFAULT_ZALO_WEB_URL: &str = "https://chat.zalo.me";
pub const DEFAULT_ZALO_ID_URL: &str = "https://id.zalo.me";

/// Default Windows Chrome User-Agent preserved on Linux Ubuntu so `imei` (`uuid-md5(UA)`)
/// and migrated Windows cookies remain 100% valid without session invalidation.
pub const DEFAULT_ZALO_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/// Compact stack-inlined identifier (<= 24 bytes inline, zero heap allocation for Zalo UIDs).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ZaloId(CompactString);

impl ZaloId {
    #[inline]
    pub fn new(value: impl Into<CompactString>) -> Self {
        Self(value.into())
    }

    #[inline]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for ZaloId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ZaloId({:?})", self.0)
    }
}

impl fmt::Display for ZaloId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.as_str())
    }
}

impl Deref for ZaloId {
    type Target = str;

    #[inline]
    fn deref(&self) -> &Self::Target {
        self.0.as_str()
    }
}

impl AsRef<str> for ZaloId {
    #[inline]
    fn as_ref(&self) -> &str {
        self.0.as_str()
    }
}

impl Borrow<str> for ZaloId {
    #[inline]
    fn borrow(&self) -> &str {
        self.0.as_str()
    }
}

impl From<&str> for ZaloId {
    fn from(value: &str) -> Self {
        Self(CompactString::from(value.trim()))
    }
}

impl From<String> for ZaloId {
    fn from(value: String) -> Self {
        Self(CompactString::from(value.trim()))
    }
}

impl From<u64> for ZaloId {
    fn from(value: u64) -> Self {
        Self(CompactString::from(value.to_string()))
    }
}

impl From<i64> for ZaloId {
    fn from(value: i64) -> Self {
        Self(CompactString::from(value.to_string()))
    }
}

impl Serialize for ZaloId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.as_str())
    }
}

impl<'de> Deserialize<'de> for ZaloId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ZaloIdVisitor;

        impl<'de> Visitor<'de> for ZaloIdVisitor {
            type Value = ZaloId;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a Zalo identifier as string or integer")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(ZaloId::from(v))
            }

            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(ZaloId::from(v))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(ZaloId::from(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(ZaloId::from(v))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                if v.is_finite() {
                    Ok(ZaloId::from(format!("{:.0}", v)))
                } else {
                    Err(E::custom("non-finite float for ZaloId"))
                }
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(ZaloId::default())
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(ZaloId::default())
            }
        }

        deserializer.deserialize_any(ZaloIdVisitor)
    }
}

/// Conversation thread kind (`zca-js` `ThreadType` parity: `0 = User`, `1 = Group`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(u8)]
pub enum ThreadType {
    #[default]
    User = 0,
    Group = 1,
}

impl ThreadType {
    #[inline]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    #[inline]
    pub const fn is_group(self) -> bool {
        matches!(self, Self::Group)
    }
}

impl Serialize for ThreadType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(self.as_u8())
    }
}

impl<'de> Deserialize<'de> for ThreadType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ThreadTypeVisitor;

        impl<'de> Visitor<'de> for ThreadTypeVisitor {
            type Value = ThreadType;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("0/1 or user/group")
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                match v {
                    0 => Ok(ThreadType::User),
                    1 => Ok(ThreadType::Group),
                    other => Err(E::custom(format!("unknown ThreadType integer: {other}"))),
                }
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                match v {
                    0 => Ok(ThreadType::User),
                    1 => Ok(ThreadType::Group),
                    other => Err(E::custom(format!("unknown ThreadType integer: {other}"))),
                }
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                match v.trim().to_ascii_lowercase().as_str() {
                    "0" | "user" | "dm" | "private" => Ok(ThreadType::User),
                    "1" | "group" => Ok(ThreadType::Group),
                    other => Err(E::custom(format!("unknown ThreadType string: {other}"))),
                }
            }
        }

        deserializer.deserialize_any(ThreadTypeVisitor)
    }
}

/// Maps Zalo `msgType` string onto `client_msg_type` integer (`utils.js::getClientMessageType`).
pub fn client_message_type_code(msg_type: &str) -> u32 {
    match msg_type {
        "webchat" | "chat.link" => 1,
        "chat.voice" => 31,
        "chat.photo" => 32,
        "chat.sticker" => 36,
        "chat.doodle" => 37,
        "chat.recommended" => 38,
        "chat.location.new" => 43,
        "chat.video.msg" => 44,
        "share.file" => 46,
        "chat.gif" => 49,
        _ => 1,
    }
}

/// Origin of an inbound event entering the bot actor pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    #[default]
    WebSocket,
    CrossBotRelay,
    Scheduler,
    LegacyBridge,
    WebAdminConsole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MentionSpan {
    pub uid: ZaloId,
    pub pos: usize,
    pub len: usize,
    #[serde(default)]
    pub mention_type: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextStyleSpan {
    pub start: usize,
    pub len: usize,
    pub style: CompactString,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotedMessage {
    pub owner_id: ZaloId,
    pub cli_msg_id: ZaloId,
    pub global_msg_id: ZaloId,
    pub cli_msg_type: u32,
    pub ts: i64,
    #[serde(default)]
    pub ttl: u64,
    pub msg: String,
    pub from_display_name: Option<String>,
    pub attach: Option<Value>,
}

/// Computes exact JavaScript `String.prototype.length` (UTF-16 code unit count) required by Zalo
/// `mentionInfo` (`pos`, `len`) and `MultiMsgStyle` (`start`, `len`).
#[inline]
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Strips Zalo `@mention` UTF-16 spans in descending `pos` order (`src/utils/format-util.js::removeMention`).
pub fn remove_mentions_utf16(content: &str, mentions: &[MentionSpan], collapse_newlines: bool) -> String {
    if content.is_empty() {
        return String::new();
    }
    let mut cleaned = if mentions.is_empty() {
        content.to_string()
    } else {
        let mut units: Vec<u16> = content.encode_utf16().collect();
        let mut sorted: Vec<MentionSpan> = mentions.to_vec();
        sorted.sort_by_key(|mention| std::cmp::Reverse(mention.pos));
        for m in sorted {
            if m.len == 0 || m.pos >= units.len() {
                continue;
            }
            let end = m.pos.saturating_add(m.len).min(units.len());
            units.drain(m.pos..end);
        }
        String::from_utf16_lossy(&units)
    };

    if collapse_newlines {
        cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
    } else {
        cleaned = cleaned
            .lines()
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("\n");
        cleaned.trim().to_string()
    }
}

impl QuotedMessage {
    /// Parses a raw Zalo `quote` JSON object, automatically unwrapping double-encoded `attach` strings.
    pub fn from_raw_zalo(raw: &Value) -> Option<Self> {
        let obj = raw.as_object()?;
        let attach = match obj.get("attach") {
            Some(Value::String(s)) if !s.trim().is_empty() => {
                serde_json::from_str::<Value>(s).ok().or_else(|| Some(Value::String(s.clone())))
            }
            Some(Value::Null) | None => None,
            Some(other) => Some(other.clone()),
        };

        let parse_id = |keys: &[&str]| -> ZaloId {
            for k in keys {
                if let Some(val) = obj.get(*k)
                    && let Ok(id) = serde_json::from_value::<ZaloId>(val.clone())
                    && !id.is_empty()
                {
                    return id;
                }
            }
            ZaloId::default()
        };

        Some(Self {
            owner_id: parse_id(&["ownerId", "uidFrom"]),
            cli_msg_id: parse_id(&["cliMsgId"]),
            global_msg_id: parse_id(&["globalMsgId", "msgId"]),
            cli_msg_type: obj
                .get("cliMsgType")
                .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
                .unwrap_or(1) as u32,
            ts: obj
                .get("ts")
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
                .unwrap_or(0),
            ttl: obj
                .get("ttl")
                .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
                .unwrap_or(0),
            msg: obj
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            from_display_name: obj
                .get("fromD")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            attach,
        })
    }
}

/// Strongly-typed message payload normalized across all Zalo message types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageContent {
    Text {
        text: String,
    },
    Photo {
        url: String,
        thumb_url: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        caption: String,
    },
    Video {
        url: String,
        thumb_url: Option<String>,
        duration_ms: Option<u64>,
        width: Option<u32>,
        height: Option<u32>,
        caption: String,
    },
    Voice {
        url: String,
        duration_ms: Option<u64>,
    },
    Sticker {
        id: u64,
        cate_id: u64,
        sticker_type: u32,
        text: Option<String>,
        sticker_url: Option<String>,
        sticker_webp_url: Option<String>,
    },
    Gif {
        url: String,
        thumb_url: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
    },
    File {
        url: String,
        file_name: String,
        file_size: u64,
        file_ext: String,
        checksum: Option<String>,
    },
    Card {
        uid: ZaloId,
        title: String,
        description: String,
        avatar: Option<String>,
        phone: Option<String>,
        qr_url: Option<String>,
    },
    Link {
        url: String,
        title: Option<String>,
        description: Option<String>,
        thumb_url: Option<String>,
    },
    System {
        msg_type: String,
        raw: Value,
    },
}

impl MessageContent {
    /// Extracts primary plain-text or caption string for command and badword matching.
    pub fn text_or_caption(&self) -> &str {
        match self {
            Self::Text { text } => text.as_str(),
            Self::Photo { caption, .. } | Self::Video { caption, .. } => caption.as_str(),
            Self::Link { url, .. } => url.as_str(),
            _ => "",
        }
    }
}

/// Normalized inbound chat message delivered to `BotActor` and `FastPathDispatcher`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboundMessage {
    pub bot_key: CompactString,
    pub msg_id: ZaloId,
    pub cli_msg_id: ZaloId,
    pub global_msg_id: ZaloId,
    pub thread_id: ZaloId,
    pub thread_type: ThreadType,
    pub sender_uid: ZaloId,
    pub sender_name: String,
    pub is_self: bool,
    pub msg_type: CompactString,
    pub timestamp_ms: i64,
    pub ws_received_at_ms: i64,
    pub ttl_ms: u64,
    pub mentions: Vec<MentionSpan>,
    pub styles: Vec<TextStyleSpan>,
    pub quote: Option<QuotedMessage>,
    pub content: MessageContent,
    pub source: EventSource,
    pub raw_property_ext: Option<Value>,
}

impl InboundMessage {
    /// Normalizes a raw Zalo WebSocket `(501, 0)` DM or `(521, 0)` Group JSON frame item.
    pub fn from_raw_zalo(
        bot_key: impl Into<CompactString>,
        self_uid: &ZaloId,
        raw: &Value,
        thread_type: ThreadType,
        ws_received_at_ms: i64,
    ) -> Option<Self> {
        let obj = raw.as_object()?;
        let uid_from = obj
            .get("uidFrom")
            .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
            .unwrap_or_default();
        let id_to = obj
            .get("idTo")
            .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
            .unwrap_or_default();

        let is_self = uid_from.as_str() == "0" || (!self_uid.is_empty() && &uid_from == self_uid);
        let sender_uid = if uid_from.as_str() == "0" && !self_uid.is_empty() {
            self_uid.clone()
        } else {
            uid_from.clone()
        };
        let norm_id_to = if id_to.as_str() == "0" && !self_uid.is_empty() {
            self_uid.clone()
        } else {
            id_to.clone()
        };

        let thread_id = match thread_type {
            ThreadType::Group => {
                if norm_id_to.as_str() == "0" || norm_id_to.is_empty() {
                    uid_from
                } else {
                    norm_id_to
                }
            }
            ThreadType::User => {
                if is_self {
                    if norm_id_to.is_empty() {
                        sender_uid.clone()
                    } else {
                        norm_id_to
                    }
                } else {
                    sender_uid.clone()
                }
            }
        };

        let msg_id = obj
            .get("msgId")
            .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
            .unwrap_or_default();
        let cli_msg_id = obj
            .get("cliMsgId")
            .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
            .unwrap_or_default();
        let global_msg_id = obj
            .get("realMsgId")
            .or_else(|| obj.get("globalMsgId"))
            .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
            .unwrap_or_else(|| msg_id.clone());

        let msg_type = CompactString::from(
            obj.get("msgType")
                .and_then(|v| v.as_str())
                .unwrap_or("webchat"),
        );
        let sender_name = obj
            .get("dName")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let timestamp_ms = obj
            .get("ts")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
            .unwrap_or(ws_received_at_ms);
        let ttl_ms = obj
            .get("ttl")
            .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
            .unwrap_or(0);

        let mentions = obj
            .get("mentions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let m = item.as_object()?;
                        Some(MentionSpan {
                            uid: m
                                .get("uid")
                                .and_then(|u| serde_json::from_value::<ZaloId>(u.clone()).ok())
                                .unwrap_or_default(),
                            pos: m.get("pos").and_then(|p| p.as_u64()).unwrap_or(0) as usize,
                            len: m.get("len").and_then(|l| l.as_u64()).unwrap_or(0) as usize,
                            mention_type: m.get("type").and_then(|t| t.as_u64()).unwrap_or(0) as u8,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let quote = obj.get("quote").and_then(QuotedMessage::from_raw_zalo);
        let content = parse_message_content(msg_type.as_str(), obj.get("content"));

        Some(Self {
            bot_key: bot_key.into(),
            msg_id,
            cli_msg_id,
            global_msg_id,
            thread_id,
            thread_type,
            sender_uid,
            sender_name,
            is_self,
            msg_type,
            timestamp_ms,
            ws_received_at_ms,
            ttl_ms,
            mentions,
            styles: Vec::new(),
            quote,
            content,
            source: EventSource::WebSocket,
            raw_property_ext: obj.get("propertyExt").cloned(),
        })
    }

    /// Returns message text/caption with all `@mention` spans stripped using UTF-16 offsets (`format-util.js::removeMention`).
    pub fn text_without_mentions(&self) -> String {
        remove_mentions_utf16(self.content.text_or_caption(), &self.mentions, true)
    }

    /// Returns message text/caption with `@mention` spans stripped while preserving line breaks (`\n`).
    pub fn text_without_mentions_preserve_lines(&self) -> String {
        remove_mentions_utf16(self.content.text_or_caption(), &self.mentions, false)
    }

    /// Converts this inbound message into a `QuotedMessage` target for bot quote-replies (`sendMessage.js:236-245`).
    pub fn to_quote_target(&self) -> QuotedMessage {
        let (msg_text, attach) = match &self.content {
            MessageContent::Text { text } => (text.clone(), self.raw_property_ext.clone()),
            MessageContent::Photo {
                url,
                thumb_url,
                caption,
                ..
            }
            | MessageContent::Video {
                url,
                thumb_url,
                caption,
                ..
            } => {
                let thumb = thumb_url.clone().unwrap_or_else(|| url.clone());
                (
                    String::new(),
                    Some(serde_json::json!({
                        "href": url,
                        "thumb": thumb,
                        "thumbUrl": thumb,
                        "oriUrl": url,
                        "normalUrl": url,
                        "title": caption,
                    })),
                )
            }
            MessageContent::Gif { url, thumb_url, .. } => {
                let thumb = thumb_url.clone().unwrap_or_else(|| url.clone());
                (
                    String::new(),
                    Some(serde_json::json!({
                        "href": url,
                        "thumb": thumb,
                        "thumbUrl": thumb,
                        "oriUrl": url,
                        "normalUrl": url,
                    })),
                )
            }
            MessageContent::Voice { url, .. } => (
                String::new(),
                Some(serde_json::json!({
                    "href": url,
                    "oriUrl": url,
                    "normalUrl": url,
                })),
            ),
            MessageContent::File { url, file_name, .. } => (
                String::new(),
                Some(serde_json::json!({
                    "href": url,
                    "title": file_name,
                    "oriUrl": url,
                    "normalUrl": url,
                })),
            ),
            MessageContent::Link {
                url,
                title,
                thumb_url,
                ..
            } => {
                let thumb = thumb_url.clone().unwrap_or_default();
                (
                    String::new(),
                    Some(serde_json::json!({
                        "href": url,
                        "thumb": thumb,
                        "thumbUrl": thumb,
                        "oriUrl": url,
                        "normalUrl": url,
                        "title": title.clone().unwrap_or_default(),
                    })),
                )
            }
            MessageContent::Sticker {
                id,
                cate_id,
                sticker_type,
                sticker_url,
                ..
            } => (
                String::new(),
                Some(serde_json::json!({
                    "id": id,
                    "catId": cate_id,
                    "type": sticker_type,
                    "stickerUrl": sticker_url,
                })),
            ),
            MessageContent::Card {
                uid, title, qr_url, ..
            } => (
                String::new(),
                Some(serde_json::json!({
                    "userId": uid.as_str(),
                    "title": title,
                    "href": qr_url,
                })),
            ),
            MessageContent::System { msg_type, raw } => {
                let todo_msg = if msg_type == "chat.todo" {
                    raw.get("params")
                        .and_then(|v| v.as_str())
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .and_then(|p| p.pointer("/item/content").and_then(|c| c.as_str()).map(ToOwned::to_owned))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let att = if msg_type == "chat.todo" {
                    Some(serde_json::json!({
                        "properties": {
                            "color": 0,
                            "size": 0,
                            "type": 0,
                            "subType": 0,
                            "ext": "{\"shouldParseLinkOrContact\":0}"
                        }
                    }))
                } else {
                    Some(raw.clone())
                };
                (todo_msg, att)
            }
        };

        QuotedMessage {
            owner_id: self.sender_uid.clone(),
            cli_msg_id: if self.cli_msg_id.is_empty() {
                self.msg_id.clone()
            } else {
                self.cli_msg_id.clone()
            },
            global_msg_id: if !self.msg_id.is_empty() {
                self.msg_id.clone()
            } else {
                self.global_msg_id.clone()
            },
            cli_msg_type: client_message_type_code(self.msg_type.as_str()),
            ts: self.timestamp_ms,
            ttl: self.ttl_ms,
            msg: msg_text,
            from_display_name: if self.sender_name.is_empty() {
                None
            } else {
                Some(self.sender_name.clone())
            },
            attach,
        }
    }
}

fn parse_message_content(msg_type: &str, raw_content: Option<&Value>) -> MessageContent {
    let Some(content_val) = raw_content else {
        return MessageContent::Text {
            text: String::new(),
        };
    };

    if let Some(s) = content_val.as_str() {
        if msg_type != "webchat"
            && let Ok(parsed_obj) = serde_json::from_str::<Value>(s)
            && parsed_obj.is_object()
        {
            return parse_object_content(msg_type, &parsed_obj);
        }
        return MessageContent::Text {
            text: s.to_string(),
        };
    }

    if content_val.is_object() {
        return parse_object_content(msg_type, content_val);
    }

    MessageContent::Text {
        text: content_val.to_string(),
    }
}

fn parse_object_content(msg_type: &str, val: &Value) -> MessageContent {
    let Some(obj) = val.as_object() else {
        return MessageContent::Text {
            text: String::new(),
        };
    };
    let str_field = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(ToOwned::to_owned);
    let u64_field = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
    };
    let params_json: Option<Value> = obj
        .get("params")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok());

    match msg_type {
        "chat.photo" => MessageContent::Photo {
            url: str_field("href").or_else(|| str_field("hd")).unwrap_or_default(),
            thumb_url: str_field("thumb"),
            width: params_json
                .as_ref()
                .and_then(|p| p.get("width"))
                .and_then(|w| w.as_u64())
                .map(|w| w as u32),
            height: params_json
                .as_ref()
                .and_then(|p| p.get("height"))
                .and_then(|h| h.as_u64())
                .map(|h| h as u32),
            caption: str_field("description").or_else(|| str_field("title")).unwrap_or_default(),
        },
        "chat.video.msg" => MessageContent::Video {
            url: str_field("href").unwrap_or_default(),
            thumb_url: str_field("thumb"),
            duration_ms: params_json
                .as_ref()
                .and_then(|p| p.get("duration"))
                .and_then(|d| d.as_u64()),
            width: params_json
                .as_ref()
                .and_then(|p| p.get("video_width").or_else(|| p.get("width")))
                .and_then(|w| w.as_u64())
                .map(|w| w as u32),
            height: params_json
                .as_ref()
                .and_then(|p| p.get("video_height").or_else(|| p.get("height")))
                .and_then(|h| h.as_u64())
                .map(|h| h as u32),
            caption: str_field("description").or_else(|| str_field("title")).unwrap_or_default(),
        },
        "chat.voice" => MessageContent::Voice {
            url: str_field("href").unwrap_or_default(),
            duration_ms: params_json
                .as_ref()
                .and_then(|p| p.get("duration"))
                .and_then(|d| d.as_u64()),
        },
        "chat.sticker" => MessageContent::Sticker {
            id: u64_field("id").unwrap_or(0),
            cate_id: u64_field("catId").unwrap_or(0),
            sticker_type: u64_field("type").unwrap_or(0) as u32,
            text: str_field("text"),
            sticker_url: str_field("stickerUrl"),
            sticker_webp_url: str_field("stickerWebpUrl"),
        },
        "chat.gif" => MessageContent::Gif {
            url: str_field("href").unwrap_or_default(),
            thumb_url: str_field("thumb"),
            width: u64_field("width").map(|w| w as u32),
            height: u64_field("height").map(|h| h as u32),
        },
        "share.file" => MessageContent::File {
            url: str_field("href").unwrap_or_default(),
            file_name: str_field("title").unwrap_or_else(|| "file".to_string()),
            file_size: params_json
                .as_ref()
                .and_then(|p| {
                    p.get("fileSize")
                        .and_then(|s| s.as_u64().or_else(|| s.as_str()?.parse().ok()))
                })
                .unwrap_or(0),
            file_ext: params_json
                .as_ref()
                .and_then(|p| p.get("fileExt"))
                .and_then(|e| e.as_str())
                .unwrap_or_default()
                .to_string(),
            checksum: params_json
                .as_ref()
                .and_then(|p| p.get("checksum"))
                .and_then(|c| c.as_str())
                .map(ToOwned::to_owned),
        },
        "chat.recommended" => MessageContent::Card {
            uid: str_field("userId").map(ZaloId::from).unwrap_or_default(),
            title: str_field("title").unwrap_or_default(),
            description: str_field("description").unwrap_or_default(),
            avatar: str_field("thumb"),
            phone: params_json
                .as_ref()
                .and_then(|p| p.get("phone"))
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            qr_url: str_field("href"),
        },
        "chat.link" => MessageContent::Link {
            url: str_field("href").unwrap_or_default(),
            title: str_field("title"),
            description: str_field("description"),
            thumb_url: str_field("thumb"),
        },
        _ => MessageContent::System {
            msg_type: msg_type.to_string(),
            raw: val.clone(),
        },
    }
}

/// Undo / message-recall event (`deleteMsg` inside `(501, 0)` or `(521, 0)`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoEvent {
    pub bot_key: CompactString,
    pub thread_id: ZaloId,
    pub thread_type: ThreadType,
    pub sender_uid: ZaloId,
    pub is_self: bool,
    pub global_msg_id: ZaloId,
    pub cli_msg_id: ZaloId,
    pub timestamp_ms: i64,
    pub ws_received_at_ms: i64,
}

/// Message reaction event (`(612, 0)`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReactionEvent {
    pub bot_key: CompactString,
    pub thread_id: ZaloId,
    pub thread_type: ThreadType,
    pub sender_uid: ZaloId,
    pub is_self: bool,
    pub msg_id: ZaloId,
    pub cli_msg_id: ZaloId,
    pub r_icon: CompactString,
    pub r_type: i32,
    pub timestamp_ms: i64,
    pub ws_received_at_ms: i64,
}

/// Typing / group-typing notification (`(602, 0)`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypingEvent {
    pub user_id: ZaloId,
    pub group_id: Option<ZaloId>,
    pub timestamp_ms: i64,
    pub is_pc: bool,
}

/// Asynchronous upload completion callback payload (`file_done` / `voice_aac_success`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadDonePayload {
    pub file_id: ZaloId,
    pub file_url: String,
}

/// All 17 Zalo `GroupEventType` variants (`src/api-zalo/models/GroupEvent.js` parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupEventType {
    JoinRequest,
    Join,
    Leave,
    RemoveMember,
    BlockMember,
    UpdateSetting,
    Update,
    NewLink,
    AddAdmin,
    RemoveAdmin,
    NewPinTopic,
    UpdateTopic,
    UpdateBoard,
    ReorderPinTopic,
    UnpinTopic,
    RemoveTopic,
    Unknown,
}

impl GroupEventType {
    pub fn from_act(act: &str) -> Self {
        match act {
            "join_request" => Self::JoinRequest,
            "join" => Self::Join,
            "leave" => Self::Leave,
            "remove_member" => Self::RemoveMember,
            "block_member" => Self::BlockMember,
            "update_setting" => Self::UpdateSetting,
            "update" => Self::Update,
            "new_link" => Self::NewLink,
            "add_admin" => Self::AddAdmin,
            "remove_admin" => Self::RemoveAdmin,
            "new_pin_topic" => Self::NewPinTopic,
            "update_topic" => Self::UpdateTopic,
            "update_board" => Self::UpdateBoard,
            "reorder_pin_topic" => Self::ReorderPinTopic,
            "unpin_topic" => Self::UnpinTopic,
            "remove_topic" => Self::RemoveTopic,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupEvent {
    pub bot_key: CompactString,
    pub group_id: ZaloId,
    pub group_name: String,
    pub event_type: GroupEventType,
    pub source_id: ZaloId,
    pub target_members: Vec<GroupEventMember>,
    pub is_self: bool,
    pub ws_received_at_ms: i64,
    pub raw_data: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupEventMember {
    pub id: ZaloId,
    pub display_name: String,
    pub avatar: Option<String>,
}

/// Rental / SaaS bot expiry policy backward-compatible with V3 `mybots.json` (`"-1"`, `"pending"`, ISO-8601).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExpiryPolicy {
    #[default]
    Permanent,
    Pending,
    At(DateTime<Utc>),
}

impl ExpiryPolicy {
    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        match self {
            Self::Permanent | Self::Pending => false,
            Self::At(deadline) => now >= *deadline,
        }
    }

    pub fn to_v3_string(&self) -> String {
        match self {
            Self::Permanent => "-1".to_string(),
            Self::Pending => "pending".to_string(),
            Self::At(dt) => dt.to_rfc3339(),
        }
    }

    pub fn from_v3_value(val: &Value) -> Self {
        match val {
            Value::Null => Self::Permanent,
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    if i < 0 {
                        Self::Permanent
                    } else if i == 0 {
                        Self::Pending
                    } else if i > 1_000_000_000_000 {
                        Utc.timestamp_millis_opt(i)
                            .single()
                            .map(Self::At)
                            .unwrap_or(Self::Permanent)
                    } else {
                        Utc.timestamp_opt(i, 0)
                            .single()
                            .map(Self::At)
                            .unwrap_or(Self::Permanent)
                    }
                } else {
                    Self::Permanent
                }
            }
            Value::String(s) => Self::parse_str(s),
            _ => Self::Permanent,
        }
    }

    pub fn parse_str(raw: &str) -> Self {
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed == "-1"
            || trimmed.eq_ignore_ascii_case("permanent")
            || trimmed.eq_ignore_ascii_case("never")
            || trimmed.eq_ignore_ascii_case("forever")
        {
            return Self::Permanent;
        }
        if trimmed == "0" || trimmed.eq_ignore_ascii_case("pending") {
            return Self::Pending;
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
            return Self::At(dt.with_timezone(&Utc));
        }
        if let Ok(epoch_ms) = trimmed.parse::<i64>() {
            if epoch_ms < 0 {
                return Self::Permanent;
            }
            if epoch_ms > 1_000_000_000_000
                && let Some(dt) = Utc.timestamp_millis_opt(epoch_ms).single()
            {
                return Self::At(dt);
            }
            if let Some(dt) = Utc.timestamp_opt(epoch_ms, 0).single() {
                return Self::At(dt);
            }
        }
        Self::Permanent
    }
}

impl Serialize for ExpiryPolicy {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_v3_string())
    }
}

impl<'de> Deserialize<'de> for ExpiryPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        Ok(Self::from_v3_value(&val))
    }
}

/// V2 standardized bot status schema (`status-schema-v2.js` parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BotStatusV2 {
    Running,
    Starting,
    Stopping,
    #[default]
    Stopped,
    Disabled,
    Expired,
    Error,
    IdentityMismatch,
    ListenerDisconnected,
    Recovering,
}

impl BotStatusV2 {
    pub const fn as_v3_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Starting => "starting",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Disabled => "disabled",
            Self::Expired => "expired",
            Self::Error => "error",
            Self::IdentityMismatch => "identity_mismatch",
            Self::ListenerDisconnected => "listener_disconnected",
            Self::Recovering => "recovering",
        }
    }

    pub fn from_v3_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "running" | "online" | "active" => Self::Running,
            "starting" | "booting" => Self::Starting,
            "stopping" => Self::Stopping,
            "disabled" | "paused" => Self::Disabled,
            "expired" | "trial_expired" | "het_han" => Self::Expired,
            "error" | "crashed" | "errored" | "cookie_dead" => Self::Error,
            "identity_mismatch" => Self::IdentityMismatch,
            "listener_disconnected" | "disconnected" => Self::ListenerDisconnected,
            "recovering" | "restarting" => Self::Recovering,
            _ => Self::Stopped,
        }
    }
}

/// Preserves exact `(cookie, imei, user_agent)` tuple per bot so migrated Windows Zalo sessions
/// stay 100% valid on Linux Ubuntu.
#[derive(Clone, Serialize, Deserialize)]
pub struct CredentialsBundle {
    pub imei: String,
    pub user_agent: String,
    pub cookie: Value,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

fn default_language() -> String {
    "vi".to_string()
}

impl fmt::Debug for CredentialsBundle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialsBundle")
            .field("imei", &"<redacted>")
            .field("user_agent", &self.user_agent)
            .field("cookie", &"<redacted>")
            .field("language", &self.language)
            .field("has_proxy", &self.proxy_url.is_some())
            .finish()
    }
}

/// Command permission tiers (`command-registry.js` / Studio V2 parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PermissionTier {
    #[default]
    All = 0,
    AdminBox = 1,
    AdminBot = 2,
    AdminLevelHigh = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ChatScope {
    #[default]
    Both,
    Group,
    Private,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum InstanceScope {
    #[default]
    Any,
    MainOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum ExecutionLane {
    #[default]
    #[serde(rename = "fast-text")]
    FastText,
    #[serde(rename = "control")]
    Control,
    #[serde(rename = "heavy")]
    Heavy,
    #[serde(rename = "broadcast")]
    Broadcast,
}

impl ExecutionLane {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FastText => "fast-text",
            Self::Control => "control",
            Self::Heavy => "heavy",
            Self::Broadcast => "broadcast",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ArgSplitMode {
    #[default]
    Whitespace,
    Underscore,
}

/// Standard JSON response envelope expected by the React 19 Dashboard SPA (`dashboard/src/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvelope<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiErrorDetail>,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl<T> ApiEnvelope<T> {
    pub fn ok(data: T, request_id: impl Into<String>) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            request_id: request_id.into(),
        }
    }

    pub fn err(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
        request_id: impl Into<String>,
    ) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(ApiErrorDetail {
                code: code.into(),
                message: message.into(),
                details,
            }),
            request_id: request_id.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn zalo_id_deserializes_string_and_integers() {
        let from_str: ZaloId = serde_json::from_value(json!("8498765432101234567")).unwrap();
        let from_u64: ZaloId = serde_json::from_value(json!(8498765432101234567_u64)).unwrap();
        assert_eq!(from_str, from_u64);
        assert_eq!(from_str.as_str(), "8498765432101234567");
    }

    #[test]
    fn expiry_policy_preserves_v3_semantics() {
        let perm: ExpiryPolicy = serde_json::from_value(json!("-1")).unwrap();
        assert_eq!(perm, ExpiryPolicy::Permanent);
        assert_eq!(perm.to_v3_string(), "-1");

        let pending: ExpiryPolicy = serde_json::from_value(json!("pending")).unwrap();
        assert_eq!(pending, ExpiryPolicy::Pending);

        let future: ExpiryPolicy = serde_json::from_value(json!("2099-01-01T00:00:00Z")).unwrap();
        assert!(!future.is_expired_at(Utc::now()));
    }

    #[test]
    fn inbound_message_unwraps_double_encoded_quote_attach() {
        let raw = json!({
            "msgId": 991122334455_u64,
            "cliMsgId": "1730000000123",
            "uidFrom": "100200300",
            "idTo": "555666777",
            "dName": "Tester",
            "msgType": "webchat",
            "ts": "1730000000999",
            "content": "!help",
            "quote": {
                "ownerId": 100200300_u64,
                "cliMsgId": 1730000000001_u64,
                "globalMsgId": "991122000000",
                "cliMsgType": 32,
                "ts": 1730000000000_i64,
                "msg": "photo quote",
                "attach": "{\"href\":\"https://f10-zpcloud.zdn.vn/test.jpg\",\"width\":800}"
            }
        });

        let msg = InboundMessage::from_raw_zalo(
            "admin",
            &ZaloId::from("999999999"),
            &raw,
            ThreadType::Group,
            1730000001000,
        )
        .expect("valid message");

        assert_eq!(msg.thread_id.as_str(), "555666777");
        assert_eq!(msg.sender_uid.as_str(), "100200300");
        assert_eq!(msg.content.text_or_caption(), "!help");
        let quote = msg.quote.expect("quote parsed");
        let attach = quote.attach.expect("attach unwrapped");
        assert_eq!(attach["href"], "https://f10-zpcloud.zdn.vn/test.jpg");
    }

    #[test]
    fn self_dm_cloud_cua_toi_normalizes_zero_ids_to_self_uid() {
        let raw = json!({
            "msgId": "11223344",
            "cliMsgId": "55667788",
            "uidFrom": "0",
            "idTo": "0",
            "dName": "My Cloud",
            "msgType": "webchat",
            "ts": 1730000000000_i64,
            "content": "!menu"
        });
        let self_uid = ZaloId::from("849123456789");
        let msg = InboundMessage::from_raw_zalo("admin", &self_uid, &raw, ThreadType::User, 1730000000100)
            .expect("valid self dm");
        assert!(msg.is_self);
        assert_eq!(msg.sender_uid.as_str(), "849123456789");
        assert_eq!(msg.thread_id.as_str(), "849123456789");
    }

    #[test]
    fn remove_mentions_utf16_handles_emoji_and_vietnamese_offsets() {
        // "🚀 @Bot Cưng !menu nhạc"
        // "🚀 " is 2 UTF-16 code units (surrogate pair) + 1 space = pos 3
        // "@Bot Cưng" is 9 UTF-16 code units (pos 3, len 9)
        let text = "🚀 @Bot Cưng !menu nhạc";
        let mentions = vec![MentionSpan {
            uid: ZaloId::from("12345"),
            pos: 3,
            len: 9,
            mention_type: 0,
        }];
        let stripped = remove_mentions_utf16(text, &mentions, true);
        assert_eq!(stripped, "🚀 !menu nhạc");
        assert_eq!(utf16_len("🚀"), 2);
        assert_eq!(utf16_len("Tiếng Việt"), 10);
    }
}
