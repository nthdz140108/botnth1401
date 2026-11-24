//! Moderation, Anti-Service & Group Protection Command Handlers (30 Canonical Commands).
//!
//! Covers `!antibadword`, `!antilink`, `!antispam`, `!antinude`, `!antiundo`, `!antiforward`,
//! `!antitag`, `!antisticker`, `!antistickerlag`, `!antistickereffect`, `!antigif`, `!antivideo`,
//! `!antiphoto`, `!antifile`, `!antivoice`, `!antitext`, `!antiall`, `!onlytext`, `!antisdt`,
//! `!antibot`, `!antiblockall`, `!antijoin`, `!autojoin`, `!antisetup`, `!mute`, `!unmute`,
//! `!listmute`, `!ban`, `!unban`, and `!whitelist`.

use chrono::Utc;
use mybot_core::{CommandContext, CommandError, CommandOutcome, CommandSpec};
use serde_json::{Value, json};

use crate::{CommandRuntimeBundle, send_text_reply};

fn parse_bool_toggle(arg: Option<&str>, current: bool) -> bool {
    match arg.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("on" | "1" | "true" | "bat" | "bật" | "enable") => true,
        Some("off" | "0" | "false" | "tat" | "tắt" | "disable") => false,
        _ => !current,
    }
}

pub(crate) fn extract_mod_targets(ctx: &CommandContext) -> Vec<String> {
    let mut targets = Vec::new();
    for m in &ctx.message.mentions {
        let s = m.uid.to_string();
        if s != "-1" && !s.is_empty() && !targets.contains(&s) {
            targets.push(s);
        }
    }
    for a in &ctx.args {
        let clean = a.trim();
        let lower = clean.to_ascii_lowercase();
        if matches!(lower.as_str(), "all" | "on" | "off" | "add" | "remove" | "del" | "list" | "clear" | "get") {
            continue;
        }
        let is_duration = clean.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
            && (lower.ends_with('m') || lower.ends_with('p') || lower.ends_with('h') || lower.ends_with('g') || lower.ends_with('d') || lower.ends_with('n') || lower.ends_with('s'));
        let is_digit_uid = clean.chars().all(|c| c.is_ascii_digit()) && clean.len() >= 6;
        let is_custom_uid = clean.len() >= 4
            && !clean.contains(' ')
            && !is_duration;
        if is_digit_uid || is_custom_uid {
            let s = clean.to_string();
            if !targets.contains(&s) {
                targets.push(s);
            }
        }
    }
    if targets.is_empty() {
        if let Some(ref q) = ctx.message.quote {
            let s = q.owner_id.to_string();
            if s != "-1" && !s.is_empty() && !targets.contains(&s) {
                targets.push(s);
            }
        }
    }
    targets
}

pub(crate) fn get_all_protected_uids(ctx: &CommandContext) -> Vec<String> {
    let mut protected = vec![ctx.self_uid.to_string()];
    if let Ok(bots) = ctx.caches.engine().list_bots() {
        for b in bots {
            let s = b.uid.to_string();
            if !s.is_empty() && !protected.contains(&s) {
                protected.push(s);
            }
            if let Some(ref guid) = b.global_uid {
                if !guid.is_empty() && !protected.contains(guid) {
                    protected.push(guid.clone());
                }
            }
        }
    }
    if let Ok(admins) = ctx.caches.engine().list_bot_admins(&ctx.bot_key) {
        for (uid, _, _) in admins {
            if !protected.contains(&uid) {
                protected.push(uid);
            }
        }
    }
    let creator_val = ctx.group_settings.settings.get("creatorId")
        .or_else(|| ctx.group_settings.settings.pointer("/cachedMembers/creatorId"));
    if let Some(creator) = creator_val.and_then(Value::as_str) {
        if !protected.contains(&creator.to_string()) {
            protected.push(creator.to_string());
        }
    }
    let admins_val = ctx.group_settings.settings.get("adminIds")
        .or_else(|| ctx.group_settings.settings.pointer("/cachedMembers/adminIds"));
    if let Some(admins) = admins_val.and_then(Value::as_array) {
        for a in admins {
            if let Some(u) = a.as_str() {
                if !protected.contains(&u.to_string()) {
                    protected.push(u.to_string());
                }
            }
        }
    }
    protected
}

