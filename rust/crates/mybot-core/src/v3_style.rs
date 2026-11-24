//! 1:1 V3 Zalo Response Envelope (`chat-style.js`, `mybot-style.js`, `command-response.js`,
//! `role-policy.js`, and `utilities.js::checkNotFindCommand`) with UTF-16 `MultiMsgStyle`
//! offsets and Zero-Markdown sanitization.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use mybot_types::{InboundMessage, MentionSpan, PermissionTier, ThreadType, ZaloId, utf16_len};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zalo_sdk::{OutboundMessage, ZaloApiError, ZaloSession};

pub const COLOR_RED: &str = "db342e";
pub const COLOR_GREEN: &str = "15a85f";
pub const COLOR_YELLOW: &str = "f7b503";
pub const DEFAULT_NAME_SERVER: &str = "Thanh Hung";
pub const DEFAULT_ICON: &str = "🤖";
pub const SIZE_MIN: u8 = 10;
pub const SIZE_MAX: u8 = 24;

pub const SAFE_COLORS: &[&str] = &[
    "db342e", "15a85f", "f7b503", "0084ff", "ff69b4", "8a2be2", "00ffff", "ffffff", "ff4500",
    "32cd32", "1e90ff", "9370db", "ffa500", "00fa9a",
];

pub const VALID_STYLE_TYPES: &[&str] = &["bold", "italic", "underline", "strike", "none"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleFontSizes {
    pub name_server: u8,
    pub text: u8,
}

impl Default for StyleFontSizes {
    fn default() -> Self {
        Self {
            name_server: 18,
            text: 14,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleFontTypes {
    pub name_server: Vec<String>,
    pub text: Vec<String>,
}

impl Default for StyleFontTypes {
    fn default() -> Self {
        Self {
            name_server: vec!["bold".to_string()],
            text: vec!["none".to_string()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotStyleConfig {
    pub icon: String,
    pub color: String,
    pub size: StyleFontSizes,
    #[serde(rename = "type")]
    pub font_type: StyleFontTypes,
}

impl Default for BotStyleConfig {
    fn default() -> Self {
        Self {
            icon: DEFAULT_ICON.to_string(),
            color: COLOR_RED.to_string(),
            size: StyleFontSizes::default(),
            font_type: StyleFontTypes::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotStyleProfile {
    pub name_server: String,
    pub style: BotStyleConfig,
}

impl Default for BotStyleProfile {
    fn default() -> Self {
        Self {
            name_server: DEFAULT_NAME_SERVER.to_string(),
            style: BotStyleConfig::default(),
        }
    }
}

impl BotStyleProfile {
    /// Extracts a bot's custom `nameServer` and `style` from `BotRecord::metadata` (falling back
    /// to V3 defaults: `nameServer = "Thanh Hung"`, `icon = "🤖"`, `color = "db342e"`).
    pub fn from_bot_metadata(metadata: &Value, fallback_display_name: Option<&str>) -> Self {
        let name_server = metadata
            .get("nameServer")
            .or_else(|| metadata.get("profile").and_then(|p| p.get("nameServer")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                fallback_display_name
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != "Bot Admin Chính")
            })
            .unwrap_or(DEFAULT_NAME_SERVER)
            .to_string();

        let raw_style = metadata
            .get("style")
            .or_else(|| metadata.get("profile").and_then(|p| p.get("style")))
            .cloned()
            .unwrap_or(Value::Null);

        Self {
            name_server,
            style: normalize_style_json(&raw_style),
        }
    }

    pub fn write_into_metadata(&self, metadata: &mut Value) {
        if !metadata.is_object() {
            *metadata = json!({});
        }
        if let Some(obj) = metadata.as_object_mut() {
            obj.insert("nameServer".to_string(), json!(self.name_server));
            obj.insert(
                "style".to_string(),
                serde_json::to_value(&self.style).unwrap_or_else(|_| json!({})),
            );
        }
    }
}

pub fn named_color_hex(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "red" | "do" | "đỏ" => Some("db342e"),
        "green" | "xanhla" | "xanhlá" => Some("15a85f"),
        "yellow" | "gold" | "vang" | "vàng" => Some("f7b503"),
        "blue" | "xanhduong" | "xanh" => Some("0084ff"),
        "pink" | "hong" | "hồng" => Some("ff69b4"),
        "purple" | "tim" | "tím" => Some("8a2be2"),
        "cyan" => Some("00ffff"),
        "white" | "trang" | "trắng" => Some("ffffff"),
        "orange" | "cam" => Some("ffa500"),
        "black" | "den" | "đen" => Some("000000"),
        "lime" => Some("32cd32"),
        _ => None,
    }
}

pub fn normalize_color(raw: &str, default_hex: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    if let Some(named) = named_color_hex(&lower) {
        return named.to_string();
    }
    let clean = lower.trim_start_matches('#');
    if clean.len() == 3 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return clean.chars().flat_map(|c| [c, c]).collect();
    }
    if clean.len() == 6 && clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return clean.to_string();
    }
    default_hex.to_string()
}

pub fn normalize_size(val: Option<&Value>, default_size: u8) -> u8 {
    let parsed = val.and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str()?.trim().parse::<i64>().ok())
    });
    match parsed {
        Some(n) => n.clamp(SIZE_MIN as i64, SIZE_MAX as i64) as u8,
        None => default_size,
    }
}

pub fn normalize_type_list(val: Option<&Value>, default_list: &[&str]) -> Vec<String> {
    let mut raw_items: Vec<String> = Vec::new();
    match val {
        Some(Value::Array(arr)) => {
            for item in arr {
                if let Some(s) = item.as_str() {
                    raw_items.push(s.trim().to_ascii_lowercase());
                }
            }
        }
        Some(Value::String(s)) => {
            for part in s.split(|c: char| c.is_whitespace() || c == ',') {
                if !part.trim().is_empty() {
                    raw_items.push(part.trim().to_ascii_lowercase());
                }
            }
        }
        _ => {}
    }

    let mut valid: Vec<String> = Vec::new();
    for item in raw_items {
        if VALID_STYLE_TYPES.contains(&item.as_str()) && !valid.contains(&item) {
            valid.push(item);
        }
    }
    if valid.is_empty() {
        return default_list.iter().map(|s| (*s).to_string()).collect();
    }
    if valid.iter().any(|s| s == "none") {
        return vec!["none".to_string()];
    }
    valid
}

pub fn normalize_style_json(input: &Value) -> BotStyleConfig {
    let icon = input
        .get("icon")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 10)
        .unwrap_or(DEFAULT_ICON)
        .to_string();

    let color = input
        .get("color")
        .and_then(Value::as_str)
        .map(|c| normalize_color(c, COLOR_RED))
        .unwrap_or_else(|| COLOR_RED.to_string());

    let size_obj = input.get("size");
    let size = StyleFontSizes {
        name_server: normalize_size(size_obj.and_then(|o| o.get("nameServer")), 18),
        text: normalize_size(size_obj.and_then(|o| o.get("text")), 14),
    };

    let type_obj = input.get("type");
    let font_type = StyleFontTypes {
        name_server: normalize_type_list(type_obj.and_then(|o| o.get("nameServer")), &["bold"]),
        text: normalize_type_list(type_obj.and_then(|o| o.get("text")), &["none"]),
    };

    BotStyleConfig {
        icon,
        color,
        size,
        font_type,
    }
}

pub fn validate_style_json(style: &Value) -> Result<(), Vec<String>> {
    let Some(obj) = style.as_object() else {
        return Err(vec!["style must be an object".to_string()]);
    };
    let mut errors = Vec::new();

    if let Some(icon) = obj.get("icon") {
        match icon.as_str() {
            Some(s) if !s.trim().is_empty() && s.chars().count() <= 10 => {}
            _ => errors.push("style.icon must be a string of length 1-10".to_string()),
        }
    }

    if let Some(color) = obj.get("color") {
        let raw = color.as_str().unwrap_or_default().trim().to_ascii_lowercase();
        let clean = raw.trim_start_matches('#');
        let is_hex = (clean.len() == 3 || clean.len() == 6)
            && clean.chars().all(|c| c.is_ascii_hexdigit());
        if named_color_hex(&raw).is_none() && !is_hex {
            errors.push(format!(
                "style.color '{raw}' is not a valid hex color code or color name"
            ));
        }
    }

    if let Some(size) = obj.get("size") {
        if let Some(sobj) = size.as_object() {
            for field in ["nameServer", "text"] {
                if let Some(v) = sobj.get(field) {
                    let parsed = v
                        .as_i64()
                        .or_else(|| v.as_str()?.trim().parse::<i64>().ok());
                    if !parsed.is_some_and(|n| (SIZE_MIN as i64..=SIZE_MAX as i64).contains(&n)) {
                        errors.push(format!(
                            "style.size.{field} must be an integer between {SIZE_MIN} and {SIZE_MAX}"
                        ));
                    }
                }
            }
        } else {
            errors.push("style.size must be an object".to_string());
        }
    }

    if let Some(tp) = obj.get("type") {
        if let Some(tobj) = tp.as_object() {
            for field in ["nameServer", "text"] {
                if let Some(v) = tobj.get(field) {
                    let items: Vec<String> = match v {
                        Value::Array(arr) => arr
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|s| s.to_ascii_lowercase())
                            .collect(),
                        Value::String(s) => vec![s.to_ascii_lowercase()],
                        _ => vec!["invalid".to_string()],
                    };
                    for item in items {
                        if !VALID_STYLE_TYPES.contains(&item.as_str()) {
                            errors.push(format!("style.type.{field} contains invalid type '{item}'"));
                        }
                    }
                }
            }
        } else {
            errors.push("style.type must be an object".to_string());
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Strips all raw Markdown tokens (`**`, `` ` ``) that Zalo does not render.
pub fn sanitize_no_markdown(raw: &str) -> String {
    if !raw.contains("**") && !raw.contains('`') {
        return raw.to_string();
    }
    raw.replace("**", "").replace('`', "")
}

/// Builds the exact Zalo `st` token string matching `src/api-zalo/models/Message.js::MessageStyle`:
/// `b`, `i`, `u`, `s`, `c_<hex>`, `f_<size>`.
pub fn format_zalo_style_tokens(color_hex: &str, font_size: u8, types: &[String]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(6);
    if types.iter().any(|t| t == "bold") {
        parts.push("b".to_string());
    }
    if types.iter().any(|t| t == "italic") {
        parts.push("i".to_string());
    }
    if types.iter().any(|t| t == "underline") {
        parts.push("u".to_string());
    }
    if types.iter().any(|t| t == "strike") {
        parts.push("s".to_string());
    }
    let clean_color = color_hex.trim().trim_start_matches('#').to_ascii_lowercase();
    if !clean_color.is_empty() {
        parts.push(format!("c_{clean_color}"));
    }
    parts.push(format!("f_{}", font_size.clamp(SIZE_MIN, SIZE_MAX)));
    parts.join(",")
}

/// Builds a `MultiMsgStyle` JSON string (`{"styles":[{"start":..,"len":..,"st":..}],"ver":0}`)
/// using **UTF-16 code unit** offsets (`mybot-style.js:204-255`).
pub struct StyledEnvelopeParams<'a> {
    pub style: &'a BotStyleConfig,
    pub name_server: &'a str,
    pub sender_name: &'a str,
    pub is_group: bool,
    pub text: &'a str,
    pub state_icon: &'a str,
    pub ttl_ms: u64,
    pub quote: Option<mybot_types::QuotedMessage>,
    pub mentions: Vec<MentionSpan>,
    pub attachments: Vec<PathBuf>,
}

pub fn build_styled_outbound(params: StyledEnvelopeParams<'_>) -> OutboundMessage {
    let clean_header_name = sanitize_no_markdown(params.name_server);
    let clean_body = sanitize_no_markdown(params.text);

    let icon_prefix = if params.style.icon.trim().is_empty() {
        String::new()
    } else {
        format!("{} ", params.style.icon.trim())
    };
    let header_line = format!("{icon_prefix}{clean_header_name}").trim().to_string();
    let group_prefix = if params.is_group && !params.sender_name.trim().is_empty() {
        format!("{}\n", params.sender_name)
    } else {
        String::new()
    };
    let state_suffix = if params.state_icon.is_empty() {
        String::new()
    } else {
        format!("\n{}", params.state_icon)
    };

    let full_msg = if clean_body.is_empty() && state_suffix.is_empty() {
        format!("{group_prefix}{header_line}")
    } else {
        format!("{group_prefix}{header_line}\n{clean_body}{state_suffix}")
    };

    let header_offset = utf16_len(&group_prefix);
    let header_len = utf16_len(&header_line);
    let mut style_spans = Vec::with_capacity(2);
    if header_len > 0 {
        style_spans.push(json!({
            "start": header_offset,
            "len": header_len,
            "st": format_zalo_style_tokens(
                &params.style.color,
                params.style.size.name_server,
                &params.style.font_type.name_server,
            ),
        }));
    }

    let body_len = utf16_len(&clean_body);
    let has_custom_text_type = params
        .style
        .font_type
        .text
        .iter()
        .any(|t| matches!(t.as_str(), "bold" | "italic" | "underline" | "strike"));
    if body_len > 0 && (has_custom_text_type || params.style.size.text != 14) {
        let text_offset = header_offset + header_len + 1;
        style_spans.push(json!({
            "start": text_offset,
            "len": body_len,
            "st": format_zalo_style_tokens(
                &params.style.color,
                params.style.size.text,
                &params.style.font_type.text,
            ),
        }));
    }

    let multi_style_str = json!({
        "styles": style_spans,
        "ver": 0,
    })
    .to_string();

    OutboundMessage {
        text: full_msg,
        mentions: params.mentions,
        quote: params.quote,
        style: Some(Value::String(multi_style_str)),
        attachments: params.attachments,
        ttl_ms: params.ttl_ms,
        link_on: false,
    }
}

fn caller_mention_if_group(msg: &InboundMessage) -> Vec<MentionSpan> {
    if msg.thread_type == ThreadType::Group
        && !msg.sender_name.trim().is_empty()
        && !msg.sender_uid.is_empty()
    {
        vec![MentionSpan {
            uid: msg.sender_uid.clone(),
            pos: 0,
            len: utf16_len(&msg.sender_name),
            mention_type: 0,
        }]
    } else {
        Vec::new()
    }
}

// =============================================================================
// 1:1 `chat-style.js` Builders
// =============================================================================

pub fn build_insufficient_authority(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    has_state: bool,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_RED.to_string();
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon: if has_state { "🚫🚫🚫" } else { "" },
        ttl_ms: 60_000,
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_query(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    has_state: bool,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_RED.to_string();
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon: if has_state { "❓❓❓" } else { "" },
        ttl_ms: 60_000,
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_warning(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    has_state: bool,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_RED.to_string();
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon: if has_state { "🚨🚨🚨" } else { "" },
        ttl_ms: 60_000,
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_complete(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    has_state: bool,
) -> OutboundMessage {
    build_styled_outbound(StyledEnvelopeParams {
        style: &profile.style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon: if has_state { "✅✅✅" } else { "" },
        ttl_ms: 60_000,
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_failed(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    has_state: bool,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_RED.to_string();
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon: if has_state { "❌❌❌" } else { "" },
        ttl_ms: 60_000,
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_state_quote(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    state: bool,
    ttl_ms: u64,
    on_state: bool,
) -> OutboundMessage {
    let state_icon = if on_state {
        if state { "✅✅✅" } else { "❌❌❌" }
    } else {
        ""
    };
    build_styled_outbound(StyledEnvelopeParams {
        style: &profile.style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon,
        ttl_ms: if ttl_ms == 0 { 60_000 } else { ttl_ms },
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_state_no_quote(
    profile: &BotStyleProfile,
    is_group: bool,
    caption: &str,
    state: bool,
    ttl_ms: u64,
) -> OutboundMessage {
    build_styled_outbound(StyledEnvelopeParams {
        style: &profile.style,
        name_server: &profile.name_server,
        sender_name: "",
        is_group,
        text: caption,
        state_icon: if state { "✅✅✅" } else { "❌❌❌" },
        ttl_ms,
        quote: None,
        mentions: Vec::new(),
        attachments: Vec::new(),
    })
}

pub fn build_from_sql(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    success: bool,
    caption: &str,
    has_state: bool,
    ttl_ms: u64,
) -> OutboundMessage {
    let state_icon = if has_state {
        if success { "✅✅✅" } else { "❌❌❌" }
    } else {
        ""
    };
    build_styled_outbound(StyledEnvelopeParams {
        style: &profile.style,
        name_server: &profile.name_server,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: caption,
        state_icon,
        ttl_ms,
        quote: Some(msg.to_quote_target()),
        mentions: caller_mention_if_group(msg),
        attachments: Vec::new(),
    })
}

pub fn build_warning_request(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    image_path: Option<PathBuf>,
    ttl_ms: u64,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_RED.to_string();
    style.size.name_server = 14;
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: caption,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: "",
        state_icon: "",
        ttl_ms,
        quote: None,
        mentions: caller_mention_if_group(msg),
        attachments: image_path.into_iter().collect(),
    })
}

pub fn build_processing_request(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    image_path: Option<PathBuf>,
    ttl_ms: u64,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_YELLOW.to_string();
    style.size.name_server = 14;
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: caption,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: "",
        state_icon: "",
        ttl_ms,
        quote: None,
        mentions: caller_mention_if_group(msg),
        attachments: image_path.into_iter().collect(),
    })
}

pub fn build_complete_request(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    image_path: Option<PathBuf>,
    ttl_ms: u64,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_GREEN.to_string();
    style.size.name_server = 14;
    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: caption,
        sender_name: &msg.sender_name,
        is_group: msg.thread_type == ThreadType::Group,
        text: "",
        state_icon: "",
        ttl_ms,
        quote: None,
        mentions: caller_mention_if_group(msg),
        attachments: image_path.into_iter().collect(),
    })
}

pub fn build_tag_message(
    profile: &BotStyleProfile,
    msg: &InboundMessage,
    caption: &str,
    extra_mentions: &[MentionSpan],
    image_path: Option<PathBuf>,
    ttl_ms: u64,
) -> OutboundMessage {
    let mut style = profile.style.clone();
    style.color = COLOR_GREEN.to_string();
    style.size.name_server = 14;
    let is_group = msg.thread_type == ThreadType::Group;
    let prefix_shift = if is_group && !msg.sender_name.trim().is_empty() {
        utf16_len(&format!("{}\n", msg.sender_name))
    } else {
        0
    };
    let icon_shift = if style.icon.trim().is_empty() {
        0
    } else {
        utf16_len(&format!("{} ", style.icon.trim()))
    };

    let mut mentions = caller_mention_if_group(msg);
    for m in extra_mentions {
        mentions.push(MentionSpan {
            uid: m.uid.clone(),
            pos: m.pos + prefix_shift + icon_shift,
            len: m.len,
            mention_type: m.mention_type,
        });
    }

    build_styled_outbound(StyledEnvelopeParams {
        style: &style,
        name_server: caption,
        sender_name: &msg.sender_name,
        is_group,
        text: "",
        state_icon: "",
        ttl_ms,
        quote: None,
        mentions,
        attachments: image_path.into_iter().collect(),
    })
}

/// Sends `"thanks"` (`rType = 111`, `"/-thanks"`) reaction on commands of `legacy_type` 1, 2, 3, or 5
/// (`command-response.js::sendReactionConfirmReceive`).
pub async fn send_reaction_confirm_receive(
    zalo: &ZaloSession,
    msg: &InboundMessage,
    legacy_type: u8,
) -> Result<bool, ZaloApiError> {
    if !matches!(legacy_type, 1 | 2 | 3 | 5) {
        return Ok(false);
    }
    let msg_id = if !msg.msg_id.is_empty() {
        &msg.msg_id
    } else if !msg.global_msg_id.is_empty() {
        &msg.global_msg_id
    } else {
        &msg.cli_msg_id
    };
    if msg_id.is_empty() || msg.thread_id.is_empty() {
        return Ok(false);
    }
    zalo.add_reaction(
        "thanks",
        msg_id,
        &msg.cli_msg_id,
        mybot_types::client_message_type_code(&msg.msg_type),
        &msg.thread_id,
        msg.thread_type,
    )
    .await?;
    Ok(true)
}

// =============================================================================
// Role Labels, Error Reference & Levenshtein Fuzzy Suggestion (`utilities.js`)
// =============================================================================

pub fn permission_display_name(tier: PermissionTier) -> &'static str {
    match tier {
        PermissionTier::All => "Tất cả người dùng",
        PermissionTier::AdminBox => "Quản trị viên nhóm",
        PermissionTier::AdminBot => "Quản trị viên bot",
        PermissionTier::AdminLevelHigh => "Quản trị viên cấp cao",
    }
}

pub fn format_permission_denied(required: PermissionTier) -> String {
    format!(
        "Bạn không có đủ quyền hạn để sử dụng lệnh này.\nYêu cầu quyền hạn tối thiểu: {}",
        permission_display_name(required)
    )
}

pub fn create_command_error_reference(msg: &InboundMessage, err_label: &str) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seed = format!(
        "{}:{}:{}:{}",
        if msg.thread_id.is_empty() {
            "unknown-thread"
        } else {
            msg.thread_id.as_str()
        },
        if msg.sender_uid.is_empty() {
            "unknown-user"
        } else {
            msg.sender_uid.as_str()
        },
        now_ms,
        err_label
    );
    let mut hash: u32 = 0;
    for cu in seed.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(cu as u32);
    }
    format!("CMD-{hash:08X}")
}

pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let m = ac.len();
    let n = bc.len();
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = usize::from(ac[i - 1] != bc[j - 1]);
            curr[j] = (prev[j - 1] + cost)
                .min(prev[j] + 1)
                .min(curr[j - 1] + 1);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

fn common_shortcut_target(short: &str) -> Option<&'static str> {
    match short {
        "dy" => Some("daily"),
        "dk" => Some("dangky"),
        "nt" => Some("nongtrai"),
        "tx" => Some("taixiu"),
        "kbb" => Some("keobuabao"),
        "tt" => Some("thongtin"),
        "bg" => Some("background"),
        _ => None,
    }
}

fn is_ordered_subsequence(needle: &str, haystack: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut h_iter = haystack.chars();
    for ch in needle.chars() {
        if !h_iter.any(|hc| hc == ch) {
            return false;
        }
    }
    true
}

/// Port of `src/commands/bot-manager/utilities.js::findSimilarCommands` + `checkNotFindCommand`.
pub fn build_not_found_command_caption(
    prefix: &str,
    typed_cmd: &str,
    available: &[(&str, PermissionTier)],
) -> String {
    let clean_cmd = typed_cmd.trim();
    if clean_cmd.is_empty() {
        return format!(
            "Nếu Mày Thắc Mắc Tao Có Những Lệnh Gì, Hãy:\n{prefix}help - Xem hướng dẫn sử dụng\n{prefix}game - Xem hướng dẫn chơi game\n{prefix}command - Xem danh sách lệnh có sẵn"
        );
    }

    let cmd_lower = clean_cmd.to_lowercase();
    let cmd_len = cmd_lower.chars().count().max(1);
    let shortcut = common_shortcut_target(&cmd_lower);

    let mut matches: Vec<(&str, PermissionTier, f64)> = Vec::new();
    for &(name, perm) in available {
        let name_lower = name.to_lowercase();
        let is_starts = name_lower.starts_with(&cmd_lower);
        let is_shortcut = shortcut == Some(name_lower.as_str());
        let is_subseq = cmd_len >= 2 && is_ordered_subsequence(&cmd_lower, &name_lower);
        let max_len = cmd_len.max(name_lower.chars().count()).max(1);
        let dist = levenshtein_distance(&cmd_lower, &name_lower);
        let sim = 1.0 - (dist as f64) / (max_len as f64);

        if is_starts || is_shortcut || is_subseq || sim >= 0.6 {
            let score = if is_starts {
                1.0
            } else if is_shortcut {
                0.95
            } else if is_subseq {
                0.9
            } else {
                sim
            };
            matches.push((name, perm, score));
        }
    }

    matches.sort_by(|a, b| {
        (a.1 as u8)
            .cmp(&(b.1 as u8))
            .then_with(|| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal))
    });
    matches.truncate(5);

    if !matches.is_empty() {
        let lines: Vec<String> = matches
            .into_iter()
            .map(|(name, perm, _)| format!("{prefix}{name} [{}]", permission_display_name(perm)))
            .collect();
        format!(
            "Không tìm thấy lệnh \"{clean_cmd}\"\nCó phải mày muốn dùng:\n{}",
            lines.join("\n")
        )
    } else {
        format!(
            "Không tìm thấy lệnh \"{clean_cmd}\". Vui lòng sử dụng:\n{prefix}help - Xem hướng dẫn sử dụng\n{prefix}game - Xem hướng dẫn chơi game\n{prefix}command - Xem danh sách lệnh có sẵn"
        )
    }
}

/// Convenience helper for sending a bare quoted message with fallback without quote (`prefix.js::safeSendMessage`).
pub async fn send_quoted_plain_ttl(
    zalo: &ZaloSession,
    msg: &InboundMessage,
    text: impl Into<String>,
    ttl_ms: u64,
) -> Result<Value, ZaloApiError> {
    let clean = sanitize_no_markdown(&text.into());
    let out = OutboundMessage {
        text: clean,
        quote: Some(msg.to_quote_target()),
        ttl_ms,
        link_on: false,
        ..Default::default()
    };
    zalo.send_message(out, &msg.thread_id, msg.thread_type).await
}

/// Helper to build a direct DM `OutboundMessage` with optional `ttl_ms`.
pub fn build_dm_plain(text: impl Into<String>, ttl_ms: u64) -> OutboundMessage {
    OutboundMessage {
        text: sanitize_no_markdown(&text.into()),
        ttl_ms,
        link_on: false,
        ..Default::default()
    }
}

pub fn thread_id_for_dm(uid: &str) -> ZaloId {
    ZaloId::new(uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mybot_types::{EventSource, MessageContent};

    fn sample_group_msg() -> InboundMessage {
        InboundMessage {
            bot_key: "admin".into(),
            msg_id: ZaloId::new("1001"),
            cli_msg_id: ZaloId::new("2002"),
            global_msg_id: ZaloId::new("1001"),
            thread_id: ZaloId::new("grp_888"),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("u_999"),
            sender_name: "Nguyễn Văn 😀".to_string(),
            is_self: false,
            msg_type: "webchat".into(),
            timestamp_ms: 1_730_000_000_000,
            ws_received_at_ms: 1_730_000_000_001,
            ttl_ms: 0,
            mentions: Vec::new(),
            styles: Vec::new(),
            quote: None,
            content: MessageContent::Text {
                text: "!help".to_string(),
            },
            source: EventSource::WebSocket,
            raw_property_ext: None,
        }
    }

    #[test]
    fn styled_envelope_strips_markdown_and_computes_exact_utf16_offsets() {
        let profile = BotStyleProfile::default();
        let msg = sample_group_msg();
        let out = build_complete(&profile, &msg, "Đã **bật** lệnh `!help` thành công", true);

        assert!(!out.text.contains("**"));
        assert!(!out.text.contains('`'));
        assert!(out.text.contains("🤖 Thanh Hung"));
        assert!(out.text.ends_with("✅✅✅"));
        assert_eq!(out.ttl_ms, 60_000);
        assert!(out.quote.is_some());

        // Caller mention must cover exact UTF-16 length of "Nguyễn Văn 😀" (emoji = 2 UTF-16 units)
        assert_eq!(out.mentions.len(), 1);
        assert_eq!(out.mentions[0].pos, 0);
        assert_eq!(out.mentions[0].len, utf16_len("Nguyễn Văn 😀"));

        let style_str = out.style.as_ref().and_then(Value::as_str).unwrap();
        let parsed: Value = serde_json::from_str(style_str).unwrap();
        let first = &parsed["styles"][0];
        assert_eq!(
            first["start"].as_u64().unwrap() as usize,
            utf16_len("Nguyễn Văn 😀\n")
        );
        assert_eq!(
            first["len"].as_u64().unwrap() as usize,
            utf16_len("🤖 Thanh Hung")
        );
        assert_eq!(first["st"], "b,c_db342e,f_18");
    }

    #[test]
    fn fuzzy_not_found_command_matches_v3_shortcuts_and_levenshtein() {
        let cmds = [
            ("help", PermissionTier::All),
            ("taixiu", PermissionTier::All),
            ("setcmd", PermissionTier::AdminLevelHigh),
        ];
        let c1 = build_not_found_command_caption("!", "tx", &cmds);
        assert!(c1.contains("!taixiu [Tất cả người dùng]"));

        let c2 = build_not_found_command_caption("!", "helpp", &cmds);
        assert!(c2.contains("!help [Tất cả người dùng]"));
    }
}
