//! Group Administration, Bot Control, Friend Management, Key Roles & `locmem` Analytics (59 Commands).

use chrono::Utc;
use mybot_core::{
    CommandContext, CommandError, CommandOutcome, CommandSpec, build_state_quote, build_tag_message,
};
use mybot_types::{MentionSpan, MessageContent, PermissionTier, ZaloId};
use serde_json::{Value, json};
use zalo_sdk::apis::messaging::OutboundMessage;

use crate::{CommandRuntimeBundle, send_text_reply};

pub(crate) fn extract_target_uids(ctx: &CommandContext) -> Vec<ZaloId> {
    let mut targets = Vec::new();
    for m in &ctx.message.mentions {
        if m.uid.as_str() != "-1" && !m.uid.is_empty() && !targets.iter().any(|u| u == &m.uid) {
            targets.push(m.uid.clone());
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
            let zid = ZaloId::from(clean);
            if !targets.iter().any(|u| u == &zid) {
                targets.push(zid);
            }
        }
    }
    if targets.is_empty() {
        if let Some(ref q) = ctx.message.quote {
            if q.owner_id.as_str() != "-1" && !q.owner_id.is_empty() {
                targets.push(q.owner_id.clone());
            }
        }
    }
    targets
}

pub(crate) fn extract_avatar_source_from_quote(ctx: &CommandContext) -> Option<String> {
    if let Some(ref q) = ctx.message.quote {
        if let Some(ref attach) = q.attach {
            if let Some(obj) = attach.as_object() {
                for key in &["hdUrl", "href", "oriUrl", "normalUrl", "thumbUrl", "fileUrl", "url"] {
                    if let Some(val) = obj.get(*key).and_then(Value::as_str) {
                        let trimmed = val.trim();
                        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                            return Some(trimmed.to_string());
                        }
                    }
                }
            } else if let Some(str_val) = attach.as_str() {
                let trimmed = str_val.trim();
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(obj) = parsed.as_object() {
                        for key in &["hdUrl", "href", "oriUrl", "normalUrl", "thumbUrl", "fileUrl", "url"] {
                            if let Some(val) = obj.get(*key).and_then(Value::as_str) {
                                let t = val.trim();
                                if t.starts_with("http://") || t.starts_with("https://") {
                                    return Some(t.to_string());
                                }
                            }
                        }
                    }
                } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    return Some(trimmed.to_string());
                }
            }
        }
        for token in q.msg.split_whitespace() {
            if token.starts_with("http://") || token.starts_with("https://") {
                return Some(token.to_string());
            }
        }
    }

    match &ctx.message.content {
        MessageContent::Photo { url, .. } => {
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(url.clone());
            }
        }
        _ => {}
    }

    for token in ctx.raw_args_text.split_whitespace() {
        if token.starts_with("http://") || token.starts_with("https://") {
            return Some(token.to_string());
        }
    }

    None
}

/// Resolves a canonical command name or alias against the static 218-command catalog.
/// `!setcmd` must reject unknown names instead of writing a dead Studio layer.
pub(crate) fn is_known_command(name: &str) -> bool {
    let norm = mybot_core::normalize_command_key(name);
    crate::catalog::ALL_218_CATALOG.iter().any(|entry| {
        mybot_core::normalize_command_key(entry.spec.name) == norm
            || entry
                .spec
                .aliases
                .iter()
                .any(|a| mybot_core::normalize_command_key(a) == norm)
    })
}

fn get_all_bot_uids(ctx: &CommandContext) -> Vec<String> {
    let mut uids = vec![ctx.self_uid.to_string()];
    if let Ok(bots) = ctx.caches.engine().list_bots() {
        for b in bots {
            let s = b.uid.to_string();
            if !s.is_empty() && !uids.contains(&s) {
                uids.push(s);
            }
            if let Some(ref guid) = b.global_uid {
                if !guid.is_empty() && !uids.contains(guid) {
                    uids.push(guid.clone());
                }
            }
        }
    }
    uids
}

/// Result of a live member-list fetch. V3 **aborts the whole action** when this fails
/// (`group-manage.js:132-152`) — it never acts on a partial or empty list.
struct LiveMemberList {
    member_uids: Vec<ZaloId>,
    creator_uid: Option<String>,
    admin_uids: Vec<String>,
}

async fn fetch_live_members(
    zalo: Option<&zalo_sdk::ZaloSession>,
    ctx: &CommandContext,
    thread_id: &ZaloId,
) -> Result<LiveMemberList, String> {
    if let Some(session) = zalo {
        if let Ok(info) = session.get_group_info(std::slice::from_ref(thread_id)).await {
            if let Some(gval) = info.get("gridInfoMap").and_then(|m| m.get(thread_id.as_str())) {
                let creator_uid = gval
                    .get("creatorId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let admin_uids: Vec<String> = gval
                    .get("adminIds")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();

                let mut member_uids: Vec<ZaloId> = gval
                    .get("memVerList")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .filter_map(|s| s.split('_').next())
                            .filter(|u| !u.is_empty())
                            .map(ZaloId::from)
                            .collect()
                    })
                    .unwrap_or_default();

                if member_uids.is_empty() {
                    if let Some(arr) = gval.get("memberIds").and_then(Value::as_array) {
                        member_uids = arr
                            .iter()
                            .filter_map(|v| v.as_str())
                            .filter(|u| !u.is_empty())
                            .map(ZaloId::from)
                            .collect();
                    }
                }

                if !member_uids.is_empty() {
                    let mem_strs: Vec<String> = member_uids.iter().map(|u| u.to_string()).collect();
                    let c_uid = creator_uid.clone();
                    let a_uids = admin_uids.clone();
                    ctx.caches.update_group_settings(&ctx.bot_key, thread_id.as_str(), |g| {
                        if let Some(obj) = g.settings.as_object_mut() {
                            obj.insert("cachedMembers".to_string(), json!(mem_strs));
                            if let Some(ref c) = c_uid {
                                obj.insert("creatorId".to_string(), json!(c));
                            }
                            obj.insert("adminIds".to_string(), json!(a_uids));
                        }
                    });

                    return Ok(LiveMemberList {
                        member_uids,
                        creator_uid,
                        admin_uids,
                    });
                }
            }
        }
    }

    // Fallback to cached members
    let gs = &ctx.group_settings;
    if let Some(arr) = gs.settings.get("cachedMembers").and_then(Value::as_array) {
        let member_uids: Vec<ZaloId> = arr
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|u| !u.is_empty())
            .map(ZaloId::from)
            .collect();
        let creator_uid = gs.settings.get("creatorId").and_then(Value::as_str).map(ToOwned::to_owned);
        let admin_uids: Vec<String> = gs
            .settings
            .get("adminIds")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(ToOwned::to_owned)).collect())
            .unwrap_or_default();

        if !member_uids.is_empty() {
            return Ok(LiveMemberList {
                member_uids,
                creator_uid,
                admin_uids,
            });
        }
    }

    Err("Không thể lấy danh sách thành viên nhóm từ Zalo hoặc bộ nhớ đệm".to_string())
}

/// Drops the group creator, native deputies, the bot itself, secondary bots, bot admins, and whitelist.
/// V3 filters exactly these (`group-manage.js:154-156`, `347-349`).
pub fn filter_protected(
    members: &[ZaloId],
    creator_uid: Option<&str>,
    admin_uids: &[String],
    self_uid: &ZaloId,
    bot_uids: &[String],
    bot_admins: &[String],
    whitelist_uids: &[String],
) -> Vec<ZaloId> {
    members
        .iter()
        .filter(|uid| {
            let u = uid.as_str();
            Some(u) != creator_uid
                && u != self_uid.as_str()
                && !admin_uids.iter().any(|a| a == u)
                && !bot_uids.iter().any(|b| b == u)
                && !bot_admins.iter().any(|a| a == u)
                && !whitelist_uids.iter().any(|w| w == u)
        })
        .cloned()
        .collect()
}

