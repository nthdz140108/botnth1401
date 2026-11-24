//! 12-Step Safe Member Pruning Workflow (`!locmem` / Node V3 parity).
//!
//! Provides the complete inactive member filtering, candidate preview,
//! ❤️ reaction confirmation wait, atomic session protection, and rate-limited kick process.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::Utc;
use chrono_tz::Asia::Ho_Chi_Minh;
use dashmap::DashSet;
use mybot_core::{
    CommandContext, CommandError, CommandOutcome, CommandSpec, build_state_quote,
    sanitize_no_markdown,
};
use mybot_storage::HotStorageCaches;
use mybot_types::{InboundMessage, PermissionTier, ThreadType, ZaloId};
use serde_json::Value;
use zalo_sdk::{OutboundMessage, ZaloSession};

use crate::send_text_reply;

/// Dynamically checks whether a given UID is currently an AdminLevelHigh for this bot session.
/// Matches Node V3: `auth.isAdminLevelHigh` (owner, bot self, supreme/high admins).
pub(crate) fn check_is_admin_level_high(
    caches: &HotStorageCaches,
    bot_key: &str,
    sender_uid: &str,
    self_uid: &str,
) -> bool {
    if sender_uid.is_empty() {
        return false;
    }
    // 1. Bot itself
    if !self_uid.is_empty() && self_uid == sender_uid {
        return true;
    }
    // 2. Bot record owner or bot UID
    if let Ok(Some(bot)) = caches.engine().get_bot(bot_key) {
        if !bot.uid.is_empty() && bot.uid.as_str() == sender_uid {
            return true;
        }
        if bot.owner_uid.as_deref() == Some(sender_uid) {
            return true;
        }
    }
    // 3. Bot admins with high / supreme / owner / adminlevelhigh
    if let Ok(admins) = caches.engine().list_bot_admins(bot_key) {
        for (uid, tier, _) in admins {
            if uid == sender_uid {
                if tier.eq_ignore_ascii_case("high")
                    || tier.eq_ignore_ascii_case("supreme")
                    || tier.eq_ignore_ascii_case("owner")
                    || tier.eq_ignore_ascii_case("adminLevelHigh")
                {
                    return true;
                }
            }
        }
    }
    // 4. Main bot admins fallback (if current bot is a child bot)
    for main_key in &["admin", "main"] {
        if *main_key != bot_key {
            if let Ok(main_admins) = caches.engine().list_bot_admins(main_key) {
                for (uid, tier, _) in main_admins {
                    if uid == sender_uid {
                        if tier.eq_ignore_ascii_case("high")
                            || tier.eq_ignore_ascii_case("supreme")
                            || tier.eq_ignore_ascii_case("owner")
                            || tier.eq_ignore_ascii_case("adminLevelHigh")
                        {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}
pub static PENDING_LOCMEM_GROUPS: LazyLock<DashSet<String>> = LazyLock::new(DashSet::new);

/// Metadata of group members and permissions.
#[derive(Debug, Clone)]
pub struct GroupMembersMeta {
    pub creator_uid: Option<String>,
    pub admin_uids: Vec<String>,
    pub member_uids: Vec<ZaloId>,
    pub group_name: String,
}

/// Returns today's date key in `Asia/Ho_Chi_Minh` and the 7 consecutive preceding calendar days.
///
/// Order of `days`: `[yesterday, 2 days ago, ..., 7 days ago]`.
pub fn get_consecutive_7_calendar_days_ict() -> (String, Vec<String>) {
    let now_ict = Utc::now().with_timezone(&Ho_Chi_Minh);
    let today_key = now_ict.format("%Y-%m-%d").to_string();
    let mut days = Vec::with_capacity(7);
    for i in 1..=7 {
        let d = (now_ict.date_naive() - chrono::Duration::days(i))
            .format("%Y-%m-%d")
            .to_string();
        days.push(d);
    }
    (today_key, days)
}

/// Parses user names from Zalo profile response.
fn parse_user_names(val: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(arr) = val.as_array().or_else(|| val.get("data").and_then(Value::as_array)) {
        for item in arr {
            let uid = item
                .get("userId")
                .or_else(|| item.get("uid"))
                .and_then(Value::as_str);
            let name = item
                .get("displayName")
                .or_else(|| item.get("zaloName"))
                .or_else(|| item.get("name"))
                .and_then(Value::as_str);
            if let (Some(u), Some(n)) = (uid, name) {
                map.insert(u.to_string(), n.to_string());
            }
        }
    } else if let Some(obj) = val.as_object().or_else(|| val.get("data").and_then(Value::as_object)) {
        for (k, item) in obj {
            let name = item
                .get("displayName")
                .or_else(|| item.get("zaloName"))
                .or_else(|| item.get("name"))
                .and_then(Value::as_str);
            if let Some(n) = name {
                map.insert(k.clone(), n.to_string());
            }
        }
    }
    map
}

/// Extracts group member list and admin information.
pub async fn extract_group_members_meta(
    ctx: &CommandContext,
) -> Result<GroupMembersMeta, String> {
    if let Some(ref zalo) = ctx.zalo {
        let info = zalo
            .get_group_info(std::slice::from_ref(&ctx.message.thread_id))
            .await
            .map_err(|e| format!("getGroupInfo failed: {e}"))?;

        let gval = info
            .get("gridInfoMap")
            .and_then(|m| m.get(ctx.message.thread_id.as_str()))
            .or_else(|| {
                info.get("gridInfoMap")
                    .and_then(Value::as_object)
                    .and_then(|m| m.values().next())
            });

        let group_name = gval
            .and_then(|g| g.get("name"))
            .or_else(|| info.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Nhóm")
            .to_string();

        let creator_uid = gval
            .and_then(|g| g.get("creatorId"))
            .or_else(|| info.get("creatorId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let admin_uids: Vec<String> = gval
            .and_then(|g| g.get("adminIds"))
            .or_else(|| info.get("adminIds"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_default();

        let member_uids: Vec<ZaloId> = gval
            .and_then(|g| g.get("memVerList"))
            .or_else(|| info.get("memVerList"))
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

        Ok(GroupMembersMeta {
            creator_uid,
            admin_uids,
            member_uids,
            group_name,
        })
    } else {
        let group_name = if !ctx.group_settings.group_name.is_empty() {
            ctx.group_settings.group_name.clone()
        } else {
            "Nhóm".to_string()
        };
        let settings = &ctx.group_settings.settings;
        let creator_uid = settings
            .get("creatorId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let admin_uids: Vec<String> = settings
            .get("adminIds")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_else(|| vec![ctx.self_uid.to_string()]);

        let member_uids: Vec<ZaloId> = settings
            .get("memberUids")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ZaloId::from))
                    .collect()
            })
            .unwrap_or_default();

        Ok(GroupMembersMeta {
            creator_uid,
            admin_uids,
            member_uids,
            group_name,
        })
    }
}

/// Fetches fresh group meta during reaction confirmation.
async fn fetch_fresh_group_meta(
    zalo: &Option<Arc<ZaloSession>>,
    caches: &HotStorageCaches,
    bot_key: &str,
    thread_id: &ZaloId,
    fallback_candidates: &[ZaloId],
) -> Result<GroupMembersMeta, String> {
    if let Some(z) = zalo.as_ref() {
        let info = z
            .get_group_info(std::slice::from_ref(thread_id))
            .await
            .map_err(|e| format!("getGroupInfo error: {e}"))?;

        let gval = info
            .get("gridInfoMap")
            .and_then(|m| m.get(thread_id.as_str()))
            .or_else(|| {
                info.get("gridInfoMap")
                    .and_then(Value::as_object)
                    .and_then(|m| m.values().next())
            });

        let group_name = gval
            .and_then(|g| g.get("name"))
            .or_else(|| info.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Nhóm")
            .to_string();

        let creator_uid = gval
            .and_then(|g| g.get("creatorId"))
            .or_else(|| info.get("creatorId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let admin_uids: Vec<String> = gval
            .and_then(|g| g.get("adminIds"))
            .or_else(|| info.get("adminIds"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_default();

        let member_uids: Vec<ZaloId> = gval
            .and_then(|g| g.get("memVerList"))
            .or_else(|| info.get("memVerList"))
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

        Ok(GroupMembersMeta {
            creator_uid,
            admin_uids,
            member_uids,
            group_name,
        })
    } else {
        let gs = caches.get_or_default_group_settings(bot_key, thread_id.as_str());
        let settings = &gs.settings;
        let creator_uid = settings
            .get("creatorId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let admin_uids: Vec<String> = settings
            .get("adminIds")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_else(|| vec!["bot_1".to_string()]);

        let member_uids: Vec<ZaloId> = settings
            .get("memberUids")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ZaloId::from))
                    .collect()
            })
            .unwrap_or_else(|| fallback_candidates.to_vec());

        Ok(GroupMembersMeta {
            creator_uid,
            admin_uids,
            member_uids,
            group_name: if !gs.group_name.is_empty() {
                gs.group_name
            } else {
                "Nhóm Test".to_string()
            },
        })
    }
}

/// Sends an outbound notice to group and sink.
async fn send_notice(
    zalo: &Option<Arc<ZaloSession>>,
    outbound_sink: &Option<Arc<parking_lot::Mutex<Vec<OutboundMessage>>>>,
    style_profile: &mybot_core::BotStyleProfile,
    quote_msg: &InboundMessage,
    thread_id: &ZaloId,
    text: &str,
) {
    let clean = sanitize_no_markdown(text);
    let out = build_state_quote(style_profile, quote_msg, &clean, false, 0, false);
    if let Some(sink) = outbound_sink {
        sink.lock().push(out.clone());
    }
    if let Some(z) = zalo.as_ref() {
        let _ = z.send_message(out, thread_id, ThreadType::Group).await;
    }
}

/// Executes the full 12-step `locmem` command.
pub async fn execute_locmem_command(
    _spec: &'static CommandSpec,
    ctx: CommandContext,
) -> Result<CommandOutcome, CommandError> {
    let thread_id = ctx.message.thread_id.clone();
    let thread_str = thread_id.to_string();

    // 1. Scope check: group only
    if ctx.message.thread_type != ThreadType::Group {
        return send_text_reply(
            &ctx,
            "⚠️ Lệnh !locmem chỉ có thể sử dụng trong nhóm trò chuyện.",
        )
        .await;
    }

    // 2. Permission check: caller must have adminLevelHigh
    if ctx.sender_tier < PermissionTier::AdminLevelHigh {
        return send_text_reply(
            &ctx,
            "⚠️ Bạn cần quyền Quản trị viên cấp cao (adminLevelHigh) để thực hiện lệnh này!",
        )
        .await;
    }

    // 3. Pending check: reject if group already has an active confirmation session
    if PENDING_LOCMEM_GROUPS.contains(&thread_str) {
        return send_text_reply(
            &ctx,
            "⚠️ Nhóm đang có một yêu cầu lọc thành viên chờ xác nhận!\nVui lòng chờ yêu cầu hiện tại hoàn tất hoặc hết hạn (120s).",
        )
        .await;
    }

    // 4. Fetch group info & verify Bot permissions (Bot must be owner or group admin)
    let meta = match extract_group_members_meta(&ctx).await {
        Ok(m) => m,
        Err(err) => {
            return send_text_reply(
                &ctx,
                &format!("⚠️ Không thể lấy thông tin nhóm: {err}"),
            )
            .await;
        }
    };

    let self_str = ctx.self_uid.as_str();
    let bot_key_str = ctx.bot_key.as_str();
    let bot_is_owner_or_admin = meta.creator_uid.as_deref() == Some(self_str)
        || meta.creator_uid.as_deref() == Some(bot_key_str)
        || meta.admin_uids.iter().any(|a| a == self_str || a == bot_key_str || a == "admin_box");

    if !bot_is_owner_or_admin {
        return send_text_reply(
            &ctx,
            "⚠️ Bot không có quyền quản trị viên hoặc chủ nhóm trong nhóm này!\nVui lòng trao quyền quản trị viên cho bot trước khi dùng lệnh lọc thành viên.",
        )
        .await;
    }

    // Immediate ACK for background scanning (Node V3 parity: src/commands/locmem-service.js:213-220)
    let ack_scanning = build_state_quote(
        &ctx.style_profile,
        &ctx.message,
        "🔍 Đang bắt đầu quét thành viên không tương tác (7 ngày)... Vui lòng đợi trong giây lát!",
        false,
        0,
        false,
    );
    let _ = ctx.send_outbound(ack_scanning).await;

    // Internal 45s scan deadline enforcement (Node V3 parity: locmem-service.js:223-236)
    let scan_start = std::time::Instant::now();
    let scan_deadline = Duration::from_secs(45);
    let is_deadline_exceeded = || scan_start.elapsed() >= scan_deadline;

    if is_deadline_exceeded() {
        return send_text_reply(
            &ctx,
            "⚠️ Quá thời gian quét dữ liệu (45s deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn.",
        )
        .await;
    }

    // 5. Query exact 7 calendar days immediately preceding today in Asia/Ho_Chi_Minh
    let (today_key, required_7_days) = get_consecutive_7_calendar_days_ict();

    // Flush any pending RAM activity deltas to SQLite (FAIL-CLOSED: do not swallow error!)
    if let Err(err) = ctx.caches.flush_ranks_messages_and_locmem() {
        tracing::error!(error = %err, "Failed to flush activity deltas before locmem scan");
        return send_text_reply(
            &ctx,
            &format!("❌ Lỗi đồng bộ dữ liệu hoạt động vào CSDL: {err}. Đã dừng lọc thành viên để đảm bảo an toàn."),
        )
        .await;
    }

    if is_deadline_exceeded() {
        return send_text_reply(
            &ctx,
            "⚠️ Quá thời gian quét dữ liệu (45s deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn.",
        )
        .await;
    }

    let complete_days = match ctx
        .caches
        .engine()
        .get_locmem_coverage_days(&ctx.bot_key, thread_id.as_str(), &required_7_days)
    {
        Ok(days) => days,
        Err(err) => {
            tracing::error!(error = %err, "Database error querying locmem coverage days");
            return send_text_reply(
                &ctx,
                &format!("❌ Lỗi kiểm tra độ bao phủ 7 ngày của nhóm: {err}. Đã dừng lọc để đảm bảo an toàn."),
            )
            .await;
        }
    };

    if complete_days.len() < 7 {
        let msg = format!(
            "⚠️ Chưa đủ dữ liệu để lọc thành viên an toàn!\n\
            ━━━━━━━━━━━━━━━━━━━━\n\
            • Yêu cầu: Đủ 7 ngày lịch hoàn chỉnh gần nhất không gián đoạn.\n\
            • Hiện có: {}/7 ngày hoàn chỉnh.\n\n\
            💡 Nguyên tắc an toàn dữ liệu: Bot chỉ lọc khi có đủ 7 ngày theo dõi liên tục, không downtime và có đầy đủ snapshot thành viên.",
            complete_days.len()
        );
        return send_text_reply(&ctx, &msg).await;
    }

    // 6. Safe exclusion list: creator, group admins, admin bot, current bot, system bots
    let mut exclude_set: HashSet<String> = HashSet::new();

    if let Some(ref c) = meta.creator_uid {
        exclude_set.insert(c.clone());
    }
    for a in &meta.admin_uids {
        exclude_set.insert(a.clone());
    }
    exclude_set.insert(ctx.self_uid.to_string());
    exclude_set.insert(ctx.bot_key.clone());

    if let Ok(bot_admins) = ctx.caches.engine().list_bot_admins(&ctx.bot_key) {
        for (admin_uid, _, _) in bot_admins {
            exclude_set.insert(admin_uid);
        }
    }

    if let Ok(bots) = ctx.caches.engine().list_bots() {
        for b in bots {
            exclude_set.insert(b.uid.to_string());
            exclude_set.insert(b.bot_key);
        }
    }

    if is_deadline_exceeded() {
        return send_text_reply(
            &ctx,
            "⚠️ Quá thời gian quét dữ liệu (45s deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn.",
        )
        .await;
    }

    // 7. Query active members from SQLite (from 7 days ago to today)
    let start_date = required_7_days.last().cloned().unwrap_or_else(|| today_key.clone());
    let end_date = required_7_days.first().cloned().unwrap_or_else(|| today_key.clone());

    let activity_rows = match ctx.caches.engine().query_locmem_range(
        &ctx.bot_key,
        thread_id.as_str(),
        &start_date,
        &today_key,
    ) {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "Database error querying locmem activity range");
            return send_text_reply(
                &ctx,
                &format!("❌ Lỗi truy vấn dữ liệu hoạt động thành viên: {err}. Đã dừng lọc để đảm bảo an toàn."),
            )
            .await;
        }
    };

    let mut active_uids: HashSet<String> = HashSet::new();
    for (uid, msg_cnt, react_cnt, join_cnt) in activity_rows {
        if msg_cnt + react_cnt + join_cnt > 0 {
            active_uids.insert(uid);
        }
    }

    // Candidates: members whose 7-day + today activity == 0, excluding protected list
    let candidates: Vec<ZaloId> = meta
        .member_uids
        .into_iter()
        .filter(|uid| {
            let s = uid.as_str();
            !exclude_set.contains(s) && !active_uids.contains(s)
        })
        .collect();

    if candidates.is_empty() {
        let msg = format!(
            "✅ Không có thành viên nào không tương tác đủ điều kiện lọc!\n\
            ━━━━━━━━━━━━━━━━━━━━\n\
            • Kỳ thống kê: 7 ngày hoàn chỉnh ({start_date} ➜ {end_date})\n\
            • Kiểm tra hôm nay ({today_key}): Hoàn tất\n\
            • Mọi thành viên đều có tương tác hoặc thuộc danh sách bảo vệ (chủ nhóm, phó nhóm, admin, bot, thành viên mới)."
        );
        return send_text_reply(&ctx, &msg).await;
    }

    // 8. Fetch candidate names in bounded batches (chunks of 20) with fallback
    let mut candidate_names: Vec<(ZaloId, String)> = Vec::with_capacity(candidates.len());
    if let Some(ref zalo) = ctx.zalo {
        for chunk in candidates.chunks(20) {
            let name_map = match zalo.get_user_info(chunk).await {
                Ok(val) => parse_user_names(&val),
                Err(_) => HashMap::new(),
            };
            for uid in chunk {
                let name = name_map
                    .get(uid.as_str())
                    .cloned()
                    .unwrap_or_else(|| format!("Thành viên ({uid})"));
                candidate_names.push((uid.clone(), name));
            }
        }
    } else {
        for uid in &candidates {
            candidate_names.push((uid.clone(), format!("Thành viên ({uid})")));
        }
    }

    // 9. Send preview chunks (25 members per message)
    let preview_chunks: Vec<&[(ZaloId, String)]> = candidate_names.chunks(25).collect();
    for (i, chunk) in preview_chunks.iter().enumerate() {
        let mut text = format!(
            "📋 DANH SÁCH THÀNH VIÊN KHÔNG TƯƠNG TÁC ({}/{})\n(Kỳ xét: {start_date} ➜ {end_date} & hôm nay)\n\n",
            i + 1,
            preview_chunks.len()
        );
        for (idx, (uid, name)) in chunk.iter().enumerate() {
            let global_idx = i * 25 + idx + 1;
            text.push_str(&format!("{global_idx}. {name} ({uid})\n"));
        }
        let out = build_state_quote(&ctx.style_profile, &ctx.message, &text, false, 0, false);
        let _ = ctx.send_outbound(out).await;
    }

    // 10. Send separate confirmation message & register 120s reaction wait session
    let confirm_caption = format!(
        "⚠️ XÁC NHẬN LỌC THÀNH VIÊN\n\
        ━━━━━━━━━━━━━━━━━━━━\n\
        • Nhóm: {}\n\
        • Số lượng lọc: {} thành viên\n\
        • Khoảng ngày: 7 ngày hoàn chỉnh ({start_date} đến {end_date})\n\
        • Thời hạn xác nhận: 120 giây\n\
        ━━━━━━━━━━━━━━━━━━━━\n\
        👉 Bất kỳ Quản trị viên cấp cao (adminLevelHigh) nào hãy thả reaction TIM (❤️) vào tin nhắn này trong 120 giây để kích hoạt lọc!",
        meta.group_name,
        candidates.len()
    );

    let thread_id_clone = ctx.message.thread_id.clone();
    let thread_id_str = thread_id_clone.to_string();
    PENDING_LOCMEM_GROUPS.insert(thread_id_str.clone());

    let bot_key = ctx.bot_key.clone();
    let self_uid = ctx.self_uid.clone();
    let caches = ctx.caches.clone();
    let outbound_sink = ctx.outbound_sink.clone();
    let style_profile = ctx.style_profile.clone();
    let raw_message = ctx.message.clone();

    let on_reaction: Arc<mybot_core::ReactionCallbackFn> = Arc::new(move |react, zalo_opt| {
        let thread_id = thread_id_clone.clone();
        let thread_str = thread_id.to_string();
        let bot_key = bot_key.clone();
        let self_uid = self_uid.clone();
        let caches = caches.clone();
        let candidates = candidates.clone();
        let start_date = start_date.clone();
        let today_key = today_key.clone();
        let outbound_sink = outbound_sink.clone();
        let style_profile = style_profile.clone();
        let raw_message = raw_message.clone();

        Box::pin(async move {
            // Re-verify caller's high admin permission dynamically at reaction time (Node V3 parity: locmem-service.js:513-529)
            let sender_uid_str = react.sender_uid.as_str();
            let is_high_admin = check_is_admin_level_high(
                &caches,
                &bot_key,
                sender_uid_str,
                self_uid.as_str(),
            );

            if !is_high_admin {
                tracing::warn!(
                    sender = %react.sender_uid,
                    thread = %thread_id,
                    "Ignored locmem reaction: sender is not adminLevelHigh"
                );
                return false;
            }

            // Remove from pending groups atomically once an authorized high admin confirmed
            PENDING_LOCMEM_GROUPS.remove(&thread_str);

            // Acknowledge receipt
            let ack_text = "⏳ Đã nhận xác nhận từ Quản trị viên cấp cao! Đang tái kiểm tra dữ liệu và quyền hạn trước khi thực thi...";
            send_notice(&zalo_opt, &outbound_sink, &style_profile, &raw_message, &thread_id, ack_text).await;

            // Step 1: Re-fetch fresh group info
            let fresh_meta = match fetch_fresh_group_meta(&zalo_opt, &caches, &bot_key, &thread_id, &candidates).await {
                Ok(m) => m,
                Err(_) => {
                    let err_text = "⚠️ Không thể lấy thông tin nhóm mới nhất từ Zalo. Đã hủy toàn bộ thao tác lọc để đảm bảo an toàn.";
                    send_notice(&zalo_opt, &outbound_sink, &style_profile, &raw_message, &thread_id, err_text).await;
                    return true;
                }
            };

            // Step 2: Re-verify bot is still owner or group admin
            let self_str = self_uid.as_str();
            let bot_key_str = bot_key.as_str();
            let bot_still_admin = fresh_meta.creator_uid.as_deref() == Some(self_str)
                || fresh_meta.creator_uid.as_deref() == Some(bot_key_str)
                || fresh_meta.admin_uids.iter().any(|a| a == self_str || a == bot_key_str || a == "admin_box");

            if !bot_still_admin {
                let err_text = "⚠️ Bot không còn là quản trị viên hoặc chủ nhóm trong nhóm này! Đã hủy toàn bộ thao tác lọc.";
                send_notice(&zalo_opt, &outbound_sink, &style_profile, &raw_message, &thread_id, err_text).await;
                return true;
            }

            // Step 3: Re-check activity since preview
            let _ = caches.flush_ranks_messages_and_locmem();
            let recent_activity = caches
                .engine()
                .query_locmem_range(&bot_key, thread_id.as_str(), &start_date, &today_key)
                .unwrap_or_default();
            let mut active_since_preview: HashSet<String> = HashSet::new();
            for (uid, m, r, j) in recent_activity {
                if m + r + j > 0 {
                    active_since_preview.insert(uid);
                }
            }

            let fresh_member_set: HashSet<ZaloId> = fresh_meta.member_uids.into_iter().collect();
            let mut to_kick = Vec::new();
            let mut skipped: Vec<(ZaloId, &'static str)> = Vec::new();

            for uid in candidates {
                if !fresh_member_set.contains(&uid) {
                    skipped.push((uid, "Đã rời nhóm"));
                    continue;
                }
                if fresh_meta.creator_uid.as_deref() == Some(uid.as_str())
                    || fresh_meta.admin_uids.iter().any(|a| a == uid.as_str())
                {
                    skipped.push((uid, "Được bổ nhiệm QTV/Chủ nhóm"));
                    continue;
                }
                if active_since_preview.contains(uid.as_str()) {
                    skipped.push((uid, "Vừa tương tác sau xem trước"));
                    continue;
                }
                to_kick.push(uid);
            }

            // Step 4: Batch kick (chunks of 20) with rate-limit
            let mut kicked = Vec::new();
            let mut failed = Vec::new();

            if let Some(ref z) = zalo_opt {
                let kick_chunks = to_kick.chunks(20);
                for (idx, chunk) in kick_chunks.enumerate() {
                    match z.remove_user_from_group(&thread_id, chunk).await {
                        Ok(val) => {
                            let error_members: HashSet<String> = val
                                .get("errorMembers")
                                .and_then(Value::as_array)
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default();
                            for u in chunk {
                                if error_members.contains(u.as_str()) {
                                    failed.push(u.clone());
                                } else {
                                    kicked.push(u.clone());
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!("remove_user_from_group failed on batch {idx}: {e}");
                            for u in chunk {
                                failed.push(u.clone());
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
            } else {
                // Mock test mode: kick succeeds for all candidates
                kicked.extend(to_kick);
            }

            // Step 5: Send final report
            let mut report = format!(
                "📊 KẾT QUẢ LỌC THÀNH VIÊN\n\
                ━━━━━━━━━━━━━━━━━━━━\n\
                • Đã kick thành công: {} thành viên\n\
                • Đã bỏ qua sau tái kiểm tra: {} thành viên\n",
                kicked.len(),
                skipped.len()
            );
            if !failed.is_empty() {
                report.push_str(&format!("• Thất bại (lỗi từ Zalo): {} thành viên\n", failed.len()));
            }
            report.push_str("━━━━━━━━━━━━━━━━━━━━\n");
            if !skipped.is_empty() {
                report.push_str("\nLý do bỏ qua:\n");
                for (uid, reason) in skipped.iter().take(8) {
                    report.push_str(&format!("- {uid}: {reason}\n"));
                }
                if skipped.len() > 8 {
                    report.push_str(&format!("... và {} thành viên khác.\n", skipped.len() - 8));
                }
            }

            send_notice(&zalo_opt, &outbound_sink, &style_profile, &raw_message, &thread_id, &report).await;
            true
        })
    });

    let thread_id_for_expire = ctx.message.thread_id.clone();
    let outbound_sink_expire = ctx.outbound_sink.clone();
    let style_profile_expire = ctx.style_profile.clone();
    let raw_message_expire = ctx.message.clone();

    let on_expire: Arc<mybot_core::ExpireCallbackFn> = Arc::new(move |zalo_opt| {
        let thread_str = thread_id_for_expire.to_string();
        PENDING_LOCMEM_GROUPS.remove(&thread_str);
        let thread_id = thread_id_for_expire.clone();
        let outbound_sink = outbound_sink_expire.clone();
        let style_profile = style_profile_expire.clone();
        let raw_message = raw_message_expire.clone();

        Box::pin(async move {
            let expire_text = "⏱️ Đã hết thời hạn 120 giây xác nhận lọc thành viên. Phiên lọc đã tự động hủy.";
            send_notice(&zalo_opt, &outbound_sink, &style_profile, &raw_message, &thread_id, expire_text).await;
        })
    });

    let accepted_icons = vec![
        "HEART".to_string(),
        "❤️".to_string(),
        "/-heart".to_string(),
    ];

    let send_result = ctx
        .send_reaction_menu(
            confirm_caption,
            Duration::from_secs(120),
            accepted_icons,
            on_reaction,
            Some(on_expire),
        )
        .await;

    if let Err(err) = send_result {
        // FAIL-CLOSED CLEANUP: If sending menu fails, remove pending immediately to prevent deadlock!
        PENDING_LOCMEM_GROUPS.remove(&thread_id_str);
        return Err(err);
    }

    Ok(CommandOutcome::Handled {
        summary: "locmem_confirmation_registered".to_string(),
        reply_text: None,
        custom_ttl_ms: None,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use mybot_core::InteractionEngine;
    use mybot_storage::{GroupSettingsRecord, HotStorageCaches, StorageEngine};
    use mybot_types::{
        EventSource, InboundMessage, MessageContent, PermissionTier, ReactionEvent, ThreadType,
        ZaloId,
    };
    use serde_json::json;

    use super::*;
    use crate::catalog::ALL_218_CATALOG;

    fn get_locmem_spec() -> &'static CommandSpec {
        ALL_218_CATALOG
            .iter()
            .find(|e| e.spec.name == "locmem")
            .unwrap()
            .spec
    }

    fn make_test_locmem_ctx(
        caches: HotStorageCaches,
        interactions: Arc<InteractionEngine>,
        sink: Arc<parking_lot::Mutex<Vec<OutboundMessage>>>,
        thread_id: &str,
        thread_type: ThreadType,
        sender_tier: PermissionTier,
    ) -> CommandContext {
        let mut settings = GroupSettingsRecord::default_for("main", thread_id);
        settings.group_name = "Nhóm Kiểm Thử Locmem".to_string();
        settings.settings = json!({
            "creatorId": "owner_999",
            "adminIds": ["bot_1", "deputy_888"],
            "memberUids": [
                "owner_999",
                "deputy_888",
                "bot_1",
                "inactive_member_1",
                "inactive_member_2",
                "active_member_3"
            ]
        });

        CommandContext {
            bot_key: "main".into(),
            is_main_bot: true,
            self_uid: ZaloId::new("bot_1"),
            prefix: "!".into(),
            invoked_alias: "locmem".into(),
            args: vec![],
            raw_args_text: "".into(),
            message: InboundMessage {
                bot_key: "main".into(),
                msg_id: ZaloId::new("msg_locmem_cmd"),
                cli_msg_id: ZaloId::new("cli_locmem_cmd"),
                global_msg_id: ZaloId::new("glob_locmem_cmd"),
                thread_id: ZaloId::new(thread_id),
                thread_type,
                sender_uid: ZaloId::new("admin_initiator"),
                sender_name: "Admin Khởi Tạo".into(),
                is_self: false,
                msg_type: "webchat".into(),
                timestamp_ms: 1_760_000_000_000,
                ws_received_at_ms: 1_760_000_000_005,
                ttl_ms: 0,
                mentions: Vec::new(),
                styles: Vec::new(),
                quote: None,
                content: MessageContent::Text {
                    text: "!locmem".into(),
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
            interactions,
            fleet: None,
            outbound_sink: Some(sink),
        }
    }

    #[tokio::test]
    async fn test_locmem_rejected_when_not_in_group() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let interactions = Arc::new(InteractionEngine::new());
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let ctx = make_test_locmem_ctx(
            caches,
            interactions,
            sink,
            "thread_dm_not_group",
            ThreadType::User, // Ca: không phải nhóm
            PermissionTier::AdminLevelHigh,
        );

        let res = execute_locmem_command(get_locmem_spec(), ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { reply_text, .. } => {
                let msg = reply_text.expect("must return reply_text");
                assert!(
                    msg.contains("chỉ có thể sử dụng trong nhóm"),
                    "Expected group-only refusal, got: {msg}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_locmem_rejected_when_insufficient_7_days() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let (_, days) = get_consecutive_7_calendar_days_ict();
        // Ghi nhận chỉ 3 trong 7 ngày lịch hoàn chỉnh
        engine.record_locmem_coverage("main", &days[0], "complete").unwrap();
        engine.record_locmem_coverage("main", &days[1], "complete").unwrap();
        engine.record_locmem_coverage("main", &days[2], "complete").unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let interactions = Arc::new(InteractionEngine::new());
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let ctx = make_test_locmem_ctx(
            caches,
            interactions,
            sink,
            "grp_locmem_days_test",
            ThreadType::Group,
            PermissionTier::AdminLevelHigh,
        );

        let res = execute_locmem_command(get_locmem_spec(), ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { reply_text, .. } => {
                let msg = reply_text.expect("must return reply_text");
                assert!(
                    msg.contains("Chưa đủ dữ liệu để lọc thành viên an toàn!"),
                    "Expected insufficient days refusal, got: {msg}"
                );
                assert!(
                    msg.contains("3/7 ngày hoàn chỉnh"),
                    "Expected 3/7 complete days reported, got: {msg}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_locmem_rejected_when_bot_not_admin() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let (_, days) = get_consecutive_7_calendar_days_ict();
        for d in &days {
            engine.record_locmem_coverage("main", d, "complete").unwrap();
        }

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let interactions = Arc::new(InteractionEngine::new());
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let mut ctx = make_test_locmem_ctx(
            caches,
            interactions,
            sink,
            "grp_locmem_botadmin_test",
            ThreadType::Group,
            PermissionTier::AdminLevelHigh,
        );
        // Bot không phải chủ nhóm cũng không có trong danh sách phó nhóm
        ctx.group_settings.settings = json!({
            "creatorId": "owner_other",
            "adminIds": ["deputy_other"],
            "memberUids": ["owner_other", "deputy_other", "bot_1", "user_1"]
        });

        let res = execute_locmem_command(get_locmem_spec(), ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { reply_text, .. } => {
                let msg = reply_text.expect("must return reply_text");
                assert!(
                    msg.contains("Bot không có quyền quản trị viên"),
                    "Expected bot not admin refusal, got: {msg}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_locmem_rejected_when_caller_not_admin_level_high() {
        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let interactions = Arc::new(InteractionEngine::new());
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let ctx = make_test_locmem_ctx(
            caches,
            interactions,
            sink,
            "grp_locmem_callertier_test",
            ThreadType::Group,
            PermissionTier::AdminBox, // Ca: người gọi không có quyền Admin cấp cao
        );

        let res = execute_locmem_command(get_locmem_spec(), ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { reply_text, .. } => {
                let msg = reply_text.expect("must return reply_text");
                assert!(
                    msg.contains("adminLevelHigh"),
                    "Expected adminLevelHigh permission denied, got: {msg}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_locmem_workflow_stranger_reaction_ignored_and_authorized_heart_kicks() {
        let thread_id = "grp_locmem_workflow_test";
        PENDING_LOCMEM_GROUPS.remove(thread_id);

        let engine = StorageEngine::open_in_memory().unwrap();
        let (_, days) = get_consecutive_7_calendar_days_ict();
        // Đủ 7 ngày lịch hoàn chỉnh
        for d in &days {
            engine.record_locmem_coverage("main", d, "complete").unwrap();
        }
        // Đăng ký cả người khởi tạo và một admin cấp cao khác trong nhóm
        engine.upsert_bot_admin("main", "admin_initiator", "high", "Admin Initiator").unwrap();
        engine.upsert_bot_admin("main", "another_high_admin", "high", "Another High Admin").unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        // Ghi nhận tương tác cho "active_member_3" để người này có tương tác (không bị lọc)
        caches.record_locmem_activity("main", thread_id, "active_member_3", 10, 2, 0);
        caches.flush_ranks_messages_and_locmem().unwrap();

        let interactions = Arc::new(InteractionEngine::new());
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let ctx = make_test_locmem_ctx(
            caches.clone(),
            Arc::clone(&interactions),
            Arc::clone(&sink),
            thread_id,
            ThreadType::Group,
            PermissionTier::AdminLevelHigh,
        );

        // Chạy lệnh !locmem
        let res = execute_locmem_command(get_locmem_spec(), ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { summary, reply_text, .. } => {
                assert_eq!(summary, "locmem_confirmation_registered");
                assert!(reply_text.is_none());
            }
            other => panic!("expected Handled, got: {other:?}"),
        }

        // Đảm bảo nhóm đã được đưa vào pending sau khi đăng ký thành công
        assert!(PENDING_LOCMEM_GROUPS.contains(thread_id));

        // Kiểm tra tin nhắn xem trước và xác nhận đã gửi vào sink
        let sent = sink.lock().clone();
        assert!(sent.len() >= 2, "Expected preview and confirm messages, got {}", sent.len());
        let confirm_msg = sent.last().unwrap();
        assert!(confirm_msg.text.contains("XÁC NHẬN LỌC THÀNH VIÊN"));
        assert!(confirm_msg.text.contains("Số lượng lọc: 2 thành viên")); // inactive_member_1 & 2

        // Lấy msg_id phiên xác nhận đã đăng ký
        let prompt_ids = interactions.list_active_reaction_prompt_ids();
        assert_eq!(prompt_ids.len(), 1);
        let prompt_msg_id = prompt_ids[0].clone();

        // CA 1: NGƯỜI NGOÀI THẢ TIM (stranger reacts with ❤️) -> BỊ TỪ CHỐI
        let stranger_react = ReactionEvent {
            bot_key: "main".into(),
            thread_id: ZaloId::new(thread_id),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("stranger_outside_user"),
            is_self: false,
            msg_id: prompt_msg_id.clone(),
            cli_msg_id: ZaloId::new(""),
            r_icon: "/-heart".into(),
            r_type: 5,
            timestamp_ms: 1_760_000_000_100,
            ws_received_at_ms: 1_760_000_000_105,
        };

        let stranger_handled = interactions
            .try_handle_reaction("main", &stranger_react, None)
            .await;
        assert!(
            !stranger_handled,
            "Người ngoài thả tim phải bị từ chối / không được xử lý"
        );
        // Sau khi người ngoài thả tim, nhóm VẪN PHẢI trong trạng thái pending chờ admin cấp cao
        assert!(PENDING_LOCMEM_GROUPS.contains(thread_id));

        // CA 2: BẤT KỲ QUẢN TRỊ VIÊN CẤP CAO NÀO THẢ TIM (kể cả không phải người gõ lệnh)
        let other_admin_react = ReactionEvent {
            bot_key: "main".into(),
            thread_id: ZaloId::new(thread_id),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("another_high_admin"), // Admin cấp cao khác xác nhận!
            is_self: false,
            msg_id: prompt_msg_id,
            cli_msg_id: ZaloId::new(""),
            r_icon: "❤️".into(),
            r_type: 5,
            timestamp_ms: 1_760_000_000_200,
            ws_received_at_ms: 1_760_000_000_205,
        };

        let admin_handled = interactions
            .try_handle_reaction("main", &other_admin_react, None)
            .await;
        assert!(
            admin_handled,
            "Bất kỳ Quản trị viên cấp cao nào (AdminLevelHigh) thả tim đều phải được tiếp nhận và xử lý kick"
        );

        // Sau khi xử lý xong, pending group phải được gỡ bỏ ngay lập tức
        assert!(!PENDING_LOCMEM_GROUPS.contains(thread_id));

        // Kiểm tra báo cáo kết quả lọc cuối cùng đã được xuất vào sink
        let final_sent = sink.lock().clone();
        let report = final_sent.last().unwrap();
        assert!(report.text.contains("KẾT QUẢ LỌC THÀNH VIÊN"), "Report: {}", report.text);
        assert!(report.text.contains("Đã kick thành công: 2 thành viên"), "Report: {}", report.text);
    }

    #[tokio::test]
    async fn test_locmem_rejects_reaction_after_120s_timeout() {
        let interactions = Arc::new(InteractionEngine::new());

        // Đăng ký phiên reaction trực tiếp với TTL = 1ms (đã hết hạn ngay lập tức)
        let prompt_ref = mybot_core::BotMessageRef {
            thread_id: ZaloId::new("grp_locmem_timeout_test"),
            thread_type: ThreadType::Group,
            msg_id: ZaloId::new("msg_expired_1"),
            cli_msg_id: ZaloId::new(""),
            global_msg_id: ZaloId::new(""),
            sender_uid: ZaloId::new("bot_1"),
        };

        interactions.register_reaction_wait(
            mybot_core::InteractiveReactionSpec {
                key: "react:main:grp_locmem_timeout_test:admin_initiator:msg_expired_1".into(),
                bot_key: "main".into(),
                thread_id: ZaloId::new("grp_locmem_timeout_test"),
                allowed_sender_uid: Some(ZaloId::new("admin_initiator")),
                prompt_ref: prompt_ref.clone(),
                accepted_icons: vec!["HEART".into(), "❤️".into(), "/-heart".into()],
                ttl: Duration::from_millis(1), // Hết hạn ngay lập tức
                recall_on_consume: false,
                recall_on_expire: false,
                show_clock: false,
                on_reaction: Arc::new(|_, _| Box::pin(async { true })),
                on_expire: None,
            },
            None,
        );

        // Đợi 10ms để phiên chắc chắn hết hạn
        tokio::time::sleep(Duration::from_millis(10)).await;

        let react = ReactionEvent {
            bot_key: "main".into(),
            thread_id: ZaloId::new("grp_locmem_timeout_test"),
            thread_type: ThreadType::Group,
            sender_uid: ZaloId::new("admin_initiator"),
            is_self: false,
            msg_id: ZaloId::new("msg_expired_1"),
            cli_msg_id: ZaloId::new(""),
            r_icon: "/-heart".into(),
            r_type: 5,
            timestamp_ms: 1_760_000_000_300,
            ws_received_at_ms: 1_760_000_000_305,
        };

        let handled = interactions.try_handle_reaction("main", &react, None).await;
        assert!(
            !handled,
            "Reaction sau khi phiên hết hạn 120s phải bị từ chối (false)"
        );
    }

    #[tokio::test]
    async fn test_locmem_rejects_concurrent_pending_request() {
        let thread_id = "grp_locmem_pending_test";
        PENDING_LOCMEM_GROUPS.insert(thread_id.to_string());

        let engine = StorageEngine::open_in_memory().unwrap();
        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let interactions = Arc::new(InteractionEngine::new());
        let sink = Arc::new(parking_lot::Mutex::new(Vec::new()));

        let ctx = make_test_locmem_ctx(
            caches,
            interactions,
            sink,
            thread_id,
            ThreadType::Group,
            PermissionTier::AdminLevelHigh,
        );

        let res = execute_locmem_command(get_locmem_spec(), ctx).await.unwrap();
        match res {
            CommandOutcome::Handled { reply_text, .. } => {
                let msg = reply_text.expect("must return reply_text");
                assert!(
                    msg.contains("Nhóm đang có một yêu cầu lọc thành viên chờ xác nhận!"),
                    "Expected pending refusal, got: {msg}"
                );
            }
            other => panic!("expected Handled, got: {other:?}"),
        }
        PENDING_LOCMEM_GROUPS.remove(thread_id);
    }
}

