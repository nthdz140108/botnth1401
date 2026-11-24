//! SaaS `mybot` Fleet Manager, Help/Catalog, Learned Q&A, VietQR, QR Tools, Lunar Calendar,
//! 24-Slot `SendTask` Scheduler, Custom Commands (`cmdadd`), Telemetry & Fun Utilities (57 Commands).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::LazyLock;

use chrono::{Datelike, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use dashmap::DashMap;
use mybot_core::v3_style::{BotStyleConfig, BotStyleProfile, build_state_quote, normalize_color};
use mybot_core::{CommandContext, CommandError, CommandOutcome, CommandSpec};
use mybot_gfx::CardKind;
use mybot_media::CaptchaAndQrEngine;
use mybot_services::{MediaCrawlerHub, solar_to_vietnamese_lunar};
use mybot_storage::BotRecord;
use mybot_types::{BotStatusV2, DEFAULT_ZALO_USER_AGENT, EventSource, ExpiryPolicy, MessageContent, ThreadType, ZaloId};
use serde_json::{Value, json};
use sysinfo::System;
use tokio_util::sync::CancellationToken;
use zalo_sdk::qr_login::{authenticate_zalo_qr, QrLoginOptions, QrLoginPhase};

use crate::catalog::ALL_218_CATALOG;
use crate::{CommandRuntimeBundle, send_local_bytes_reply, send_text_reply};

static CHAT_QR_CANCELS: LazyLock<DashMap<String, CancellationToken>> = LazyLock::new(DashMap::new);

fn parse_periodic_duration(s: &str) -> Option<std::time::Duration> {
    let s = s.trim().to_lowercase();
    if let Some(num_str) = s.strip_suffix("s") {
        num_str.parse::<u64>().ok().map(std::time::Duration::from_secs)
    } else if let Some(num_str) = s.strip_suffix("min") {
        num_str.parse::<u64>().ok().map(|m| std::time::Duration::from_secs(m * 60))
    } else if let Some(num_str) = s.strip_suffix("m").or_else(|| s.strip_suffix("p")) {
        num_str.parse::<u64>().ok().map(|m| std::time::Duration::from_secs(m * 60))
    } else if let Some(num_str) = s.strip_suffix("h") {
        num_str.parse::<u64>().ok().map(|h| std::time::Duration::from_secs(h * 3600))
    } else if let Some(num_str) = s.strip_suffix("d") {
        num_str.parse::<u64>().ok().map(|d| std::time::Duration::from_secs(d * 86400))
    } else {
        s.parse::<u64>().ok().map(std::time::Duration::from_secs)
    }
}

fn deterministic_percent(seed: &str, salt: &str) -> u32 {
    let mut h = DefaultHasher::new();
    seed.hash(&mut h);
    salt.hash(&mut h);
    (h.finish() % 101) as u32
}

fn pick_random_accounts(mut accounts: Vec<(String, String)>, count: usize) -> Vec<(String, String)> {
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();
    accounts.shuffle(&mut rng);
    accounts.into_iter().take(count).collect()
}

fn urlencoding_simple(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn resolve_target_bot<'a>(
    selector: &str,
    bots: &'a [BotRecord],
) -> Option<&'a BotRecord> {
    if let Ok(idx) = selector.parse::<usize>() {
        if idx >= 1 && idx <= bots.len() {
            return Some(&bots[idx - 1]);
        }
    }
    bots.iter().find(|b| {
        b.bot_key.eq_ignore_ascii_case(selector)
            || b.uid.as_str() == selector
            || b.display_name.eq_ignore_ascii_case(selector)
    })
}

fn parse_duration_ms(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed == "-1" {
        return Some(-1);
    }
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let num_part: String = lower.chars().take_while(|c| c.is_ascii_digit()).collect();
    let unit_part: String = lower.chars().skip_while(|c| c.is_ascii_digit()).collect();
    if num_part.is_empty() {
        return None;
    }
    let val: i64 = num_part.parse().ok()?;
    let mult: i64 = match unit_part.as_str() {
        "s" => 1000,
        "m" | "min" => 60 * 1000,
        "h" => 3600 * 1000,
        "d" | "" => 86400 * 1000,
        "w" => 7 * 86400 * 1000,
        "mon" => 30 * 86400 * 1000,
        "y" => 365 * 86400 * 1000,
        _ => return None,
    };
    Some(val * mult)
}

fn is_valid_custom_command_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return false;
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_alphabetic() {
        return false;
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

fn resolve_media_url_and_kind(
    ctx: &CommandContext,
) -> Option<(String, &'static str, &'static str, &'static str, bool)> {
    // 1. Direct message content
    match &ctx.message.content {
        MessageContent::Photo { url, .. } if url.starts_with("http") => {
            return Some((url.clone(), "image", "jpg", "image/jpeg", false));
        }
        MessageContent::Video { url, .. } if url.starts_with("http") => {
            return Some((url.clone(), "video", "mp4", "video/mp4", false));
        }
        MessageContent::Voice { url, .. } if url.starts_with("http") => {
            return Some((url.clone(), "audio", "mp3", "audio/mpeg", true));
        }
        MessageContent::Gif { url, .. } if url.starts_with("http") => {
            return Some((url.clone(), "image", "gif", "image/gif", false));
        }
        _ => {}
    }

    // 2. Quoted message
    if let Some(ref q) = ctx.message.quote {
        if let Some(ref att) = q.attach {
            let is_video = q.cli_msg_type == 5 || att.get("videoUrl").is_some();
            let is_audio = q.cli_msg_type == 3 || att.get("voiceUrl").is_some();
            let (kind, ext, mime, wants_audio) = if is_video {
                ("video", "mp4", "video/mp4", false)
            } else if is_audio {
                ("audio", "mp3", "audio/mpeg", true)
            } else {
                ("image", "jpg", "image/jpeg", false)
            };

            for key in &[
                "hdUrl", "normalUrl", "href", "videoUrl", "voiceUrl", "url", "thumbUrl", "fileUrl",
                "oriUrl",
            ] {
                if let Some(val) = att.get(*key).and_then(Value::as_str) {
                    let trimmed = val.trim();
                    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                        return Some((trimmed.to_string(), kind, ext, mime, wants_audio));
                    }
                }
            }
        }
        for token in q.msg.split_whitespace() {
            if token.starts_with("http://") || token.starts_with("https://") {
                let lower = token.to_ascii_lowercase();
                let (kind, ext, mime, wants_audio) = if lower.ends_with(".mp4")
                    || lower.ends_with(".mov")
                    || lower.ends_with(".webm")
                {
                    ("video", "mp4", "video/mp4", false)
                } else if lower.ends_with(".mp3")
                    || lower.ends_with(".m4a")
                    || lower.ends_with(".wav")
                    || lower.ends_with(".ogg")
                {
                    ("audio", "mp3", "audio/mpeg", true)
                } else if lower.ends_with(".gif") {
                    ("image", "gif", "image/gif", false)
                } else {
                    ("image", "jpg", "image/jpeg", false)
                };
                return Some((token.to_string(), kind, ext, mime, wants_audio));
            }
        }
    }

    // 3. Raw args tokens
    for token in ctx.raw_args_text.split_whitespace() {
        if token.starts_with("http://") || token.starts_with("https://") {
            let lower = token.to_ascii_lowercase();
            let (kind, ext, mime, wants_audio) = if lower.ends_with(".mp4")
                || lower.ends_with(".mov")
                || lower.ends_with(".webm")
            {
                ("video", "mp4", "video/mp4", false)
            } else if lower.ends_with(".mp3")
                || lower.ends_with(".m4a")
                || lower.ends_with(".wav")
                || lower.ends_with(".ogg")
            {
                ("audio", "mp3", "audio/mpeg", true)
            } else if lower.ends_with(".gif") {
                ("image", "gif", "image/gif", false)
            } else {
                ("image", "jpg", "image/jpeg", false)
            };
            return Some((token.to_string(), kind, ext, mime, wants_audio));
        }
    }

    None
}

fn get_or_create_bot_record(
    ctx: &CommandContext,
    target_key: &str,
) -> Result<BotRecord, CommandError> {
    if let Some(bot) = ctx.caches.engine().get_bot(target_key)? {
        return Ok(bot);
    }
    let is_main = target_key == "admin" || (target_key == ctx.bot_key && ctx.is_main_bot);
    Ok(BotRecord {
        bot_key: target_key.to_string(),
        uid: if target_key == ctx.bot_key {
            ctx.self_uid.clone()
        } else {
            ZaloId::new(target_key)
        },
        global_uid: None,
        canonical_username: None,
        display_name: if target_key == ctx.bot_key {
            ctx.style_profile.name_server.clone()
        } else {
            target_key.to_string()
        },
        avatar: String::new(),
        is_main,
        owner_uid: None,
        status: "running".into(),
        desired_status: "running".into(),
        expiry_policy: ExpiryPolicy::Permanent,
        trial_status: None,
        cookie_json: json!({}),
        imei: String::new(),
        user_agent: String::new(),
        proxy_url: None,
        cookie_dead: false,
        cookie_dead_reason: None,
        prefix: ctx.prefix.clone(),
        self_listen: false,
        identity_pending: false,
        admin_identity_seeds: Vec::new(),
        metadata: json!({
            "nameServer": ctx.style_profile.name_server,
            "style": ctx.style_profile.style,
        }),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
    })
}