pub fn parse_mute_duration_minutes(args: &[String]) -> i64 {
    for arg in args {
        let s = arg.trim().to_ascii_lowercase();
        if let Some(num) = s.strip_suffix('m').or_else(|| s.strip_suffix('p')) {
            if let Ok(v) = num.parse::<i64>() {
                return v.clamp(1, 43_200);
            }
        } else if let Some(num) = s.strip_suffix('h').or_else(|| s.strip_suffix('g')) {
            if let Ok(v) = num.parse::<i64>() {
                return (v * 60).clamp(1, 43_200);
            }
        } else if let Some(num) = s.strip_suffix('d').or_else(|| s.strip_suffix('n')) {
            if let Ok(v) = num.parse::<i64>() {
                return (v * 1440).clamp(1, 43_200);
            }
        } else if let Some(num) = s.strip_suffix('s') {
            if let Ok(v) = num.parse::<i64>() {
                return (v / 60).max(1).clamp(1, 43_200);
            }
        } else if let Ok(v) = s.parse::<i64>() {
            if v > 0 && v <= 43_200 && s.len() <= 5 {
                return v;
            }
        }
    }
    60
}

pub async fn execute_moderation_command(
    spec: &'static CommandSpec,
    ctx: CommandContext,
    _rt: &CommandRuntimeBundle,
) -> Result<CommandOutcome, CommandError> {
    let thread_id = ctx.message.thread_id.as_str().to_string();
    let bot_key = ctx.bot_key.clone();
    let first_arg = ctx.args.first().map(String::as_str);

    let reply = match spec.name {
        "antibadword" => {
            let sub = first_arg.unwrap_or("").to_ascii_lowercase();
            if sub == "add" {
                if ctx.args.len() < 2 {
                    return send_text_reply(&ctx, "⚠️ Vui lòng nhập từ khóa cần thêm vào danh sách từ cấm.").await;
                }
                let word = ctx.args[1..].join(" ").trim().to_lowercase();
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    let arr = g.settings
                        .as_object_mut()
                        .unwrap()
                        .entry("badWords")
                        .or_insert_with(|| json!([]));
                    if let Some(list) = arr.as_array_mut()
                        && !list.iter().any(|v| v.as_str() == Some(word.as_str()))
                    {
                        list.push(json!(word));
                    }
                    g.anti_bad_word = true;
                });
                format!("🛡️ Đã thêm từ cấm `{word}` và bật lọc từ thô tục cho nhóm.")
            } else if sub == "remove" {
                if ctx.args.len() < 2 {
                    return send_text_reply(&ctx, "⚠️ Vui lòng nhập từ khóa cần xóa khỏi danh sách từ cấm.").await;
                }
                let word = ctx.args[1..].join(" ").trim().to_lowercase();
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    if let Some(list) = g.settings.get_mut("badWords").and_then(Value::as_array_mut) {
                        list.retain(|v| v.as_str() != Some(word.as_str()));
                    }
                });
                format!("🛡️ Đã gỡ từ cấm `{word}` khỏi danh sách lọc của nhóm.")
            } else if sub == "list" {
                let words: Vec<String> = ctx
                    .group_settings
                    .settings
                    .get("badWords")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(ToOwned::to_owned)).collect())
                    .unwrap_or_default();
                if words.is_empty() {
                    "📋 Danh sách từ cấm riêng của nhóm hiện đang trống.".into()
                } else {
                    format!("📋 Từ cấm của nhóm ({}): {}", words.len(), words.join(", "))
                }
            } else {
                let next = parse_bool_toggle(first_arg, ctx.group_settings.anti_bad_word);
                ctx.caches
                    .update_group_settings(&bot_key, &thread_id, |g| g.anti_bad_word = next);
                format!(
                    "🛡️ Chống từ ngữ thô tục (antibadword): {}",
                    if next { "ĐÃ BẬT" } else { "ĐÃ TẮT" }
                )
            }
        }
        "mute" => {
            let is_mute_all = first_arg == Some("all") || ctx.raw_args_text.contains("mute all");
            let mins = parse_mute_duration_minutes(&ctx.args);
            let until_epoch = Utc::now().timestamp() + mins * 60;

            if is_mute_all {
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    let obj = g.settings.as_object_mut().unwrap();
                    let mute_map = obj.entry("muteList").or_insert_with(|| json!({}));
                    if let Some(m) = mute_map.as_object_mut() {
                        m.insert(
                            "-1".to_string(),
                            json!({ "timeMute": until_epoch, "mutedAt": Utc::now().to_rfc3339() }),
                        );
                    }
                });
                format!("🔇 Đã cấm chat toàn bộ thành viên trong nhóm trong {mins} phút.")
            } else {
                let targets = extract_mod_targets(&ctx);
                if targets.is_empty() {
                    return Err(CommandError::MissingArgument(
                        "Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của thành viên cần cấm chat.".into(),
                    ));
                }
                let protected = get_all_protected_uids(&ctx);
                let valid_targets: Vec<String> = targets
                    .into_iter()
                    .filter(|u| !protected.contains(u))
                    .collect();

                if valid_targets.is_empty() {
                    return send_text_reply(
                        &ctx,
                        "⚠️ Không thể cấm chat vì mục tiêu là Quản trị viên hoặc Bot được bảo vệ.",
                    )
                    .await;
                }

                let count = valid_targets.len();
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    let obj = g.settings.as_object_mut().unwrap();
                    let mute_map = obj.entry("muteList").or_insert_with(|| json!({}));
                    if let Some(m) = mute_map.as_object_mut() {
                        for uid in valid_targets {
                            m.insert(
                                uid,
                                json!({ "timeMute": until_epoch, "mutedAt": Utc::now().to_rfc3339() }),
                            );
                        }
                    }
                });
                format!("🔇 Đã cấm chat {count} thành viên trong {mins} phút.")
            }
        }
        "unmute" => {
            let is_unmute_all = first_arg == Some("all")
                || ctx.raw_args_text.contains("unmute all")
                || (ctx.args.is_empty() && ctx.message.mentions.is_empty() && ctx.message.quote.is_none());

            if is_unmute_all {
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    if let Some(m) = g.settings.get_mut("muteList").and_then(Value::as_object_mut) {
                        m.clear();
                    }
                });
                "🔊 Đã gỡ cấm chat cho toàn bộ thành viên trong nhóm.".into()
            } else {
                let targets = extract_mod_targets(&ctx);
                if targets.is_empty() {
                    ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                        if let Some(m) = g.settings.get_mut("muteList").and_then(Value::as_object_mut) {
                            m.clear();
                        }
                    });
                    "🔊 Đã gỡ cấm chat cho toàn bộ thành viên trong nhóm.".into()
                } else {
                    let count = targets.len();
                    ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                        if let Some(m) = g.settings.get_mut("muteList").and_then(Value::as_object_mut) {
                            for uid in &targets {
                                m.remove(uid);
                            }
                        }
                    });
                    format!("🔊 Đã gỡ cấm chat cho {count} thành viên.")
                }
            }
        }
        "listmute" => {
            let mute_map = ctx
                .group_settings
                .settings
                .get("muteList")
                .and_then(Value::as_object);
            let count = mute_map.map(|m| m.len()).unwrap_or(0);
            if count == 0 {
                "🔇 Hiện không có thành viên nào bị cấm chat trong nhóm.".into()
            } else {
                let now = Utc::now().timestamp();
                let mut lines = Vec::new();
                if let Some(all_mute) = mute_map.and_then(|m| m.get("-1")) {
                    let until = all_mute.get("timeMute").and_then(Value::as_i64).unwrap_or(0);
                    let rem = (until - now).max(0) / 60;
                    lines.push(format!("• Toàn bộ thành viên (còn ~{rem} phút)"));
                }
                if let Some(map) = mute_map {
                    for (uid, val) in map {
                        if uid == "-1" {
                            continue;
                        }
                        let until = val.get("timeMute").and_then(Value::as_i64).unwrap_or(0);
                        let rem = (until - now).max(0) / 60;
                        lines.push(format!("• UID `{uid}` (còn ~{rem} phút)"));
                    }
                }
                format!("🔇 Danh sách thành viên bị cấm chat ({count}):\n{}", lines.join("\n"))
            }
        }
        "whitelist" => {
            let targets = extract_mod_targets(&ctx);
            let sub = first_arg.unwrap_or("").to_ascii_lowercase();

            if sub == "remove" || sub == "del" {
                if targets.is_empty() {
                    return send_text_reply(&ctx, "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn để xóa khỏi Whitelist.").await;
                }
                let count = targets.len();
                let target_names = targets.join(", ");
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    if let Some(w) = g.settings.get_mut("whiteList") {
                        if let Some(map) = w.as_object_mut() {
                            for uid in &targets {
                                map.remove(uid);
                            }
                        } else if let Some(arr) = w.as_array_mut() {
                            arr.retain(|v| v.as_str().map(|s| !targets.contains(&s.to_string())).unwrap_or(true));
                        }
                    }
                });
                format!("✅ Đã xóa {count} thành viên ({target_names}) khỏi Whitelist.")
            } else if sub == "clear" {
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    g.settings["whiteList"] = json!({});
                });
                "✅ Đã xóa toàn bộ thành viên khỏi Whitelist.".into()
            } else if !targets.is_empty() && sub != "list" {
                let count = targets.len();
                let target_names = targets.join(", ");
                ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                    let w = g
                        .settings
                        .as_object_mut()
                        .unwrap()
                        .entry("whiteList")
                        .or_insert_with(|| json!({}));
                    if let Some(map) = w.as_object_mut() {
                        for uid in &targets {
                            map.insert(uid.clone(), json!(true));
                        }
                    } else if let Some(arr) = w.as_array_mut() {
                        for uid in &targets {
                            if !arr.iter().any(|v| v.as_str() == Some(uid.as_str())) {
                                arr.push(json!(uid));
                            }
                        }
                    }
                });
                format!("✅ Đã thêm {count} thành viên ({target_names}) vào Whitelist miễn trừ kiểm duyệt.")
            } else {
                let mut uids: Vec<String> = Vec::new();
                if let Some(obj) = ctx.group_settings.settings.get("whiteList").and_then(Value::as_object) {
                    for (k, v) in obj {
                        if v.as_bool().unwrap_or(true) {
                            uids.push(k.clone());
                        }
                    }
                } else if let Some(arr) = ctx.group_settings.settings.get("whiteList").and_then(Value::as_array) {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            uids.push(s.to_string());
                        }
                    }
                }
                let n = uids.len();
                if n == 0 {
                    "📋 Danh sách Whitelist miễn trừ của nhóm hiện đang trống.".into()
                } else {
                    let preview: Vec<String> = uids
                        .into_iter()
                        .take(20)
                        .map(|k| format!("• `{k}`"))
                        .collect();
                    format!("📋 Danh sách Whitelist miễn trừ ({n}):\n{}", preview.join("\n"))
                }
            }
        }
        "ban" | "unban" => {
            let is_ban = spec.name == "ban";
            let targets = extract_mod_targets(&ctx);
            let target = targets
                .first()
                .cloned()
                .or_else(|| first_arg.map(ToOwned::to_owned))
                .ok_or_else(|| {
                    CommandError::MissingArgument("Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người dùng.".into())
                })?;

            if is_ban {
                let protected = get_all_protected_uids(&ctx);
                if protected.contains(&target) {
                    return send_text_reply(
                        &ctx,
                        "⚠️ Không thể cấm sử dụng bot đối với Quản trị viên hoặc Bot.",
                    )
                    .await;
                }
            }

            if is_ban {
                let reason = ctx.args.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
                let r = if reason.is_empty() { "Banned by admin" } else { &reason };
                let _ = ctx.caches.engine().upsert_blocked_user(&bot_key, &target, "", r, ctx.message.sender_uid.as_str());
            } else {
                let _ = ctx.caches.engine().remove_blocked_user(&bot_key, &target);
            }

            ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                let banned = g
                    .settings
                    .as_object_mut()
                    .unwrap()
                    .entry("bannedBotUsers")
                    .or_insert_with(|| json!([]));
                if let Some(arr) = banned.as_array_mut() {
                    arr.retain(|v| v.as_str() != Some(target.as_str()));
                    if is_ban {
                        arr.push(json!(target));
                    }
                }
            });
            format!(
                "{} người dùng {target} sử dụng bot.",
                if is_ban { "⛔ Đã cấm" } else { "✅ Đã mở chặn" }
            )
        }
        "antisetup" => {
            let enable = first_arg.map(|s| s != "off" && s != "0" && s != "tat" && s != "tắt").unwrap_or(true);
            ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                g.anti_spam = enable;
                g.anti_link = enable;
                g.anti_bad_word = enable;
                g.anti_undo = enable;
                g.anti_mention = enable;
                g.anti_sticker_effect = enable;
            });
            format!(
                "🛡️ Đã {} gói bảo vệ tiêu chuẩn (`antispam`, `antilink`, `antibadword`, `antiundo`, `antitag`, `antistickerlag`).",
                if enable { "KÍCH HOẠT" } else { "TẮT" }
            )
        }
        "antiall" => {
            let enable = parse_bool_toggle(first_arg, false);
            ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                g.anti_spam = enable;
                g.anti_link = enable;
                g.anti_bad_word = enable;
                g.anti_nude = enable;
                g.anti_undo = enable;
                g.anti_forward = enable;
                g.anti_mention = enable;
                g.anti_sticker = enable;
                g.anti_gif = enable;
                g.anti_bot = enable;
            });
            format!(
                "🛡️ Chế độ bảo vệ toàn diện (antiall): {}",
                if enable { "ĐÃ BẬT" } else { "ĐÃ TẮT" }
            )
        }
        other => {
            let updated = ctx.caches.update_group_settings(&bot_key, &thread_id, |g| {
                match other {
                    "antilink" => g.anti_link = parse_bool_toggle(first_arg, g.anti_link),
                    "antispam" => g.anti_spam = parse_bool_toggle(first_arg, g.anti_spam),
                    "antinude" => g.anti_nude = parse_bool_toggle(first_arg, g.anti_nude),
                    "antiundo" => g.anti_undo = parse_bool_toggle(first_arg, g.anti_undo),
                    "antiforward" => g.anti_forward = parse_bool_toggle(first_arg, g.anti_forward),
                    "antitag" => g.anti_mention = parse_bool_toggle(first_arg, g.anti_mention),
                    "antisticker" => g.anti_sticker = parse_bool_toggle(first_arg, g.anti_sticker),
                    "antistickerlag" => {
                        g.anti_sticker_effect = parse_bool_toggle(first_arg, g.anti_sticker_effect)
                    }
                    "antistickereffect" => {
                        g.anti_all_effect_sticker =
                            parse_bool_toggle(first_arg, g.anti_all_effect_sticker)
                    }
                    "antigif" => g.anti_gif = parse_bool_toggle(first_arg, g.anti_gif),
                    "antiphoto" | "antivideo" => {
                        g.anti_photo_video = parse_bool_toggle(first_arg, g.anti_photo_video)
                    }
                    "antifile" => g.anti_file = parse_bool_toggle(first_arg, g.anti_file),
                    "antivoice" => g.anti_voice = parse_bool_toggle(first_arg, g.anti_voice),
                    "antitext" => g.anti_text = parse_bool_toggle(first_arg, g.anti_text),
                    "onlytext" => g.only_text = parse_bool_toggle(first_arg, g.only_text),
                    "antibot" => g.anti_bot = parse_bool_toggle(first_arg, g.anti_bot),
                    "antiblockall" | "antisdt" | "autojoin" | "antijoin" => {
                        let cur = g
                            .settings
                            .get(other)
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let next = parse_bool_toggle(first_arg, cur);
                        if let Some(obj) = g.settings.as_object_mut() {
                            obj.insert(other.to_string(), json!(next));
                        }
                    }
                    _ => {
                        let cur = g
                            .settings
                            .get(other)
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let next = parse_bool_toggle(first_arg, cur);
                        if let Some(obj) = g.settings.as_object_mut() {
                            obj.insert(other.to_string(), json!(next));
                        }
                    }
                }
            });
            let state_flag = match other {
                "antilink" => updated.anti_link,
                "antispam" => updated.anti_spam,
                "antinude" => updated.anti_nude,
                "antiundo" => updated.anti_undo,
                "antiforward" => updated.anti_forward,
                "antitag" => updated.anti_mention,
                "antisticker" => updated.anti_sticker,
                "antistickerlag" => updated.anti_sticker_effect,
                "antistickereffect" => updated.anti_all_effect_sticker,
                "antigif" => updated.anti_gif,
                "antiphoto" | "antivideo" => updated.anti_photo_video,
                "antifile" => updated.anti_file,
                "antivoice" => updated.anti_voice,
                "antitext" => updated.anti_text,
                "onlytext" => updated.only_text,
                "antibot" => updated.anti_bot,
                _ => updated
                    .settings
                    .get(other)
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            };
            format!(
                "🛡️ Cấu hình {other} tại nhóm: {}",
                if state_flag { "ĐÃ BẬT" } else { "ĐÃ TẮT" }
            )
        }
    };

    send_text_reply(&ctx, &reply).await
}
