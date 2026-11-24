//! Native 2D Card & Animated GIF Renderers (`src/utils/canvas/*` 100% V3 Parity).
//!
//! Renders V3 Zalo cards (PNG/WebP) and multi-frame `GIF89a` animations using SIMD
//! `Canvas2dCompat` + `FontManager` + `ImageCache` with zero raw V4 promo strings.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canvas2d::{Canvas2dCompat, GfxError, Rgba, encode_animated_gif};
use crate::font_manager::FontManager;
use crate::image_cache::ImageCache;

/// Complete V3 graphical card & animated GIF catalog (preserving all 40 core variants + specialized V3 cards).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    // 1..8 Group Event Banners
    Welcome,
    Goodbye,
    Kick,
    BlockSpam,
    MemberApprove,
    BotAdded,
    AdminChange,
    GroupSettingEvent,
    // 9..13 Profile & System Telemetry Cards
    UserInfo,
    BotInfo,
    GroupInfo,
    SystemConfig,
    ServerDashboard,
    // 14..17 Help & Command Catalog Grids
    HelpCard,
    CmdList,
    ManagerHelp,
    CustomCommandsGrid,
    // 18..23 Moderation & Admin Lists
    ListAdmin,
    ListBots,
    ListBlocked,
    ListBlockBot,
    ListMute,
    ListWhitelist,
    // 24..27 Leaderboards, Locmem & Anti-Service Setup
    RankLeaderboard,
    DailyRankCard,
    LocmemReport,
    SetupAntiCard,
    // 28..35 Weather, QR, Finance, Speedtest, CCCD & Status Post
    WeatherCard,
    WeatherHourly,
    BankQrCard,
    BusinessCardQr,
    SpeedtestCard,
    GoldPriceCard,
    CccdCard,
    StatusPost,
    // 36..40 Media Search, Mini-Games & Animated GIF
    MusicSearchCard,
    VideoSearchCard,
    GameTaixiuCard,
    GameBaucuaCard,
    GiftextAnimated,
    // Additional specialized V3 cards
    MusicCard,
    CalendarCard,
    CheckCard,
    KeyList,
    BotDetail,
    GoogleAiSnippet,
    Block,
    BlockSpamLink,
    AntiVideo,
    AntiStickerEffect,
}

impl CardKind {
    pub const ALL_40: [Self; 40] = [
        Self::Welcome,
        Self::Goodbye,
        Self::Kick,
        Self::BlockSpam,
        Self::MemberApprove,
        Self::BotAdded,
        Self::AdminChange,
        Self::GroupSettingEvent,
        Self::UserInfo,
        Self::BotInfo,
        Self::GroupInfo,
        Self::SystemConfig,
        Self::ServerDashboard,
        Self::HelpCard,
        Self::CmdList,
        Self::ManagerHelp,
        Self::CustomCommandsGrid,
        Self::ListAdmin,
        Self::ListBots,
        Self::ListBlocked,
        Self::ListBlockBot,
        Self::ListMute,
        Self::ListWhitelist,
        Self::RankLeaderboard,
        Self::DailyRankCard,
        Self::LocmemReport,
        Self::SetupAntiCard,
        Self::WeatherCard,
        Self::WeatherHourly,
        Self::BankQrCard,
        Self::BusinessCardQr,
        Self::SpeedtestCard,
        Self::GoldPriceCard,
        Self::CccdCard,
        Self::StatusPost,
        Self::MusicSearchCard,
        Self::VideoSearchCard,
        Self::GameTaixiuCard,
        Self::GameBaucuaCard,
        Self::GiftextAnimated,
    ];
}

#[derive(Clone, Default)]
pub struct CardRenderEngine {
    fonts: FontManager,
    images: ImageCache,
}

impl CardRenderEngine {
    pub fn new(fonts: FontManager) -> Self {
        Self {
            fonts,
            images: ImageCache::new(),
        }
    }

    pub fn fonts(&self) -> &FontManager {
        &self.fonts
    }

    pub fn images(&self) -> &ImageCache {
        &self.images
    }

    /// Prefetches all remote image URLs inside `data` into the bounded LRU cache and renders off the async executor.
    pub async fn render_async(
        &self,
        kind: CardKind,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        self.images.prefetch_json_urls(data).await;
        let engine = self.clone();
        let data_owned = data.clone();
        let avt_owned = avatar_bytes.map(ToOwned::to_owned);
        tokio::task::spawn_blocking(move || engine.render(kind, &data_owned, avt_owned.as_deref()))
            .await
            .map_err(|e| GfxError::Qr(format!("render task join error: {e}")))?
    }