pub fn parse_group_action_result(
    res: &Value,
    total_requested: usize,
) -> (usize, usize, Vec<String>) {
    let error_code = res
        .get("error_code")
        .or_else(|| res.get("errorCode"))
        .or_else(|| res.pointer("/data/error_code"))
        .or_else(|| res.pointer("/data/errorCode"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let error_members: Vec<String> = res
        .get("errorMembers")
        .or_else(|| res.get("error_members"))
        .or_else(|| res.pointer("/data/errorMembers"))
        .or_else(|| res.pointer("/data/error_members"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                .collect()
        })
        .unwrap_or_default();

    if error_code != 0 && error_members.is_empty() {
        return (0, total_requested, vec![]);
    }

    let fail_count = error_members.len();
    let success_count = total_requested.saturating_sub(fail_count);
    (success_count, fail_count, error_members)
}

pub async fn execute_admin_group_command(
    spec: &'static CommandSpec,
    ctx: CommandContext,
    _rt: &CommandRuntimeBundle,
) -> Result<CommandOutcome, CommandError> {
    let thread_id = ctx.message.thread_id.clone();
    let bot_key = ctx.bot_key.clone();

    let reply = match spec.name {
        "prefix" => {
            if let Some(new_prefix) = ctx.args.first().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                if let Some(mut bot) = ctx.caches.engine().get_bot(&bot_key)? {
                    bot.prefix = new_prefix.to_string();
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                }
                format!("⚙️ Đã đổi prefix của bot `{bot_key}` thành `{new_prefix}`.")
            } else {
                format!("⚙️ Prefix hiện tại của bot `{bot_key}` là `{}`.", ctx.prefix)
            }
        }
        "bot" => {
            let next = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "1" | "bat" | "bật") => true,
                Some("off" | "0" | "tat" | "tắt") => false,
                _ => !ctx.group_settings.enable_bot,
            };
            ctx.caches
                .update_group_settings(&bot_key, thread_id.as_str(), |g| g.enable_bot = next);
            format!(
                "🤖 Trạng thái hoạt động của bot trong nhóm: {}",
                if next { "ĐANG BẬT" } else { "TẠM DỪNG" }
            )
        }
        "welcome" | "bye" | "updategroup" | "prwelcome" | "approve" => {
            let mode = spec.name;
            let next = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "1" | "bat" | "bật") => true,
                Some("off" | "0" | "tat" | "tắt") => false,
                _ => match mode {
                    "welcome" => !ctx.group_settings.welcome_group,
                    "bye" => !ctx.group_settings.bye_group,
                    _ => true,
                },
            };
            ctx.caches
                .update_group_settings(&bot_key, thread_id.as_str(), |g| match mode {
                    "welcome" => g.welcome_group = next,
                    "bye" => g.bye_group = next,
                    _ => {
                        if let Some(obj) = g.settings.as_object_mut() {
                            obj.insert(mode.to_string(), json!(next));
                        }
                    }
                });
            format!(
                "🎉 Chế độ {mode} của nhóm: {}",
                if next { "ĐÃ BẬT" } else { "ĐÃ TẮT" }
            )
        }
        "listadmin" | "admin" | "add" | "remove" => {
            let action = if spec.name == "add" || ctx.args.first().is_some_and(|a| a == "add") {
                "add"
            } else if spec.name == "remove" || ctx.args.first().is_some_and(|a| a == "remove" || a == "del") {
                "remove"
            } else {
                "list"
            };
            if action == "add" {
                let targets = extract_target_uids(&ctx);
                if targets.is_empty() {
                    return Err(CommandError::MissingArgument(
                        "Vui lòng @tag hoặc nhập UID người cần cấp quyền Admin Bot.".into(),
                    ));
                }
                for uid in &targets {
                    ctx.caches
                        .engine()
                        .upsert_bot_admin(&bot_key, uid.as_str(), "adminBot", "")?;
                }
                format!("👑 Đã thêm {} UID vào danh sách Admin Bot `{bot_key}`.", targets.len())
            } else if action == "remove" {
                let targets = extract_target_uids(&ctx);
                let mut removed = 0usize;
                for uid in &targets {
                    if ctx.caches.engine().remove_bot_admin(&bot_key, uid.as_str())? {
                        removed += 1;
                    }
                }
                format!("👑 Đã gỡ {removed} Admin khỏi bot {bot_key}.")
            } else {
                let admins = ctx.caches.engine().list_bot_admins(&bot_key)?;
                if admins.is_empty() {
                    format!("👑 Bot {bot_key} hiện chưa có Admin phụ nào.")
                } else {
                    let lines: Vec<String> = admins
                        .iter()
                        .enumerate()
                        .map(|(i, (uid, tier, name))| {
                            if name.is_empty() {
                                format!("{}. {} ({})", i + 1, uid, tier)
                            } else {
                                format!("{}. {} - {} ({})", i + 1, name, uid, tier)
                            }
                        })
                        .collect();
                    format!("👑 Danh sách Admin Bot {bot_key} ({}):\n{}", admins.len(), lines.join("\n"))
                }
            }
        }
        "setcmd" => {
            let p = &ctx.prefix;
            if ctx.args.len() < 2 {
                return Ok(CommandOutcome::Handled {
                    summary: "setcmd syntax help".into(),
                    reply_text: Some(format!(
                        "⚠️ Vui lòng nhập đúng cú pháp:\n{p}setcmd on/off <tên_lệnh> - Bật/tắt lệnh\n{p}setcmd p <tên_lệnh> <level> - Đặt quyền hạn lệnh (1-4)\n{p}setcmd cd <tên_lệnh> <giây> - Đặt thời gian chờ lệnh"
                    )),
                    custom_ttl_ms: Some(300_000),
                });
            }
            let first = ctx.args[0].to_ascii_lowercase();
            let target_cmd = ctx.args[1].to_ascii_lowercase();
            let norm_cmd = mybot_core::normalize_command_key(&target_cmd);

            // Kiểm tra tên lệnh hợp lệ cho toàn bộ các cờ thao tác on, off, p, cd
            if !is_known_command(&norm_cmd) {
                return Ok(CommandOutcome::Handled {
                    summary: "setcmd unknown command".into(),
                    reply_text: Some(format!("❌ Không tìm thấy lệnh \"{target_cmd}\"")),
                    custom_ttl_ms: Some(300_000),
                });
            }

            match first.as_str() {
                "on" | "off" => {
                    let active = first == "on";
                    // Dispatch reads `operation.enabled` (`pipeline.rs` kill-switch gate); a bare
                    // `active` key would be written and never consulted.
                    ctx.caches.save_studio_layer_cas(
                        "bot",
                        &bot_key,
                        "",
                        &norm_cmd,
                        &json!({ "operation.enabled": active }),
                        None,
                        ctx.message.sender_uid.as_str(),
                        "setcmd on/off via chat",
                    )?;
                    format!("✅ Đã {} lệnh \"{}\"", if active { "bật" } else { "tắt" }, target_cmd)
                }
                "p" => {
                    if target_cmd == "setcmd" || target_cmd == "cmdset" {
                        return Ok(CommandOutcome::Handled {
                            summary: "setcmd immutable".into(),
                            reply_text: Some("⚠️ Quyền hạn của lệnh setcmd là cố định (Admin tối cao - adminLevelHigh) và không thể thay đổi!".into()),
                            custom_ttl_ms: Some(300_000),
                        });
                    }
                    if ctx.args.len() < 3 {
                        return Ok(CommandOutcome::Handled {
                            summary: "setcmd p missing level".into(),
                            reply_text: Some(
                                "⚠️ Vui lòng nhập level quyền hạn (1-4):\n1: all (Tất cả)\n2: adminBox (Quản trị viên nhóm)\n3: adminBot (Quản trị viên bot)\n4: adminLevelHigh (Quản trị viên cấp cao / Admin tối cao)".into()
                            ),
                            custom_ttl_ms: Some(300_000),
                        });
                    }
                    let Ok(level) = ctx.args[2].parse::<u8>() else {
                        return Ok(CommandOutcome::Handled {
                            summary: "setcmd invalid level".into(),
                            reply_text: Some(
                                "❌ Level quyền hạn Không hợp lệ. Vui lòng chọn từ 1-4:\n1: all (Tất cả người dùng)\n2: adminBox (Quản trị viên nhóm)\n3: adminBot (Quản trị viên bot)\n4: adminLevelHigh (Quản trị viên cấp cao)".into()
                            ),
                            custom_ttl_ms: Some(300_000),
                        });
                    };
                    let (tier_key, tier_name) = match level {
                        1 => ("all", "Tất cả người dùng"),
                        2 => ("adminBox", "Quản trị viên nhóm"),
                        3 => ("adminBot", "Quản trị viên bot"),
                        4 => ("adminLevelHigh", "Quản trị viên cấp cao"),
                        _ => {
                            return Ok(CommandOutcome::Handled {
                                summary: "setcmd invalid level".into(),
                                reply_text: Some(
                                    "❌ Level quyền hạn Không hợp lệ. Vui lòng chọn từ 1-4:\n1: all (Tất cả người dùng)\n2: adminBox (Quản trị viên nhóm)\n3: adminBot (Quản trị viên bot)\n4: adminLevelHigh (Quản trị viên cấp cao)".into()
                                ),
                                custom_ttl_ms: Some(300_000),
                            });
                        }
                    };
                    ctx.caches.save_studio_layer_cas(
                        "bot",
                        &bot_key,
                        "",
                        &norm_cmd,
                        &json!({ "access.permission": tier_key }),
                        None,
                        ctx.message.sender_uid.as_str(),
                        "setcmd permission via chat",
                    )?;
                    format!("✅ Đã thay đổi quyền hạn của lệnh \"{}\":\n- Quyền hạn mới: {}", target_cmd, tier_name)
                }
                "cd" => {
                    if ctx.args.len() < 3 {
                        return Ok(CommandOutcome::Handled {
                            summary: "setcmd cd missing seconds".into(),
                            reply_text: Some("⚠️ Vui lòng nhập thời gian chờ (tính bằng giây)".into()),
                            custom_ttl_ms: Some(300_000),
                        });
                    }
                    let parsed_cd = ctx.args[2].parse::<i64>();
                    let seconds = match parsed_cd {
                        Ok(s) if s >= 0 => s as u64,
                        _ => {
                            // Node V3: từ chối lệnh và báo lỗi, tuyệt đối KHÔNG âm thầm gán 5s
                            return Ok(CommandOutcome::Handled {
                                summary: "setcmd cd invalid seconds".into(),
                                reply_text: Some("❌ Thời gian countdown phải là số nguyên dương".into()),
                                custom_ttl_ms: Some(300_000),
                            });
                        }
                    };
                    let old_cd = ctx.caches.get_studio_layer_hot("bot", &bot_key, "", &norm_cmd)
                        .and_then(|l| l.overrides.get("operation.cooldownSeconds").and_then(Value::as_u64))
                        .or_else(|| crate::catalog::ALL_218_CATALOG.iter().find(|e| mybot_core::normalize_command_key(e.spec.name) == norm_cmd).map(|e| e.spec.default_cooldown_secs as u64))
                        .unwrap_or(0);

                    ctx.caches.save_studio_layer_cas(
                        "bot",
                        &bot_key,
                        "",
                        &norm_cmd,
                        &json!({ "operation.cooldownSeconds": seconds }),
                        None,
                        ctx.message.sender_uid.as_str(),
                        "setcmd cooldown via chat",
                    )?;
                    format!("✅ Đã cập nhật thời gian chờ của lệnh \"{}\":\n- Cũ: {}s\n- Mới: {}s", target_cmd, old_cd, seconds)
                }
                _ => {
                    return Ok(CommandOutcome::Handled {
                        summary: "setcmd invalid action".into(),
                        reply_text: Some(
                            "❌ Hành động Không hợp lệ. Vui lòng sử dụng:\n- on/off: Bật/tắt lệnh\n- p: Đặt quyền hạn\n- cd: Đặt thời gian chờ".into()
                        ),
                        custom_ttl_ms: Some(300_000),
                    });
                }
            }
        }
        "kickimg" => {
            let next = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "1" | "bat" | "bật") => true,
                Some("off" | "0" | "tat" | "tắt") => false,
                _ => {
                    let cur = ctx.group_settings.settings.get("enableKickImage").and_then(Value::as_bool).unwrap_or(false);
                    !cur
                }
            };
            ctx.caches.update_group_settings(&bot_key, thread_id.as_str(), |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("enableKickImage".to_string(), json!(next));
                }
            });
            format!("Chức năng thông báo kick thành viên đã được {}!", if next { "bật" } else { "tắt" })
        }
        "blockimg" => {
            let next = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "1" | "bat" | "bật") => true,
                Some("off" | "0" | "tat" | "tắt") => false,
                _ => {
                    let cur = ctx.group_settings.settings.get("enableBlockImage").and_then(Value::as_bool).unwrap_or(false);
                    !cur
                }
            };
            ctx.caches.update_group_settings(&bot_key, thread_id.as_str(), |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("enableBlockImage".to_string(), json!(next));
                }
            });
            format!("Chức năng thông báo block thành viên đã được {}!", if next { "bật" } else { "tắt" })
        }
        "kick" | "kickall" | "kickallmember" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(
                    &ctx,
                    "⚠️ Bot chưa kết nối Zalo nên không thể kick thành viên.",
                )
                .await;
            };
            let is_mass = matches!(spec.name, "kickall" | "kickallmember");
            let bot_uids = get_all_bot_uids(&ctx);
            let bot_admins: Vec<String> = ctx
                .caches
                .engine()
                .list_bot_admins(&bot_key)
                .unwrap_or_default()
                .into_iter()
                .map(|(uid, _, _)| uid)
                .collect();
            let whitelist_uids: Vec<String> = ctx
                .group_settings
                .settings
                .get("whiteList")
                .and_then(Value::as_object)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();

            let targets = if is_mass {
                let live = match fetch_live_members(Some(zalo), &ctx, &thread_id).await {
                    Ok(v) => v,
                    Err(err) => {
                        return send_text_reply(
                            &ctx,
                            &format!("⚠️ Không lấy được danh sách thành viên nên đã hủy kickall ({err})."),
                        )
                        .await;
                    }
                };
                filter_protected(
                    &live.member_uids,
                    live.creator_uid.as_deref(),
                    &live.admin_uids,
                    &ctx.self_uid,
                    &bot_uids,
                    &bot_admins,
                    &whitelist_uids,
                )
            } else {
                let raw = extract_target_uids(&ctx);
                if raw.is_empty() {
                    return send_text_reply(
                        &ctx,
                        "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần kick.",
                    )
                    .await;
                }
                let live = fetch_live_members(Some(zalo), &ctx, &thread_id).await.ok();
                filter_protected(
                    &raw,
                    live.as_ref().and_then(|l| l.creator_uid.as_deref()),
                    live.as_ref().map(|l| l.admin_uids.as_slice()).unwrap_or(&[]),
                    &ctx.self_uid,
                    &bot_uids,
                    &bot_admins,
                    &whitelist_uids,
                )
            };

            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    if is_mass {
                        "⚡ Không có thành viên nào đủ điều kiện để kick (đã bỏ qua trưởng/phó nhóm, Bot và Admin Bot)."
                    } else {
                        "⚡ Không thể kick thành viên này (đây là Trưởng nhóm, Phó nhóm, Bot hoặc Admin Bot được bảo vệ)."
                    },
                )
                .await;
            }

            match zalo.remove_user_from_group(&thread_id, &targets).await {
                Ok(res) => {
                    let (success, fail, _) = parse_group_action_result(&res, targets.len());
                    if success == 0 {
                        format!("⚠️ Không thể kick bất kỳ thành viên nào (lỗi API hoặc bot chưa có quyền Trưởng/Phó nhóm).")
                    } else if fail > 0 {
                        format!("👢 Đã kick {success}/{} thành viên khỏi nhóm (thất bại: {fail}).", targets.len())
                    } else {
                        format!("👢 Đã kick {success} thành viên khỏi nhóm.")
                    }
                }
                Err(err) => format!("⚠️ Kick thất bại ({} mục tiêu): {err}", targets.len()),
            }
        }
        "block" | "blockall" | "blockallmember" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(
                    &ctx,
                    "⚠️ Bot chưa kết nối Zalo nên không thể chặn thành viên.",
                )
                .await;
            };
            let is_mass = matches!(spec.name, "blockall" | "blockallmember");
            let bot_uids = get_all_bot_uids(&ctx);
            let bot_admins: Vec<String> = ctx
                .caches
                .engine()
                .list_bot_admins(&bot_key)
                .unwrap_or_default()
                .into_iter()
                .map(|(uid, _, _)| uid)
                .collect();
            let whitelist_uids: Vec<String> = ctx
                .group_settings
                .settings
                .get("whiteList")
                .and_then(Value::as_object)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();

            let targets = if is_mass {
                let live = match fetch_live_members(Some(zalo), &ctx, &thread_id).await {
                    Ok(v) => v,
                    Err(err) => {
                        return send_text_reply(
                            &ctx,
                            &format!("⚠️ Không lấy được danh sách thành viên nên đã hủy blockall ({err})."),
                        )
                        .await;
                    }
                };
                filter_protected(
                    &live.member_uids,
                    live.creator_uid.as_deref(),
                    &live.admin_uids,
                    &ctx.self_uid,
                    &bot_uids,
                    &bot_admins,
                    &whitelist_uids,
                )
            } else {
                let raw = extract_target_uids(&ctx);
                if raw.is_empty() {
                    return send_text_reply(
                        &ctx,
                        "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần chặn.",
                    )
                    .await;
                }
                let live = fetch_live_members(Some(zalo), &ctx, &thread_id).await.ok();
                filter_protected(
                    &raw,
                    live.as_ref().and_then(|l| l.creator_uid.as_deref()),
                    live.as_ref().map(|l| l.admin_uids.as_slice()).unwrap_or(&[]),
                    &ctx.self_uid,
                    &bot_uids,
                    &bot_admins,
                    &whitelist_uids,
                )
            };

            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    if is_mass {
                        "⚡ Không có thành viên nào đủ điều kiện để chặn (đã bỏ qua trưởng/phó nhóm, Bot và Admin Bot)."
                    } else {
                        "⚡ Không thể chặn thành viên này (đây là Trưởng nhóm, Phó nhóm, Bot hoặc Admin Bot được bảo vệ)."
                    },
                )
                .await;
            }

            match zalo.block_users_in_group(&thread_id, &targets).await {
                Ok(res) => {
                    let (success, fail, _) = parse_group_action_result(&res, targets.len());
                    if success == 0 {
                        format!("⚠️ Không thể chặn bất kỳ thành viên nào (lỗi API hoặc bot chưa có quyền Trưởng/Phó nhóm).")
                    } else if fail > 0 {
                        format!("🚫 Đã chặn {success}/{} thành viên khỏi nhóm (thất bại: {fail}).", targets.len())
                    } else {
                        format!("🚫 Đã chặn {success} thành viên khỏi nhóm.")
                    }
                }
                Err(err) => format!("⚠️ Chặn thất bại ({} mục tiêu): {err}", targets.len()),
            }
        }
        "keysilver" | "keygold" | "unkey" | "key" | "keylist" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(
                    &ctx,
                    "⚠️ Bot chưa kết nối Zalo nên không thể phân quyền nhóm.",
                )
                .await;
            };
            if spec.name == "keylist" {
                let info = zalo
                    .get_group_info(std::slice::from_ref(&thread_id))
                    .await
                    .map_err(|e| CommandError::Internal(e.to_string()))?;
                let gval = info
                    .get("gridInfoMap")
                    .and_then(|m| m.get(thread_id.as_str()))
                    .ok_or_else(|| CommandError::Internal("gridInfoMap missing".into()))?;
                let owner = gval.get("creatorId").and_then(Value::as_str).unwrap_or("N/A");
                let admins: Vec<String> = gval
                    .get("adminIds")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                return send_text_reply(
                    &ctx,
                    &format!(
                        "🔑 Phân quyền nhóm {thread_id}\n• Trưởng nhóm (key vàng): {owner}\n• Phó nhóm (key bạc): {}",
                        if admins.is_empty() {
                            "Chưa có".to_string()
                        } else {
                            admins.join(", ")
                        }
                    ),
                )
                .await;
            }
            let mut targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                if spec.name == "keysilver" || spec.name == "keygold" || spec.name == "key" {
                    targets.push(ctx.message.sender_uid.clone());
                } else {
                    return send_text_reply(
                        &ctx,
                        &format!("⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần xử lý cho `{}`.", spec.name),
                    )
                    .await;
                }
            }
            match spec.name {
                "keysilver" | "key" => match zalo.add_group_admins(&thread_id, &targets).await {
                    Ok(res) => {
                        let (s, f, _) = parse_group_action_result(&res, targets.len());
                        if s == 0 {
                            format!("⚠️ Phong key bạc thất bại (lỗi API hoặc bot không có quyền trưởng nhóm).")
                        } else if f > 0 {
                            format!("🔑 Đã phong key bạc (phó nhóm) cho {s}/{} thành viên (thất bại: {f}).", targets.len())
                        } else {
                            format!("🔑 Đã phong key bạc (phó nhóm) cho {s} thành viên.")
                        }
                    }
                    Err(err) => format!("⚠️ Phong key bạc thất bại: {err}"),
                },
                "unkey" => match zalo.remove_group_admins(&thread_id, &targets).await {
                    Ok(res) => {
                        let (s, f, _) = parse_group_action_result(&res, targets.len());
                        if s == 0 {
                            format!("⚠️ Thu hồi key thất bại (thành viên không có key hoặc bot không đủ quyền).")
                        } else if f > 0 {
                            format!("🔑 Đã thu hồi key của {s}/{} thành viên (thất bại: {f}).", targets.len())
                        } else {
                            format!("🔑 Đã thu hồi key của {s} thành viên.")
                        }
                    }
                    Err(err) => format!("⚠️ Thu hồi key thất bại: {err}"),
                },
                "keygold" => {
                    let first = &targets[0];
                    match zalo.change_group_owner(&thread_id, first).await {
                        Ok(res) => {
                            let code = res.get("error_code").or_else(|| res.get("errorCode")).and_then(Value::as_i64).unwrap_or(0);
                            if code == 0 {
                                format!("👑 Đã chuyển quyền trưởng nhóm (key vàng) cho `{first}`.")
                            } else {
                                format!("⚠️ Chuyển key vàng thất bại (mã lỗi {code}).")
                            }
                        }
                        Err(err) => format!("⚠️ Chuyển key vàng thất bại: {err}"),
                    }
                }
                _ => format!("🔑 Đã xử lý phân quyền nhóm ({}) cho {} thành viên.", spec.name, targets.len()),
            }
        }
        "changelink" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể đổi link nhóm.").await;
            };
            match zalo.change_group_link(&thread_id).await {
                Ok(res) => {
                    let link = res
                        .get("link")
                        .or_else(|| res.get("data").and_then(|d| d.get("link")))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if link.is_empty() {
                        "🔗 Đã làm mới đường dẫn mời tham gia nhóm.".to_string()
                    } else {
                        format!("🔗 Link mời mới của nhóm: {link}")
                    }
                }
                Err(err) => format!("⚠️ Đổi link nhóm thất bại: {err}"),
            }
        }
        "join" => {
            let link = ctx
                .args
                .iter()
                .find(|a| a.starts_with("http"))
                .or_else(|| ctx.args.first())
                .ok_or_else(|| {
                    CommandError::MissingArgument("Vui lòng cung cấp link nhóm Zalo.".into())
                })?;
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể vào nhóm.").await;
            };
            match zalo.join_group(link).await {
                Ok(res) => {
                    let joined = res
                        .pointer("/data/group_link_info")
                        .is_some()
                        || res.get("data").is_some();
                    if joined {
                        format!("🚪 Đã tham gia nhóm qua link {link}.")
                    } else {
                        format!("🚪 Đã gửi yêu cầu tham gia nhóm qua link {link} (chờ duyệt).")
                    }
                }
                Err(err) => format!("⚠️ Không thể tham gia nhóm qua link {link}: {err}"),
            }
        }
        "leaveallbox" => {
            let mut left_count = 0;
            if let Some(ref zalo) = ctx.zalo
                && let Ok(val) = zalo.get_all_groups().await
                && let Some(grid_map) = val.get("gridVerMap").and_then(Value::as_object)
            {
                for gid_str in grid_map.keys() {
                    if gid_str == thread_id.as_str() {
                        continue;
                    }
                    let other_id = ZaloId::new(gid_str);
                    if zalo.leave_group(std::slice::from_ref(&other_id), false).await.is_ok() {
                        left_count += 1;
                    }
                }
            }
            format!("✅ Đã rời thành công {left_count} box.")
        }
        "leavelock" => {
            let mut left_count = 0;
            if let Some(ref zalo) = ctx.zalo
                && let Ok(val) = zalo.get_all_groups().await
                && let Some(grid_map) = val.get("gridVerMap").and_then(Value::as_object)
            {
                let bot_uid_str = ctx.self_uid.as_str();
                for gid_str in grid_map.keys() {
                    let target_gid = ZaloId::new(gid_str);
                    if let Ok(info) = zalo.get_group_info(std::slice::from_ref(&target_gid)).await
                        && let Some(gval) = info.get("gridInfoMap").and_then(|m| m.get(gid_str))
                    {
                        let is_locked = gval.get("lockSendMsg").and_then(Value::as_i64) == Some(1)
                            || gval.get("setting").and_then(|s| s.get("lockSendMsg")).and_then(Value::as_i64) == Some(1);
                        if !is_locked {
                            continue;
                        }
                        let is_admin = gval.get("creatorId").and_then(Value::as_str) == Some(bot_uid_str)
                            || gval.get("adminIds").and_then(Value::as_array).is_some_and(|arr| {
                                arr.iter().any(|u| u.as_str() == Some(bot_uid_str))
                            });
                        if is_admin {
                            continue;
                        }
                        if zalo.leave_group(std::slice::from_ref(&target_gid), false).await.is_ok() {
                            left_count += 1;
                        }
                    }
                }
            }
            if left_count > 0 {
                format!("✅ Đã rời {left_count} box bị khóa chat (đã bỏ qua các box mà bot là admin).")
            } else {
                "⚡ Không tìm thấy box nào bị khóa chat hoặc tất cả box khóa đều là admin.".into()
            }
        }
        "leave" | "dispersegroup" => {
            if let Some(ref zalo) = ctx.zalo {
                if spec.name == "dispersegroup" {
                    let _ = zalo.disperse_group(&thread_id).await;
                } else {
                    let _ = zalo.leave_group(std::slice::from_ref(&thread_id), false).await;
                }
            }
            format!("👋 Đã thực thi {} trên nhóm {thread_id}.", spec.name)
        }
        "listgroups" | "scangroups" | "group" | "settinggroup" | "manager" => {
            if spec.name == "group" {
                let cur = ctx
                    .caches
                    .get_or_default_group_settings(&bot_key, thread_id.as_str());
                if let Some(ref zalo) = ctx.zalo
                    && let Ok(info) = zalo.get_group_info(std::slice::from_ref(&thread_id)).await
                    && let Some(gval) = info
                        .get("gridInfoMap")
                        .and_then(|m| m.get(thread_id.as_str()))
                {
                    let gname = gval
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&cur.group_name);
                    let total = gval
                        .get("totalMember")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let creator = gval
                        .get("creatorId")
                        .and_then(Value::as_str)
                        .unwrap_or("N/A");
                    let deputies = gval
                        .get("adminIds")
                        .and_then(Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0);
                    return send_text_reply(
                        &ctx,
                        &format!(
                            "🏠 Thông Tin Nhóm: {gname}\n• Mã nhóm: {thread_id}\n• Thành viên: {total}\n• Trưởng nhóm UID: {creator} • Phó nhóm: {deputies}\n• Trạng thái Bot: {} • Anti-Spam: {} • Anti-Link: {} • Anti-Undo: {}",
                            if cur.enable_bot { "ĐANG BẬT" } else { "ĐANG TẮT" },
                            if cur.anti_spam { "ON" } else { "OFF" },
                            if cur.anti_link { "ON" } else { "OFF" },
                            if cur.anti_undo { "ON" } else { "OFF" },
                        ),
                    )
                    .await;
                }
                return send_text_reply(
                    &ctx,
                    &format!(
                        "🏠 Thông Tin Nhóm ({thread_id})\n• Tên lưu đệm: {}\n• Trạng thái Bot: {} • Anti-Spam: {} • Anti-Link: {} • Anti-Undo: {}",
                        if cur.group_name.is_empty() { "Chưa đồng bộ" } else { &cur.group_name },
                        if cur.enable_bot { "ĐANG BẬT" } else { "ĐANG TẮT" },
                        if cur.anti_spam { "ON" } else { "OFF" },
                        if cur.anti_link { "ON" } else { "OFF" },
                        if cur.anti_undo { "ON" } else { "OFF" },
                    ),
                )
                .await;
            }
            if let Some(ref zalo) = ctx.zalo
                && matches!(spec.name, "listgroups" | "scangroups")
                && let Ok(val) = zalo.get_all_groups().await
            {
                let count = val
                    .get("gridVerMap")
                    .and_then(Value::as_object)
                    .map(|m| m.len())
                    .unwrap_or(0);
                return send_text_reply(
                    &ctx,
                    &format!("📋 Đã đồng bộ danh sách {count} nhóm trực tiếp từ máy chủ Zalo."),
                )
                .await;
            }
            let gs = ctx.caches.list_bot_group_settings(&bot_key);
            format!(
                "📋 Quản trị nhóm {}: Đang theo dõi {} nhóm.",
                spec.name,
                gs.len()
            )
        }
        "undo" | "deletemessage" => {
            if let Some(ref zalo) = ctx.zalo
                && let Some(ref q) = ctx.message.quote
            {
                let _ = zalo
                    .undo_message(
                        &q.global_msg_id,
                        &q.cli_msg_id,
                        &thread_id,
                        ctx.message.thread_type,
                    )
                    .await;
            }
            "🗑️ Đã thu hồi / xóa tin nhắn được chọn.".into()
        }
        "todo" => {
            // `todo` uses underscore `_` splitting: `todo Tiêu đề _ Nội dung công việc`
            let title = ctx.args.first().cloned().unwrap_or_else(|| "Công việc mới".into());
            let body = if ctx.args.len() >= 2 {
                ctx.args[1..].join(" ")
            } else {
                title.clone()
            };
            let assignees = extract_target_uids(&ctx);
            if let Some(ref zalo) = ctx.zalo
                && !assignees.is_empty()
            {
                let _ = zalo
                    .send_todo(&format!("{title}: {body}"), &assignees, -1, &thread_id, ctx.message.thread_type)
                    .await;
            }
            format!("📌 Đã giao việc {title}: {body}")
        }
        "sendp" | "senduser" => {
            // `sendp` uses underscore `_` splitting: `sendp UID _ Nội dung nhắn riêng`
            let target = extract_target_uids(&ctx)
                .into_iter()
                .next()
                .or_else(|| ctx.args.first().map(|s| ZaloId::from(s.as_str())))
                .ok_or_else(|| CommandError::MissingArgument("Thiếu UID người nhận.".into()))?;
            let text = if ctx.args.len() >= 2 {
                ctx.args[1..].join(" ")
            } else {
                ctx.raw_args_text.clone()
            };
            if let Some(ref zalo) = ctx.zalo {
                let _ = zalo.send_private(&text, &target, 0).await;
            }
            format!("✉️ Đã gửi tin nhắn riêng tới {target}.")
        }
        "locmem" => {
            return crate::locmem::execute_locmem_command(spec, ctx).await;
        }
        "listfriend" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể xem danh sách bạn bè.").await;
            };
            match zalo.get_all_friends(1, 500).await {
                Ok(res) => {
                    let friends_arr = res
                        .as_array()
                        .or_else(|| res.get("data").and_then(Value::as_array))
                        .or_else(|| res.pointer("/data/friends").and_then(Value::as_array))
                        .or_else(|| res.pointer("/data/data").and_then(Value::as_array));
                    let total = friends_arr.map(|a| a.len()).unwrap_or(0);
                    if total == 0 {
                        "👥 Danh sách bạn bè hiện tại trên Zalo đang trống.".into()
                    } else {
                        let friends = friends_arr.unwrap();
                        let names: Vec<String> = friends
                            .iter()
                            .take(30)
                            .enumerate()
                            .map(|(i, f)| {
                                let name = f.get("displayName")
                                    .or_else(|| f.get("zaloName"))
                                    .or_else(|| f.get("dName"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("Người dùng Zalo");
                                let uid = f.get("userId")
                                    .or_else(|| f.get("uid"))
                                    .or_else(|| f.get("id"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if uid.is_empty() {
                                    format!("{}. {name}", i + 1)
                                } else {
                                    format!("{}. {name} ({uid})", i + 1)
                                }
                            })
                            .collect();
                        format!("👥 Danh sách bạn bè trên Zalo ({total} người):\n{}", names.join("\n"))
                    }
                }
                Err(err) => format!("⚠️ Không thể lấy danh sách bạn bè: {err}"),
            }
        }
        "waitinglist" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể xem danh sách chờ.").await;
            };
            match zalo.get_pending_friend_requests().await {
                Ok(res) => {
                    let reqs_arr = res
                        .as_array()
                        .or_else(|| res.get("data").and_then(Value::as_array))
                        .or_else(|| res.pointer("/data/items").and_then(Value::as_array))
                        .or_else(|| res.pointer("/data/list").and_then(Value::as_array))
                        .or_else(|| res.pointer("/data/data").and_then(Value::as_array));
                    let count = reqs_arr.map(|a| a.len()).unwrap_or(0);
                    if count == 0 {
                        "📋 Hiện không có lời mời kết bạn nào đang chờ duyệt.".into()
                    } else {
                        let reqs = reqs_arr.unwrap();
                        let lines: Vec<String> = reqs
                            .iter()
                            .take(30)
                            .enumerate()
                            .map(|(i, item)| {
                                let uid = item.get("userId")
                                    .or_else(|| item.get("uid"))
                                    .or_else(|| item.get("id"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown");
                                let name = item.get("displayName")
                                    .or_else(|| item.get("zaloName"))
                                    .or_else(|| item.get("dName"))
                                    .or_else(|| item.get("name"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("Người dùng");
                                let note = item.pointer("/recommInfo/message")
                                    .or_else(|| item.get("msg"))
                                    .and_then(Value::as_str)
                                    .map(|m| format!(" - \"{m}\""))
                                    .unwrap_or_default();
                                format!("{}. {name} ({uid}){note}", i + 1)
                            })
                            .collect();
                        format!("📋 Danh sách lời mời kết bạn đang chờ ({count}):\n{}", lines.join("\n"))
                    }
                }
                Err(err) => format!("⚠️ Không thể lấy danh sách lời mời kết bạn: {err}"),
            }
        }
        "addfriendall" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể kết bạn hàng loạt.").await;
            };
            let live = match fetch_live_members(Some(zalo), &ctx, &thread_id).await {
                Ok(v) => v,
                Err(err) => {
                    return send_text_reply(
                        &ctx,
                        &format!("⚠️ Không lấy được danh sách thành viên nên đã hủy addfriendall ({err})."),
                    )
                    .await;
                }
            };
            let bot_uids = get_all_bot_uids(&ctx);
            let bot_admins: Vec<String> = ctx
                .caches
                .engine()
                .list_bot_admins(&bot_key)
                .unwrap_or_default()
                .into_iter()
                .map(|(uid, _, _)| uid)
                .collect();
            let whitelist_uids: Vec<String> = ctx
                .group_settings
                .settings
                .get("whiteList")
                .and_then(Value::as_object)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();

            let mut existing_friend_uids: Vec<String> = Vec::new();
            if let Ok(friends_res) = zalo.get_all_friends(1, 20_000).await {
                if let Some(arr) = friends_res
                    .as_array()
                    .or_else(|| friends_res.get("data").and_then(Value::as_array))
                    .or_else(|| friends_res.pointer("/data/friends").and_then(Value::as_array))
                {
                    for f in arr {
                        if let Some(fid) = f.get("userId").or_else(|| f.get("uid")).or_else(|| f.get("id")).and_then(Value::as_str) {
                            existing_friend_uids.push(fid.to_string());
                        }
                    }
                }
            }

            let candidates: Vec<ZaloId> = filter_protected(
                &live.member_uids,
                live.creator_uid.as_deref(),
                &live.admin_uids,
                &ctx.self_uid,
                &bot_uids,
                &bot_admins,
                &whitelist_uids,
            )
            .into_iter()
            .filter(|u| !existing_friend_uids.iter().any(|f| f == u.as_str()))
            .take(50)
            .collect();

            if candidates.is_empty() {
                return send_text_reply(
                    &ctx,
                    "⚡ Không có thành viên mới nào cần gửi lời mời kết bạn trong nhóm này (đã là bạn bè hoặc thuộc danh sách bảo vệ).",
                )
                .await;
            }

            let greeting = if !ctx.raw_args_text.trim().is_empty() {
                ctx.raw_args_text.trim()
            } else {
                "Chào bạn, kết bạn với mình nhé!"
            };

            let mut success_count = 0;
            let mut fail_count = 0;
            for uid in &candidates {
                match zalo.send_friend_request(uid, greeting).await {
                    Ok(res) => {
                        let code = res.get("error_code").or_else(|| res.get("errorCode")).and_then(Value::as_i64).unwrap_or(0);
                        if code == 0 {
                            success_count += 1;
                        } else {
                            fail_count += 1;
                        }
                    }
                    Err(_) => {
                        fail_count += 1;
                    }
                }
            }

            let fail_info = if fail_count > 0 {
                format!(" (Thất bại: {fail_count})")
            } else {
                String::new()
            };
            format!("🤝 Kết quả addfriendall: Thành công {success_count}/{} thành viên{fail_info}.", candidates.len())
        }
        "addfriend" | "ketban" | "kb" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể kết bạn.").await;
            };
            let targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần kết bạn.",
                )
                .await;
            }
            let greeting = if ctx.args.len() >= 2 {
                ctx.args[1..].join(" ")
            } else {
                "Chào bạn, kết bạn với mình nhé!".to_string()
            };

            let mut success_count = 0;
            let mut fail_count = 0;
            let mut last_err = String::new();
            for uid in &targets {
                match zalo.send_friend_request(uid, &greeting).await {
                    Ok(res) => {
                        let code = res.get("error_code").or_else(|| res.get("errorCode")).and_then(Value::as_i64).unwrap_or(0);
                        if code == 0 {
                            success_count += 1;
                        } else {
                            fail_count += 1;
                            last_err = res.get("error_message").and_then(Value::as_str).unwrap_or("API error").to_string();
                        }
                    }
                    Err(err) => {
                        fail_count += 1;
                        last_err = err.to_string();
                    }
                }
            }

            if targets.len() == 1 {
                let uid = &targets[0];
                if success_count == 1 {
                    format!("🤝 Đã gửi lời mời kết bạn tới UID `{uid}`.")
                } else {
                    format!("⚠️ Gửi lời mời kết bạn tới UID `{uid}` thất bại: {last_err}")
                }
            } else {
                let fail_info = if fail_count > 0 {
                    format!(" (Thất bại: {fail_count})")
                } else {
                    String::new()
                };
                format!("🤝 Kết quả gửi lời mời kết bạn: Thành công {success_count}/{}{fail_info}.", targets.len())
            }
        }
        "undofriend" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể thu hồi lời mời kết bạn.").await;
            };
            let targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần thu hồi lời mời kết bạn.",
                )
                .await;
            }
            let mut success_count = 0;
            let mut fail_count = 0;
            for uid in &targets {
                match zalo.undo_friend_request(uid).await {
                    Ok(res) => {
                        let code = res.get("error_code").or_else(|| res.get("errorCode")).and_then(Value::as_i64).unwrap_or(0);
                        if code == 0 {
                            success_count += 1;
                        } else {
                            fail_count += 1;
                        }
                    }
                    Err(_) => {
                        fail_count += 1;
                    }
                }
            }
            let fail_info = if fail_count > 0 {
                format!(" (Thất bại: {fail_count})")
            } else {
                String::new()
            };
            format!("🔄 Kết quả thu hồi lời mời kết bạn: Thành công {success_count}/{}{fail_info}.", targets.len())
        }
        "rejectfriend" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể từ chối lời mời kết bạn.").await;
            };
            let targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần từ chối lời mời kết bạn.",
                )
                .await;
            }
            let mut success_count = 0;
            let mut fail_count = 0;
            for uid in &targets {
                match zalo.reject_friend_request(uid).await {
                    Ok(res) => {
                        let code = res.get("error_code").or_else(|| res.get("errorCode")).and_then(Value::as_i64).unwrap_or(0);
                        if code == 0 {
                            success_count += 1;
                        } else {
                            fail_count += 1;
                        }
                    }
                    Err(_) => {
                        fail_count += 1;
                    }
                }
            }
            let fail_info = if fail_count > 0 {
                format!(" (Thất bại: {fail_count})")
            } else {
                String::new()
            };
            format!("❌ Kết quả từ chối lời mời kết bạn: Thành công {success_count}/{}{fail_info}.", targets.len())
        }
        "removefriend" => {
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể hủy kết bạn.").await;
            };
            let targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    "⚠️ Vui lòng @tag, nhập UID hoặc phản hồi tin nhắn của người cần hủy kết bạn.",
                )
                .await;
            }
            let mut success_count = 0;
            let mut fail_count = 0;
            for uid in &targets {
                match zalo.remove_friend(uid).await {
                    Ok(res) => {
                        let code = res.get("error_code").or_else(|| res.get("errorCode")).and_then(Value::as_i64).unwrap_or(0);
                        if code == 0 {
                            success_count += 1;
                        } else {
                            fail_count += 1;
                        }
                    }
                    Err(_) => {
                        fail_count += 1;
                    }
                }
            }
            let fail_info = if fail_count > 0 {
                format!(" (Thất bại: {fail_count})")
            } else {
                String::new()
            };
            format!("💔 Kết quả hủy kết bạn: Thành công {success_count}/{}{fail_info}.", targets.len())
        }
        "tagall" => {
            let body = if ctx.raw_args_text.trim().is_empty() {
                "Thông báo tới toàn bộ thành viên trong nhóm!"
            } else {
                ctx.raw_args_text.trim()
            };
            let full = format!("@All {body}");
            if let Some(ref zalo) = ctx.zalo {
                let out = OutboundMessage {
                    text: full.clone(),
                    mentions: vec![MentionSpan {
                        uid: ZaloId::new("-1"),
                        pos: 0,
                        len: 4,
                        mention_type: 1,
                    }],
                    ..Default::default()
                };
                if zalo
                    .send_message(out, &thread_id, ctx.message.thread_type)
                    .await
                    .is_ok()
                {
                    return Ok(CommandOutcome::Handled {
                        summary: "sent @All mention".into(),
                        reply_text: None,
                        custom_ttl_ms: None,
                    });
                }
            }
            full
        }
        "call" => {
            let target = extract_target_uids(&ctx)
                .into_iter()
                .next()
                .unwrap_or_else(|| ctx.message.sender_uid.clone());
            let Some(ref zalo) = ctx.zalo else {
                return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể gọi thoại.").await;
            };
            match zalo.send_call_voice(&target).await {
                Ok(_) => format!("📞 Đã gửi tín hiệu nhá máy thoại tới UID `{target}`."),
                Err(err) => format!("⚠️ Nhá máy thoại tới `{target}` thất bại: {err}"),
            }
        }
        // `target`/`taget` add a member to the group's persistent target list (V3 keeps BOTH
        // `stateDir/target-list.json` and `dataDir/tagetList.json`; we read the legacy spelling).
        "target" | "taget" => {
            let targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                let current = ctx
                    .group_settings
                    .settings
                    .get("targetList")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Chưa có ai".to_string());
                return send_text_reply(&ctx, &format!("🎯 Danh sách target hiện tại: {current}")).await;
            }
            let added: Vec<String> = targets.iter().map(|t| t.as_str().to_string()).collect();
            ctx.caches.update_group_settings(&bot_key, thread_id.as_str(), |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    let entry = obj
                        .entry("targetList".to_string())
                        .or_insert_with(|| json!([]));
                    if let Some(arr) = entry.as_array_mut() {
                        for uid in &added {
                            if !arr.iter().any(|v| v.as_str() == Some(uid.as_str())) {
                                arr.push(json!(uid));
                            }
                        }
                    }
                }
            });
            format!("🎯 Đã thêm {} thành viên vào danh sách target.", added.len())
        }
        "scold" => {
            let thread_str = thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            let is_stop = matches!(
                first_arg.as_deref(),
                Some("tha" | "stop" | "dung" | "dừng" | "off" | "tat" | "tắt")
            );

            if is_stop {
                let scold_prefix = format!("scold:{}:{}:", bot_key, thread_str);
                let count = ctx.interactions.cancel_tasks_with_prefix(&scold_prefix);
                if count > 0 {
                    return send_text_reply(&ctx, "Dạ đại ca em sẽ tha cho nó ạ!").await;
                } else {
                    return send_text_reply(&ctx, "Hiện không có phiên réo/chửi nào đang hoạt động trong nhóm này.").await;
                }
            }

            let targets = extract_target_uids(&ctx);
            if targets.is_empty() {
                return send_text_reply(
                    &ctx,
                    "⚠️ Vui lòng đề cập người dùng qua @mention hoặc nhập UID để chửi. Ví dụ: !scold @user hoặc !scold 123456",
                )
                .await;
            }

            let target_uid = targets[0].clone();
            let target_name = "Bạn".to_string();

            // Cancel any old scold tasks in this group
            let scold_prefix = format!("scold:{}:{}:", bot_key, thread_str);
            ctx.interactions.cancel_tasks_with_prefix(&scold_prefix);

            let task_key = format!("scold:{}:{}:{}", bot_key, thread_str, target_uid);
            let token = ctx.interactions.register_named_task(&task_key);

            let zalo = ctx.zalo.clone();
            let thread_id_owned = thread_id.clone();
            let thread_type = ctx.message.thread_type;
            let sink = ctx.outbound_sink.clone();
            let style_profile = ctx.style_profile.clone();
            let msg_ref = ctx.message.clone();
            let t_name = target_name.clone();
            let t_uid = target_uid.clone();

            tokio::spawn(async move {
                let phrases = [
                    "ra đây tao bảo, hiện hồn nhanh con chó!",
                    "hiện hồn nhanh không tao đốt nhà Bạn giờ!",
                    "bố nói tử tế mà không dậy à?",
                    "nhanh ra chửi nhau với tao!",
                    "đừng tỏ vẻ máu liều nhiều hơn máu não!",
                    "làm người thì khó, làm chó thì dễ!",
                    "bố gọi không nghe à, hiện hồn nhanh!",
                    "trốn kỹ thế, ra đây xem nào!",
                ];
                let mut idx = 0;
                while !token.is_cancelled() {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(std::time::Duration::from_millis(2500)) => {
                            let phrase = phrases[idx % phrases.len()];
                            idx += 1;
                            let text = format!("{t_name} {phrase}");
                            let mention = MentionSpan {
                                uid: t_uid.clone(),
                                pos: 0,
                                len: t_name.chars().count(),
                                mention_type: 0,
                            };
                            let out = build_tag_message(
                                &style_profile,
                                &msg_ref,
                                &text,
                                std::slice::from_ref(&mention),
                                None,
                                30_000,
                            );
                            if let Some(ref s) = sink {
                                s.lock().push(out.clone());
                            }
                            if let Some(ref z) = zalo {
                                let _ = z.send_message(out, &thread_id_owned, thread_type).await;
                            }
                        }
                    }
                }
            });

            format!(
                "🔥 Đã bắt đầu réo tên/chửi `{target_name}`. Gõ `{}scold tha` hoặc gửi từ `tha` để dừng.",
                ctx.prefix
            )
        }
        "spamgroup" => {
            let thread_str = thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            let is_stop = matches!(first_arg.as_deref(), Some("stop" | "off" | "tat"));

            let task_key = format!("spamgroup:{}:{}", bot_key, thread_str);
            if is_stop {
                if ctx.interactions.cancel_named_task(&task_key) {
                    return send_text_reply(&ctx, "🛑 Đã dừng spam nhóm.").await;
                } else {
                    return send_text_reply(&ctx, "Hiện không có phiên spam nhóm nào đang hoạt động.").await;
                }
            }

            let (text, delay_ms, repeat) = if ctx.raw_args_text.contains('|') {
                let parts: Vec<&str> = ctx.raw_args_text.split('|').collect();
                let txt = parts[0].trim().to_string();
                let del = parts.get(1).and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(1000).max(1000);
                let rep = parts.get(2).and_then(|s| s.trim().parse::<usize>().ok()).unwrap_or(5).clamp(1, 20);
                (txt, del, rep)
            } else {
                if ctx.args.is_empty() {
                    return send_text_reply(
                        &ctx,
                        &format!(
                            "⚠️ Cú pháp: {}spamgroup <nội dung> [số lần (1-20)] hoặc {}spamgroup <nội dung>|<delay_ms>|<số lần> hoặc {}spamgroup stop",
                            ctx.prefix, ctx.prefix, ctx.prefix
                        ),
                    ).await;
                }
                let last_is_num = ctx.args.last().and_then(|s| s.parse::<usize>().ok());
                if let Some(num) = last_is_num && ctx.args.len() > 1 {
                    let txt = ctx.args[..ctx.args.len() - 1].join(" ");
                    (txt, 1000, num.clamp(1, 20))
                } else {
                    (ctx.raw_args_text.trim().to_string(), 1000, 5)
                }
            };

            if text.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "⚠️ Cú pháp: {}spamgroup <nội dung> [số lần (1-20)] hoặc {}spamgroup stop",
                        ctx.prefix, ctx.prefix
                    ),
                ).await;
            }

            let token = ctx.interactions.register_named_task(&task_key);
            let zalo = ctx.zalo.clone();
            let thread_id_owned = thread_id.clone();
            let thread_type = ctx.message.thread_type;
            let sink = ctx.outbound_sink.clone();
            let style_profile = ctx.style_profile.clone();
            let msg_ref = ctx.message.clone();
            let spam_text = text.clone();
            let interactions = ctx.interactions.clone();
            let cleanup_key = task_key.clone();

            tokio::spawn(async move {
                let mut sent = 0;
                while !token.is_cancelled() && sent < repeat {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {
                            sent += 1;
                            let out = build_state_quote(
                                &style_profile,
                                &msg_ref,
                                &spam_text,
                                true,
                                30_000,
                                false,
                            );
                            if let Some(ref s) = sink {
                                s.lock().push(out.clone());
                            }
                            if let Some(ref z) = zalo {
                                let _ = z.send_message(out, &thread_id_owned, thread_type).await;
                            }
                        }
                    }
                }
                interactions.cancel_named_task(&cleanup_key);
            });

            format!(
                "🚀 Bắt đầu spam {} lần (khoảng cách {}ms). Dùng `{}spamgroup stop` để dừng.",
                repeat, delay_ms, ctx.prefix
            )
        }
        "spamjoin" => {
            let thread_str = thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            let is_stop = matches!(first_arg.as_deref(), Some("stop" | "off" | "tat"));

            let task_key = format!("spamjoin:{}:{}", bot_key, thread_str);
            if is_stop {
                if ctx.interactions.cancel_named_task(&task_key) {
                    return send_text_reply(&ctx, "🛑 Đã dừng spam join/leave nhóm.").await;
                } else {
                    return send_text_reply(&ctx, "Hiện không có phiên spamjoin nào đang hoạt động.").await;
                }
            }

            let link = ctx.args.first().map(|s| s.trim()).unwrap_or("");
            if link.is_empty() || (!link.starts_with("http") && !link.contains("zalo.me")) {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "⚠️ Cú pháp: {}spamjoin <link_nhóm> [số lần (1-20)] hoặc {}spamjoin stop",
                        ctx.prefix, ctx.prefix
                    ),
                ).await;
            }

            let count: usize = ctx.args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5).clamp(1, 20);
            let token = ctx.interactions.register_named_task(&task_key);
            let zalo = ctx.zalo.clone();
            let link_owned = link.to_string();
            let interactions = ctx.interactions.clone();
            let cleanup_key = task_key.clone();

            tokio::spawn(async move {
                let mut done = 0;
                while !token.is_cancelled() && done < count {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                            if let Some(ref z) = zalo {
                                if let Ok(info) = z.get_group_info_by_link(&link_owned, 1).await {
                                    let _ = z.join_group(&link_owned).await;
                                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                    let gid = info.get("grid").or_else(|| info.get("groupId")).and_then(serde_json::Value::as_str).unwrap_or("");
                                    if !gid.is_empty() {
                                        let _ = z.leave_group(&[mybot_types::ZaloId::new(gid)], true).await;
                                    }
                                    done += 1;
                                }
                            } else {
                                done += 1;
                            }
                        }
                    }
                }
                interactions.cancel_named_task(&cleanup_key);
            });

            format!(
                "⚡ Bắt đầu tiến trình spam join/leave link nhóm {} lần (giới hạn an toàn tối đa 20). Dùng `{}spamjoin stop` để hủy.",
                count, ctx.prefix
            )
        }
        "name" => {
            let invoked = ctx.invoked_alias.trim().to_ascii_lowercase();

            // Branch 1: myaccount / myacc
            if invoked == "myaccount" || invoked == "myacc" {
                let bot_rec = ctx.caches.engine().get_bot(&bot_key).ok().flatten();
                let bot_uid = if !ctx.self_uid.is_empty() {
                    ctx.self_uid.to_string()
                } else {
                    bot_rec.as_ref().map(|b| b.uid.to_string()).unwrap_or_else(|| "Không xác định".into())
                };

                let info_val = if let Some(ref z) = ctx.zalo {
                    z.fetch_account_info().await.ok()
                } else {
                    None
                };

                let name = info_val
                    .as_ref()
                    .and_then(|v| v.get("data"))
                    .and_then(|d| d.get("displayName").or_else(|| d.get("name")))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .or_else(|| bot_rec.as_ref().map(|b| b.display_name.as_str()).filter(|s| !s.is_empty()))
                    .unwrap_or("MyBot");

                let avatar_url = info_val
                    .as_ref()
                    .and_then(|v| v.get("data"))
                    .and_then(|d| d.get("avatar").or_else(|| d.get("avatarUrl")))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .or_else(|| bot_rec.as_ref().map(|b| b.avatar.as_str()).filter(|s| !s.is_empty()))
                    .unwrap_or("Mặc định");

                let uptime = bot_rec
                    .as_ref()
                    .map(|b| b.created_at.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Đang hoạt động");

                return send_text_reply(
                    &ctx,
                    &format!(
                        "🤖 Thông tin tài khoản bot:\n• Tên hiển thị: {name}\n• UID: {bot_uid}\n• Avatar: {avatar_url}\n• Thời gian hoạt động: {uptime}"
                    ),
                )
                .await;
            }

            // Branch 2: mysetting
            if invoked == "mysetting" {
                return send_text_reply(
                    &ctx,
                    "⚙️ HHH đang dùng cấu hình tài khoản từ dashboard và provider service. Dùng !setaccount để đổi tên bot, hoặc !setavatar-account để đổi avatar nếu API hỗ trợ.",
                )
                .await;
            }

            // Branch 3: Avatar aliases (setavatar-account, setavataraccount, setavtacc, setavt, setavatarbox, changeavatar, avatar, botavatar, setavatar)
            let is_avatar_alias = matches!(
                invoked.as_str(),
                "setavatar-account"
                    | "setavataraccount"
                    | "setavtacc"
                    | "setavt"
                    | "setavatarbox"
                    | "changeavatar"
                    | "avatar"
                    | "botavatar"
                    | "setavatar"
            );

            if is_avatar_alias {
                if ctx.sender_tier < PermissionTier::AdminBot {
                    return send_text_reply(&ctx, "❌ Tuổi cặc đổi tên tao!").await;
                }

                let avatar_source = extract_avatar_source_from_quote(&ctx);
                let Some(source_url) = avatar_source else {
                    return send_text_reply(&ctx, "⚠️ Vui lòng reply một ảnh để đặt avatar tài khoản.").await;
                };

                let Some(ref zalo) = ctx.zalo else {
                    return send_text_reply(&ctx, "⚠️ Bot chưa kết nối Zalo nên không thể đổi avatar tài khoản.").await;
                };

                // Download image bytes via crawler hub
                let downloaded = _rt.crawlers.download_media_to_ram(&source_url, false).await;
                let scratch = match downloaded {
                    Ok(s) => s,
                    Err(err) => {
                        return send_text_reply(&ctx, &format!("❌ Đổi avatar thất bại: Không thể tải ảnh ({err})")).await;
                    }
                };
                let bytes = match scratch.read_bytes() {
                    Ok(b) => b,
                    Err(err) => {
                        return send_text_reply(&ctx, &format!("❌ Đổi avatar thất bại: Không thể đọc dữ liệu ảnh ({err})")).await;
                    }
                };

                match zalo.change_account_avatar(&bytes).await {
                    Ok(_) => "✅ Đã cập nhật avatar tài khoản bot.".to_string(),
                    Err(err) => format!("❌ Đổi avatar thất bại: {err}"),
                }
            } else {
                // Branch 4: name <tên>, rename, setaccount
                // Sender permission check: must be AdminBot or higher
                if ctx.sender_tier < PermissionTier::AdminBot {
                    return send_text_reply(&ctx, "❌ Tuổi cặc đổi tên tao!").await;
                }

                let new_name = ctx.raw_args_text.trim();
                if new_name.is_empty() {
                    return send_text_reply(&ctx, "⚠️ Vui lòng nhập tên mới để đổi!").await;
                }

                let transformed_name = new_name.to_uppercase();

                let Some(ref zalo) = ctx.zalo else {
                    // Update database record if session is offline
                    if let Some(mut bot) = ctx.caches.engine().get_bot(&bot_key)? {
                        bot.display_name = transformed_name.clone();
                        bot.updated_at = Utc::now().to_rfc3339();
                        let _ = ctx.caches.engine().upsert_bot(&bot);
                    }
                    return send_text_reply(
                        &ctx,
                        &format!("✅ Đã đổi tên bot thành: {transformed_name} (chế độ offline)"),
                    )
                    .await;
                };

                let default_dob = "2002-12-06";
                let default_gender = 0;
                match zalo.change_account_setting(&transformed_name, default_dob, default_gender, &serde_json::json!({})).await {
                    Ok(_) => {
                        if let Some(mut bot) = ctx.caches.engine().get_bot(&bot_key)? {
                            bot.display_name = transformed_name.clone();
                            bot.updated_at = Utc::now().to_rfc3339();
                            let _ = ctx.caches.engine().upsert_bot(&bot);
                        }
                        format!("✅ Đã đổi tên bot thành: {transformed_name}")
                    }
                    Err(err) => format!("❌ Đổi tên thất bại: {err}"),
                }
            }
        }
        "restart" => {
            // Node V3: `src/utils/util.js:87-101`:
            // Gửi tin nhắn thông báo đang khởi động lại bot, sau đó kích hoạt luồng thoát tiến trình
            // có hẹn giờ ngắn (graceful exit) để process supervisor (systemd / PM2 / run.ps1) tự động khởi động lại tiến trình.
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                std::process::exit(0);
            });
            return send_text_reply(
                &ctx,
                "🤖 Bot đang khởi động lại 🔂",
            )
            .await;
        }
        "blockbot" => {
            let targets: Vec<String> = if !ctx.message.mentions.is_empty() {
                ctx.message.mentions.iter().map(|m| m.uid.to_string()).collect()
            } else if let Some(first) = ctx.args.first() {
                vec![first.clone()]
            } else {
                return send_text_reply(&ctx, "🚨 Vui lòng đề cập người dùng qua @mention hoặc nhập UID để chặn!").await;
            };

            ctx.caches.update_group_settings(&ctx.bot_key, ctx.message.thread_id.as_str(), |g| {
                let obj = g.settings.as_object_mut().unwrap();
                let list = obj.entry("blockBot").or_insert_with(|| json!([]));
                if let Some(arr) = list.as_array_mut() {
                    for t in &targets {
                        if !arr.iter().any(|v| v.as_str() == Some(t)) {
                            arr.push(json!(t));
                        }
                    }
                }
            });
            format!("✅ Đã chặn tương tác bot đối với: {}", targets.join(", "))
        }
        "unblockbot" => {
            let targets: Vec<String> = if !ctx.message.mentions.is_empty() {
                ctx.message.mentions.iter().map(|m| m.uid.to_string()).collect()
            } else if let Some(first) = ctx.args.first() {
                vec![first.clone()]
            } else {
                return send_text_reply(&ctx, "🚨 Vui lòng @mention người dùng cần bỏ chặn tương tác bot!").await;
            };

            ctx.caches.update_group_settings(&ctx.bot_key, ctx.message.thread_id.as_str(), |g| {
                let obj = g.settings.as_object_mut().unwrap();
                if let Some(arr) = obj.get_mut("blockBot").and_then(Value::as_array_mut) {
                    arr.retain(|v| !targets.iter().any(|t| v.as_str() == Some(t)));
                }
            });
            format!("✅ Đã bỏ chặn tương tác bot đối với: {}", targets.join(", "))
        }
        "listblockbot" => {
            let current_grp = ctx
                .caches
                .get_or_default_group_settings(&ctx.bot_key, ctx.message.thread_id.as_str());
            let list: Vec<String> = current_grp
                .settings
                .get("blockBot")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(ToOwned::to_owned)).collect())
                .unwrap_or_default();
            if list.is_empty() {
                "🚨 Không có ai bị chặn tương tác với bot trong nhóm này.".into()
            } else {
                format!("📋 Danh sách bị chặn tương tác bot ({}):\n• {}", list.len(), list.join("\n• "))
            }
        }
        other => {
            return Err(CommandError::Internal(format!(
                "Lệnh quản trị `{other}` chưa được định nghĩa handler."
            )));
        }
    };

    send_text_reply(&ctx, &reply).await
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use mybot_core::{CommandContext, CommandOutcome, InteractionEngine};
    use mybot_storage::{BotRecord, GroupSettingsRecord, HotStorageCaches, StorageEngine};
    use mybot_types::{
        EventSource, ExpiryPolicy, InboundMessage, MessageContent, PermissionTier, ThreadType,
        ZaloId,
    };
    use serde_json::json;
    use zalo_sdk::apis::messaging::OutboundMessage;

    use super::execute_admin_group_command as execute;
    use crate::CommandRuntimeBundle;
    use crate::catalog::SPEC_5;

    fn make_test_admin_ctx(
        caches: HotStorageCaches,
        sink: Arc<parking_lot::Mutex<Vec<OutboundMessage>>>,
        invoked_alias: &str,
        raw_args: &str,
        sender_tier: PermissionTier,
    ) -> CommandContext {
        let thread_id = "grp_test_admin_group";
        let mut settings = GroupSettingsRecord::default_for("main", thread_id);
        settings.group_name = "Nhóm Test Admin".to_string();

        let args_vec: Vec<String> = raw_args
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();

        CommandContext {
            bot_key: "main".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("bot_uid_123"),
            prefix: "!".into(),
            invoked_alias: invoked_alias.into(),
            args: args_vec,
            raw_args_text: raw_args.into(),
            message: InboundMessage {
                bot_key: "main".into(),
                msg_id: ZaloId::new("msg_cmd_1"),
                cli_msg_id: ZaloId::new("cli_cmd_1"),
                global_msg_id: ZaloId::new("glob_cmd_1"),
                thread_id: ZaloId::new(thread_id),
                thread_type: ThreadType::Group,
                sender_uid: ZaloId::new("user_sender_456"),
                sender_name: "Test Caller".into(),
                is_self: false,
                msg_type: "webchat".into(),
                timestamp_ms: 1_760_000_000_000,
                ws_received_at_ms: 1_760_000_000_005,
                ttl_ms: 0,
                mentions: Vec::new(),
                styles: Vec::new(),
                quote: None,
                content: MessageContent::Text {
                    text: format!("!{invoked_alias} {raw_args}"),
                },
                source: EventSource::default(),
                raw_property_ext: None,
            },
            sender_tier,
            group_settings: settings,
            effective_studio_config: json!({}),
            zalo: None,
            caches,
            assets_root: PathBuf::from("../../../assets"),
            style_profile: mybot_core::BotStyleProfile::default(),
            interactions: Arc::new(InteractionEngine::new()),
            fleet: None,
            outbound_sink: Some(sink),
        }
    }

    #[tokio::test]
    async fn test_name_rejected_without_admin_bot_tier() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        // Gọi lệnh !name mà không có quyền AdminBot
        let ctx = make_test_admin_ctx(
            caches,
            sink.clone(),
            "name",
            "Tên Bot Mới",
            PermissionTier::All,
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("Tuổi cặc đổi tên tao!"),
                    "Expected rejection message, got: {text}"
                );
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_name_empty_args_requests_new_name() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        let ctx = make_test_admin_ctx(
            caches,
            sink.clone(),
            "name",
            "",
            PermissionTier::AdminBot,
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("Vui lòng nhập tên mới để đổi!"),
                    "Expected query message, got: {text}"
                );
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_name_success_updates_database_and_uppercases() {
        let engine = StorageEngine::open_in_memory().unwrap();
        // Tạo bot record trong DB
        let bot = BotRecord {
            bot_key: "main".into(),
            uid: ZaloId::new("bot_uid_123"),
            global_uid: None,
            canonical_username: None,
            display_name: "Old Name".into(),
            avatar: "avatar.jpg".into(),
            is_main: true,
            owner_uid: None,
            status: "online".into(),
            desired_status: "running".into(),
            expiry_policy: ExpiryPolicy::Permanent,
            trial_status: None,
            cookie_json: json!({}),
            imei: "".into(),
            user_agent: "".into(),
            proxy_url: None,
            cookie_dead: false,
            cookie_dead_reason: None,
            prefix: "!".into(),
            self_listen: false,
            identity_pending: false,
            admin_identity_seeds: vec![],
            metadata: json!({}),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        engine.upsert_bot(&bot).unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        let ctx = make_test_admin_ctx(
            caches.clone(),
            sink.clone(),
            "name",
            "bot sieu cap v3",
            PermissionTier::AdminBot,
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("BOT SIEU CAP V3"),
                    "Expected transformed uppercase name, got: {text}"
                );
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }

        // Kiểm tra database đã được cập nhật tên in hoa
        let updated = caches.engine().get_bot("main").unwrap().unwrap();
        assert_eq!(updated.display_name, "BOT SIEU CAP V3");
    }

    #[tokio::test]
    async fn test_myaccount_alias_returns_bot_info() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let bot = BotRecord {
            bot_key: "main".into(),
            uid: ZaloId::new("bot_uid_123"),
            global_uid: None,
            canonical_username: None,
            display_name: "SuperBot".into(),
            avatar: "https://example.com/bot_avatar.jpg".into(),
            is_main: true,
            owner_uid: None,
            status: "online".into(),
            desired_status: "running".into(),
            expiry_policy: ExpiryPolicy::Permanent,
            trial_status: None,
            cookie_json: json!({}),
            imei: "".into(),
            user_agent: "".into(),
            proxy_url: None,
            cookie_dead: false,
            cookie_dead_reason: None,
            prefix: "!".into(),
            self_listen: false,
            identity_pending: false,
            admin_identity_seeds: vec![],
            metadata: json!({}),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        engine.upsert_bot(&bot).unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        let ctx = make_test_admin_ctx(
            caches,
            sink.clone(),
            "myaccount",
            "",
            PermissionTier::All,
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(text.contains("Thông tin tài khoản bot:"), "Got: {text}");
                assert!(text.contains("bot_uid_123"), "Got: {text}");
                assert!(text.contains("SuperBot"), "Got: {text}");
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_mysetting_alias_returns_guidance() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        let ctx = make_test_admin_ctx(
            caches,
            sink.clone(),
            "mysetting",
            "",
            PermissionTier::All,
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("HHH đang dùng cấu hình tài khoản từ dashboard"),
                    "Got: {text}"
                );
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_avatar_alias_requires_admin_bot() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        let ctx = make_test_admin_ctx(
            caches,
            sink.clone(),
            "setavatar-account",
            "",
            PermissionTier::AdminBox, // Không đủ quyền AdminBot
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("Tuổi cặc đổi tên tao!"),
                    "Got: {text}"
                );
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_avatar_alias_requires_image_reply() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let rt = CommandRuntimeBundle::new(&PathBuf::from("."), caches.clone());

        let ctx = make_test_admin_ctx(
            caches,
            sink.clone(),
            "setavatar-account",
            "",
            PermissionTier::AdminBot,
        );

        let outcome = execute(&SPEC_5, ctx, &rt).await.unwrap();
        match outcome {
            CommandOutcome::Handled { reply_text, .. } => {
                let text = reply_text.unwrap_or_default();
                assert!(
                    text.contains("Vui lòng reply một ảnh để đặt avatar tài khoản."),
                    "Got: {text}"
                );
            }
            other => panic!("Expected Handled, got: {other:?}"),
        }
    }
}