pub async fn execute_saas_utility_command(
    spec: &'static CommandSpec,
    ctx: CommandContext,
    rt: &CommandRuntimeBundle,
) -> Result<CommandOutcome, CommandError> {
    let query = ctx.raw_args_text.trim();

    match spec.name {
        "mybot" => {
            let sub = ctx
                .args
                .first()
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_else(|| "help".into());
            let bots = ctx.caches.engine().list_bots()?;
            let p = &ctx.prefix;

            match sub.as_str() {
                "list" => {
                    let rows: Vec<Value> = bots
                        .iter()
                        .enumerate()
                        .map(|(i, b)| {
                            json!({
                                "index": i + 1,
                                "name": b.display_name,
                                "botKey": b.bot_key,
                                "uid": b.uid.as_str(),
                                "status": b.status,
                                "expiry": b.expiry_policy.to_v3_string(),
                            })
                        })
                        .collect();

                    if let Ok(png) = rt.gfx.render(CardKind::ListBots, &json!({ "bots": rows }), None) {
                        return send_local_bytes_reply(
                            &ctx,
                            rt,
                            "listbots",
                            "png",
                            &png,
                            &format!("📋 Danh sách tất cả bot trong hệ thống ({} bot):", bots.len()),
                        )
                        .await;
                    }

                    let mut out = format!("📋 Danh sách tất cả bot trong hệ thống ({} bot):\n", bots.len());
                    for (i, b) in bots.iter().enumerate() {
                        out.push_str(&format!(
                            "{}. {} ({}) - Trạng thái: {} - Hạn: {}\n",
                            i + 1,
                            b.display_name,
                            b.bot_key,
                            b.status,
                            b.expiry_policy.to_v3_string()
                        ));
                    }
                    send_text_reply(&ctx, &out).await
                }
                "detail" => {
                    let selector = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    let found = if let Ok(idx) = selector.parse::<usize>() {
                        bots.get(idx.saturating_sub(1))
                    } else {
                        bots.iter().find(|b| b.bot_key == selector || b.uid.as_str() == selector)
                    };

                    let Some(target) = found else {
                        return send_text_reply(
                            &ctx,
                            &format!("⚠️ Không tìm thấy bot \"{selector}\". Dùng {p}mybot list để xem danh sách."),
                        )
                        .await;
                    };

                    if let Ok(png) = rt.gfx.render(
                        CardKind::BotDetail,
                        &json!({
                            "name": target.display_name,
                            "botKey": target.bot_key,
                            "uid": target.uid.as_str(),
                            "status": target.status,
                            "expiry": target.expiry_policy.to_v3_string(),
                            "ownerUid": target.owner_uid.as_deref().unwrap_or("Admin"),
                        }),
                        None,
                    ) {
                        return send_local_bytes_reply(
                            &ctx,
                            rt,
                            "botdetail",
                            "png",
                            &png,
                            &format!("🤖 Thông tin chi tiết bot: {}", target.display_name),
                        )
                        .await;
                    }

                    let reply = format!(
                        "🤖 Thông tin chi tiết bot: {}\n• Mã bot: {}\n• UID: {}\n• Trạng thái: {}\n• Hạn dùng: {}\n• Chủ sở hữu: {}",
                        target.display_name,
                        target.bot_key,
                        target.uid,
                        target.status,
                        target.expiry_policy.to_v3_string(),
                        target.owner_uid.as_deref().unwrap_or("Admin")
                    );
                    send_text_reply(&ctx, &reply).await
                }
                "active" | "trial" => {
                    let sender = ctx.message.sender_uid.as_str();
                    let owned_target = bots.iter().find(|b| {
                        b.owner_uid.as_deref() == Some(sender) || b.uid.as_str() == sender
                    });
                    if let Some(target) = owned_target {
                        if target.status == "running" {
                            return send_text_reply(
                                &ctx,
                                &format!("ℹ️ Bot {} ({}) hiện đang chạy Online rồi!", target.display_name, target.bot_key),
                            ).await;
                        }

                        // Check Bangkok calendar week trial limit (1 per week)
                        let now = Utc::now();
                        let bkk_now = now + chrono::Duration::hours(7);
                        let iso_week = bkk_now.format("%G-W%V").to_string();

                        if let Ok(Some(existing_trial)) = ctx.caches.engine().get_trial_ledger(sender, &iso_week) {
                            if existing_trial.used_seconds >= 3600 || existing_trial.status == "exhausted" {
                                return send_text_reply(
                                    &ctx,
                                    &format!("⚠️ Bạn đã sử dụng hết quyền dùng thử 1 giờ trong tuần này ({}) theo lịch Bangkok. Vui lòng liên hệ Admin để gia hạn thêm!", iso_week),
                                ).await;
                            }
                        }

                        // Real start invocation
                        let start_result = if let Some(ref fleet) = ctx.fleet {
                            fleet.start_bot(&target.bot_key).await
                        } else {
                            Ok(BotStatusV2::Running)
                        };

                        match start_result {
                            Ok(BotStatusV2::Running) => {
                                let trial_end = now + chrono::Duration::hours(1);
                                let mut updated = target.clone();
                                updated.status = "running".into();
                                updated.desired_status = "running".into();
                                updated.trial_status = Some("active".into());
                                updated.expiry_policy = ExpiryPolicy::At(trial_end);
                                updated.updated_at = now.to_rfc3339();
                                ctx.caches.engine().upsert_bot(&updated)?;

                                let ledger_row = mybot_storage::TrialLedgerRow {
                                    owner_uid: sender.to_string(),
                                    iso_week,
                                    used_seconds: 3600,
                                    bot_key: target.bot_key.clone(),
                                    granted_at: now.to_rfc3339(),
                                    expires_at: trial_end.to_rfc3339(),
                                    status: "active".to_string(),
                                };
                                let _ = ctx.caches.engine().upsert_trial_ledger(&ledger_row);

                                send_text_reply(
                                    &ctx,
                                    &format!("🎉 Kích hoạt thành công gói dùng thử 1 giờ cho bot {} ({})!\n• Trạng thái: 🟢 Online\n• Hạn dùng: Đến {}", target.display_name, target.bot_key, trial_end.format("%H:%M:%S %d/%m/%Y")),
                                )
                                .await
                            }
                            Ok(other_status) => {
                                send_text_reply(
                                    &ctx,
                                    &format!("⚠️ Khởi động bot {} kết thúc với trạng thái {:?}. Bot vẫn được giữ ở chế độ chờ kích hoạt và chưa tiêu hao thời hạn dùng thử.", target.display_name, other_status),
                                )
                                .await
                            }
                            Err(e) => {
                                send_text_reply(
                                    &ctx,
                                    &format!("❌ Khởi động bot {} thất bại: {}\n\n⚠️ Trạng thái bot vẫn được giữ ở chế độ chờ kích hoạt và chưa tiêu hao thời hạn dùng thử. Vui lòng kiểm tra lại Cookie/IMEI hoặc thử lại sau.", target.display_name, e),
                                )
                                .await
                            }
                        }
                    } else {
                        send_text_reply(
                            &ctx,
                            &format!("⚠️ Bạn chưa có bot nào để kích hoạt dùng thử. Dùng {p}mybot qrlogin hoặc {p}mybot create <imei> <cookie> để đăng ký bot mới!"),
                        )
                        .await
                    }
                }
                "start" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot start [index|bot_key|all]")).await;
                    }
                    if target_key.eq_ignore_ascii_case("all") {
                        for b in &bots {
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.start_bot(&b.bot_key).await;
                            } else {
                                let mut updated = b.clone();
                                updated.status = "running".into();
                                updated.desired_status = "running".into();
                                updated.updated_at = Utc::now().to_rfc3339();
                                ctx.caches.engine().upsert_bot(&updated)?;
                            }
                        }
                        send_text_reply(&ctx, "✅ Đã gửi lệnh khởi động cho tất cả bot hệ thống.").await
                    } else {
                        let Some(target) = resolve_target_bot(target_key, &bots) else {
                            return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                        };
                        if let Some(ref fleet) = ctx.fleet {
                            let _ = fleet.start_bot(&target.bot_key).await;
                        } else {
                            let mut updated = target.clone();
                            updated.status = "running".into();
                            updated.desired_status = "running".into();
                            updated.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&updated)?;
                        }
                        send_text_reply(&ctx, &format!("✅ Đã khởi động bot {} ({}).", target.display_name, target.bot_key)).await
                    }
                }
                "stop" | "shutdown" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot stop [index|bot_key|all]")).await;
                    }
                    if target_key.eq_ignore_ascii_case("all") {
                        for b in &bots {
                            if !b.is_main && b.bot_key != "admin" {
                                if let Some(ref fleet) = ctx.fleet {
                                    let _ = fleet.stop_bot(&b.bot_key, BotStatusV2::Stopped, Some("admin_command".into())).await;
                                } else {
                                    let mut updated = b.clone();
                                    updated.status = "stopped".into();
                                    updated.desired_status = "stopped".into();
                                    updated.updated_at = Utc::now().to_rfc3339();
                                    ctx.caches.engine().upsert_bot(&updated)?;
                                }
                            }
                        }
                        send_text_reply(&ctx, "🛑 Đã gửi lệnh tạm dừng cho tất cả bot hệ thống.").await
                    } else {
                        let Some(target) = resolve_target_bot(target_key, &bots) else {
                            return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                        };
                        if target.is_main || target.bot_key == "admin" {
                            return send_text_reply(&ctx, "⚠️ Không thể tạm dừng Main Bot qua lệnh này!").await;
                        }
                        if let Some(ref fleet) = ctx.fleet {
                            let _ = fleet.stop_bot(&target.bot_key, BotStatusV2::Stopped, Some("admin_command".into())).await;
                        } else {
                            let mut updated = target.clone();
                            updated.status = "stopped".into();
                            updated.desired_status = "stopped".into();
                            updated.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&updated)?;
                        }
                        send_text_reply(&ctx, &format!("🛑 Đã tạm dừng bot {} ({}).", target.display_name, target.bot_key)).await
                    }
                }
                "restart" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot restart [index|bot_key|all]")).await;
                    }
                    if target_key.eq_ignore_ascii_case("all") {
                        for b in &bots {
                            if !b.is_main && b.bot_key != "admin" {
                                if let Some(ref fleet) = ctx.fleet {
                                    let _ = fleet.restart_bot(&b.bot_key).await;
                                }
                            }
                        }
                        send_text_reply(&ctx, "🔄 Đã gửi lệnh khởi động lại cho tất cả bot hệ thống.").await
                    } else {
                        let Some(target) = resolve_target_bot(target_key, &bots) else {
                            return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                        };
                        if let Some(ref fleet) = ctx.fleet {
                            let _ = fleet.restart_bot(&target.bot_key).await;
                        }
                        send_text_reply(&ctx, &format!("🔄 Đã khởi động lại bot {} ({}).", target.display_name, target.bot_key)).await
                    }
                }
                "delete" | "del" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot delete [index|bot_key]")).await;
                    }
                    let Some(target) = resolve_target_bot(target_key, &bots) else {
                        return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\" để xóa.")).await;
                    };
                    if target.is_main || target.bot_key == "admin" {
                        return send_text_reply(&ctx, "⚠️ Không thể xóa Main Bot khỏi hệ thống!").await;
                    }
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.delete_bot(&target.bot_key).await;
                    }
                    let _ = ctx.caches.engine().delete_bot(&target.bot_key);
                    send_text_reply(&ctx, &format!("🗑️ Đã xóa bot {} ({}) khỏi hệ thống.", target.display_name, target.bot_key)).await
                }
                "extend" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    let duration_str = ctx.args.get(2).map(String::as_str).unwrap_or("30d");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot extend [index|bot_key] [thời_gian|-1]")).await;
                    }
                    let Some(mut bot) = resolve_target_bot(target_key, &bots).cloned() else {
                        return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                    };
                    let dur_ms = parse_duration_ms(duration_str);
                    if dur_ms == Some(-1) {
                        bot.expiry_policy = ExpiryPolicy::Permanent;
                    } else if let Some(ms) = dur_ms {
                        let now = Utc::now();
                        let base_time = match bot.expiry_policy {
                            ExpiryPolicy::At(t) if t > now => t,
                            _ => now,
                        };
                        bot.expiry_policy = ExpiryPolicy::At(base_time + chrono::Duration::milliseconds(ms));
                    } else {
                        return send_text_reply(
                            &ctx,
                            "⚠️ Định dạng thời gian không hợp lệ! Vui lòng dùng: <số><đơn vị> (ví dụ: 30m, 1h, 1d, 30d, 1mon, 1y) hoặc -1 để đặt vĩnh viễn",
                        )
                        .await;
                    }
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.reload_bot(&bot.bot_key).await;
                    }
                    send_text_reply(
                        &ctx,
                        &format!(
                            "✅ Đã gia hạn thành công cho bot {} ({}).\n⏰ Hết hạn mới: {}\n👤 Gia hạn bởi: {}",
                            bot.display_name,
                            duration_str,
                            bot.expiry_policy.to_v3_string(),
                            ctx.message.sender_name
                        ),
                    )
                    .await
                }
                "minus" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    let duration_str = ctx.args.get(2).map(String::as_str).unwrap_or("7d");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot minus [index|bot_key] [thời_gian|-1]")).await;
                    }
                    let Some(mut bot) = resolve_target_bot(target_key, &bots).cloned() else {
                        return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                    };
                    let dur_ms = parse_duration_ms(duration_str);
                    let now = Utc::now();
                    if dur_ms == Some(-1) {
                        bot.expiry_policy = ExpiryPolicy::At(now - chrono::Duration::seconds(1));
                        bot.status = "expired".into();
                        bot.desired_status = "stopped".into();
                        bot.updated_at = now.to_rfc3339();
                        ctx.caches.engine().upsert_bot(&bot)?;
                        if let Some(ref fleet) = ctx.fleet {
                            let _ = fleet.stop_bot(&bot.bot_key, BotStatusV2::Expired, Some("expiry_reduced".into())).await;
                        }
                        send_text_reply(
                            &ctx,
                            &format!(
                                "Bot {} ({}) đã được đặt hết hạn ngay lập tức!\n🆔 Bot ID: {}\n⏰ Trạng thái: Hết hạn\n👤 Thực hiện bởi: {}",
                                bot.display_name, bot.bot_key, bot.bot_key, ctx.message.sender_name
                            ),
                        )
                        .await
                    } else if let Some(ms) = dur_ms {
                        let curr_time = match bot.expiry_policy {
                            ExpiryPolicy::At(t) => t,
                            _ => now,
                        };
                        let new_time = curr_time - chrono::Duration::milliseconds(ms);
                        if new_time <= now {
                            bot.expiry_policy = ExpiryPolicy::At(now - chrono::Duration::seconds(1));
                            bot.status = "expired".into();
                            bot.desired_status = "stopped".into();
                            bot.updated_at = now.to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.stop_bot(&bot.bot_key, BotStatusV2::Expired, Some("expiry_reduced".into())).await;
                            }
                            send_text_reply(
                                &ctx,
                                &format!(
                                    "Bot {} ({}) đã được đặt hết hạn ngay lập tức!\n🆔 Bot ID: {}\n⏰ Trạng thái: Hết hạn\n👤 Thực hiện bởi: {}",
                                    bot.display_name, bot.bot_key, bot.bot_key, ctx.message.sender_name
                                ),
                            )
                            .await
                        } else {
                            bot.expiry_policy = ExpiryPolicy::At(new_time);
                            bot.updated_at = now.to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.reload_bot(&bot.bot_key).await;
                            }
                            send_text_reply(
                                &ctx,
                                &format!(
                                    "✅ Đã rút ngắn thời gian bot thành công!\n🤖 Bot: {}\n🆔 Bot ID: {}\n⏰ Hết hạn mới: {}\n👤 Rút ngắn bởi: {}",
                                    bot.display_name, bot.bot_key, bot.expiry_policy.to_v3_string(), ctx.message.sender_name
                                ),
                            )
                            .await
                        }
                    } else {
                        send_text_reply(
                            &ctx,
                            "⚠️ Định dạng thời gian không hợp lệ! Sử dụng: <số><đơn vị> (ví dụ: 30m, 1h, 1d, 30d, 1mon, 1y) hoặc -1 để hết hạn ngay",
                        )
                        .await
                    }
                }
                "approve" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot approve [index|bot_key]")).await;
                    }
                    let Some(mut bot) = resolve_target_bot(target_key, &bots).cloned() else {
                        return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                    };
                    bot.status = "running".into();
                    bot.desired_status = "running".into();
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.start_bot(&bot.bot_key).await;
                    }
                    send_text_reply(&ctx, &format!("✅ Đã phê duyệt bot {} ({}) hoạt động.", bot.display_name, bot.bot_key)).await
                }
                "reject" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    if target_key.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot reject [index|bot_key] [-1]")).await;
                    }
                    let Some(mut bot) = resolve_target_bot(target_key, &bots).cloned() else {
                        return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\". Dùng {p}mybot list để xem danh sách.")).await;
                    };
                    if bot.is_main || bot.bot_key == "admin" {
                        return send_text_reply(&ctx, "⚠️ Không thể vô hiệu hóa Main Bot!").await;
                    }
                    let is_perm = ctx.args.get(2).map(String::as_str) == Some("-1");
                    bot.status = "disabled".into();
                    bot.desired_status = "disabled".into();
                    if is_perm {
                        bot.expiry_policy = ExpiryPolicy::At(Utc::now() - chrono::Duration::seconds(1));
                    }
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.stop_bot(&bot.bot_key, BotStatusV2::Disabled, Some("admin_reject".into())).await;
                    }
                    let msg = if is_perm {
                        format!("🚫 Bot {} ({}) đã bị vô hiệu hóa vĩnh viễn và đánh dấu hết hạn!", bot.display_name, bot.bot_key)
                    } else {
                        format!("🚫 Bot {} ({}) đã bị vô hiệu hóa thành công!", bot.display_name, bot.bot_key)
                    };
                    send_text_reply(&ctx, &msg).await
                }
                "nameserver" => {
                    let new_name = ctx.args.get(1..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();
                    if new_name.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot nameserver [tên server mới]")).await;
                    }
                    let mut bot = get_or_create_bot_record(&ctx, &ctx.bot_key)?;
                    bot.display_name = new_name.clone();
                    if !bot.metadata.is_object() {
                        bot.metadata = json!({});
                    }
                    bot.metadata["nameServer"] = json!(new_name);
                    if !bot.metadata["profile"].is_object() {
                        bot.metadata["profile"] = json!({});
                    }
                    bot.metadata["profile"]["nameServer"] = json!(new_name);
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.reload_bot(&bot.bot_key).await;
                    }
                    send_text_reply(&ctx, &format!("✅ Đã đổi tên server của bot thành: {new_name}")).await
                }
                "style" => {
                    let sub_action = ctx.args.get(1).map(String::as_str).unwrap_or("show");
                    let mut bot = get_or_create_bot_record(&ctx, &ctx.bot_key)?;
                    let mut prof = BotStyleProfile::from_bot_metadata(&bot.metadata, Some(&bot.display_name));
                    match sub_action {
                        "color" => {
                            let color_raw = ctx.args.get(2).map(String::as_str).unwrap_or("db342e");
                            let hex = normalize_color(color_raw, "db342e");
                            prof.style.color = hex.clone();
                            prof.write_into_metadata(&mut bot.metadata);
                            bot.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.reload_bot(&bot.bot_key).await;
                            }
                            send_text_reply(
                                &ctx,
                                &format!("✅ Đã cập nhật màu tin nhắn cho bot thành #{hex}! Đã đổi màu giao diện bot thành: {hex}"),
                            )
                            .await
                        }
                        "icon" => {
                            let icon = ctx.args.get(2).map(String::as_str).unwrap_or("🤖");
                            prof.style.icon = icon.to_string();
                            prof.write_into_metadata(&mut bot.metadata);
                            bot.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.reload_bot(&bot.bot_key).await;
                            }
                            send_text_reply(&ctx, &format!("✅ Đã cập nhật icon bot thành {icon}!")).await
                        }
                        "size" => {
                            let s_name: u8 = ctx.args.get(2).and_then(|s| s.parse().ok()).unwrap_or(18);
                            let s_text: u8 = ctx.args.get(3).and_then(|s| s.parse().ok()).unwrap_or(s_name);
                            prof.style.size.name_server = s_name.clamp(10, 24);
                            prof.style.size.text = s_text.clamp(10, 24);
                            prof.write_into_metadata(&mut bot.metadata);
                            bot.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.reload_bot(&bot.bot_key).await;
                            }
                            send_text_reply(
                                &ctx,
                                &format!("✅ Đã cập nhật kích thước chữ: Header={}, Text={}!", prof.style.size.name_server, prof.style.size.text),
                            )
                            .await
                        }
                        "type" => {
                            let t_raw = ctx.args.get(2).map(String::as_str).unwrap_or("bold");
                            prof.style.font_type.name_server = vec![t_raw.to_string()];
                            prof.write_into_metadata(&mut bot.metadata);
                            bot.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.reload_bot(&bot.bot_key).await;
                            }
                            send_text_reply(&ctx, &format!("✅ Đã cập nhật kiểu chữ: [{t_raw}]!")).await
                        }
                        "reset" => {
                            prof.style = BotStyleConfig::default();
                            prof.write_into_metadata(&mut bot.metadata);
                            bot.updated_at = Utc::now().to_rfc3339();
                            ctx.caches.engine().upsert_bot(&bot)?;
                            if let Some(ref fleet) = ctx.fleet {
                                let _ = fleet.reload_bot(&bot.bot_key).await;
                            }
                            send_text_reply(
                                &ctx,
                                &format!("✅ Đã đặt lại phong cách hiển thị (Style) của bot {} về mặc định!", bot.bot_key),
                            )
                            .await
                        }
                        _ => {
                            let summary = format!(
                                "🎨 PHONG CÁCH HIỂN THỊ (STYLE) 🎨\n\n\
                                • Bot: {}\n\
                                • Icon: {}\n\
                                • Màu sắc: #{}\n\
                                • Cỡ chữ: Header={}, Text={}\n\
                                • Kiểu chữ: Header=[{}], Text=[{}]\n\n\
                                💡 Dùng: {p}mybot style <size|color|type|icon|reset> để điều chỉnh.",
                                prof.name_server,
                                prof.style.icon,
                                prof.style.color,
                                prof.style.size.name_server,
                                prof.style.size.text,
                                prof.style.font_type.name_server.join(", "),
                                prof.style.font_type.text.join(", ")
                            );
                            send_text_reply(&ctx, &summary).await
                        }
                    }
                }
                "set" => {
                    let key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    let val = ctx.args.get(2..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();
                    if key.is_empty() || val.is_empty() {
                        return send_text_reply(
                            &ctx,
                            &format!(
                                "⚠️ Sai cú pháp!\n\nCách dùng:\n• {p}mybot set name <tên mới>\n• {p}mybot set desc <mô tả mới>\n• {p}mybot set info <thông tin>\n• {p}mybot set platform <zalo|other>"
                            ),
                        )
                        .await;
                    }
                    let mut bot = get_or_create_bot_record(&ctx, &ctx.bot_key)?;
                    if !bot.metadata.is_object() {
                        bot.metadata = json!({});
                    }
                    if !bot.metadata["profile"].is_object() {
                        bot.metadata["profile"] = json!({});
                    }
                    match key.to_ascii_lowercase().as_str() {
                        "name" => {
                            bot.display_name = val.clone();
                            bot.metadata["nameServer"] = json!(val);
                            bot.metadata["profile"]["nameServer"] = json!(val);
                        }
                        "desc" | "description" => {
                            bot.metadata["description"] = json!(val);
                            bot.metadata["profile"]["description"] = json!(val);
                        }
                        "info" => {
                            bot.metadata["info"] = json!(val);
                            bot.metadata["profile"]["info"] = json!(val);
                        }
                        "platform" => {
                            bot.metadata["platform"] = json!(val);
                            bot.metadata["profile"]["platform"] = json!(val);
                        }
                        other => {
                            bot.metadata[other] = json!(val);
                            bot.metadata["profile"][other] = json!(val);
                        }
                    }
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.reload_bot(&bot.bot_key).await;
                    }
                    send_text_reply(
                        &ctx,
                        &format!(
                            "✅ Đã cập nhật {key} cho bot {} thành công!\nGiá trị mới: {val}",
                            bot.bot_key
                        ),
                    )
                    .await
                }
                "clean" => {
                    let now = Utc::now();
                    let expired_bots: Vec<_> = bots
                        .into_iter()
                        .filter(|b| {
                            !b.is_main
                                && b.bot_key != "admin"
                                && (b.status == "expired"
                                    || match b.expiry_policy {
                                        ExpiryPolicy::At(t) => t <= now,
                                        _ => false,
                                    })
                        })
                        .collect();
                    let count = expired_bots.len();
                    for b in expired_bots {
                        if let Some(ref fleet) = ctx.fleet {
                            let _ = fleet.delete_bot(&b.bot_key).await;
                        }
                        let _ = ctx.caches.engine().delete_bot(&b.bot_key);
                    }
                    send_text_reply(
                        &ctx,
                        &format!("🧹 Đã dọn dẹp các bot hết hạn khỏi hệ thống:\n• Đã dọn dẹp: {count} bot"),
                    )
                    .await
                }
                "notify" => {
                    let msg_text = ctx.args.get(1..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();
                    if msg_text.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot notify [nội dung thông báo]")).await;
                    }
                    let child_bots: Vec<_> = bots.into_iter().filter(|b| !b.is_main && b.bot_key != "admin").collect();
                    if child_bots.is_empty() {
                        return send_text_reply(&ctx, "⚠️ Hệ thống hiện không có bot con nào để gửi thông báo!").await;
                    }
                    let mut sent = 0;
                    for b in &child_bots {
                        if let Some(ref fleet) = ctx.fleet {
                            let mut n_msg = ctx.message.clone();
                            n_msg.bot_key = b.bot_key.clone().into();
                            n_msg.content = MessageContent::Text {
                                text: format!("[THÔNG BÁO TỪ HỆ THỐNG BOT]\n\n{msg_text}"),
                            };
                            n_msg.source = EventSource::CrossBotRelay;
                            if fleet.relay_command_to_bot(&b.bot_key, n_msg).await.is_ok() {
                                sent += 1;
                            }
                        } else {
                            sent += 1;
                        }
                    }
                    send_text_reply(
                        &ctx,
                        &format!(
                            "📢 Đã gửi thông báo hệ thống tới các bot con:\n• Tổng số bot con: {}\n• Đã gửi thành công: {}\n• Nội dung: \"{msg_text}\"",
                            child_bots.len(),
                            sent
                        ),
                    )
                    .await
                }
                "cmd" => {
                    let target_key = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    let cmd_text = ctx.args.get(2..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();
                    if target_key.is_empty() || cmd_text.is_empty() {
                        return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot cmd <index|uid|bot_key> <lệnh>")).await;
                    }
                    let Some(target) = resolve_target_bot(target_key, &bots) else {
                        return send_text_reply(&ctx, &format!("⚠️ Không tìm thấy bot \"{target_key}\".")).await;
                    };
                    if target.is_main || target.bot_key == "admin" {
                        return send_text_reply(&ctx, "⚠️ Lệnh cmd từ xa chỉ áp dụng cho bot con!").await;
                    }
                    if let Some(ref fleet) = ctx.fleet {
                        let mut r_msg = ctx.message.clone();
                        r_msg.bot_key = target.bot_key.clone().into();
                        r_msg.content = MessageContent::Text {
                            text: cmd_text.clone(),
                        };
                        r_msg.source = EventSource::CrossBotRelay;
                        match fleet.relay_command_to_bot(&target.bot_key, r_msg).await {
                            Ok(out) => send_text_reply(&ctx, &format!("🤖 [Bot con: {}]\n{}", target.display_name, out)).await,
                            Err(err) => send_text_reply(&ctx, &format!("⚠️ [Bot con: {}] Lỗi thực thi lệnh: {err}", target.display_name)).await,
                        }
                    } else {
                        send_text_reply(
                            &ctx,
                            &format!("📡 Đã chuyển tiếp lệnh \"{cmd_text}\" tới bot con {}.", target.display_name),
                        )
                        .await
                    }
                }
                "cancel" => {
                    let sender = ctx.message.sender_uid.as_str();
                    if let Some((_, cancel_token)) = CHAT_QR_CANCELS.remove(sender) {
                        cancel_token.cancel();
                        return send_text_reply(&ctx, "✅ Đã hủy phiên tạo mã QR của bạn thành công.").await;
                    }
                    send_text_reply(&ctx, "ℹ️ Hiện bạn không có phiên đăng nhập QR nào đang chờ.").await
                }
                "create" => {
                    if ctx.message.thread_type == ThreadType::Group {
                        return send_text_reply(
                            &ctx,
                            "⚠️ Vui lòng khởi tạo bot ở chat cá nhân (1-1) vì thông tin tạo bot là bảo mật an toàn.",
                        )
                        .await;
                    }

                    let imei = ctx.args.get(1).map(String::as_str).unwrap_or("").trim();
                    let cookie_raw = ctx.args.get(2..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();

                    if imei.is_empty() || cookie_raw.is_empty() {
                        return send_text_reply(
                            &ctx,
                            &format!("📖 Cách dùng lệnh tạo bot:\n{p}mybot create <IMEI> <Cookie>\n\nVí dụ: {p}mybot create 98765432-xxxx {{\"cookies\":[...]}}"),
                        )
                        .await;
                    }

                    let cookie_json: Value = if cookie_raw.starts_with('{') || cookie_raw.starts_with('[') {
                        serde_json::from_str(&cookie_raw).unwrap_or_else(|_| json!({ "raw": cookie_raw }))
                    } else {
                        json!({ "raw": cookie_raw })
                    };

                    let sender = ctx.message.sender_uid.as_str();
                    let sender_name = &ctx.message.sender_name;

                    let existing_owned = bots.iter().find(|b| b.owner_uid.as_deref() == Some(sender));
                    let bot_key = if let Some(owned) = existing_owned {
                        owned.bot_key.clone()
                    } else {
                        format!("bot_{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
                    };

                    let now = Utc::now().to_rfc3339();
                    let record = BotRecord {
                        bot_key: bot_key.clone(),
                        uid: ZaloId::new(&bot_key),
                        global_uid: None,
                        canonical_username: None,
                        display_name: format!("Bot của {}", sender_name),
                        avatar: String::new(),
                        is_main: false,
                        owner_uid: Some(sender.to_string()),
                        status: "stopped".to_string(),
                        desired_status: "stopped".to_string(),
                        expiry_policy: ExpiryPolicy::Pending,
                        trial_status: Some("pending".to_string()),
                        cookie_json,
                        imei: imei.to_string(),
                        user_agent: DEFAULT_ZALO_USER_AGENT.to_string(),
                        proxy_url: None,
                        cookie_dead: false,
                        cookie_dead_reason: None,
                        prefix: "!".to_string(),
                        self_listen: true,
                        identity_pending: false,
                        admin_identity_seeds: Vec::new(),
                        metadata: json!({}),
                        created_at: now.clone(),
                        updated_at: now,
                    };

                    ctx.caches.engine().upsert_bot(&record)?;

                    send_text_reply(
                        &ctx,
                        &format!(
                            "🎉 Khởi tạo dữ liệu bot cho {} thành công!\n\n📋 Thông tin bot:\n• Mã Bot: {}\n• Trạng thái: ⏸ Tạm dừng (chờ kích hoạt)\n• Gói chờ: Dùng thử 1 giờ\n\n💡 Dùng lệnh: {}mybot active để kích hoạt dùng thử 1 giờ (1 lần / tuần lịch Bangkok).",
                            sender_name, bot_key, p
                        ),
                    )
                    .await
                }
                "qrlogin" | "login" | "qr" => {
                    if ctx.message.thread_type == ThreadType::Group {
                        return send_text_reply(
                            &ctx,
                            "⚠️ Vui lòng thực hiện đăng nhập QR ở chat cá nhân (1-1) để bảo mật thông tin tài khoản.",
                        )
                        .await;
                    }

                    let sender = ctx.message.sender_uid.as_str();
                    let sender_name = &ctx.message.sender_name;

                    if let Some((_, prev_token)) = CHAT_QR_CANCELS.remove(sender) {
                        prev_token.cancel();
                    }
                    let cancel = CancellationToken::new();
                    CHAT_QR_CANCELS.insert(sender.to_string(), cancel.clone());

                    let existing_owned = bots.iter().find(|b| b.owner_uid.as_deref() == Some(sender));
                    let bot_key = if let Some(owned) = existing_owned {
                        owned.bot_key.clone()
                    } else {
                        format!("bot_{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
                    };

                    if existing_owned.is_none() {
                        let now = Utc::now().to_rfc3339();
                        let record = BotRecord {
                            bot_key: bot_key.clone(),
                            uid: ZaloId::new(&bot_key),
                            global_uid: None,
                            canonical_username: None,
                            display_name: format!("Bot của {}", sender_name),
                            avatar: String::new(),
                            is_main: false,
                            owner_uid: Some(sender.to_string()),
                            status: "stopped".to_string(),
                            desired_status: "stopped".to_string(),
                            expiry_policy: ExpiryPolicy::Pending,
                            trial_status: Some("pending".to_string()),
                            cookie_json: json!({}),
                            imei: String::new(),
                            user_agent: DEFAULT_ZALO_USER_AGENT.to_string(),
                            proxy_url: None,
                            cookie_dead: true,
                            cookie_dead_reason: Some("Đang chờ quét mã QR Zalo".to_string()),
                            prefix: "!".to_string(),
                            self_listen: true,
                            identity_pending: false,
                            admin_identity_seeds: Vec::new(),
                            metadata: json!({}),
                            created_at: now.clone(),
                            updated_at: now,
                        };
                        ctx.caches.engine().upsert_bot(&record)?;
                    }

                    let opts = QrLoginOptions::default();
                    let sender_owned = sender.to_string();
                    let p_owned = p.to_string();
                    let style_profile = ctx.style_profile.clone();
                    let msg_ref = ctx.message.clone();
                    let zalo_opt = ctx.zalo.clone();
                    let thread_id = ctx.message.thread_id.clone();
                    let thread_type = ctx.message.thread_type;
                    let bot_key_clone = bot_key.clone();
                    let caches_clone = ctx.caches.clone();
                    let cancel_worker = cancel.clone();

                    let (phase_tx, mut phase_rx) = tokio::sync::mpsc::channel::<QrLoginPhase>(16);

                    tokio::spawn(async move {
                        let auth_res = authenticate_zalo_qr(
                            opts,
                            move |phase| {
                                let _ = phase_tx.try_send(phase);
                            },
                            cancel_worker,
                        )
                        .await;

                        CHAT_QR_CANCELS.remove(&sender_owned);

                        match auth_res {
                            Ok(outcome) => {
                                let engine = caches_clone.engine();
                                if let Ok(Some(mut bot)) = engine.get_bot(&bot_key_clone) {
                                    if !outcome.uid.is_empty() {
                                        bot.uid = ZaloId::new(&outcome.uid);
                                    }
                                    if !outcome.display_name.trim().is_empty() {
                                        bot.display_name = outcome.display_name.trim().to_string();
                                    }
                                    if !outcome.avatar.trim().is_empty() {
                                        bot.avatar = outcome.avatar.trim().to_string();
                                    }
                                    bot.self_listen = true;
                                    bot.cookie_json = outcome.credentials.cookie;
                                    bot.imei = outcome.credentials.imei;
                                    bot.user_agent = outcome.credentials.user_agent;
                                    bot.cookie_dead = false;
                                    bot.cookie_dead_reason = None;
                                    bot.status = "stopped".to_string();
                                    bot.desired_status = "stopped".to_string();
                                    bot.trial_status = Some("pending".to_string());
                                    bot.updated_at = Utc::now().to_rfc3339();
                                    let _ = engine.upsert_bot(&bot);

                                    if let Some(ref z) = zalo_opt {
                                        let success_text = format!(
                                            "🎉 Quét mã QR thành công cho bot {}!\n\n📋 Thông tin bot:\n• Tên hiển thị: {}\n• UID: {}\n• Trạng thái: ⏸ Tạm dừng (chờ kích hoạt)\n• Gói chờ: Dùng thử 1 giờ\n\n💡 Dùng lệnh: {}mybot active để kích hoạt bot và bắt đầu dùng thử 1 giờ (1 lần / tuần lịch Bangkok)!",
                                            bot.display_name, bot.display_name, bot.uid, p_owned
                                        );
                                        let out = build_state_quote(&style_profile, &msg_ref, &success_text, true, 30_000, false);
                                        let _ = z.send_message(out, &thread_id, thread_type).await;
                                    }
                                }
                            }
                            Err(e) => {
                                let err_str = e.to_string();
                                if !err_str.contains("cancel") {
                                    if let Some(ref z) = zalo_opt {
                                        let fail_text = format!(
                                            "⚠️ Phiên đăng nhập QR Zalo thất bại hoặc đã hết hạn: {err_str}\nVui lòng tạo phiên mới bằng {}mybot qrlogin.",
                                            p_owned
                                        );
                                        let out = build_state_quote(&style_profile, &msg_ref, &fail_text, false, 30_000, false);
                                        let _ = z.send_message(out, &thread_id, thread_type).await;
                                    }
                                }
                            }
                        }
                    });

                    // Wait for QrReady phase from channel to render & send QR image
                    let mut qr_sent = false;
                    while let Some(phase) = phase_rx.recv().await {
                        match phase {
                            QrLoginPhase::QrReady { code, expires_in_secs, .. } => {
                                if let Ok(png) = CaptchaAndQrEngine::encode_qr_png(&code, 360) {
                                    let caption = format!(
                                        "📱 MÃ QR ĐĂNG NHẬP BOT ZALO ({})\n\n1. Mở Zalo trên điện thoại\n2. Chọn Quét mã QR và quét mã trên\n3. Bấm \"Xác nhận đăng nhập\" trên điện thoại\n\n⏱ Mã có hiệu lực trong {} giây.\n💡 Dùng lệnh: {}mybot cancel để hủy phiên bất kỳ lúc nào.",
                                        sender_name, expires_in_secs, p
                                    );
                                    let _ = send_local_bytes_reply(&ctx, rt, "zalo_qr", "png", &png, &caption).await;
                                    qr_sent = true;
                                }
                                break;
                            }
                            _ => {}
                        }
                    }

                    if !qr_sent {
                        send_text_reply(
                            &ctx,
                            "⚠️ Không thể khởi tạo mã QR Zalo lúc này. Vui lòng thử lại sau.",
                        )
                        .await
                    } else {
                        Ok(CommandOutcome::handled("zalo_qr_sent", None))
                    }
                }
                "getupdate" => {
                    send_text_reply(&ctx, "🔄 Trạng thái phiên đăng nhập: Sẵn sàng.").await
                }
                "update" => {
                    let update_type = ctx.args.get(1).map(String::as_str).unwrap_or("");
                    let mut bot = get_or_create_bot_record(&ctx, &ctx.bot_key)?;
                    if update_type == "name" {
                        let val = ctx.args.get(2..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();
                        if val.is_empty() {
                            return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot update name [tên mới]")).await;
                        }
                        bot.display_name = val.clone();
                        if !bot.metadata.is_object() {
                            bot.metadata = json!({});
                        }
                        bot.metadata["nameServer"] = json!(val);
                        if !bot.metadata["profile"].is_object() {
                            bot.metadata["profile"] = json!({});
                        }
                        bot.metadata["profile"]["nameServer"] = json!(val);
                    } else if update_type == "desc" || update_type == "description" {
                        let val = ctx.args.get(2..).map(|a| a.join(" ")).unwrap_or_default().trim().to_string();
                        if val.is_empty() {
                            return send_text_reply(&ctx, &format!("⚠️ Cách dùng: {p}mybot update description [mô tả mới]")).await;
                        }
                        if !bot.metadata.is_object() {
                            bot.metadata = json!({});
                        }
                        bot.metadata["description"] = json!(val);
                        if !bot.metadata["profile"].is_object() {
                            bot.metadata["profile"] = json!({});
                        }
                        bot.metadata["profile"]["description"] = json!(val);
                    } else if ctx.args.len() >= 3 {
                        bot.imei = ctx.args[1].clone();
                        if let Ok(cookie_val) = serde_json::from_str::<Value>(&ctx.args[2]) {
                            bot.cookie_json = cookie_val;
                        }
                    }
                    bot.updated_at = Utc::now().to_rfc3339();
                    ctx.caches.engine().upsert_bot(&bot)?;
                    if let Some(ref fleet) = ctx.fleet {
                        let _ = fleet.reload_bot(&bot.bot_key).await;
                    }
                    send_text_reply(&ctx, "✅ Đã cập nhật thông tin bot thành công.").await
                }
                "showinfo" | "info" => {
                    let sender = ctx.message.sender_uid.as_str();
                    let owned: Vec<_> = bots
                        .iter()
                        .filter(|b| b.owner_uid.as_deref() == Some(sender) || b.uid.as_str() == sender)
                        .collect();
                    if owned.is_empty() {
                        send_text_reply(
                            &ctx,
                            &format!("🤖 Bạn hiện chưa sở hữu bot phụ nào. Dùng {p}mybot qrlogin hoặc liên hệ Admin để khởi tạo bot bằng mã QR!"),
                        )
                        .await
                    } else {
                        let lines: Vec<String> = owned
                            .iter()
                            .map(|b| {
                                format!(
                                    "• {} ({}) - Trạng thái: {} - Hạn: {}",
                                    b.bot_key,
                                    b.display_name,
                                    b.status,
                                    b.expiry_policy.to_v3_string()
                                )
                            })
                            .collect();
                        send_text_reply(&ctx, &format!("🤖 Bot của bạn ({}):\n{}", owned.len(), lines.join("\n"))).await
                    }
                }
                "manager" => {
                    let manager_msg = format!(
                        "👮 LỆNH QUẢN TRỊ HỆ THỐNG BOT 👮\n\n\
                        ✪ Quản lý danh sách:\n\
                          ➤ {p}mybot list: Xem danh sách tất cả bot\n\
                          ➤ {p}mybot showinfo all: Xem chi tiết toàn bộ bot hệ thống\n\
                          ➤ {p}mybot notify [nội dung]: Thông báo cho tất cả bot con\n\n\
                        ✪ Quản lý bot cụ thể:\n\
                          ➤ {p}mybot detail [index|uid]: Xem chi tiết bot\n\
                          ➤ {p}mybot cmd [index|uid] <lệnh>: Thực thi lệnh từ xa trên bot con\n\
                          ➤ {p}mybot restart [index|uid|all]: Khởi động lại bot\n\
                          ➤ {p}mybot start [index|uid|all]: Khởi động bot\n\
                          ➤ {p}mybot stop [index|uid|all]: Tắt bot\n\n\
                        ✪ Phê duyệt / Gia hạn:\n\
                          ➤ {p}mybot approve [index|uid]: Cho phép bot hoạt động lại\n\
                          ➤ {p}mybot reject [index|uid] [-1]: Vô hiệu hóa bot\n\
                          ➤ {p}mybot extend [index|uid] [thời gian|-1]: Gia hạn bot\n\
                          ➤ {p}mybot minus [index|uid] [thời gian|-1]: Rút ngắn hạn bot\n\n\
                        ✪ Quản lý hệ thống:\n\
                          ➤ {p}mybot delete [index|uid|all]: Xóa bot khỏi hệ thống\n\
                          ➤ {p}mybot clean: Xóa các bot đã hết hạn"
                    );
                    send_text_reply(&ctx, &manager_msg).await
                }
                _ => {
                    let qtv_msg = format!(
                        "🤖 HƯỚNG DẪN QUẢN LÝ BOT 🤖\n\n\
                        ➤ {p}mybot info: Xem hạn dùng & trạng thái bot của bạn\n\
                        ➤ {p}mybot active: Kích hoạt dùng thử bot\n\
                        ➤ {p}mybot start: Khởi động bot\n\
                        ➤ {p}mybot restart: Khởi động lại bot\n\
                        ➤ {p}mybot shutdown: Dừng bot\n\
                        ➤ {p}mybot showinfo: Xem tất cả bot của bạn\n\
                        ➤ {p}mybot delete: Xóa bot khỏi hệ thống\n\
                        ➤ {p}mybot manager: Xem lệnh quản trị cấp cao (Admin)"
                    );
                    send_text_reply(&ctx, &qtv_msg).await
                }
            }
        }
        "help" | "command" => {
            let page_size = 15usize;
            if let Some(sub) = ctx.args.first()
                && sub.eq_ignore_ascii_case("find")
                && ctx.args.len() >= 2
            {
                let kw = ctx.args[1..].join(" ").to_lowercase();
                let matches: Vec<String> = ALL_218_CATALOG
                    .iter()
                    .filter(|e| {
                        e.spec.name.contains(&kw)
                            || e.spec.description.to_lowercase().contains(&kw)
                            || e.spec.aliases.iter().any(|a| a.contains(&kw))
                    })
                    .take(15)
                    .map(|e| format!("{} {}{} - {}", e.icon, ctx.prefix, e.spec.name, e.spec.description))
                    .collect();
                let msg = if matches.is_empty() {
                    format!("📚 Không tìm thấy lệnh nào khớp với \"{kw}\".")
                } else {
                    format!("📚 Tìm thấy lệnh khớp \"{kw}\":\n{}", matches.join("\n"))
                };
                return send_text_reply(&ctx, &msg).await;
            }

            let page: usize = ctx
                .args
                .first()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(1)
                .max(1);
            let total_pages = ALL_218_CATALOG.len().div_ceil(page_size);
            let clamped_page = page.min(total_pages);
            let start = (clamped_page - 1) * page_size;
            let items: Vec<String> = ALL_218_CATALOG
                .iter()
                .skip(start)
                .take(page_size)
                .map(|e| format!("{} {}{} - {}", e.icon, ctx.prefix, e.spec.name, e.spec.description))
                .collect();

            send_text_reply(
                &ctx,
                &format!(
                    "📜 Danh sách lệnh (Trang {clamped_page}/{total_pages} - Tổng {} lệnh):\n{}\n💡 Gõ {}{} <số_trang> hoặc {}command find <từ_khóa>.",
                    ALL_218_CATALOG.len(),
                    items.join("\n"),
                    ctx.prefix,
                    spec.name,
                    ctx.prefix
                ),
            )
            .await
        }
        "lich" => {
            let now_ict = Utc::now().with_timezone(&Ho_Chi_Minh);
            let (d, m, y) = if let Some(first) = ctx.args.first()
                && let parts = first.split(['/', '-']).collect::<Vec<_>>()
                && parts.len() == 3
            {
                (
                    parts[0].parse::<u32>().unwrap_or(now_ict.day()),
                    parts[1].parse::<u32>().unwrap_or(now_ict.month()),
                    parts[2].parse::<i32>().unwrap_or(now_ict.year()),
                )
            } else {
                (now_ict.day(), now_ict.month(), now_ict.year())
            };
            let lunar = solar_to_vietnamese_lunar(d, m, y);
            let png = rt
                .gfx
                .render(
                    CardKind::StatusPost,
                    &json!({
                        "title": format!("Dương lịch: {:02}/{:02}/{}", lunar.solar_day, lunar.solar_month, lunar.solar_year),
                        "subtitle": format!("Âm lịch: {:02}/{:02}/{} ({})", lunar.lunar_day, lunar.lunar_month, lunar.lunar_year, lunar.can_chi_year),
                        "name": format!("Ngày {} • Tháng {}", lunar.can_chi_day, lunar.can_chi_month),
                        "role": lunar.tiet_khi,
                    }),
                    None,
                )
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(
                &ctx,
                rt,
                "lich",
                "png",
                &png,
                &format!(
                    "📅 Dương lịch {:02}/{:02}/{} -> Âm lịch **{:02}/{:02}/{}** (Năm **{}**, Ngày **{}**, Tiết **{}**)\n⏰ Giờ Hoàng Đạo: {}",
                    lunar.solar_day,
                    lunar.solar_month,
                    lunar.solar_year,
                    lunar.lunar_day,
                    lunar.lunar_month,
                    lunar.lunar_year,
                    lunar.can_chi_year,
                    lunar.can_chi_day,
                    lunar.tiet_khi,
                    lunar.auspicious_hours.join(", ")
                ),
            )
            .await
        }
        "qrbank" | "mybank" | "cardqr" => {
            let bank = ctx.args.first().map(String::as_str).unwrap_or("VCB");
            let acc = ctx.args.get(1).map(String::as_str).unwrap_or("0123456789");
            let amount = ctx.args.get(2).and_then(|s| s.parse::<u64>().ok());
            let spec_qr = MediaCrawlerHub::build_vietqr(bank, acc, "MYBOT V4", amount, "Chuyen khoan");
            let png = rt
                .gfx
                .render(
                    CardKind::BankQrCard,
                    &json!({
                        "qrPayload": spec_qr.emv_payload,
                        "bankName": spec_qr.bank_code,
                        "accountNumber": spec_qr.account_number,
                        "accountName": spec_qr.account_name,
                        "memo": spec_qr.memo,
                    }),
                    None,
                )
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(
                &ctx,
                rt,
                "vietqr",
                "png",
                &png,
                &format!("🏦 Mã VietQR {} - `{}`", spec_qr.bank_code, spec_qr.account_number),
            )
            .await
        }
        "createqr" | "qrheart" => {
            let payload = if query.is_empty() {
                "https://chat.zalo.me"
            } else {
                query
            };
            let png = CaptchaAndQrEngine::encode_qr_png(payload, 360)
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(&ctx, rt, "qr", "png", &png, &format!("🔳 QR Code: `{payload}`")).await
        }
        "scanqr" => {
            if let Some(url) = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("href").or_else(|| a.get("hdUrl")))
                .and_then(|v| v.as_str())
                && let Ok(resp) = rt.crawlers.http().get(url).send().await
                && let Ok(bytes) = resp.bytes().await
                && let Ok(codes) = CaptchaAndQrEngine::decode_qr_image(&bytes)
                && !codes.is_empty()
            {
                return send_text_reply(
                    &ctx,
                    &format!("🔍 Nội dung giải mã QR:\n{}", codes.join("\n")),
                )
                .await;
            }
            send_text_reply(&ctx, "🔍 Vui lòng reply trực tiếp vào một hình ảnh chứa mã QR rõ nét.").await
        }
        "learnnow" => {
            let thread_str = ctx.message.thread_id.as_str();
            // Syntax: `!learnnow câu hỏi _ câu trả lời` or `câu hỏi _ câu trả lời`
            let (q_raw, a_raw) = if ctx.raw_args_text.contains('_') {
                let parts: Vec<&str> = ctx.raw_args_text.splitn(2, '_').collect();
                (parts[0].trim().to_string(), parts[1].trim().to_string())
            } else if ctx.args.len() >= 2 {
                (ctx.args[0].trim().to_string(), ctx.args[1..].join(" ").trim().to_string())
            } else {
                (String::new(), String::new())
            };

            if q_raw.is_empty() || a_raw.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Cú pháp không hợp lệ. Vui lòng sử dụng: {}learnnow [Câu Hỏi]_[Câu Trả Lời] (dùng \\n để xuống dòng)",
                        ctx.prefix
                    ),
                )
                .await;
            }

            let answer = a_raw.replace("\\n", "\n");
            let q_norm = crate::passive_hooks::normalize_question(&q_raw);
            let existing = ctx.caches.engine().lookup_learned_qa(&ctx.bot_key, thread_str, &q_norm)?;
            let mut answers = existing.unwrap_or_default();
            if answers.iter().any(|ans| ans == &answer) {
                return send_text_reply(
                    &ctx,
                    &format!("Câu trả lời \"{answer}\" đã tồn tại cho câu hỏi \"{q_raw}\""),
                )
                .await;
            }
            answers.push(answer.clone());
            ctx.caches.engine().upsert_learned_qa(&ctx.bot_key, thread_str, &q_norm, &answers)?;
            send_text_reply(
                &ctx,
                &format!(
                    "Đã thêm câu trả lời mới thành công. Khi người dùng gửi tin nhắn chứa \"{q_raw}\", tôi sẽ trả lời:\n{answer}"
                ),
            )
            .await
        }
        "learn" => {
            let thread_str = ctx.message.thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());

            if first_arg.as_deref() == Some("list") {
                let page: usize = ctx.args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1).max(1);
                let all = ctx.caches.engine().list_learned_qa_for_thread(&ctx.bot_key, thread_str)?;
                if all.is_empty() {
                    return send_text_reply(&ctx, "📚 Nhóm này chưa có dữ liệu học nào.").await;
                }
                let page_size = 10;
                let total = all.len();
                let total_pages = (total + page_size - 1) / page_size;
                let safe_page = page.min(total_pages);
                let start = (safe_page - 1) * page_size;
                let slice = &all[start..(start + page_size).min(total)];

                let mut lines = Vec::new();
                lines.push(format!("📚 Danh sách câu học của nhóm (trang {safe_page}/{total_pages}, tổng {total}):"));
                for (i, (question, ans_list)) in slice.iter().enumerate() {
                    let ans_preview = ans_list.first().map(|s| s.as_str()).unwrap_or("");
                    lines.push(format!("{}. [✅lưu] Hỏi: {} → Đáp: {}", start + i + 1, question, ans_preview));
                }
                lines.push(format!("💡 Dùng {}unlearn <câu hỏi> để xoá.", ctx.prefix));
                return send_text_reply(&ctx, &lines.join("\n")).await;
            }

            let enabled = match first_arg.as_deref() {
                Some("on" | "bat" | "1") => true,
                Some("off" | "tat" | "0") => false,
                _ => {
                    let current = ctx.group_settings.settings.get("learnEnabled")
                        .or_else(|| ctx.group_settings.settings.get("learn"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    !current
                }
            };

            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("learn".into(), json!(enabled));
                    obj.insert("learnEnabled".into(), json!(enabled));
                }
            });
            send_text_reply(
                &ctx,
                &format!("Chế độ học tập đã được {}!", if enabled { "bật" } else { "tắt" }),
            )
            .await
        }
        "unlearn" => {
            let thread_str = ctx.message.thread_id.as_str();
            if ctx.args.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("❌ Cú pháp không hợp lệ. Vui lòng sử dụng: {}unlearn <câu hỏi>", ctx.prefix),
                )
                .await;
            }
            let raw_target = ctx.raw_args_text.trim();
            let target_q = if let Ok(idx) = raw_target.parse::<usize>() {
                let all = ctx.caches.engine().list_learned_qa_for_thread(&ctx.bot_key, thread_str)?;
                if idx >= 1 && idx <= all.len() {
                    all[idx - 1].0.clone()
                } else {
                    raw_target.to_string()
                }
            } else {
                raw_target.to_string()
            };

            let norm = crate::passive_hooks::normalize_question(&target_q);
            let deleted = ctx.caches.engine().delete_learned_qa(&ctx.bot_key, thread_str, &norm)?;
            if deleted || (norm != target_q && ctx.caches.engine().delete_learned_qa(&ctx.bot_key, thread_str, &target_q)?) {
                send_text_reply(&ctx, &format!("✅ Đã xóa thành công câu hỏi \"{target_q}\" khỏi cơ sở dữ liệu.")).await
            } else {
                send_text_reply(&ctx, &format!("❌ Không tìm thấy câu hỏi \"{target_q}\" trong dữ liệu học của nhóm.")).await
            }
        }
        "reply" => {
            let thread_str = ctx.message.thread_id.as_str();
            let enabled = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "bat" | "1") => true,
                Some("off" | "tat" | "0") => false,
                _ => {
                    let current = ctx.group_settings.settings.get("replyEnabled")
                        .or_else(|| ctx.group_settings.settings.get("reply"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    !current
                }
            };
            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("reply".into(), json!(enabled));
                    obj.insert("replyEnabled".into(), json!(enabled));
                }
            });
            send_text_reply(
                &ctx,
                &format!("Chế độ trả lời đã được {}!", if enabled { "bật" } else { "tắt" }),
            )
            .await
        }
        "autoreply" => {
            let thread_str = ctx.message.thread_id.as_str();
            let enabled = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "bat" | "1") => true,
                Some("off" | "tat" | "0") => false,
                _ => {
                    let current = ctx.group_settings.settings.get("autoreply")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    !current
                }
            };
            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("autoreply".into(), json!(enabled));
                }
            });
            send_text_reply(
                &ctx,
                &format!("💬 Chế độ `autoreply` tại nhóm: **{}**", if enabled { "ĐÃ BẬT" } else { "ĐÃ TẮT" }),
            )
            .await
        }
        "replytag" => {
            let thread_str = ctx.message.thread_id.as_str();
            let enabled = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "bat" | "1") => true,
                Some("off" | "tat" | "0") => false,
                _ => {
                    let current = ctx.group_settings.settings.get("replytag")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    !current
                }
            };
            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("replytag".into(), json!(enabled));
                }
            });
            send_text_reply(
                &ctx,
                &format!("💬 Chế độ `replytag` tại nhóm: **{}**", if enabled { "ĐÃ BẬT" } else { "ĐÃ TẮT" }),
            )
            .await
        }
        "simsimi" => {
            let thread_str = ctx.message.thread_id.as_str();
            if query.is_empty() {
                return send_text_reply(&ctx, "💬 Vui lòng nhập nội dung muốn trò chuyện với Simsimi. Ví dụ: !simsimi Chào bạn").await;
            }
            let norm = crate::passive_hooks::normalize_question(query);
            if let Ok(Some(answers)) = ctx.caches.engine().lookup_learned_qa(&ctx.bot_key, thread_str, &norm)
                && !answers.is_empty()
            {
                let idx = (ctx.message.timestamp_ms.unsigned_abs() as usize) % answers.len();
                return send_text_reply(&ctx, &answers[idx]).await;
            }
            let ans = rt
                .ai
                .chat_simsimi_or_learned(&ctx.bot_key, thread_str, query)
                .await
                .unwrap_or_else(|_| "Xin chào! Mình là Simsimi đây!".into());
            send_text_reply(&ctx, &ans).await
        }
        "topchat" => {
            let top = ctx
                .caches
                .top_ranks_hot(&ctx.bot_key, ctx.message.thread_id.as_str(), 10, false);
            if top.is_empty() {
                return send_text_reply(&ctx, "🏆 Nhóm chưa có dữ liệu xếp hạng tương tác.").await;
            }
            let lines: Vec<String> = top
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let display = if r.user_name.is_empty() {
                        &r.user_uid
                    } else {
                        &r.user_name
                    };
                    format!("{}. **{}** — {} tin nhắn", i + 1, display, r.msg_count)
                })
                .collect();
            send_text_reply(&ctx, &format!("🏆 **Top 10 Tương Tác Nhóm**:\n{}", lines.join("\n"))).await
        }
        "detail" | "cpus" | "benchmark" | "speedtest" => {
            let mut sys = System::new_all();
            sys.refresh_memory();
            let total_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
            let used_gb = sys.used_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
            let cores = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1);
            let png = rt
                .gfx
                .render(
                    CardKind::BotInfo,
                    &json!({
                        "cpu": format!("{cores} vCPU (Pure Rust V4)"),
                        "ram": format!("{used_gb:.2} / {total_gb:.2} GiB"),
                        "uptime": "Online • SQLite WAL + /dev/shm",
                        "bots": format!("Bot `{}`", ctx.bot_key),
                    }),
                    None,
                )
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(
                &ctx,
                rt,
                "telemetry",
                "png",
                &png,
                &format!(
                    "⚡ **MyBot V4 Pure-Rust Engine** (`{}`) • {cores} luồng CPU • RAM hệ thống {used_gb:.2}/{total_gb:.2} GiB",
                    std::env::consts::OS
                ),
            )
            .await
        }
        "info" | "check" | "card" => {
            let target_uid = ctx
                .message
                .mentions
                .first()
                .map(|m| m.uid.clone())
                .unwrap_or_else(|| ctx.message.sender_uid.clone());
            if spec.name == "card"
                && let Some(ref zalo) = ctx.zalo
            {
                let _ = zalo
                    .send_business_card(
                        &target_uid,
                        None,
                        &ctx.message.thread_id,
                        ctx.message.thread_type,
                        0,
                    )
                    .await;
            }
            let png = rt
                .gfx
                .render(
                    CardKind::UserInfo,
                    &json!({
                        "name": ctx.message.sender_name,
                        "uid": target_uid.as_str(),
                        "role": format!("{:?}", ctx.sender_tier),
                    }),
                    None,
                )
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(
                &ctx,
                rt,
                "userinfo",
                "png",
                &png,
                &format!("🪪 Thông tin tài khoản Zalo UID `{target_uid}`"),
            )
            .await
        }
        "object" | "getlink" => {
            let dump = serde_json::to_string_pretty(&ctx.message)
                .unwrap_or_else(|_| "{}".into());
            send_text_reply(
                &ctx,
                &format!("🔎 Cấu trúc gói tin (`{}`):\n{}", spec.name, dump.chars().take(900).collect::<String>()),
            )
            .await
        }
        "reverse" => {
            let rev: String = query.chars().rev().collect();
            send_text_reply(&ctx, &format!("🔄 `{rev}`")).await
        }
        "gay" | "les" | "dam" => {
            let target = if query.is_empty() {
                ctx.message.sender_name.as_str()
            } else {
                query
            };
            let pct = deterministic_percent(target, spec.name);
            send_text_reply(
                &ctx,
                &format!(
                    "🎲 [Trò chơi vui] Chỉ số `{}` của {target}: {pct}% (ngẫu nhiên, không phải số liệu thật).",
                    spec.name
                ),
            )
            .await
        }
        "cmdadd" => {
            let p = &ctx.prefix;
            let raw_text = ctx.raw_args_text.trim();
            let first_token = ctx.args.first().map(|s| s.to_ascii_lowercase()).unwrap_or_default();

            let has_pipe = raw_text.contains('|');

            // 1. Subcommand: !cmdadd list [trang]
            if !has_pipe && first_token == "list" {
                let page: usize = ctx.args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
                let list = ctx.caches.engine().list_custom_commands(Some(&ctx.bot_key))?;
                if list.is_empty() {
                    return send_text_reply(
                        &ctx,
                        &format!(
                            "Chưa có lệnh custom nào.\nDùng {p}cmdadd <tên> | <nội dung> để tạo lệnh đầu tiên."
                        ),
                    )
                    .await;
                }
                let page_size = 16;
                let total = list.len();
                let total_pages = (total + page_size - 1) / page_size;
                let current_page = page.clamp(1, total_pages);
                let start = (current_page - 1) * page_size;
                let end = (start + page_size).min(total);

                let page_slice = &list[start..end];
                let mut page_commands = Vec::new();
                let mut fallback_lines = Vec::new();

                for (idx, (_, name, def, en)) in page_slice.iter().enumerate() {
                    let cmd_id = start + idx + 1;
                    let media = def.get("media");
                    let kind = media.and_then(|m| m.get("kind")).and_then(Value::as_str).unwrap_or("");
                    let icon = match kind {
                        "image" | "gif" | "sticker" => "🖼️",
                        "audio" => "🎤",
                        "video" => "🎬",
                        _ => {
                            if def.get("attachments").is_some() {
                                "🖼️"
                            } else {
                                "🔖"
                            }
                        }
                    };
                    let preview = def
                        .get("content")
                        .or_else(|| def.get("text"))
                        .or_else(|| def.get("responseContent"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let short_desc = if preview.chars().count() > 60 {
                        format!("{}…", preview.chars().take(59).collect::<String>())
                    } else {
                        preview.to_string()
                    };
                    let is_conflict = crate::admin_and_group::is_known_command(name);

                    page_commands.push(json!({
                        "id": cmd_id,
                        "name": name,
                        "description": short_desc,
                        "countdown": 30,
                        "icon": icon,
                        "conflict": is_conflict,
                        "enabled": *en,
                    }));

                    let badge = if is_conflict { " [⚠️ xung đột]" } else if !*en { " (tắt)" } else { "" };
                    fallback_lines.push(format!("#{cmd_id}. {name}{badge} — {short_desc}"));
                }

                let card_data = json!({
                    "title": "DANH SÁCH LỆNH TÙY CHỈNH",
                    "botName": if ctx.style_profile.name_server.is_empty() { &ctx.bot_key } else { &ctx.style_profile.name_server },
                    "totalCommands": total,
                    "page": current_page,
                    "totalPages": total_pages,
                    "prefix": p,
                    "items": page_commands,
                    "pageCommands": page_commands,
                    "pageInfo": {
                        "footer": format!("Dùng {p}cmdadd remove <ID> để xóa   •   {p}cmdadd list [trang] để chuyển trang")
                    }
                });

                if let Ok(png) = rt.gfx.render(CardKind::CustomCommandsGrid, &card_data, None) {
                    return send_local_bytes_reply(
                        &ctx,
                        rt,
                        "cmdadd_list",
                        "png",
                        &png,
                        &format!("📄 Trang {current_page}/{total_pages}"),
                    )
                    .await;
                }

                // Fallback text theo đúng Node V3 (src/commands/custom-commands/cmdadd-command.js:220-235)
                let fallback_text = format!(
                    "📜 Danh sách lệnh custom (trang {current_page}/{total_pages}):\n\n{}\n\n📄 Trang {current_page}/{total_pages}\n💡 Dùng {p}cmdadd remove <ID> để xóa lệnh.",
                    fallback_lines.join("\n")
                );
                return send_text_reply(&ctx, &fallback_text).await;
            }

            // 2. Subcommand: !cmdadd remove <tên|ID> hoặc !cmdadd del <tên|ID>
            if !has_pipe && (first_token == "remove" || first_token == "del") {
                let target = ctx.args.get(1).map(String::as_str).unwrap_or("").trim();
                if target.is_empty() {
                    return send_text_reply(
                        &ctx,
                        &format!("⚠️ Thiếu tên hoặc ID lệnh cần xóa. Dùng `{p}cmdadd remove <tên|ID>`."),
                    )
                    .await;
                }

                let all_cmds = ctx.caches.engine().list_custom_commands(Some(&ctx.bot_key))?;
                let mut found_name: Option<String> = None;
                let mut found_id: Option<usize> = None;
                let mut media_paths_to_clean = Vec::new();

                // Kiểm tra nếu target là số ID
                if let Ok(id_num) = target.parse::<usize>() {
                    if id_num >= 1 && id_num <= all_cmds.len() {
                        let (_, name, def, _) = &all_cmds[id_num - 1];
                        found_name = Some(name.clone());
                        found_id = Some(id_num);
                        if let Some(arr) = def.get("attachments").and_then(Value::as_array) {
                            for item in arr {
                                if let Some(path_str) = item.as_str().or_else(|| item.get("path").and_then(Value::as_str)) {
                                    media_paths_to_clean.push(path_str.to_string());
                                }
                            }
                        }
                        if let Some(mpath) = def.get("media").and_then(|m| m.get("path")).and_then(Value::as_str) {
                            media_paths_to_clean.push(mpath.to_string());
                        }
                    }
                }

                // Nếu không tìm theo ID, tìm theo tên lệnh
                if found_name.is_none() {
                    let norm = mybot_core::normalize_command_key(target);
                    for (i, (_, name, def, _)) in all_cmds.iter().enumerate() {
                        if mybot_core::normalize_command_key(name) == norm {
                            found_name = Some(name.clone());
                            found_id = Some(i + 1);
                            if let Some(arr) = def.get("attachments").and_then(Value::as_array) {
                                for item in arr {
                                    if let Some(path_str) = item.as_str().or_else(|| item.get("path").and_then(Value::as_str)) {
                                        media_paths_to_clean.push(path_str.to_string());
                                    }
                                }
                            }
                            if let Some(mpath) = def.get("media").and_then(|m| m.get("path")).and_then(Value::as_str) {
                                media_paths_to_clean.push(mpath.to_string());
                            }
                            break;
                        }
                    }
                }

                let Some(name_to_del) = found_name else {
                    return send_text_reply(
                        &ctx,
                        &format!("⚠️ Không tìm thấy lệnh custom \"{target}\"."),
                    )
                    .await;
                };

                let norm_to_del = mybot_core::normalize_command_key(&name_to_del);
                let deleted = ctx.caches.engine().delete_custom_command(&ctx.bot_key, &norm_to_del)?;
                let deleted_global = if !deleted && ctx.is_main_bot {
                    ctx.caches.engine().delete_custom_command("", &norm_to_del).unwrap_or(false)
                } else {
                    false
                };

                if deleted || deleted_global {
                    for p in media_paths_to_clean {
                        let _ = std::fs::remove_file(p);
                    }
                    let id_str = found_id.map(|i| format!(" (ID #{i})")).unwrap_or_default();
                    return send_text_reply(
                        &ctx,
                        &format!("✅ Đã xóa lệnh custom \"{name_to_del}\"{id_str}."),
                    )
                    .await;
                } else {
                    return send_text_reply(
                        &ctx,
                        &format!("⚠️ Không tìm thấy lệnh custom \"{target}\" để xóa."),
                    )
                    .await;
                }
            }

            // 3. Bare `!cmdadd` with no args: show list overview
            if raw_text.is_empty() {
                let list = ctx.caches.engine().list_custom_commands(Some(&ctx.bot_key))?;
                if list.is_empty() {
                    return send_text_reply(
                        &ctx,
                        &format!(
                            "✨ Chưa có lệnh tùy chỉnh nào. Cú pháp: {p}cmdadd <tên> | <nội dung trả lời>"
                        ),
                    )
                    .await;
                }
                let names = list
                    .iter()
                    .map(|(_, n, _, en)| if *en { n.clone() } else { format!("{n} (tắt)") })
                    .collect::<Vec<_>>()
                    .join(", ");
                return send_text_reply(
                    &ctx,
                    &format!(
                        "✨ Hiện có {} lệnh tùy chỉnh: {names}\n💡 Dùng: {p}cmdadd list để xem chi tiết.",
                        list.len()
                    ),
                )
                .await;
            }

            // 4. Create custom command: !cmdadd <tên> | <nội dung>
            let (raw_name, raw_content) = if let Some(pipe_idx) = raw_text.find('|') {
                let name_part = raw_text[..pipe_idx].trim();
                let content_part = raw_text[pipe_idx + 1..].trim();
                (name_part, content_part)
            } else if ctx.args.len() >= 2 {
                let name_part = ctx.args[0].as_str();
                let content_part = raw_text[name_part.len()..].trim();
                (name_part, content_part)
            } else {
                return send_text_reply(
                    &ctx,
                    &format!("⚠️ Không hiểu cú pháp. Dùng `{p}cmdadd <tên> | <nội dung>`."),
                )
                .await;
            };

            let norm_name = mybot_core::normalize_command_key(raw_name);

            // Validate name format
            if !is_valid_custom_command_name(&norm_name) {
                return send_text_reply(
                    &ctx,
                    "⚠️ Tên lệnh không hợp lệ. Tên lệnh phải bắt đầu bằng chữ cái, chỉ chứa chữ cái, số, dấu gạch dưới hoặc gạch ngang, và không có khoảng trắng.",
                )
                .await;
            }

            // Validate reserved names (subcommands & 218 canonical + 181 aliases)
            let reserved_sub = ["list", "remove", "del"];
            if reserved_sub.contains(&norm_name.as_str()) {
                return send_text_reply(
                    &ctx,
                    &format!("⚠️ Tên lệnh \"{norm_name}\" trùng với tên dành riêng của hệ thống."),
                )
                .await;
            }
            if crate::admin_and_group::is_known_command(&norm_name) {
                return send_text_reply(
                    &ctx,
                    &format!("⚠️ Tên \"{norm_name}\" trùng với lệnh hệ thống."),
                )
                .await;
            }

            // Validate duplicate command name
            let existing = ctx.caches.engine().list_custom_commands(Some(&ctx.bot_key))?;
            if existing.iter().any(|(_, n, _, _)| mybot_core::normalize_command_key(n) == norm_name) {
                return send_text_reply(
                    &ctx,
                    &format!("⚠️ Lệnh \"{norm_name}\" đã tồn tại. Hãy xóa rồi tạo lại."),
                )
                .await;
            }

            // Validate content
            if raw_content.is_empty() {
                return send_text_reply(&ctx, "⚠️ Nội dung lệnh không được để trống.").await;
            }
            if raw_content.len() > 2000 {
                return send_text_reply(&ctx, "⚠️ Nội dung lệnh quá dài (tối đa 2000 ký tự).").await;
            }

            // Resolve attached or quoted media - tải về lưu cục bộ vĩnh viễn
            let (media_info, attachment_path): (Option<Value>, Option<std::path::PathBuf>) =
                if let Some((url, kind, ext, mime, wants_audio)) = resolve_media_url_and_kind(&ctx) {
                    match rt.crawlers.download_media_to_ram(&url, wants_audio).await {
                        Ok(scratch) => {
                            match scratch.read_bytes() {
                                Ok(bytes) => {
                                    let custom_dir = ctx.assets_root.join("custom-commands");
                                    let _ = std::fs::create_dir_all(&custom_dir);
                                    let file_name = format!("{}_{}.{}", norm_name, Utc::now().timestamp_millis(), ext);
                                    let file_path = custom_dir.join(&file_name);
                                    if std::fs::write(&file_path, &bytes).is_ok() {
                                        let p_str = file_path.to_string_lossy().to_string();
                                        let m = json!({
                                            "path": p_str,
                                            "kind": kind,
                                            "type": mime,
                                            "ext": ext,
                                            "size": bytes.len(),
                                            "url": url,
                                        });
                                        (Some(m), Some(file_path))
                                    } else {
                                        let m = json!({
                                            "kind": kind,
                                            "type": mime,
                                            "url": url,
                                        });
                                        (Some(m), None)
                                    }
                                }
                                Err(_) => {
                                    let m = json!({
                                        "kind": kind,
                                        "type": mime,
                                        "url": url,
                                    });
                                    (Some(m), None)
                                }
                            }
                        }
                        Err(_) => {
                            let m = json!({
                                "kind": kind,
                                "type": mime,
                                "url": url,
                            });
                            (Some(m), None)
                        }
                    }
                } else if let MessageContent::Sticker { id, cate_id, .. } = &ctx.message.content {
                    let m = json!({
                        "kind": "sticker",
                        "type": "sticker",
                        "stickerId": id,
                        "cateId": cate_id,
                    });
                    (Some(m), None)
                } else {
                    (None, None)
                };

            let mut def_json = json!({
                "name": norm_name,
                "content": raw_content,
                "responseContent": raw_content,
                "text": raw_content,
                "createdBy": ctx.message.sender_uid.as_str(),
                "createdAt": Utc::now().to_rfc3339(),
                "usageCount": 0,
            });
            if let Some(m) = media_info {
                def_json["media"] = m;
            }
            if let Some(p) = attachment_path {
                def_json["attachments"] = json!([p.to_string_lossy().to_string()]);
            }

            ctx.caches.engine().upsert_custom_command(
                &ctx.bot_key,
                &norm_name,
                &def_json,
                true,
            )?;

            send_text_reply(
                &ctx,
                &format!("✅ Đã tạo lệnh custom \"{norm_name}\". Mọi thành viên có thể gọi ngay: !{norm_name}"),
            )
            .await
        }
        "alias" => {
            // `alias` is NOT `cmdadd`: it edits the `aliases` field of an existing canonical
            // command's Studio layer (`mybot-core/src/studio.rs` reads `aliases` from that layer).
            let canonical = ctx
                .args
                .first()
                .map(|s| mybot_core::normalize_command_key(s))
                .unwrap_or_default();
            if canonical.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "🔗 Cú pháp:\n{}alias <lệnh> — xem bí danh\n{}alias <lệnh> add <bí danh>\n{}alias <lệnh> remove <bí danh>",
                        ctx.prefix, ctx.prefix, ctx.prefix
                    ),
                )
                .await;
            }
            let Some(entry) = ALL_218_CATALOG
                .iter()
                .find(|e| mybot_core::normalize_command_key(e.spec.name) == canonical)
            else {
                return send_text_reply(
                    &ctx,
                    &format!("❌ Không tìm thấy lệnh \"{canonical}\""),
                )
                .await;
            };
            let base_aliases: Vec<String> =
                entry.spec.aliases.iter().map(|a| a.to_string()).collect();
            match ctx.args.get(1).map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("add") => {
                    let Some(new_alias) = ctx.args.get(2).map(|s| s.to_ascii_lowercase()) else {
                        return Err(CommandError::MissingArgument(
                            "Thiếu bí danh cần thêm.".into(),
                        ));
                    };
                    let norm_new = mybot_core::normalize_command_key(&new_alias);
                    let taken = ALL_218_CATALOG.iter().any(|e| {
                        let n = mybot_core::normalize_command_key(e.spec.name);
                        n == norm_new
                            || e.spec
                                .aliases
                                .iter()
                                .any(|a| mybot_core::normalize_command_key(a) == norm_new)
                    });
                    if taken {
                        return send_text_reply(
                            &ctx,
                            &format!("⚠️ Bí danh `{new_alias}` đã được dùng bởi lệnh khác."),
                        )
                        .await;
                    }
                    let mut merged = base_aliases.clone();
                    if !merged.iter().any(|a| a.eq_ignore_ascii_case(&new_alias)) {
                        merged.push(new_alias.clone());
                    }
                    ctx.caches.save_studio_layer_cas(
                        "bot",
                        &ctx.bot_key,
                        "",
                        &canonical,
                        &json!({ "aliases": merged }),
                        None,
                        ctx.message.sender_uid.as_str(),
                        "alias add via chat",
                    )?;
                    send_text_reply(
                        &ctx,
                        &format!("🔗 Đã thêm bí danh `{new_alias}` cho lệnh `{canonical}`."),
                    )
                    .await
                }
                Some("remove" | "del") => {
                    let Some(old_alias) = ctx.args.get(2).map(|s| s.to_ascii_lowercase()) else {
                        return Err(CommandError::MissingArgument(
                            "Thiếu bí danh cần xoá.".into(),
                        ));
                    };
                    let kept: Vec<String> = base_aliases
                        .iter()
                        .filter(|a| !a.eq_ignore_ascii_case(&old_alias))
                        .cloned()
                        .collect();
                    if kept.len() == base_aliases.len() {
                        return send_text_reply(
                            &ctx,
                            &format!("⚠️ Lệnh `{canonical}` không có bí danh `{old_alias}`."),
                        )
                        .await;
                    }
                    ctx.caches.save_studio_layer_cas(
                        "bot",
                        &ctx.bot_key,
                        "",
                        &canonical,
                        &json!({ "aliases": kept }),
                        None,
                        ctx.message.sender_uid.as_str(),
                        "alias remove via chat",
                    )?;
                    send_text_reply(
                        &ctx,
                        &format!("🔗 Đã xoá bí danh `{old_alias}` khỏi lệnh `{canonical}`."),
                    )
                    .await
                }
                _ => {
                    send_text_reply(
                        &ctx,
                        &format!(
                            "🔗 Bí danh của lệnh `{canonical}`: {}",
                            if base_aliases.is_empty() {
                                "Chưa có".to_string()
                            } else {
                                base_aliases.join(", ")
                            }
                        ),
                    )
                    .await
                }
            }
        }
        "sendtask" => {
            // `sendtask` is the only one of this family with a real scheduler wired in `mybotd`
            // (`build_default_sendtask_schedules` → 24 slots at `:05` `Asia/Ho_Chi_Minh`,
            // consumed by `PoolBackedSendTaskRunner`). Report the actual contract state.
            let enabled = !ctx
                .args
                .first()
                .is_some_and(|a| a == "off" || a == "0" || a == "tắt");
            let has_content = ctx
                .effective_studio_config
                .get("scheduler.content")
                .or_else(|| ctx.effective_studio_config.get("content"))
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty());
            if enabled && !has_content {
                return send_text_reply(
                    &ctx,
                    "⚠️ `sendtask` chưa có nội dung để gửi. Hãy đặt nội dung trong Dashboard (Command Studio → sendtask) trước khi bật.",
                )
                .await;
            }
            ctx.caches.update_group_settings(
                &ctx.bot_key,
                ctx.message.thread_id.as_str(),
                |g| {
                    if let Some(obj) = g.settings.as_object_mut() {
                        obj.insert("sendtask".to_string(), json!(enabled));
                    }
                },
            );
            send_text_reply(
                &ctx,
                &format!(
                    "⏰ Đã {} `sendtask` cho nhóm này (24 khung giờ, phút thứ 05, múi giờ Asia/Ho_Chi_Minh).",
                    if enabled { "bật" } else { "tắt" }
                ),
            )
            .await
        }
        "sendtext" => {
            let thread_str = ctx.message.thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            let is_stop = matches!(first_arg.as_deref(), Some("off" | "stop" | "tat" | "0"));

            let task_key = format!("sendtext:{}:{}", ctx.bot_key, thread_str);
            if is_stop {
                ctx.interactions.cancel_named_task(&task_key);
                ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                    if let Some(obj) = g.settings.as_object_mut() {
                        obj.insert("sendtext".into(), json!(false));
                    }
                });
                return send_text_reply(&ctx, "Đã tắt chức năng gửi tin nhắn tự động vào nhóm này!").await;
            }

            if matches!(first_arg.as_deref(), Some("on" | "1")) {
                let auto_send = ctx.group_settings.settings.get("autoSendText");
                let interval_secs = auto_send.and_then(|v| v.get("interval_secs")).and_then(Value::as_u64).unwrap_or(0);
                let text_content = auto_send.and_then(|v| v.get("content")).and_then(Value::as_str).unwrap_or("");

                if interval_secs == 0 || text_content.is_empty() {
                    return send_text_reply(
                        &ctx,
                        &format!("Vui lòng thiết lập nội dung và thời gian trước: {}sendtext <số><s/p/h> <nội dung>", ctx.prefix),
                    ).await;
                }

                ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                    if let Some(obj) = g.settings.as_object_mut() {
                        obj.insert("sendtext".into(), json!(true));
                    }
                });

                let dur = std::time::Duration::from_secs(interval_secs.max(5));
                let token = ctx.interactions.register_named_task(&task_key);
                let zalo = ctx.zalo.clone();
                let thread_id_owned = ctx.message.thread_id.clone();
                let thread_type = ctx.message.thread_type;
                let sink = ctx.outbound_sink.clone();
                let style_profile = ctx.style_profile.clone();
                let msg_ref = ctx.message.clone();
                let body = text_content.to_string();

                tokio::spawn(async move {
                    while !token.is_cancelled() {
                        tokio::select! {
                            _ = token.cancelled() => break,
                            _ = tokio::time::sleep(dur) => {
                                let out = build_state_quote(&style_profile, &msg_ref, &body, true, 30_000, false);
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

                return send_text_reply(&ctx, "Đã bật chức năng gửi tin nhắn tự động vào nhóm này!").await;
            }

            // Syntax: !sendtext <time><s/p/h> <nội dung>
            if ctx.args.len() < 2 {
                return send_text_reply(
                    &ctx,
                    &format!("⚠️ Cú pháp: {}sendtext <thời_gian (ví dụ 30s/5p/1h)> <nội dung> hoặc {}sendtext off", ctx.prefix, ctx.prefix),
                ).await;
            }

            let dur_raw = &ctx.args[0];
            let dur = match parse_periodic_duration(dur_raw) {
                Some(d) => d.clamp(std::time::Duration::from_secs(5), std::time::Duration::from_secs(86400 * 7)),
                None => {
                    return send_text_reply(&ctx, "⚠️ Thời gian không hợp lệ! Vui lòng dùng định dạng <số>s/p/h (ví dụ: 15s, 5p, 1h).").await;
                }
            };

            let content = ctx.args[1..].join(" ");
            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("sendtext".into(), json!(true));
                    obj.insert("autoSendText".into(), json!({
                        "interval_secs": dur.as_secs(),
                        "content": content,
                    }));
                }
            });

            let token = ctx.interactions.register_named_task(&task_key);
            let zalo = ctx.zalo.clone();
            let thread_id_owned = ctx.message.thread_id.clone();
            let thread_type = ctx.message.thread_type;
            let sink = ctx.outbound_sink.clone();
            let style_profile = ctx.style_profile.clone();
            let msg_ref = ctx.message.clone();
            let body = content.clone();

            tokio::spawn(async move {
                while !token.is_cancelled() {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(dur) => {
                            let out = build_state_quote(&style_profile, &msg_ref, &body, true, 30_000, false);
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

            send_text_reply(
                &ctx,
                &format!("Đã bật chức năng gửi tin nhắn tự động vào nhóm này! (chu kỳ {}s)\nNội dung: {}", dur.as_secs(), content),
            )
            .await
        }
        "sendstk" => {
            let thread_str = ctx.message.thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            let is_stop = matches!(first_arg.as_deref(), Some("off" | "stop" | "tat" | "0"));

            let task_key = format!("sendstk:{}:{}", ctx.bot_key, thread_str);
            if is_stop {
                ctx.interactions.cancel_named_task(&task_key);
                ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                    if let Some(obj) = g.settings.as_object_mut() {
                        obj.insert("sendstk".into(), json!(false));
                    }
                });
                return send_text_reply(&ctx, "Đã tắt chức năng gửi sticker tự động vào nhóm này!").await;
            }

            let dur = first_arg
                .as_deref()
                .and_then(parse_periodic_duration)
                .unwrap_or(std::time::Duration::from_secs(180))
                .clamp(std::time::Duration::from_secs(10), std::time::Duration::from_secs(86400));

            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("sendstk".into(), json!(true));
                }
            });

            let token = ctx.interactions.register_named_task(&task_key);
            let zalo = ctx.zalo.clone();
            let thread_id_owned = ctx.message.thread_id.clone();
            let thread_type = ctx.message.thread_type;
            let sink = ctx.outbound_sink.clone();

            tokio::spawn(async move {
                const STICKER_IDS: &[u64] = &[15437, 17854, 18099, 18609, 19364, 16245, 17855, 18100, 18610, 19365, 16844, 23339, 23338, 23337];
                let mut idx = 0;
                while !token.is_cancelled() {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(dur) => {
                            let stk_id = STICKER_IDS[idx % STICKER_IDS.len()];
                            idx += 1;
                            if let Some(ref z) = zalo {
                                let _ = z.send_sticker(stk_id, 1, 1, &thread_id_owned, thread_type).await;
                            }
                            if let Some(ref s) = sink {
                                s.lock().push(zalo_sdk::apis::messaging::OutboundMessage {
                                    text: format!("[sticker:{stk_id}]"),
                                    ..Default::default()
                                });
                            }
                        }
                    }
                }
            });

            send_text_reply(
                &ctx,
                &format!("Đã bật chức năng gửi sticker tự động vào nhóm này! (chu kỳ {}s)", dur.as_secs()),
            )
            .await
        }
        "prservice" => {
            let thread_str = ctx.message.thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            let is_stop = matches!(first_arg.as_deref(), Some("off" | "stop" | "tat"));

            let task_key = format!("prservice:{}:{}", ctx.bot_key, thread_str);
            if is_stop {
                ctx.interactions.cancel_named_task(&task_key);
                ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                    if let Some(obj) = g.settings.as_object_mut() {
                        obj.insert("prservice".into(), json!(false));
                    }
                });
                return send_text_reply(&ctx, "Đã tắt dịch vụ quảng cáo tự động (PR Service) cho nhóm này.").await;
            }

            let (dur, content) = if let Some(first) = ctx.args.first() && let Some(parsed) = parse_periodic_duration(first) {
                let d = parsed.clamp(std::time::Duration::from_secs(5), std::time::Duration::from_secs(86400 * 7));
                let body = if ctx.args.len() > 1 {
                    ctx.args[1..].join(" ")
                } else {
                    "📢 Dịch vụ Bot Zalo tự động hóa - Đa tính năng, ổn định & bảo mật cao!".into()
                };
                (d, body)
            } else {
                let body = if !ctx.args.is_empty() && first_arg.as_deref() != Some("on") && first_arg.as_deref() != Some("start") {
                    ctx.args.join(" ")
                } else {
                    "📢 Dịch vụ Bot Zalo tự động hóa - Đa tính năng, ổn định & bảo mật cao!".into()
                };
                (std::time::Duration::from_secs(60), body)
            };

            ctx.caches.update_group_settings(&ctx.bot_key, thread_str, |g| {
                if let Some(obj) = g.settings.as_object_mut() {
                    obj.insert("prservice".into(), json!(true));
                }
            });

            let token = ctx.interactions.register_named_task(&task_key);
            let zalo = ctx.zalo.clone();
            let thread_id_owned = ctx.message.thread_id.clone();
            let thread_type = ctx.message.thread_type;
            let sink = ctx.outbound_sink.clone();
            let style_profile = ctx.style_profile.clone();
            let msg_ref = ctx.message.clone();
            let pr_body = content.clone();

            tokio::spawn(async move {
                while !token.is_cancelled() {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(dur) => {
                            let out = build_state_quote(&style_profile, &msg_ref, &pr_body, true, 30_000, false);
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

            send_text_reply(
                &ctx,
                &format!("📢 Đã bật dịch vụ quảng cáo tự động (PR Service) cho nhóm này (chu kỳ {}s).\nNội dung: {}", dur.as_secs(), content),
            )
            .await
        }
        "nhacnho" => {
            let thread_str = ctx.message.thread_id.as_str();
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());

            if first_arg.as_deref() == Some("list") {
                let reminders = ctx.caches.engine().list_reminders_for_thread(&ctx.bot_key, thread_str)?;
                if reminders.is_empty() {
                    return send_text_reply(&ctx, "⏰ Nhóm này hiện không có lời nhắc nào đang chờ.").await;
                }
                let mut lines = Vec::new();
                lines.push(format!("⏰ Danh sách lời nhắc đang chờ ({}) :", reminders.len()));
                for r in &reminders {
                    lines.push(format!("• [#{}] {} (due: {}ms)", r.id, r.content, r.due_at_ms));
                }
                lines.push(format!("💡 Dùng {}nhacnho stop để hủy lời nhắc.", ctx.prefix));
                return send_text_reply(&ctx, &lines.join("\n")).await;
            }

            if matches!(first_arg.as_deref(), Some("stop" | "off" | "tat" | "huy" | "xoa")) {
                let task_key = format!("nhacnho:{}:{}", ctx.bot_key, thread_str);
                let cancelled = ctx.interactions.cancel_named_task(&task_key);
                if let Some(id_str) = ctx.args.get(1) && let Ok(id) = id_str.parse::<i64>() {
                    let _ = ctx.caches.engine().delete_reminder(&ctx.bot_key, thread_str, id);
                }
                return send_text_reply(
                    &ctx,
                    if cancelled {
                        "🛑 Đã hủy lịch nhắc nhở thành công."
                    } else {
                        "Đã xử lý yêu cầu hủy lời nhắc."
                    },
                )
                .await;
            }

            // Syntax: !nhacnho <thời_gian> <nội_dung>
            let (dur, content) = if let Some(first) = ctx.args.first() && let Some(parsed) = parse_periodic_duration(first) {
                let c = if ctx.args.len() > 1 { ctx.args[1..].join(" ") } else { "Đến giờ rồi!".into() };
                (parsed, c)
            } else if ctx.args.len() >= 2 && let Some(parsed) = parse_periodic_duration(ctx.args.last().unwrap()) {
                let c = ctx.args[..ctx.args.len() - 1].join(" ");
                (parsed, c)
            } else {
                return send_text_reply(
                    &ctx,
                    &format!("⚠️ Cú pháp: {}nhacnho <thời gian (ví dụ 10s/5p/1h)> <nội dung> hoặc {}nhacnho list hoặc {}nhacnho stop", ctx.prefix, ctx.prefix, ctx.prefix),
                ).await;
            };

            let due_ms = chrono::Utc::now().timestamp_millis() + dur.as_millis() as i64;
            let _ = ctx.caches.engine().insert_reminder(
                &ctx.bot_key,
                thread_str,
                2,
                ctx.message.sender_uid.as_str(),
                ctx.message.sender_uid.as_str(),
                &content,
                due_ms,
                "once",
            );

            let task_key = format!("nhacnho:{}:{}", ctx.bot_key, thread_str);
            let token = ctx.interactions.register_named_task(&task_key);
            let zalo = ctx.zalo.clone();
            let thread_id_owned = ctx.message.thread_id.clone();
            let thread_type = ctx.message.thread_type;
            let sink = ctx.outbound_sink.clone();
            let style_profile = ctx.style_profile.clone();
            let msg_ref = ctx.message.clone();
            let reminder_text = format!("⏰ [NHẮC NHỞ] Đến giờ rồi: {}!", content);

            tokio::spawn(async move {
                tokio::select! {
                    _ = token.cancelled() => {}
                    _ = tokio::time::sleep(dur) => {
                        let out = build_state_quote(&style_profile, &msg_ref, &reminder_text, true, 30_000, false);
                        if let Some(ref s) = sink {
                            s.lock().push(out.clone());
                        }
                        if let Some(ref z) = zalo {
                            let _ = z.send_message(out, &thread_id_owned, thread_type).await;
                        }
                    }
                }
            });

            send_text_reply(
                &ctx,
                &format!("⏰ Đã đặt lời nhắc sau {}s với nội dung: \"{}\"", dur.as_secs(), content),
            )
            .await
        }
        "rutgonlink" => {
            if query.is_empty() {
                return Err(CommandError::MissingArgument(
                    "Vui lòng nhập đường dẫn URL cần rút gọn.".into(),
                ));
            }
            let api_url = format!(
                "https://is.gd/create.php?format=simple&url={}",
                urlencoding_simple(query)
            );
            if let Ok(resp) = rt.crawlers.http().get(&api_url).send().await
                && let Ok(short) = resp.text().await
                && short.trim().starts_with("http")
            {
                return send_text_reply(&ctx, &format!("🔗 Link rút gọn: {}", short.trim())).await;
            }
            send_text_reply(&ctx, &format!("🔗 Không thể rút gọn URL `{query}` lúc này.")).await
        }
        "dinhgiasim" => {
            let digits: String = query.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "❌ Vui lòng nhập số điện thoại để định giá!\n👉 Cú pháp: {}dinhgiasim <sdt>",
                        ctx.prefix
                    ),
                )
                .await;
            }
            if digits.len() < 9 || digits.len() > 11 {
                return send_text_reply(
                    &ctx,
                    "❌ Vui lòng nhập số điện thoại hợp lệ (9-11 chữ số)!",
                )
                .await;
            }

            let api_url = format!("https://api.nemg.me/valuation?sdt={digits}");
            match rt
                .crawlers
                .http()
                .get(&api_url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                Ok(resp) => {
                    if let Ok(json) = resp.json::<Value>().await
                        && json["success"].as_bool().unwrap_or(false)
                        && let Some(val) = json
                            .pointer(&format!("/data/valuation/{digits}"))
                            .and_then(Value::as_str)
                    {
                        send_text_reply(
                            &ctx,
                            &format!(
                                "📱 ĐỊNH GIÁ SIM THÀNH CÔNG\n\n➤ Số điện thoại: {digits}\n➤ Định giá: {val}\n\n✨ Chúc bạn luôn 8386"
                            ),
                        )
                        .await
                    } else {
                        send_text_reply(
                            &ctx,
                            &format!("❌ Không tìm thấy định giá cho số {digits}."),
                        )
                        .await
                    }
                }
                Err(e) => {
                    send_text_reply(
                        &ctx,
                        &format!("❌ Lỗi khi kết nối dịch vụ định giá SIM: {e}"),
                    )
                    .await
                }
            }
        }
        "lovelink" | "myheart" => {
            let target = if query.is_empty() {
                ctx.message.sender_name.as_str()
            } else {
                query
            };
            let pct = 50 + (deterministic_percent(target, "love") % 51);
            send_text_reply(
                &ctx,
                &format!(
                    "💖 [Trò chơi vui] Độ hợp duyên với {target}: {pct}% (ngẫu nhiên, không phải số liệu thật)."
                ),
            )
            .await
        }
        "mail10p" => {
            let sub = ctx.args.first().map(|s| s.to_ascii_lowercase());
            match sub.as_deref() {
                Some("new" | "more") => {
                    let api_url = "https://10minutemail.net/address.api.php?more=1";
                    match rt.crawlers.http().get(api_url).send().await {
                        Ok(resp) => {
                            if let Ok(data) = resp.json::<Value>().await {
                                let email = data["mail_get_mail"].as_str().unwrap_or("Không xác định");
                                let key = data["mail_get_key"].as_str().unwrap_or("N/A");
                                let time_left = data["mail_left_time"].as_i64().unwrap_or(600);
                                send_text_reply(
                                    &ctx,
                                    &format!(
                                        "📨 Tạo Email 10 Phút Thành Công!\n\n📧 Email: `{email}`\n🔑 Key: `{key}`\n⏳ Thời gian còn lại: {time_left}s\n\n📌 Gõ `{}mail10p check` để kiểm tra hòm thư đến.",
                                        ctx.prefix
                                    ),
                                )
                                .await
                            } else {
                                send_text_reply(&ctx, "⚠️ Không phân tích được phản hồi từ dịch vụ mail10p.").await
                            }
                        }
                        Err(e) => send_text_reply(&ctx, &format!("⚠️ Lỗi kết nối dịch vụ mail10p: {e}")).await,
                    }
                }
                Some("get") => {
                    let api_url = "https://10minutemail.net/address.api.php";
                    match rt.crawlers.http().get(api_url).send().await {
                        Ok(resp) => {
                            if let Ok(data) = resp.json::<Value>().await {
                                let email = data["mail_get_mail"].as_str().unwrap_or("Không xác định");
                                send_text_reply(&ctx, &format!("📧 Email hiện tại: `{email}`")).await
                            } else {
                                send_text_reply(&ctx, "⚠️ Không lấy được thông tin email hiện tại.").await
                            }
                        }
                        Err(e) => send_text_reply(&ctx, &format!("⚠️ Lỗi kết nối: {e}")).await,
                    }
                }
                Some("check") => {
                    let api_url = "https://10minutemail.net/address.api.php";
                    match rt.crawlers.http().get(api_url).send().await {
                        Ok(resp) => {
                            if let Ok(data) = resp.json::<Value>().await {
                                let list = data["mail_list"].as_array();
                                if let Some(arr) = list && !arr.is_empty() {
                                    let first = &arr[0];
                                    let subject = first["subject"].as_str().unwrap_or("Không có tiêu đề");
                                    let date = first["datetime2"].as_str().unwrap_or("N/A");
                                    send_text_reply(&ctx, &format!("📬 Thư mới nhất:\n📝 Tiêu đề: {subject}\n🕒 Lúc: {date}")).await
                                } else {
                                    send_text_reply(&ctx, "📭 Hòm thư hiện chưa có thư mới.").await
                                }
                            } else {
                                send_text_reply(&ctx, "⚠️ Không đọc được hòm thư.").await
                            }
                        }
                        Err(e) => send_text_reply(&ctx, &format!("⚠️ Lỗi kết nối: {e}")).await,
                    }
                }
                _ => {
                    send_text_reply(
                        &ctx,
                        &format!(
                            "📌 Cú pháp lệnh 10MinuteMail:\n• `{}mail10p new` -> Tạo mail mới\n• `{}mail10p get` -> Xem thông tin mail\n• `{}mail10p check` -> Kiểm tra thư đến",
                            ctx.prefix, ctx.prefix, ctx.prefix
                        ),
                    )
                    .await
                }
            }
        }
        "checkorder" => {
            let code = query.trim();
            if code.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("Vui lòng nhập mã vận đơn!\n👉 Ví dụ: {}checkorder SPXVN...", ctx.prefix),
                )
                .await;
            }
            let upper_code = code.to_ascii_uppercase();
            if !upper_code.starts_with("SPXVN") {
                return send_text_reply(
                    &ctx,
                    "Mã không hợp lệ! Phải bắt đầu bằng SPXVN",
                )
                .await;
            }

            let url = format!(
                "https://spx.vn/shipment/order/open/order/get_order_info?spx_tn={upper_code}&language_code=vi"
            );
            match rt
                .crawlers
                .http()
                .get(&url)
                .header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                .header("accept", "application/json")
                .header("x-requested-with", "XMLHttpRequest")
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                Ok(resp) => {
                    if let Ok(json) = resp.json::<Value>().await {
                        if json["retcode"].as_i64() == Some(0)
                            && let Some(info) = json.pointer("/data/sls_tracking_info")
                        {
                            let sls_tn = info["sls_tn"].as_str().unwrap_or(&upper_code);
                            let client_order_id = info["client_order_id"].as_str().unwrap_or("Không có");
                            let records = info["records"].as_array();
                            let latest_record = records.and_then(|r| r.first());

                            let (status_text, desc, update_time) = if let Some(rec) = latest_record {
                                let tn = rec["tracking_name"].as_str().unwrap_or("");
                                let status_emoji = if tn == "Delivered" {
                                    "Đã giao"
                                } else if tn.contains("Out For Delivery") {
                                    "Đang giao"
                                } else if tn.contains("In transit") {
                                    "Đang vận chuyển"
                                } else {
                                    "Chờ lấy hàng"
                                };
                                let bd = rec["buyer_description"].as_str().unwrap_or("").trim();
                                let act_time = rec["actual_time"].as_i64().unwrap_or(0);
                                (status_emoji, bd, act_time)
                            } else {
                                ("Chờ cập nhật", "", 0)
                            };

                            let time_formatted = if update_time > 0 {
                                chrono::DateTime::from_timestamp(update_time, 0)
                                    .map(|dt| dt.format("%d/%m/%Y %H:%M").to_string())
                                    .unwrap_or_else(|| format!("{update_time}"))
                            } else {
                                "N/A".to_string()
                            };

                            let mut msg = format!(
                                "📦 TRA CỨU VẬN ĐƠN\n\nMã vận đơn: {sls_tn}\nMã đơn Shopee: {client_order_id}\nTrạng thái: {status_text} {desc}\nCập nhật: {time_formatted}\n\nLỊCH SỬ HÀNH TRÌNH:\n"
                            );

                            if let Some(recs) = records {
                                for r in recs.iter().take(8) {
                                    let t = r["actual_time"].as_i64().unwrap_or(0);
                                    let t_str = chrono::DateTime::from_timestamp(t, 0)
                                        .map(|dt| dt.format("%d/%m %H:%M").to_string())
                                        .unwrap_or_default();
                                    let d = r["buyer_description"].as_str().unwrap_or("").trim();
                                    let loc = r.pointer("/current_location/location_name").and_then(Value::as_str).unwrap_or("");
                                    let loc_clean = loc.replace("28-NDH", "").replace(" Hub", "").trim().to_string();
                                    if !loc_clean.is_empty() && !d.contains(&loc_clean) {
                                        msg.push_str(&format!("• {t_str} │ {d} ({loc_clean})\n"));
                                    } else {
                                        msg.push_str(&format!("• {t_str} │ {d}\n"));
                                    }
                                }
                            }

                            send_text_reply(&ctx, &msg).await
                        } else {
                            let err_msg = json["message"].as_str().unwrap_or("Mã không tồn tại hoặc chưa cập nhật");
                            send_text_reply(
                                &ctx,
                                &format!("❌ Không tìm thấy đơn: {upper_code}\n{err_msg}"),
                            )
                            .await
                        }
                    } else {
                        send_text_reply(
                            &ctx,
                            &format!("❌ Lỗi đọc phản hồi khi tra cứu đơn hàng `{upper_code}`."),
                        )
                        .await
                    }
                }
                Err(e) => {
                    send_text_reply(
                        &ctx,
                        &format!("⚠️ Lỗi tra cứu {upper_code}: {e}"),
                    )
                    .await
                }
            }
        }
        "fakecccd" => {
            if query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "📌 Cú pháp tạo CCCD giả lập:\n`{}fakecccd Họ Tên | Ngày Sinh | Giới Tính | Quê Quán | Nơi Thường Trú`\n(Lưu ý: Chỉ dùng minh họa giải trí, không dùng mạo danh pháp lý).",
                        ctx.prefix
                    ),
                )
                .await;
            }
            let parts: Vec<&str> = query.split('|').map(str::trim).collect();
            let name = parts.first().unwrap_or(&"NGUYEN VAN A");
            let dob = parts.get(1).unwrap_or(&"01/01/2000");
            let sex = parts.get(2).unwrap_or(&"Nam");
            let que = parts.get(3).unwrap_or(&"Hà Nội");
            let thuongtru = parts.get(4).unwrap_or(&"Hà Nội");
            let cccd_data = json!({
                "name": name,
                "dob": dob,
                "sex": sex,
                "quequan": que,
                "thuongtru": thuongtru,
                "so": "001200012345",
            });
            let png = rt.gfx.render(CardKind::CccdCard, &cccd_data, None)
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(&ctx, rt, "cccd", "png", &png, &format!("🪪 CCCD mẫu cho: {name}")).await
        }
        "testflight" => {
            let kw = query.trim();
            if kw.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("❌ Vui lòng nhập tên ứng dụng cần tìm.\n👉 Ví dụ: {}testflight locket", ctx.prefix),
                )
                .await;
            }

            let api_url = format!("https://api.nemg.me/testflight?search={}", urlencoding_simple(kw));
            let mut api_links = Vec::new();
            if let Ok(resp) = rt
                .crawlers
                .http()
                .get(&api_url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                if let Ok(data) = resp.json::<Value>().await
                    && data["success"].as_bool().unwrap_or(false)
                    && let Some(ung_dung) = data["ung_dung"].as_array()
                {
                    for (i, app) in ung_dung.iter().enumerate() {
                        if let Some(link) = app["testflight"].as_str().or_else(|| app["link"].as_str()) {
                            let name = app["name"].as_str().or_else(|| app["ten"].as_str()).unwrap_or("");
                            if name.is_empty() {
                                api_links.push(format!("{}. {}", i + 1, link));
                            } else {
                                api_links.push(format!("{}. {} - {}", i + 1, name, link));
                            }
                        }
                    }
                }
            }

            if !api_links.is_empty() {
                send_text_reply(
                    &ctx,
                    &format!(" KẾT QUẢ TÌM KIẾM TESTFLIGHT \n\n{}", api_links.join("\n")),
                )
                .await
            } else {
                match rt.crawlers.search_web_snippets(&format!("site:testflight.apple.com/join {kw}"), 3).await {
                    Ok(snippets) if !snippets.is_empty() => {
                        let formatted: Vec<String> = snippets
                            .iter()
                            .enumerate()
                            .map(|(i, (title, link, _))| format!("{}. {}\n🔗 {}", i + 1, title, link))
                            .collect();
                        send_text_reply(&ctx, &format!("✈️ TestFlight `{kw}`:\n\n{}", formatted.join("\n\n"))).await
                    }
                    _ => send_text_reply(&ctx, &format!("❌ Không tìm thấy ứng dụng nào có tên \"{kw}\" trên TestFlight.")).await,
                }
            }
        }
        "quocgia" => {
            let country = if query.is_empty() { "vietnam" } else { query };
            let url = format!("https://restcountries.com/v3.1/name/{}?fullText=false", urlencoding_simple(country));
            match rt.crawlers.http().get(&url).send().await {
                Ok(resp) => {
                    if let Ok(data) = resp.json::<Value>().await
                        && let Some(arr) = data.as_array()
                        && let Some(first) = arr.first()
                    {
                        let official = first["name"]["official"].as_str().unwrap_or(country);
                        let capital = first["capital"].as_array().and_then(|a| a.first()).and_then(Value::as_str).unwrap_or("N/A");
                        let population = first["population"].as_u64().unwrap_or(0);
                        let region = first["region"].as_str().unwrap_or("N/A");
                        send_text_reply(
                            &ctx,
                            &format!("🌍 Quốc gia: **{official}**\n• Thủ đô: {capital}\n• Dân số: {population}\n• Khu vực: {region}"),
                        ).await
                    } else {
                        send_text_reply(&ctx, &format!("❌ Không tìm thấy thông tin quốc gia: `{country}`.")).await
                    }
                }
                Err(e) => send_text_reply(&ctx, &format!("⚠️ Lỗi tra cứu quốc gia: {e}")).await,
            }
        }
        "ff" => {
            let uid_ff = query.trim();
            if uid_ff.is_empty() {
                return Err(CommandError::MissingArgument(format!(
                    "Vui lòng nhập UID Free Fire. Ví dụ: {}ff 123456789",
                    ctx.prefix
                )));
            }
            send_text_reply(&ctx, &format!("🎮 Tra cứu thông tin Free Fire (UID: `{uid_ff}`):\n• Trạng thái: Đang kết nối máy chủ Garena Free Fire...")).await
        }
        "checklq" => {
            if ctx.args.len() < 2 {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "❌ Vui lòng nhập tài khoản và mật khẩu để check thông tin tài khoản Liên Quân\n👉 Cú pháp: {}checklq <tài khoản> <mật khẩu>",
                        ctx.prefix
                    ),
                )
                .await;
            }

            let account = &ctx.args[0];
            let password = &ctx.args[1];
            let api_url = format!(
                "https://api.nemg.me/checkacclq?acc={}&pass={}",
                urlencoding_simple(account),
                urlencoding_simple(password)
            );

            match rt
                .crawlers
                .http()
                .get(&api_url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                Ok(resp) => {
                    if let Ok(json) = resp.json::<Value>().await {
                        if !json["ok"].as_bool().unwrap_or(false) {
                            send_text_reply(
                                &ctx,
                                "❌ Không tìm thấy thông tin tài khoản hoặc mật khẩu sai.",
                            )
                            .await
                        } else {
                            let mut msg = String::from("🔍 THÔNG TIN TÀI KHOẢN LIÊN QUÂN\n\n");
                            let get_val = |key: &str| -> String {
                                if let Some(s) = json[key].as_str() {
                                    s.to_string()
                                } else if let Some(n) = json[key].as_i64() {
                                    n.to_string()
                                } else {
                                    "Không rõ".to_string()
                                }
                            };

                            msg.push_str(&format!("👤 Username: {}\n", get_val("username")));
                            msg.push_str(&format!("🆔 UID: {}\n", get_val("uid")));
                            msg.push_str(&format!("🔑 Loại tài khoản: {}\n", get_val("loaiacc")));
                            msg.push_str(&format!("🎮 Nickname: {}\n", get_val("playername")));
                            msg.push_str(&format!("⭐ Level: {}\n", get_val("level")));
                            msg.push_str(&format!("🏆 Rank: {}\n", get_val("rank")));
                            msg.push_str(&format!("🎨 Skin: {}\n", get_val("skin")));
                            msg.push_str(&format!("📅 Ngày tạo: {}\n", get_val("regtime")));
                            msg.push_str(&format!("🚫 Tình trạng ban: {}\n", get_val("bantime")));
                            msg.push_str(&format!("💎 Quân huy: {}\n", get_val("quanhuy")));
                            msg.push_str(&format!("📩 Email: {}\n", get_val("email")));
                            msg.push_str(&format!("📱 Mobile: {}\n", get_val("mobile")));
                            msg.push_str(&format!("📘 Facebook: {}\n", get_val("fb")));
                            msg.push_str(&format!("🔒 CMND: {}\n", get_val("cmnd")));

                            if let Some(history) = json["login_history"].as_array() && !history.is_empty() {
                                msg.push_str("\n🕒 LỊCH SỬ ĐĂNG NHẬP:\n");
                                for (i, item) in history.iter().take(3).enumerate() {
                                    let ip = item["ip"].as_str().unwrap_or("N/A");
                                    let city = item["thanh_pho"].as_str().unwrap_or("");
                                    let country = item["quoc_gia"].as_str().unwrap_or("");
                                    let src = item["nguon"].as_str().unwrap_or("N/A");
                                    let time = item["thoigian"].as_str().unwrap_or("N/A");
                                    msg.push_str(&format!("#{}:\n   🌍 IP: {ip}\n   📍 {city}, {country}\n   📱 Nguồn: {src}\n   ⏰ {time}\n", i + 1));
                                }
                            }

                            send_text_reply(&ctx, &msg).await
                        }
                    } else {
                        send_text_reply(
                            &ctx,
                            "❌ Không tìm thấy thông tin tài khoản hoặc mật khẩu sai.",
                        )
                        .await
                    }
                }
                Err(e) => {
                    send_text_reply(
                        &ctx,
                        &format!("❌ Lỗi khi truy vấn máy chủ Liên Quân Mobile: {e}. Vui lòng thử lại sau."),
                    )
                    .await
                }
            }
        }
        "acclq" => {
            let count = ctx
                .args
                .first()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(1);

            if count < 1 || count > 10 {
                return send_text_reply(
                    &ctx,
                    "❗ Vui lòng nhập số lượng acc muốn random (1-10)",
                )
                .await;
            }

            let candidates = [
                ctx.assets_root.join("../src/service-debug/lienquanmobile/lq.txt"),
                ctx.assets_root.join("resources/lq.txt"),
                ctx.assets_root.join("lq.txt"),
                std::path::PathBuf::from("lq.txt"),
            ];
            let found_file = candidates.iter().find(|p| p.is_file());

            let accounts: Vec<(String, String)> = if let Some(p) = found_file
                && let Ok(content) = std::fs::read_to_string(p)
            {
                content
                    .lines()
                    .filter_map(|l| {
                        let l = l.trim();
                        if l.is_empty() || l.starts_with('#') {
                            None
                        } else if let Some((tk, mk)) = l.split_once(':') {
                            Some((tk.trim().to_string(), mk.trim().to_string()))
                        } else {
                            None
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            };

            if accounts.is_empty() {
                send_text_reply(
                    &ctx,
                    "❌ Không tìm thấy file lq.txt hoặc file không có tài khoản hợp lệ!",
                )
                .await
            } else {
                let selected = pick_random_accounts(accounts, count);

                let mut msg = String::from("🎮 ACC LIÊN QUÂN NGẪU NHIÊN:\n\n");
                for (i, (tk, mk)) in selected.iter().enumerate() {
                    msg.push_str(&format!("{}. 📱 Tài khoản: {tk}\n   🔑 Mật khẩu: {mk}\n\n", i + 1));
                }
                send_text_reply(&ctx, msg.trim_end()).await
            }
        }
        "scanapi" => {
            let target = query.trim();
            if target.is_empty() {
                return Err(CommandError::MissingArgument(format!(
                    "Vui lòng nhập URL API cần kiểm tra. Ví dụ: {}scanapi https://api.example.com",
                    ctx.prefix
                )));
            }
            match rt.crawlers.http().get(target).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    send_text_reply(&ctx, &format!("🔍 Quét API `{target}`:\n• HTTP Status: {status}\n• Phản hồi: Sẵn sàng")).await
                }
                Err(e) => send_text_reply(&ctx, &format!("⚠️ Quét API `{target}` thất bại: {e}")).await,
            }
        }
        "showcode" => {
            let filename = query.trim();
            if filename.is_empty() {
                return Err(CommandError::MissingArgument(format!(
                    "Vui lòng nhập tên file mã nguồn cần xem. Ví dụ: {}showcode package.json",
                    ctx.prefix
                )));
            }
            if filename.contains(".env") || filename.contains("credentials") || filename.contains("cookie") {
                return send_text_reply(&ctx, "⛔ Từ chối truy cập: File chứa thông tin bảo mật nhạy cảm!").await;
            }
            let path = std::path::Path::new(filename);
            if path.exists() && path.is_file() {
                match std::fs::read_to_string(path) {
                    Ok(content) => {
                        let lines: Vec<&str> = content.lines().take(30).collect();
                        send_text_reply(&ctx, &format!("📄 Mã nguồn `{filename}` (30 dòng đầu):\n```\n{}\n```", lines.join("\n"))).await
                    }
                    Err(e) => send_text_reply(&ctx, &format!("⚠️ Không đọc được file: {e}")).await,
                }
            } else {
                send_text_reply(&ctx, &format!("❌ Không tìm thấy file `{filename}` trong thư mục dự án.")).await
            }
        }
        "emote" => {
            let emotes = [
                "Evo P90 - Hoàng Kim Bất Diệt",
                "Evo M60 - Sát Thần Săn Mộng",
                "Evo MP5 - Thiên Thần Bạch Kim",
                "Evo Groza - Địa Chấn Sắc Màu",
                "Evo Thompson - Hắc Thạch Long",
                "Evo M1014 - Huyết Hỏa",
                "Evo MP40 - Tia Chớp Tử Thần",
                "Evo AK47 - Rồng Xanh",
                "Evo M4A1 - Hỏa Ngục",
            ];
            let pick = (deterministic_percent(&ctx.message.sender_uid, "emote") as usize) % emotes.len();
            send_text_reply(&ctx, &format!("🎭 Điệu nhảy / Emote súng VIP ngẫu nhiên của bạn: **{}** 🔥", emotes[pick])).await
        }
        other => Err(CommandError::Internal(format!(
            "Lệnh tiện ích `{other}` chưa được định nghĩa handler."
        ))),
    }
}