    /// Dispatches any `CardKind` variant and returns encoded PNG (or `GIF89a` for `GiftextAnimated`) bytes.
    pub fn render(
        &self,
        kind: CardKind,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let avt_cached = self.images.get_sync(str_any(data, &["avatar", "avatarUrl", "avt"], ""));
        let eff_avt = avatar_bytes.or_else(|| avt_cached.as_deref().map(Vec::as_slice));

        match kind {
            CardKind::Welcome => {
                let member = str_any(data, &["memberName", "userName", "name"], "Thành viên mới");
                let group = str_any(data, &["groupName"], "Nhóm");
                let author = str_any(
                    data,
                    &["author", "actorName"],
                    "Tham Gia Trực Tiếp Hoặc Được Mời",
                );
                let sub = if let Some(cnt) = data.get("memberCount").and_then(Value::as_str)
                    && !cnt.is_empty()
                {
                    format!("Đã Tham Gia {group} • Thành viên #{cnt}")
                } else {
                    format!("Đã Tham Gia {group}")
                };
                self.render_event_banner(
                    group,
                    &format!("Chào mừng {member}"),
                    &sub,
                    author,
                    Rgba::hex(0xFFEE58, 255),
                    Rgba::hex(0x10B981, 255),
                    data,
                    eff_avt,
                )
            }
            CardKind::Goodbye => {
                let member = str_any(data, &["memberName", "userName", "name"], "Thành viên");
                let group = str_any(data, &["groupName"], "Nhóm");
                self.render_event_banner(
                    "Member Left The Group",
                    member,
                    str_any(data, &["subtitle"], "Vừa rời khỏi Nhóm"),
                    group,
                    Rgba::hex(0xE2E8F0, 255),
                    Rgba::hex(0xF59E0B, 255),
                    data,
                    eff_avt,
                )
            }
            CardKind::Kick
            | CardKind::Block
            | CardKind::BlockSpam
            | CardKind::BlockSpamLink
            | CardKind::AntiVideo
            | CardKind::AntiStickerEffect => {
                let member = str_any(data, &["memberName", "userName", "name"], "Thành viên");
                let group = str_any(data, &["groupName"], "Nhóm");
                let actor = str_any(data, &["actorName"], "Quản trị viên");
                let (badge, default_sub) = match kind {
                    CardKind::Kick => ("Kicked Out Member", format!("Đã Bị {actor} Sút Khỏi {group}")),
                    CardKind::Block => ("Blocked Out Member", format!("Đã Bị {actor} Chặn Khỏi {group}")),
                    CardKind::BlockSpamLink => (
                        "Blocked Out Spam Link Member",
                        format!("Do spam link đã bị chặn khỏi {group}"),
                    ),
                    CardKind::AntiVideo => (
                        "Anti Video",
                        format!("Gửi video không được phép trong {group}"),
                    ),
                    CardKind::AntiStickerEffect => (
                        "Anti Sticker Effect",
                        format!("Gửi sticker hiệu ứng bị cảnh báo trong {group}"),
                    ),
                    _ => (
                        "Blocked Out Spam Member",
                        format!("Do spam đã bị chặn khỏi {group}"),
                    ),
                };
                let sub = str_any(data, &["reason", "subtitle"], &default_sub);
                self.render_event_banner(
                    badge,
                    member,
                    sub,
                    group,
                    Rgba::hex(0xEF4444, 255),
                    Rgba::hex(0xF97316, 255),
                    data,
                    eff_avt,
                )
            }
            CardKind::MemberApprove
            | CardKind::BotAdded
            | CardKind::AdminChange
            | CardKind::GroupSettingEvent => {
                let badge = match kind {
                    CardKind::MemberApprove => "PHÊ DUYỆT THÀNH VIÊN",
                    CardKind::BotAdded => "KÍCH HOẠT BOT TRONG NHÓM",
                    CardKind::AdminChange => "CẬP NHẬT QUẢN TRỊ VIÊN",
                    _ => "THAY ĐỔI CÀI ĐẶT NHÓM",
                };
                self.render_event_banner(
                    badge,
                    str_any(data, &["title", "memberName"], "Thông báo nhóm"),
                    str_any(data, &["subtitle"], "Đã cập nhật trạng thái nhóm Zalo"),
                    str_any(data, &["footer", "groupName"], "Thanh Hùng"),
                    Rgba::hex(0x3B82F6, 255),
                    Rgba::hex(0x8B5CF6, 255),
                    data,
                    eff_avt,
                )
            }
            CardKind::UserInfo => self.render_user_info_v3(data, eff_avt),
            CardKind::GroupInfo => self.render_group_info_v3(data, eff_avt),
            CardKind::BotInfo | CardKind::BotDetail => self.render_bot_info_v3(kind, data, eff_avt),
            CardKind::CccdCard => self.render_cccd_card(data, eff_avt),
            CardKind::CheckCard => self.render_check_card(data, eff_avt),
            CardKind::KeyList => self.render_key_list_card(data),
            CardKind::GoogleAiSnippet => self.render_google_ai_snippet_card(data),
            CardKind::SystemConfig | CardKind::ServerDashboard | CardKind::SpeedtestCard => {
                self.render_telemetry_dashboard_card(kind, data)
            }
            CardKind::CmdList | CardKind::CustomCommandsGrid => self.render_cmd_list_4x4(kind, data),
            CardKind::HelpCard | CardKind::ManagerHelp => self.render_help_instructions_v3(kind, data),
            CardKind::BankQrCard | CardKind::BusinessCardQr => {
                self.render_qr_payment_or_contact_card(kind, data, eff_avt)
            }
            CardKind::WeatherCard | CardKind::WeatherHourly => self.render_weather_card(kind, data),
            CardKind::CalendarCard => self.render_calendar_card_v3(data),
            CardKind::SetupAntiCard => self.render_setup_anti_card(data),
            CardKind::StatusPost => self.render_status_post_card(data, eff_avt),
            CardKind::MusicCard => self.render_music_card(data, eff_avt),
            CardKind::MusicSearchCard | CardKind::VideoSearchCard => {
                if data.get("items").is_some() || data.get("results").is_some() {
                    self.render_search_result_grid(data)
                } else {
                    self.render_table_list_card(kind, data)
                }
            }
            CardKind::ListAdmin => self.render_list_admin_v3(data),
            CardKind::ListBots => self.render_list_bots_v3(data),
            CardKind::ListBlocked
            | CardKind::ListBlockBot
            | CardKind::ListMute
            | CardKind::ListWhitelist => self.render_member_moderation_list(kind, data),
            CardKind::GiftextAnimated => {
                let text = str_any(data, &["text"], "THANH HUNG BOT");
                self.render_giftext_animated(text, 720, 220)
            }
            _ => self.render_table_list_card(kind, data),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_event_banner(
        &self,
        badge: &str,
        headline: &str,
        subtitle: &str,
        footer: &str,
        accent_a: Rgba,
        accent_b: Rgba,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(1000, 380, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            1000.0,
            380.0,
            Rgba::hex(0x1E1E35, 255),
            Rgba::hex(0x131B36, 255),
            Rgba::hex(0x0B1120, 255),
        );
        if let Some(bg_raw) = self
            .images
            .get_sync(str_any(data, &["cover", "backgroundUrl"], ""))
            && let Ok(bg_img) = image::load_from_memory(&bg_raw)
        {
            c.draw_image_fit(&bg_img, 0, 0, 1000, 380, false);
            c.fill_rect(0.0, 0.0, 1000.0, 380.0, Rgba(15, 23, 42, 175));
        } else {
            c.fill_circle(160.0, 70.0, 140.0, Rgba(accent_a.0, accent_a.1, accent_a.2, 34));
            c.fill_circle(880.0, 320.0, 170.0, Rgba(accent_b.0, accent_b.1, accent_b.2, 34));
        }

        c.fill_rounded_rect(36.0, 34.0, 928.0, 312.0, 28.0, Rgba(15, 23, 42, 215));
        c.stroke_rounded_rect(36.0, 34.0, 928.0, 312.0, 28.0, 2.0, accent_a);

        c.draw_avatar_or_monogram(168.0, 190.0, 88.0, avatar_bytes, headline, accent_a);
        c.draw_line(284.0, 74.0, 284.0, 306.0, 2.0, Rgba(255, 255, 255, 85));

        let cx = 618.0;
        c.draw_text_centered(&c.ellipsize(badge, 600.0, 28.0, true), cx, 66.0, 28.0, accent_a, true);
        c.draw_text_centered(
            &c.ellipsize(headline, 600.0, 36.0, true),
            cx,
            124.0,
            36.0,
            Rgba::WHITE,
            true,
        );

        let lines = c.fonts().wrap_text(subtitle, 600.0, 23.0, "sans-serif", false, 2);
        for (i, line) in lines.iter().enumerate() {
            c.draw_text_centered(
                line,
                cx,
                190.0 + (i as f32) * 32.0,
                23.0,
                Rgba::hex(0xE2E8F0, 255),
                false,
            );
        }

        c.draw_line(320.0, 274.0, 916.0, 274.0, 1.5, Rgba(148, 163, 184, 60));
        c.draw_text_centered(&c.ellipsize(footer, 580.0, 21.0, true), cx, 292.0, 21.0, accent_b, true);
        c.encode_png()
    }

    /// `cmd-list-canvas.js`: V3 4×4 = 16 commands/page light glassmorphic grid (`1080×980`).
    fn render_cmd_list_4x4(&self, kind: CardKind, data: &Value) -> Result<Vec<u8>, GfxError> {
        let is_admin = data
            .get("isAdminList")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let prefix = str_any(data, &["prefix"], "!");
        let bot_name = str_any(data, &["botName"], "MyBot");
        let page = data.get("page").and_then(Value::as_u64).unwrap_or(1);
        let total_pages = data.get("totalPages").and_then(Value::as_u64).unwrap_or(1);

        let items: Vec<(String, String, u64, String)> = data
            .get("commands")
            .or_else(|| data.get("pageCommands"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|it| {
                        let name = str_any(it, &["name", "command"], "cmd").to_string();
                        let desc = str_any(it, &["description", "content"], "Lệnh hệ thống").to_string();
                        let cd = it
                            .get("countdown")
                            .or_else(|| it.get("cooldown"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let icon = str_any(it, &["icon"], "🔖").to_string();
                        (name, desc, cd, icon)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let total_cmds = data
            .get("totalCommands")
            .and_then(Value::as_u64)
            .unwrap_or(items.len() as u64);

        let w = 1080u32;
        let h = 984u32;
        let m = 28.0f32;
        let mut c = Canvas2dCompat::new(w, h, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            w as f32,
            h as f32,
            Rgba::hex(0xF8FAFC, 255),
            Rgba::hex(0xEEF4FF, 255),
            Rgba::hex(0xFEF6F3, 255),
        );
        c.fill_circle(160.0, 95.0, 220.0, Rgba(99, 102, 241, 28));
        c.fill_circle(960.0, 890.0, 250.0, Rgba(244, 114, 182, 26));

        let default_title = if kind == CardKind::CustomCommandsGrid {
            "DANH SÁCH LỆNH TÙY CHỈNH"
        } else if is_admin {
            "DANH SÁCH LỆNH ADMIN"
        } else {
            "DANH SÁCH LỆNH"
        };
        let title_col = if is_admin {
            Rgba::hex(0xB91C1C, 255)
        } else {
            Rgba::hex(0x1D4ED8, 255)
        };
        c.draw_text(
            str_any(data, &["title"], default_title),
            m,
            m + 6.0,
            34.0,
            title_col,
            "sans-serif",
            true,
        );
        c.draw_text(
            &format!("Bot: {bot_name}"),
            m,
            m + 52.0,
            18.5,
            Rgba::hex(0x1F2937, 255),
            "sans-serif",
            true,
        );
        let list_kind = if is_admin { "Admin" } else { "Thành viên" };
        c.draw_text(
            &format!("Tổng: {total_cmds} lệnh {list_kind}   •   Trang {page}/{total_pages}"),
            m,
            m + 82.0,
            15.0,
            Rgba::hex(0x475569, 255),
            "sans-serif",
            false,
        );

        let tag_bg = if is_admin {
            Rgba(239, 68, 68, 34)
        } else {
            Rgba(59, 130, 246, 34)
        };
        c.fill_rounded_rect(w as f32 - m - 140.0, m + 56.0, 140.0, 28.0, 14.0, tag_bg);
        c.draw_text_centered(
            if is_admin { "QUYỀN ADMIN" } else { "QUYỀN ALL" },
            w as f32 - m - 70.0,
            m + 61.0,
            13.5,
            title_col,
            true,
        );

        let card_w = (w as f32 - m * 2.0 - 14.0 * 3.0) / 4.0;
        let card_h = 178.0f32;
        let start_y = m + 132.0;

        if items.is_empty() {
            c.draw_text_centered(
                "Chưa có lệnh nào trong trang này.",
                w as f32 * 0.5,
                start_y + 320.0,
                20.0,
                Rgba::hex(0x64748B, 255),
                false,
            );
        } else {
            for (idx, (name, desc, cd, icon)) in items.iter().take(16).enumerate() {
                let col = (idx % 4) as f32;
                let row = (idx / 4) as f32;
                let cx = m + col * (card_w + 14.0);
                let cy = start_y + row * (card_h + 14.0);

                c.fill_rounded_rect(cx, cy, card_w, card_h, 14.0, Rgba(255, 255, 255, 224));
                c.stroke_rounded_rect(cx, cy, card_w, card_h, 14.0, 1.0, Rgba(15, 23, 42, 24));

                let icon_bg = if is_admin {
                    Rgba::hex(0xFECACA, 255)
                } else {
                    Rgba::hex(0xDBEAFE, 255)
                };
                c.fill_rounded_rect(cx + 14.0, cy + 14.0, 40.0, 40.0, 10.0, icon_bg);
                c.draw_text_centered(icon, cx + 34.0, cy + 20.0, 22.0, Rgba::hex(0x0F172A, 255), true);

                let sname = c.ellipsize(name, card_w - 78.0, 18.0, true);
                c.draw_text(
                    &sname,
                    cx + 64.0,
                    cy + 22.0,
                    18.0,
                    Rgba::hex(0x0F172A, 255),
                    "sans-serif",
                    true,
                );

                let lines = c
                    .fonts()
                    .wrap_text(desc, card_w - 28.0, 14.5, "sans-serif", false, 3);
                for (li, ln) in lines.iter().enumerate() {
                    c.draw_text(
                        ln,
                        cx + 14.0,
                        cy + 66.0 + (li as f32) * 20.0,
                        14.5,
                        Rgba::hex(0x475569, 255),
                        "sans-serif",
                        false,
                    );
                }

                c.draw_text(
                    &format!("CD {cd}s"),
                    cx + 14.0,
                    cy + card_h - 30.0,
                    13.5,
                    Rgba::hex(0x64748B, 255),
                    "sans-serif",
                    false,
                );

                c.fill_rounded_rect(cx + card_w - 72.0, cy + card_h - 32.0, 58.0, 20.0, 10.0, tag_bg);
                c.draw_text_centered(
                    if is_admin { "ADMIN" } else { "ALL" },
                    cx + card_w - 43.0,
                    cy + card_h - 29.0,
                    11.5,
                    title_col,
                    true,
                );
            }
        }

        let admin_arg = if is_admin { "admin " } else { "" };
        let default_footer = format!(
            "Dùng {prefix}cmd {admin_arg}[trang] để chuyển trang   •   {prefix}cmd map {admin_arg}để xem tất cả"
        );
        let footer = str_any(data, &["pageInfo", "footer"], &default_footer);
        c.draw_text(
            footer,
            m,
            h as f32 - 42.0,
            14.5,
            Rgba::hex(0x475569, 255),
            "sans-serif",
            false,
        );
        c.encode_png()
    }

    /// `help.js::createInstructionsImage` (`!help` & `!manager` V3 instruction list).
    fn render_help_instructions_v3(&self, kind: CardKind, data: &Value) -> Result<Vec<u8>, GfxError> {
        let mut all_rows: Vec<(String, String)> = Vec::new();
        let mut admin_rows: Vec<(String, String)> = Vec::new();

        if let Some(arr) = data.get("allMembers").and_then(Value::as_array) {
            for it in arr {
                let ic = str_any(it, &["icon"], "🔹");
                let cmd = str_any(it, &["command", "name"], "");
                let desc = str_any(it, &["description"], "");
                all_rows.push((format!("{ic} {cmd}"), format!(" -> {desc}")));
            }
        } else if let Some(arr) = data.get("commands").and_then(Value::as_array) {
            for it in arr {
                let ic = str_any(it, &["icon"], "🔹");
                let cmd = str_any(it, &["command", "name"], "");
                let desc = str_any(it, &["description"], "");
                all_rows.push((format!("{ic} {cmd}"), format!(" -> {desc}")));
            }
        }
        if let Some(arr) = data.get("admin").and_then(Value::as_array) {
            for it in arr {
                let ic = str_any(it, &["icon"], "🛡️");
                let cmd = str_any(it, &["command", "name"], "");
                let desc = str_any(it, &["description"], "");
                admin_rows.push((format!("{ic} {cmd}"), format!(" -> {desc}")));
            }
        }

        let w = 880u32;
        let total_lines = (all_rows.len() + admin_rows.len()).max(4);
        let h = (140 + total_lines * 50 + if !admin_rows.is_empty() { 70 } else { 0 } + 40).max(430) as u32;
        let mut c = Canvas2dCompat::new(w, h, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            w as f32,
            h as f32,
            Rgba::hex(0x0B1120, 255),
            Rgba::hex(0x1E1B4B, 255),
            Rgba::hex(0x111827, 255),
        );

        let default_title = if kind == CardKind::ManagerHelp {
            "BẢNG LỆNH QUẢN TRỊ NHÓM"
        } else {
            "HƯỚNG DẪN SỬ DỤNG LỆNH BOT"
        };
        let mut y = 38.0;
        c.draw_text_with_shadow(
            str_any(data, &["title"], default_title),
            36.0,
            y,
            28.0,
            Rgba::hex(0x38BDF8, 255),
            true,
        );
        y += 54.0;

        for (lhs, rhs) in &all_rows {
            c.draw_text(lhs, 36.0, y, 22.0, Rgba::hex(0xFDE047, 255), "sans-serif", true);
            let lw = c.fonts().measure_text_width(lhs, 22.0, "sans-serif", true);
            let srhs = c.ellipsize(rhs, w as f32 - 72.0 - lw, 20.0, false);
            c.draw_text(&srhs, 36.0 + lw, y + 2.0, 20.0, Rgba::WHITE, "sans-serif", false);
            y += 48.0;
        }

        if !admin_rows.is_empty() {
            y += 18.0;
            c.draw_text_with_shadow(
                str_any(data, &["titleAdmin"], "LỆNH QUẢN TRỊ VIÊN"),
                36.0,
                y,
                26.0,
                Rgba::hex(0xF472B6, 255),
                true,
            );
            y += 50.0;
            for (lhs, rhs) in &admin_rows {
                c.draw_text(lhs, 36.0, y, 22.0, Rgba::hex(0x34D399, 255), "sans-serif", true);
                let lw = c.fonts().measure_text_width(lhs, 22.0, "sans-serif", true);
                let srhs = c.ellipsize(rhs, w as f32 - 72.0 - lw, 20.0, false);
                c.draw_text(&srhs, 36.0 + lw, y + 2.0, 20.0, Rgba::WHITE, "sans-serif", false);
                y += 48.0;
            }
        }

        c.encode_png()
    }

    fn render_telemetry_dashboard_card(
        &self,
        kind: CardKind,
        data: &Value,
    ) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(980, 520, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            980.0,
            520.0,
            Rgba::hex(0x020617, 255),
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x064E3B, 255),
        );
        c.fill_rounded_rect(30.0, 30.0, 920.0, 460.0, 24.0, Rgba(15, 23, 42, 225));
        c.stroke_rounded_rect(30.0, 30.0, 920.0, 460.0, 24.0, 2.0, Rgba::hex(0x10B981, 200));

        let title = match kind {
            CardKind::SpeedtestCard => "KẾT QUẢ ĐO TỐC ĐỘ MẠNG (SPEEDTEST)",
            CardKind::SystemConfig => "CẤU HÌNH HỆ THỐNG BOT",
            _ => "BẢNG GIÁM SÁT HIỆU NĂNG HỆ THỐNG",
        };
        c.draw_text_with_shadow(
            str_any(data, &["title"], title),
            64.0,
            62.0,
            30.0,
            Rgba::hex(0x34D399, 255),
            true,
        );
        c.draw_text(
            str_any(data, &["subtitle"], "Thông số tài nguyên máy chủ thời gian thực"),
            64.0,
            106.0,
            19.0,
            Rgba::hex(0x94A3B8, 255),
            "sans-serif",
            false,
        );

        let metrics = [
            (
                str_any(data, &["m1Label"], "CPU Usage"),
                f32_or(data, "cpuRatio", 0.14),
                str_any(data, &["cpuText"], "14.0%"),
                Rgba::hex(0x38BDF8, 255),
            ),
            (
                str_any(data, &["m2Label"], "RAM Usage"),
                f32_or(data, "ramRatio", 0.22),
                str_any(data, &["ramText"], "120 MB"),
                Rgba::hex(0x10B981, 255),
            ),
            (
                str_any(data, &["m3Label"], "Ping / Độ trễ"),
                f32_or(data, "latRatio", 0.12),
                str_any(data, &["latText", "ping"], "12 ms"),
                Rgba::hex(0xA855F7, 255),
            ),
            (
                str_any(data, &["m4Label"], "Trạng thái"),
                f32_or(data, "botRatio", 0.85),
                str_any(data, &["botText"], "Đang hoạt động"),
                Rgba::hex(0xF59E0B, 255),
            ),
        ];

        for (i, (label, ratio, txt, col)) in metrics.iter().enumerate() {
            let y = 168.0 + (i as f32) * 74.0;
            c.draw_text(label, 64.0, y, 21.0, Rgba::WHITE, "sans-serif", true);
            c.draw_text_right(txt, 914.0, y, 21.0, *col, true);
            c.draw_progress_bar(64.0, y + 32.0, 850.0, 16.0, *ratio, Rgba(30, 41, 59, 255), *col);
        }

        c.encode_png()
    }

    fn render_qr_payment_or_contact_card(
        &self,
        kind: CardKind,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        if kind == CardKind::BusinessCardQr {
            let mut c = Canvas2dCompat::new(700, 900, self.fonts.clone())?;
            c.fill_linear_gradient_rect(
                0.0,
                0.0,
                700.0,
                900.0,
                Rgba::hex(0x0F172A, 255),
                Rgba::hex(0x1E1B4B, 255),
                Rgba::hex(0x064E3B, 255),
            );
            c.fill_rounded_rect(36.0, 36.0, 628.0, 828.0, 28.0, Rgba(15, 23, 42, 230));
            c.stroke_rounded_rect(36.0, 36.0, 628.0, 828.0, 28.0, 2.0, Rgba::hex(0x38BDF8, 190));
            let holder = str_any(data, &["displayName", "name", "accountName"], "Danh Thiếp Zalo");
            c.draw_avatar_or_monogram(350.0, 164.0, 74.0, avatar_bytes, holder, Rgba::hex(0x38BDF8, 255));
            c.draw_text_centered(holder, 350.0, 266.0, 32.0, Rgba::WHITE, true);
            c.draw_text_centered(
                &format!("UID: {}", str_any(data, &["uid", "accountNumber"], "N/A")),
                350.0,
                314.0,
                19.0,
                Rgba::hex(0x94A3B8, 255),
                false,
            );
            let qr_payload = str_any(data, &["qrPayload", "qrUrl"], "https://chat.zalo.me");
            if let Some(qr_raw) = self.images.get_sync(str_any(data, &["qrImageUrl"], ""))
                && let Ok(qr_img) = image::load_from_memory(&qr_raw)
            {
                c.draw_rounded_image_fit(&qr_img, 170, 370, 360, 360, 18.0);
            } else {
                c.draw_qr_code(qr_payload, 170.0, 370.0, 360.0, Rgba::hex(0x0F172A, 255), Rgba::WHITE)?;
            }
            c.draw_text_centered(
                str_any(data, &["memo", "bio"], "Quét mã QR bằng Zalo để kết bạn nhanh"),
                350.0,
                768.0,
                19.0,
                Rgba::hex(0x34D399, 255),
                true,
            );
            return c.encode_png();
        }

        let mut c = Canvas2dCompat::new(1000, 400, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            1000.0,
            400.0,
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x1E293B, 255),
            Rgba::hex(0x065F46, 255),
        );
        c.fill_rounded_rect(28.0, 28.0, 944.0, 344.0, 24.0, Rgba(15, 23, 42, 232));

        let qr_payload = str_any(data, &["qrPayload"], "https://img.vietqr.io");
        if let Some(qr_raw) = self.images.get_sync(str_any(data, &["qrImageUrl"], ""))
            && let Ok(qr_img) = image::load_from_memory(&qr_raw)
        {
            c.fill_rounded_rect(650.0, 52.0, 296.0, 296.0, 14.0, Rgba::WHITE);
            c.draw_rounded_image_fit(&qr_img, 658, 60, 280, 280, 10.0);
        } else {
            c.draw_qr_code(qr_payload, 650.0, 52.0, 296.0, Rgba::hex(0x0F172A, 255), Rgba::WHITE)?;
        }

        c.draw_text(
            "VIETQR CHUYỂN KHOẢN NHANH 24/7",
            60.0,
            60.0,
            19.0,
            Rgba::hex(0x34D399, 255),
            "sans-serif",
            true,
        );
        let holder = str_any(data, &["accountName", "displayName"], "CHỦ TÀI KHOẢN");
        c.draw_avatar_or_monogram(102.0, 148.0, 38.0, avatar_bytes, holder, Rgba::hex(0x34D399, 255));
        c.draw_text_with_shadow(
            &c.ellipsize(holder, 460.0, 30.0, true),
            158.0,
            128.0,
            30.0,
            Rgba::WHITE,
            true,
        );
        c.draw_text(
            &format!("Số tài khoản: {}", str_any(data, &["accountNumber"], "0000000000")),
            60.0,
            214.0,
            23.0,
            Rgba::hex(0xFDE047, 255),
            "sans-serif",
            true,
        );
        c.draw_text(
            &format!("Ngân hàng: {}", str_any(data, &["bankName"], "Napas 247")),
            60.0,
            254.0,
            20.0,
            Rgba::hex(0xE2E8F0, 255),
            "sans-serif",
            false,
        );
        let amount = str_any(data, &["amount"], "");
        let memo = str_any(data, &["memo", "addInfo"], "Chuyen khoan");
        let bottom_line = if amount.is_empty() {
            format!("Nội dung: {memo}")
        } else {
            format!("Số tiền: {amount}   •   ND: {memo}")
        };
        c.draw_text(
            &c.ellipsize(&bottom_line, 560.0, 19.0, true),
            60.0,
            296.0,
            19.0,
            Rgba::hex(0x38BDF8, 255),
            "sans-serif",
            true,
        );
        c.encode_png()
    }

    fn render_weather_card(&self, _kind: CardKind, data: &Value) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(940, 440, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            940.0,
            440.0,
            Rgba::hex(0x0C4A6E, 255),
            Rgba::hex(0x0284C7, 255),
            Rgba::hex(0x1E1B4B, 255),
        );
        c.fill_rounded_rect(30.0, 30.0, 880.0, 380.0, 26.0, Rgba(15, 23, 42, 190));
        c.draw_text(
            "DỰ BÁO THỜI TIẾT KHU VỰC",
            60.0,
            60.0,
            19.0,
            Rgba::hex(0x7DD3FC, 255),
            "sans-serif",
            true,
        );
        c.draw_text_with_shadow(
            str_any(data, &["location", "city", "area"], "Việt Nam"),
            60.0,
            98.0,
            38.0,
            Rgba::WHITE,
            true,
        );
        c.draw_text_with_shadow(
            str_any(data, &["temperature", "temp"], "--°C"),
            60.0,
            162.0,
            68.0,
            Rgba::hex(0xFDE047, 255),
            true,
        );
        let cond = str_any(
            data,
            &["condition", "description", "summary"],
            "Thời tiết hiện tại",
        );
        c.draw_text(cond, 60.0, 258.0, 22.0, Rgba::hex(0xE2E8F0, 255), "sans-serif", true);

        let mut details = Vec::new();
        for (k, lbl) in [
            ("humidity", "💧 Độ ẩm"),
            ("wind", "🌬️ Gió"),
            ("rainChance", "☔ Mưa"),
            ("uv", "☀️ UV"),
            ("aqi", "🍃 AQI"),
        ] {
            let v = str_any(data, &[k], "");
            if !v.is_empty() {
                details.push(format!("{lbl}: {v}"));
            }
        }
        if !details.is_empty() {
            c.draw_text(
                &details.join("   •   "),
                60.0,
                304.0,
                18.5,
                Rgba::hex(0xBAE6FD, 255),
                "sans-serif",
                false,
            );
        }

        if let Some(arr) = data.get("forecast").and_then(Value::as_array) {
            for (i, slot) in arr.iter().take(4).enumerate() {
                let fx = 520.0 + (i as f32) * 94.0;
                c.fill_rounded_rect(fx, 86.0, 86.0, 148.0, 14.0, Rgba(255, 255, 255, 22));
                c.draw_text_centered(
                    str_any(slot, &["time", "day"], "--"),
                    fx + 43.0,
                    102.0,
                    15.5,
                    Rgba::hex(0xBAE6FD, 255),
                    true,
                );
                c.draw_text_centered(
                    str_any(slot, &["temp"], "--°"),
                    fx + 43.0,
                    152.0,
                    22.0,
                    Rgba::hex(0xFDE047, 255),
                    true,
                );
                c.draw_text_centered(
                    str_any(slot, &["rain", "desc"], ""),
                    fx + 43.0,
                    196.0,
                    13.5,
                    Rgba::WHITE,
                    false,
                );
            }
        }
        c.encode_png()
    }

    fn render_setup_anti_card(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(1020, 620, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            1020.0,
            620.0,
            Rgba::hex(0x090D16, 255),
            Rgba::hex(0x111827, 255),
            Rgba::hex(0x31102F, 255),
        );
        c.draw_text_with_shadow(
            str_any(data, &["title"], "CẤU HÌNH BẢO VỆ NHÓM (ANTI-SHIELD)"),
            48.0,
            38.0,
            30.0,
            Rgba::hex(0xF472B6, 255),
            true,
        );

        let rules = [
            ("antiBot", "Chống Bot lạ"),
            ("onlyText", "Chỉ cho nhắn chữ"),
            ("antiPhotoVideo", "Chặn Ảnh/Video"),
            ("antiVoice", "Chặn Voice"),
            ("antiFile", "Chặn Tệp tin"),
            ("antiForward", "Chặn Chuyển tiếp"),
            ("antiLink", "Chặn Liên kết"),
            ("antiPhoneNumber", "Chặn Số ĐT"),
            ("antiTag", "Chặn Tag @All"),
            ("antiSpam", "Chống Spam nhanh"),
            ("antiBadWord", "Lọc Từ cấm"),
            ("antiNude", "Chặn Ảnh nhạy cảm"),
            ("antiStickerEffect", "Chặn Sticker hiệu ứng"),
            ("antiCard", "Chặn Danh thiếp"),
            ("antiUndo", "Chống Thu hồi"),
            ("welcomeGroup", "Chào mừng / Tạm biệt"),
        ];

        for (i, (key, label)) in rules.iter().enumerate() {
            let col = (i % 2) as f32;
            let row = (i / 2) as f32;
            let bx = 48.0 + col * 470.0;
            let by = 104.0 + row * 60.0;
            let on = data.get(*key).and_then(Value::as_bool).unwrap_or(false);
            c.fill_rounded_rect(bx, by, 450.0, 50.0, 12.0, Rgba(30, 41, 59, 215));
            c.draw_text(label, bx + 18.0, by + 13.0, 20.0, Rgba::WHITE, "sans-serif", true);
            let pill_col = if on {
                Rgba::hex(0x10B981, 255)
            } else {
                Rgba::hex(0x64748B, 255)
            };
            c.fill_rounded_rect(bx + 354.0, by + 11.0, 78.0, 28.0, 14.0, pill_col);
            c.draw_text_centered(
                if on { "BẬT" } else { "TẮT" },
                bx + 393.0,
                by + 15.0,
                16.0,
                Rgba::WHITE,
                true,
            );
        }
        c.encode_png()
    }

    fn render_status_post_card(
        &self,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(900, 480, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            900.0,
            480.0,
            Rgba::hex(0x1E1B4B, 255),
            Rgba::hex(0x312E81, 255),
            Rgba::hex(0x0F172A, 255),
        );
        c.fill_rounded_rect(44.0, 44.0, 812.0, 392.0, 28.0, Rgba(15, 23, 42, 225));
        let author = str_any(data, &["author", "name"], "Thành viên Zalo");
        c.draw_avatar_or_monogram(112.0, 112.0, 38.0, avatar_bytes, author, Rgba::hex(0x818CF8, 255));
        c.draw_text(author, 168.0, 86.0, 28.0, Rgba::WHITE, "sans-serif", true);
        c.draw_text(
            str_any(data, &["timestamp"], "Vừa xong"),
            168.0,
            122.0,
            17.0,
            Rgba::hex(0x94A3B8, 255),
            "sans-serif",
            false,
        );
        let content = str_any(data, &["text", "content"], "");
        let lines = c.fonts().wrap_text(content, 720.0, 28.0, "sans-serif", false, 5);
        for (i, line) in lines.iter().enumerate() {
            c.draw_text(
                line,
                84.0,
                188.0 + (i as f32) * 40.0,
                28.0,
                Rgba::WHITE,
                "sans-serif",
                false,
            );
        }
        c.encode_png()
    }

    fn render_cccd_card(
        &self,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(920, 560, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            920.0,
            560.0,
            Rgba::hex(0xDBEAFE, 255),
            Rgba::hex(0xEFF6FF, 255),
            Rgba::hex(0xFEF3C7, 255),
        );
        c.stroke_rounded_rect(20.0, 20.0, 880.0, 520.0, 24.0, 3.0, Rgba::hex(0x1D4ED8, 200));
        c.draw_text_centered(
            "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
            520.0,
            46.0,
            22.0,
            Rgba::hex(0xB91C1C, 255),
            true,
        );
        c.draw_text_centered(
            "CĂN CƯỚC CÔNG DÂN",
            520.0,
            84.0,
            30.0,
            Rgba::hex(0xB91C1C, 255),
            true,
        );
        let name = str_any(data, &["name", "fullName"], "NGUYỄN VĂN A");
        c.draw_avatar_or_monogram(156.0, 300.0, 92.0, avatar_bytes, name, Rgba::hex(0x1D4ED8, 255));
        let fields = [
            ("Số / No.:", str_any(data, &["idNumber", "cccd", "uid"], "001200012345")),
            ("Họ và tên:", name),
            ("Ngày sinh:", str_any(data, &["dob", "birthday"], "01/01/2000")),
            ("Giới tính:", str_any(data, &["gender"], "Nam")),
            ("Quê quán:", str_any(data, &["hometown", "origin"], "Việt Nam")),
            ("Nơi thường trú:", str_any(data, &["address"], "Việt Nam")),
        ];
        for (i, (k, v)) in fields.iter().enumerate() {
            let fy = 152.0 + (i as f32) * 56.0;
            c.draw_text(k, 290.0, fy, 18.5, Rgba::hex(0x334155, 255), "sans-serif", false);
            c.draw_text(
                &c.ellipsize(v, 420.0, 21.0, true),
                450.0,
                fy - 2.0,
                21.0,
                Rgba::hex(0x0F172A, 255),
                "sans-serif",
                true,
            );
        }
        c.encode_png()
    }

    fn render_check_card(
        &self,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(1000, 450, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            1000.0,
            450.0,
            Rgba::hex(0x0B1120, 255),
            Rgba::hex(0x1E1B4B, 255),
            Rgba::hex(0x0F172A, 255),
        );
        c.fill_rounded_rect(32.0, 32.0, 936.0, 386.0, 24.0, Rgba(15, 23, 42, 225));
        let name = str_any(data, &["name", "displayName"], "Thành viên");
        c.draw_avatar_or_monogram(154.0, 225.0, 82.0, avatar_bytes, name, Rgba::hex(0x38BDF8, 255));
        c.draw_text_with_shadow(name, 276.0, 74.0, 34.0, Rgba::WHITE, true);
        let stats = [
            ("Xếp hạng nhóm:", str_any(data, &["rank"], "#1")),
            ("Tổng tin nhắn:", str_any(data, &["totalMsgs", "msgCount"], "0")),
            ("Tương tác hôm nay:", str_any(data, &["dailyMsgs", "dailyCount"], "0")),
            ("Vai trò:", str_any(data, &["role"], "Thành viên")),
        ];
        for (i, (k, v)) in stats.iter().enumerate() {
            let sy = 152.0 + (i as f32) * 54.0;
            c.draw_text(k, 276.0, sy, 21.0, Rgba::hex(0x94A3B8, 255), "sans-serif", false);
            c.draw_text(v, 540.0, sy, 22.0, Rgba::hex(0x34D399, 255), "sans-serif", true);
        }
        c.encode_png()
    }

    fn render_key_list_card(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        self.render_member_moderation_list(CardKind::ListAdmin, data)
    }

    fn render_google_ai_snippet_card(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        let answer = str_any(data, &["answer", "snippet", "text"], "");
        let mut c = Canvas2dCompat::new(760, 460, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            760.0,
            460.0,
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x1E293B, 255),
            Rgba::hex(0x172554, 255),
        );
        c.fill_rounded_rect(28.0, 28.0, 704.0, 404.0, 22.0, Rgba(15, 23, 42, 230));
        c.draw_text(
            "GOOGLE SEARCH AI OVERVIEW",
            54.0,
            54.0,
            19.0,
            Rgba::hex(0x38BDF8, 255),
            "sans-serif",
            true,
        );
        c.draw_text_with_shadow(
            &c.ellipsize(str_any(data, &["query", "title"], "Kết quả tìm kiếm AI"), 650.0, 26.0, true),
            54.0,
            88.0,
            26.0,
            Rgba::WHITE,
            true,
        );
        let lines = c.fonts().wrap_text(answer, 650.0, 19.5, "sans-serif", false, 9);
        for (i, ln) in lines.iter().enumerate() {
            c.draw_text(
                ln,
                54.0,
                144.0 + (i as f32) * 28.0,
                19.5,
                Rgba::hex(0xE2E8F0, 255),
                "sans-serif",
                false,
            );
        }
        c.encode_png()
    }

    fn render_table_list_card(&self, kind: CardKind, data: &Value) -> Result<Vec<u8>, GfxError> {
        let rows: Vec<(String, String)> = data
            .get("rows")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .enumerate()
                    .map(|(i, it)| {
                        (
                            str_any(it, &["left", "brand", "name"], &format!("#{}", i + 1)).to_string(),
                            str_any(it, &["right", "price", "value"], "-").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_else(|| vec![("1. Chưa có dữ liệu".into(), "0".into())]);

        let visible = rows.len().clamp(1, 14);
        let w = if kind == CardKind::GoldPriceCard { 1100 } else { 920 };
        let h = 170 + (visible as u32) * 56;
        let mut c = Canvas2dCompat::new(w, h, self.fonts.clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            w as f32,
            h as f32,
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x1E293B, 255),
            Rgba::hex(0x090D16, 255),
        );
        let default_title = match kind {
            CardKind::RankLeaderboard => "BẢNG XẾP HẠNG TƯƠNG TÁC NHÓM",
            CardKind::DailyRankCard => "TOP TƯƠNG TÁC HÔM NAY",
            CardKind::LocmemReport => "BÁO CÁO LỌC THÀNH VIÊN KÉM TƯƠNG TÁC",
            CardKind::GoldPriceCard => "BẢNG GIÁ VÀNG HÔM NAY",
            CardKind::MusicSearchCard => "KẾT QUẢ TÌM KIẾM NHẠC",
            CardKind::VideoSearchCard => "KẾT QUẢ TÌM KIẾM VIDEO",
            _ => "DANH SÁCH THỐNG KÊ",
        };
        c.draw_text_with_shadow(
            str_any(data, &["title"], default_title),
            48.0,
            42.0,
            30.0,
            Rgba::hex(0xFBBF24, 255),
            true,
        );
        c.draw_text(
            str_any(data, &["subtitle"], "Cập nhật dữ liệu trực tuyến"),
            48.0,
            84.0,
            18.0,
            Rgba::hex(0x94A3B8, 255),
            "sans-serif",
            false,
        );

        let row_w = w as f32 - 96.0;
        for (i, (left, right)) in rows.iter().take(14).enumerate() {
            let y = 132.0 + (i as f32) * 54.0;
            c.fill_rounded_rect(48.0, y, row_w, 46.0, 10.0, Rgba(30, 41, 59, 210));
            c.draw_text(
                &c.ellipsize(left, row_w * 0.62, 20.0, true),
                68.0,
                y + 11.0,
                20.0,
                Rgba::WHITE,
                "sans-serif",
                true,
            );
            c.draw_text_right(
                &c.ellipsize(right, row_w * 0.34, 20.0, true),
                48.0 + row_w - 20.0,
                y + 11.0,
                20.0,
                Rgba::hex(0x38BDF8, 255),
                true,
            );
        }
        c.encode_png()
    }

    /// Generates an 8-frame neon wave animated `GIF89a` for `!giftext`.
    pub fn render_giftext_animated(
        &self,
        text: &str,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, GfxError> {
        let palette = [
            Rgba::hex(0x38BDF8, 255),
            Rgba::hex(0xA855F7, 255),
            Rgba::hex(0xEC4899, 255),
            Rgba::hex(0xF43F5E, 255),
            Rgba::hex(0xF59E0B, 255),
            Rgba::hex(0x10B981, 255),
            Rgba::hex(0x06B6D4, 255),
            Rgba::hex(0x6366F1, 255),
        ];

        let mut frames = Vec::with_capacity(8);
        for (idx, accent) in palette.iter().enumerate() {
            let mut f = Canvas2dCompat::new(width, height, self.fonts.clone())?;
            let next_col = palette[(idx + 3) % palette.len()];
            f.fill_linear_gradient_rect(
                0.0,
                0.0,
                width as f32,
                height as f32,
                Rgba::hex(0x090D16, 255),
                Rgba(accent.0 / 3, accent.1 / 3, accent.2 / 3, 255),
                Rgba::hex(0x0F172A, 255),
            );
            f.stroke_rounded_rect(
                12.0,
                12.0,
                width as f32 - 24.0,
                height as f32 - 24.0,
                18.0,
                3.0,
                *accent,
            );
            let wave_y =
                (height as f32) * 0.34 + ((idx as f32 * std::f32::consts::PI / 4.0).sin() * 10.0);
            f.draw_text_centered(
                text,
                (width as f32) * 0.5 + 2.0,
                wave_y + 2.0,
                44.0,
                next_col,
                true,
            );
            f.draw_text_centered(text, (width as f32) * 0.5, wave_y, 44.0, Rgba::WHITE, true);
            frames.push(f);
        }
        encode_animated_gif(&frames, 8)
    }
}

pub(crate) fn str_any<'a>(v: &'a Value, keys: &[&str], fallback: &'a str) -> &'a str {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            return s;
        }
    }
    fallback
}

pub(crate) fn f32_or(v: &Value, key: &str, fallback: f32) -> f32 {
    v.get(key)
        .and_then(Value::as_f64)
        .map(|n| n as f32)
        .unwrap_or(fallback)
}
