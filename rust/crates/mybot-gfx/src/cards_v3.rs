//! Specialized 1:1 V3 Canvas Renderers (`search-canvas.js`, `music-canvas.js`, `info.js`,
//! `nqduan-detail-renderer.js`, `listadmin-canvas.js`, `listbots-canvas.js`, `listblocked-canvas.js`, `lich.js`).

use serde_json::Value;

use crate::canvas2d::{Canvas2dCompat, GfxError, Rgba};
use crate::renderers::{CardKind, CardRenderEngine, f32_or, str_any};

impl CardRenderEngine {
    /// `search-canvas.js`: 1–3 column search result grid (up to 30 items, circular thumbnail, `#1..N` badge, stats).
    pub(crate) fn render_search_result_grid(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        let raw_items = data
            .get("items")
            .or_else(|| data.get("results"))
            .or_else(|| data.get("rows"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let limited: Vec<&Value> = raw_items.iter().take(30).collect();
        if limited.is_empty() {
            let mut c = Canvas2dCompat::new(640, 180, self.fonts().clone())?;
            c.fill_linear_gradient_rect(
                0.0,
                0.0,
                640.0,
                180.0,
                Rgba::hex(0x0F172A, 255),
                Rgba::hex(0x1E293B, 255),
                Rgba::hex(0x090D16, 255),
            );
            c.draw_text_centered(
                str_any(data, &["emptyText", "title"], "Không tìm thấy kết quả phù hợp"),
                320.0,
                74.0,
                24.0,
                Rgba::WHITE,
                true,
            );
            return c.encode_png();
        }

        let max_rows = 10usize;
        let num_cols = limited.len().div_ceil(max_rows).clamp(1, 3);
        let rows_in_first = limited.len().min(max_rows);
        let col_w = 560.0f32;
        let col_gap = 28.0f32;
        let pad = 20.0f32;
        let header_h = if data.get("title").is_some() { 58.0 } else { 0.0 };
        let w = (col_w * (num_cols as f32) + col_gap * ((num_cols - 1) as f32) + pad * 2.0) as u32;
        let h = (header_h + (rows_in_first as f32) * 144.0 + pad * 2.0) as u32;

        let mut c = Canvas2dCompat::new(w, h, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            w as f32,
            h as f32,
            Rgba::hex(0x111827, 255),
            Rgba::hex(0x0B0F19, 255),
            Rgba::hex(0x030712, 255),
        );

        if header_h > 0.0 {
            c.draw_text(
                str_any(data, &["title"], "KẾT QUẢ TÌM KIẾM"),
                pad,
                18.0,
                26.0,
                Rgba::hex(0x38BDF8, 255),
                "sans-serif",
                true,
            );
        }

        for (idx, item) in limited.iter().enumerate() {
            let col = idx / max_rows;
            let row = idx % max_rows;
            let sx = pad + (col as f32) * (col_w + col_gap);
            let sy = pad + header_h + (row as f32) * 144.0;

            c.fill_rounded_rect(sx, sy, col_w, 128.0, 12.0, Rgba(255, 255, 255, 26));
            c.fill_rounded_rect(sx, sy, 48.0, 38.0, 10.0, Rgba::hex(0x4CAF50, 255));
            c.draw_text_centered(
                &format!("{}", idx + 1),
                sx + 24.0,
                sy + 7.0,
                21.0,
                Rgba::WHITE,
                true,
            );

            let title = str_any(item, &["title", "name", "left"], "Không có tiêu đề");
            let artist = str_any(
                item,
                &["artistsNames", "artists", "author", "channel", "subtitle", "right"],
                "",
            );
            let thumb_url = str_any(
                item,
                &["thumbnailM", "thumbnail", "cover", "avatar", "thumb"],
                "",
            );
            let thumb_bytes = self.images().get_sync(thumb_url);
            c.draw_avatar_or_monogram(
                sx + 108.0,
                sy + 64.0,
                50.0,
                thumb_bytes.as_deref().map(Vec::as_slice),
                title,
                Rgba(255, 255, 255, 110),
            );

            c.fill_rect(sx + 172.0, sy + 18.0, 2.5, 92.0, Rgba(255, 255, 255, 50));

            let tx = sx + 188.0;
            let max_tw = col_w - 202.0;
            let short_title = c.ellipsize(title, max_tw, 21.0, true);
            c.draw_text(&short_title, tx, sy + 14.0, 21.0, Rgba::WHITE, "sans-serif", true);

            if !artist.is_empty() {
                let short_artist = c.ellipsize(artist, max_tw, 17.0, false);
                c.draw_text(
                    &short_artist,
                    tx,
                    sy + 48.0,
                    17.0,
                    Rgba::hex(0xCCCCCC, 255),
                    "sans-serif",
                    false,
                );
            }

            let mut stats = Vec::new();
            if let Some(rk) = item.get("rank").or_else(|| item.get("rankChart")) {
                let s = val_compact(rk);
                if !s.is_empty() {
                    stats.push(format!("🏆 Top {s}"));
                }
            }
            for (k, icon) in [
                ("view", "👀"),
                ("views", "👀"),
                ("listen", "🎧"),
                ("like", "❤️"),
                ("duration", "🕒"),
                ("publishedTime", "🕒"),
            ] {
                if let Some(v) = item.get(k) {
                    let s = val_compact(v);
                    if !s.is_empty() && s != "0" {
                        stats.push(format!("{icon} {s}"));
                    }
                }
            }
            if item.get("isOfficial").and_then(Value::as_bool) == Some(true) {
                stats.push("✅ Official".to_string());
            }
            if item.get("isPremium").and_then(Value::as_bool) == Some(true) {
                stats.push("💳 [ Premium ]".to_string());
            }
            let stats_line = if stats.is_empty() {
                str_any(item, &["stats", "meta"], "").to_string()
            } else {
                stats.join(" • ")
            };
            if !stats_line.is_empty() {
                let short_stats = c.ellipsize(&stats_line, max_tw, 15.5, false);
                c.draw_text(
                    &short_stats,
                    tx,
                    sy + 84.0,
                    15.5,
                    Rgba::hex(0x93C5FD, 255),
                    "sans-serif",
                    false,
                );
            }
        }

        c.encode_png()
    }

    /// `music-canvas.js`: `660×200` single playing track card.
    pub(crate) fn render_music_card(
        &self,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let mut c = Canvas2dCompat::new(660, 200, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            660.0,
            200.0,
            Rgba::hex(0x1E293B, 255),
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x172554, 255),
        );

        let thumb_url = str_any(data, &["thumbnailPath", "thumbnailM", "thumbnail", "cover"], "");
        let cached_thumb = self.images().get_sync(thumb_url);
        let thumb_slice = cached_thumb.as_deref().map(Vec::as_slice).or(avatar_bytes);
        if let Some(raw) = thumb_slice
            && let Ok(bg_img) = image::load_from_memory(raw)
        {
            c.draw_image_fit(&bg_img, 0, 0, 660, 200, false);
            c.fill_rect(0.0, 0.0, 660.0, 200.0, Rgba(8, 12, 24, 205));
        }

        let title = str_any(data, &["title", "name"], "Bài hát đang phát");
        c.draw_avatar_or_monogram(115.0, 100.0, 72.0, thumb_slice, title, Rgba::hex(0x38BDF8, 255));

        let source = str_any(data, &["source", "platform"], "ZingMp3");
        c.fill_rounded_rect(142.0, 134.0, 56.0, 26.0, 13.0, Rgba::hex(0x0EA5E9, 235));
        let src_short: String = source.chars().take(5).collect();
        c.draw_text_centered(&src_short.to_uppercase(), 170.0, 139.0, 12.5, Rgba::WHITE, true);

        let tx = 216.0;
        let max_w = 365.0;
        let title_lines = c.fonts().wrap_text(title, max_w, 22.0, "sans-serif", true, 2);
        let mut ty = if title_lines.len() > 1 { 26.0 } else { 36.0 };
        for line in &title_lines {
            c.draw_text_with_shadow(line, tx, ty, 22.0, Rgba::hex(0xFDE047, 255), true);
            ty += 26.0;
        }

        let artist = format!(
            "Artist: {}",
            str_any(data, &["artists", "artistsNames", "author"], "Unknown")
        );
        let short_artist = c.ellipsize(&artist, max_w, 18.0, false);
        c.draw_text(&short_artist, tx, ty + 4.0, 18.0, Rgba::hex(0xE2E8F0, 255), "sans-serif", false);

        let rank_part = data
            .get("rank")
            .map(val_compact)
            .filter(|s| !s.is_empty())
            .map(|r| format!(" - 🏆 Top {r} BXH"))
            .unwrap_or_default();
        let from_line = format!("From {source}{rank_part}");
        c.draw_text(
            &c.ellipsize(&from_line, max_w, 16.5, true),
            tx,
            ty + 32.0,
            16.5,
            Rgba::hex(0x38BDF8, 255),
            "sans-serif",
            true,
        );

        let mut stats = Vec::new();
        for (k, ic) in [
            ("listen", "🎧"),
            ("viewCount", "👀"),
            ("like", "💜"),
            ("comment", "💬"),
            ("duration", "🕒"),
        ] {
            if let Some(v) = data.get(k) {
                let s = val_compact(v);
                if !s.is_empty() && s != "0" {
                    stats.push(format!("{ic} {s}"));
                }
            }
        }
        if !stats.is_empty() {
            c.draw_text(
                &c.ellipsize(&stats.join("   "), max_w, 15.5, false),
                tx,
                ty + 60.0,
                15.5,
                Rgba::WHITE,
                "sans-serif",
                false,
            );
        }

        let user_avt_url = str_any(data, &["userAvatar"], "");
        if !user_avt_url.is_empty() {
            let ua = self.images().get_sync(user_avt_url);
            c.draw_avatar_or_monogram(
                614.0,
                154.0,
                26.0,
                ua.as_deref().map(Vec::as_slice),
                "U",
                Rgba::hex(0xA855F7, 255),
            );
        }

        c.encode_png()
    }

    /// `info.js::createUserInfoImage` (`1080px` modern dark aurora profile card).
    pub(crate) fn render_user_info_v3(
        &self,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let width = 1080u32;
        let pad = 36.0f32;
        let cover_h = 300.0f32;
        let grid_gap = 18.0f32;
        let card_h = 98.0f32;

        let name = str_any(data, &["name", "displayName", "zaloName"], "Người dùng Zalo");
        let uid = str_any(data, &["uid", "userId"], "N/A");
        let bio = str_any(data, &["bio", "status"], "");
        let show_bio = !bio.is_empty() && bio != "Không có thông tin bio";

        let cards: Vec<(String, String)> = if let Some(arr) = data.get("fields").and_then(Value::as_array) {
            arr.iter()
                .map(|it| {
                    (
                        str_any(it, &["label"], "Mục").to_string(),
                        str_any(it, &["value"], "N/A").to_string(),
                    )
                })
                .collect()
        } else {
            let mut devs = Vec::new();
            if data.get("isActive").and_then(Value::as_bool) == Some(true) {
                devs.push("Mobile");
            }
            if data.get("isActivePC").and_then(Value::as_bool) == Some(true) {
                devs.push("PC");
            }
            if data.get("isActiveWeb").and_then(Value::as_bool) == Some(true) {
                devs.push("Web");
            }
            let dev_str = if devs.is_empty() {
                str_any(data, &["device", "platform"], "Mobile").to_string()
            } else {
                devs.join(" / ")
            };
            vec![
                ("GIỚI TÍNH".into(), str_any(data, &["gender"], "N/A").into()),
                ("SINH NHẬT".into(), str_any(data, &["birthday", "dob"], "N/A").into()),
                ("THIẾT BỊ".into(), dev_str),
                (
                    "LOẠI TÀI KHOẢN".into(),
                    str_any(data, &["businessType", "accountType", "role"], "Cá nhân").into(),
                ),
                ("NGÀY TẠO".into(), str_any(data, &["createdDate", "createdAt"], "N/A").into()),
                (
                    "HOẠT ĐỘNG GẦN NHẤT".into(),
                    str_any(data, &["lastActive", "statusText"], "Đang hoạt động").into(),
                ),
            ]
        };

        let rows = cards.len().clamp(1, 8).div_ceil(2) as f32;
        let grid_h = rows * card_h + (rows - 1.0) * grid_gap;
        let bio_h = if show_bio { 126.0 } else { 0.0 };
        let height = (pad + cover_h + 44.0 + grid_h + if show_bio { grid_gap + bio_h } else { 0.0 } + 62.0) as u32;

        let mut c = Canvas2dCompat::new(width, height, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            width as f32,
            height as f32,
            Rgba::hex(0x07091A, 255),
            Rgba::hex(0x0E1130, 255),
            Rgba::hex(0x1A0E2E, 255),
        );

        let cover_w = width as f32 - pad * 2.0;
        let cover_url = str_any(data, &["cover"], "");
        if let Some(cov_raw) = self.images().get_sync(cover_url)
            && let Ok(cov_img) = image::load_from_memory(&cov_raw)
        {
            c.draw_rounded_image_fit(&cov_img, pad as i32, pad as i32, cover_w as u32, cover_h as u32, 24.0);
            c.fill_rounded_rect(pad, pad, cover_w, cover_h, 24.0, Rgba(7, 9, 26, 145));
        } else {
            c.fill_rounded_rect(pad, pad, cover_w, cover_h, 24.0, Rgba::hex(0x1E1B4B, 245));
            c.fill_circle(pad + 130.0, pad + 90.0, 110.0, Rgba(167, 139, 250, 55));
            c.fill_circle(pad + cover_w - 160.0, pad + cover_h - 70.0, 130.0, Rgba(34, 211, 238, 45));
        }
        c.stroke_rounded_rect(pad, pad, cover_w, cover_h, 24.0, 1.5, Rgba(255, 255, 255, 48));

        let avt_url = str_any(data, &["avatar", "avatarUrl"], "");
        let avt_cached = self.images().get_sync(avt_url);
        let avt_slice = avatar_bytes.or_else(|| avt_cached.as_deref().map(Vec::as_slice));
        let avt_cx = pad + 140.0;
        let avt_cy = pad + cover_h - 62.0;
        c.draw_avatar_or_monogram(avt_cx, avt_cy, 84.0, avt_slice, name, Rgba::hex(0xA78BFA, 255));

        let is_online = data.get("isOnline").and_then(Value::as_bool).unwrap_or(true);
        c.fill_circle(
            avt_cx + 62.0,
            avt_cy + 62.0,
            13.0,
            if is_online {
                Rgba::hex(0x10B981, 255)
            } else {
                Rgba::hex(0x64748B, 255)
            },
        );
        c.stroke_circle(avt_cx + 62.0, avt_cy + 62.0, 13.0, 2.5, Rgba::WHITE);

        c.draw_text_with_shadow(name, avt_cx + 112.0, pad + cover_h - 108.0, 34.0, Rgba::WHITE, true);
        c.draw_text(
            &format!("UID: {uid}"),
            avt_cx + 112.0,
            pad + cover_h - 60.0,
            18.0,
            Rgba(255, 255, 255, 195),
            "sans-serif",
            false,
        );

        let card_w = (cover_w - grid_gap) * 0.5;
        let grid_y = pad + cover_h + 40.0;
        for (idx, (label, val)) in cards.iter().take(8).enumerate() {
            let col = (idx % 2) as f32;
            let row = (idx / 2) as f32;
            let cx = pad + col * (card_w + grid_gap);
            let cy = grid_y + row * (card_h + grid_gap);
            c.fill_rounded_rect(cx, cy, card_w, card_h, 18.0, Rgba(255, 255, 255, 18));
            c.stroke_rounded_rect(cx, cy, card_w, card_h, 18.0, 1.0, Rgba(255, 255, 255, 32));
            c.fill_rect(cx + 18.0, cy + 16.0, 36.0, 3.0, Rgba::hex(0x22D3EE, 210));
            c.draw_text(
                &label.to_uppercase(),
                cx + 18.0,
                cy + 26.0,
                14.5,
                Rgba(255, 255, 255, 155),
                "sans-serif",
                true,
            );
            let short_v = c.ellipsize(val, card_w - 36.0, 21.0, true);
            c.draw_text(&short_v, cx + 18.0, cy + 56.0, 21.0, Rgba::WHITE, "sans-serif", true);
        }

        if show_bio {
            let by = grid_y + grid_h + grid_gap;
            c.fill_rounded_rect(pad, by, cover_w, bio_h, 18.0, Rgba(255, 255, 255, 16));
            c.stroke_rounded_rect(pad, by, cover_w, bio_h, 18.0, 1.0, Rgba(255, 255, 255, 30));
            c.draw_text("BIO", pad + 24.0, by + 18.0, 15.0, Rgba(255, 255, 255, 155), "sans-serif", true);
            let lines = c.fonts().wrap_text(bio, cover_w - 48.0, 19.0, "sans-serif", false, 2);
            for (li, ln) in lines.iter().enumerate() {
                c.draw_text(
                    ln,
                    pad + 24.0,
                    by + 50.0 + (li as f32) * 28.0,
                    19.0,
                    Rgba::hex(0xF1F5F9, 255),
                    "sans-serif",
                    false,
                );
            }
        }

        c.draw_text_right(
            "MYBOT  •  USER PROFILE",
            width as f32 - pad,
            height as f32 - 34.0,
            13.5,
            Rgba(255, 255, 255, 95),
            true,
        );
        c.encode_png()
    }

    /// `info.js::createGroupInfoImage` (`1000px` group overview + 10 Zalo group settings + description).
    pub(crate) fn render_group_info_v3(
        &self,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let w = 1000u32;
        let pad = 24.0f32;
        let gname = str_any(data, &["name", "groupName"], "Nhóm Zalo");
        let owner_name = str_any(data, &["ownerName", "creatorName", "owner"], "Trưởng nhóm");
        let desc = str_any(data, &["desc", "description"], "");
        let has_desc = !desc.is_empty();

        let settings_spec = [
            ("blockName", "Chặn đổi tên nhóm", false),
            ("signAdminMsg", "Ký tên quản trị viên", false),
            ("addMemberOnly", "Chỉ quản trị viên thêm thành viên", false),
            ("setTopicOnly", "Chỉ quản trị viên đặt chủ đề", true),
            ("enableMsgHistory", "Lịch sử tin nhắn cho thành viên mới", false),
            ("lockCreatePost", "Khóa tạo bài viết", false),
            ("lockCreatePoll", "Khóa tạo bình chọn", false),
            ("joinAppr", "Phê duyệt thành viên tham gia", false),
            ("lockSendMsg", "Khóa gửi tin nhắn", false),
            ("lockViewMember", "Khóa xem danh sách thành viên", false),
        ];

        let info_h = 225.0f32;
        let set_h = 390.0f32;
        let desc_h = if has_desc { 150.0f32 } else { 0.0f32 };
        let h = (180.0 + info_h + 24.0 + set_h + if has_desc { 24.0 + desc_h } else { 0.0 } + 44.0) as u32;

        let mut c = Canvas2dCompat::new(w, h, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            w as f32,
            h as f32,
            Rgba::hex(0x050814, 255),
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x111827, 255),
        );

        let avt_url = str_any(data, &["avt", "avatar"], "");
        let avt_cached = self.images().get_sync(avt_url);
        let avt_slice = avatar_bytes.or_else(|| avt_cached.as_deref().map(Vec::as_slice));
        c.draw_avatar_or_monogram(98.0, 92.0, 56.0, avt_slice, gname, Rgba::hex(0x38BDF8, 255));

        c.draw_text_with_shadow(
            &c.ellipsize(&format!("★ {gname}"), 780.0, 32.0, true),
            176.0,
            48.0,
            32.0,
            Rgba::hex(0x22D3EE, 255),
            true,
        );
        c.draw_text(
            &format!("Trưởng Nhóm: {owner_name}"),
            176.0,
            98.0,
            22.0,
            Rgba::WHITE,
            "sans-serif",
            false,
        );

        let box_w = w as f32 - pad * 2.0;
        let mut cy = 172.0;
        c.fill_rounded_rect(pad, cy, box_w, info_h, 14.0, Rgba(255, 255, 255, 20));
        c.stroke_rounded_rect(pad, cy, box_w, info_h, 14.0, 1.5, Rgba(255, 255, 255, 38));
        c.draw_text_centered("Group Info", w as f32 * 0.5, cy + 14.0, 24.0, Rgba::hex(0xFDE047, 255), true);

        let gid = str_any(data, &["groupId", "uid", "threadId"], "N/A");
        let members = data
            .get("memberCount")
            .or_else(|| data.get("totalMember"))
            .map(val_compact)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "0".to_string());
        let created = str_any(data, &["createdTime", "createdDate"], "N/A");
        let gtype = if data.get("groupType").and_then(Value::as_u64) == Some(2) {
            "Cộng Đồng"
        } else {
            str_any(data, &["groupTypeLabel"], "Nhóm")
        };
        let admins = data
            .get("adminCount")
            .map(val_compact)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "1".to_string());

        for (i, line) in [
            format!("🆔 ID: {gid}"),
            format!("👥 Thành viên: {members}"),
            format!("📅 Ngày tạo: {created}"),
            format!("🏷️ Loại: {gtype}"),
            format!("👑 Quản trị: {admins}"),
        ]
        .iter()
        .enumerate()
        {
            c.draw_text(line, pad + 24.0, cy + 56.0 + (i as f32) * 32.0, 19.5, Rgba::WHITE, "sans-serif", false);
        }

        cy += info_h + 24.0;
        c.fill_rounded_rect(pad, cy, box_w, set_h, 14.0, Rgba(255, 255, 255, 20));
        c.stroke_rounded_rect(pad, cy, box_w, set_h, 14.0, 1.5, Rgba(255, 255, 255, 38));
        c.draw_text_centered("Cài đặt nhóm", w as f32 * 0.5, cy + 14.0, 24.0, Rgba::hex(0x22D3EE, 255), true);

        let setting_obj = data.get("setting").or_else(|| data.get("settings"));
        for (i, (key, label, inverted)) in settings_spec.iter().enumerate() {
            let raw_val = setting_obj
                .and_then(|s| s.get(*key))
                .map(|v| v.as_i64().unwrap_or_else(|| i64::from(v.as_bool().unwrap_or(false))))
                .unwrap_or(0);
            let enabled = if *inverted { raw_val == 0 } else { raw_val == 1 };
            let sy = cy + 56.0 + (i as f32) * 32.0;
            c.draw_text(label, pad + 24.0, sy, 19.0, Rgba::WHITE, "sans-serif", false);
            c.draw_text_right(
                if enabled { "✓ Bật" } else { "✗ Tắt" },
                pad + box_w - 28.0,
                sy,
                19.0,
                if enabled {
                    Rgba::hex(0x34D399, 255)
                } else {
                    Rgba::hex(0xEF4444, 255)
                },
                true,
            );
        }

        if has_desc {
            cy += set_h + 24.0;
            c.fill_rounded_rect(pad, cy, box_w, desc_h, 14.0, Rgba(255, 255, 255, 20));
            c.stroke_rounded_rect(pad, cy, box_w, desc_h, 14.0, 1.5, Rgba(255, 255, 255, 38));
            c.draw_text_centered("Mô tả nhóm", w as f32 * 0.5, cy + 14.0, 23.0, Rgba::hex(0xFDE047, 255), true);
            let lines = c.fonts().wrap_text(desc, box_w - 48.0, 18.5, "sans-serif", false, 3);
            for (li, ln) in lines.iter().enumerate() {
                c.draw_text(ln, pad + 24.0, cy + 56.0 + (li as f32) * 28.0, 18.5, Rgba::WHITE, "sans-serif", false);
            }
        }

        c.encode_png()
    }

    /// `info.js::createBotInfoImage` + `nqduan-detail-renderer.js` (`!detail` / `!mybot detail` with dual Pie Charts & Group Configs).
    pub(crate) fn render_bot_info_v3(
        &self,
        kind: CardKind,
        data: &Value,
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Vec<u8>, GfxError> {
        let on_cfgs: Vec<String> = data
            .get("onConfigs")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
            .unwrap_or_default();
        let off_cfgs: Vec<String> = data
            .get("offConfigs")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect())
            .unwrap_or_default();
        let has_cfgs = !on_cfgs.is_empty() || !off_cfgs.is_empty();

        let w = if has_cfgs { 1420u32 } else { 900u32 };
        let max_cfg_rows = on_cfgs.len().max(off_cfgs.len());
        let cfg_box_h = (110 + max_cfg_rows * 28).max(580) as f32;
        let h = (210.0 + cfg_box_h.max(660.0) + 48.0) as u32;

        let mut c = Canvas2dCompat::new(w, h, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            w as f32,
            h as f32,
            Rgba::hex(0x0F2027, 255),
            Rgba::hex(0x203A43, 255),
            Rgba::hex(0x2C5364, 255),
        );

        let avt_url = str_any(data, &["avatar", "avatarUrl"], "");
        let avt_cached = self.images().get_sync(avt_url);
        let avt_slice = avatar_bytes.or_else(|| avt_cached.as_deref().map(Vec::as_slice));
        let bot_name = str_any(data, &["displayName", "name"], "MyBot");
        c.draw_avatar_or_monogram(110.0, 108.0, 56.0, avt_slice, bot_name, Rgba::hex(0x4ECB71, 255));

        let title_str = if kind == CardKind::BotDetail {
            format!("Thông Tin Chi Tiết Bot: {bot_name}")
        } else {
            bot_name.to_string()
        };
        c.draw_text_with_shadow(&title_str, 192.0, 58.0, 31.0, Rgba::WHITE, true);
        c.draw_text(
            &format!("Developer: {}", str_any(data, &["developer", "createdBy"], "</>Thanh Hung")),
            192.0,
            100.0,
            20.0,
            Rgba::hex(0xCBD5E1, 255),
            "sans-serif",
            false,
        );
        c.draw_text(
            &format!("Uptime: {}", str_any(data, &["uptime"], "Đang hoạt động")),
            192.0,
            132.0,
            20.0,
            Rgba::hex(0x34D399, 255),
            "sans-serif",
            true,
        );

        let left_w = if has_cfgs { 680.0 } else { 820.0 };
        let draw_kv_box =
            |c: &mut Canvas2dCompat, title: &str, items: &[(&str, String)], x: f32, y: f32, bw: f32, bh: f32| {
                c.fill_rounded_rect(x, y, bw, bh, 14.0, Rgba(0, 0, 0, 125));
                c.stroke_rounded_rect(x, y, bw, bh, 14.0, 1.5, Rgba(255, 255, 255, 48));
                c.draw_text_centered(title, x + bw * 0.5, y + 14.0, 23.0, Rgba::hex(0x4ECB71, 255), true);
                for (i, (k, v)) in items.iter().enumerate() {
                    let ry = y + 54.0 + (i as f32) * 32.0;
                    c.draw_text(k, x + 22.0, ry, 18.5, Rgba::hex(0x7DD3FC, 255), "sans-serif", true);
                    let sv = c.ellipsize(v, bw * 0.56, 18.5, false);
                    c.draw_text_right(&sv, x + bw - 22.0, ry, 18.5, Rgba::WHITE, false);
                }
            };

        let sys_items = [
            ("🔢 Phiên bản:", str_any(data, &["version"], "V3 QR Login").into()),
            ("🟢 Trạng thái:", str_any(data, &["status"], "Đang hoạt động").into()),
            ("💻 Hệ điều hành:", str_any(data, &["os"], std::env::consts::OS).into()),
            ("⚙️ CPU Model:", str_any(data, &["cpuModel"], "Multi-Core CPU").into()),
            ("📊 CPU Usage:", str_any(data, &["cpu", "cpuText"], "5.0%").into()),
        ];
        draw_kv_box(&mut c, "System Info", &sys_items, 40.0, 196.0, left_w, 224.0);

        let res_items = [
            ("📈 RAM Usage:", str_any(data, &["ram", "ramText"], "120 MB / 8.0 GB").into()),
            ("💽 Disk Usage:", str_any(data, &["disk", "diskText"], "20.0 GB / 80.0 GB").into()),
            ("🔑 Prefix:", str_any(data, &["prefix"], "!").into()),
            ("⏳ Thời hạn:", str_any(data, &["expiry", "timeRemaining"], "Vĩnh viễn").into()),
        ];
        draw_kv_box(&mut c, "Resource & Bot Status", &res_items, 40.0, 438.0, left_w, 194.0);

        let pie_y = 650.0;
        c.fill_rounded_rect(40.0, pie_y, left_w, 200.0, 14.0, Rgba(0, 0, 0, 125));
        c.stroke_rounded_rect(40.0, pie_y, left_w, 200.0, 14.0, 1.5, Rgba(255, 255, 255, 48));
        c.draw_text_centered(
            "RAM & Disk Usage",
            40.0 + left_w * 0.5,
            pie_y + 12.0,
            22.0,
            Rgba::hex(0x38BDF8, 255),
            true,
        );

        let ram_pct = f32_or(data, "ramPercent", f32_or(data, "ramRatio", 0.22) * 100.0).clamp(1.0, 99.0);
        let disk_pct = f32_or(data, "diskPercent", 28.0).clamp(1.0, 99.0);
        for (cx, pct, lbl) in [
            (40.0 + left_w * 0.30, ram_pct, "RAM"),
            (40.0 + left_w * 0.70, disk_pct, "Disk"),
        ] {
            c.draw_pie_chart(
                cx,
                pie_y + 106.0,
                52.0,
                pct,
                Rgba::hex(0xFF6B6B, 255),
                Rgba::hex(0x4ECB71, 255),
            );
            c.draw_text_centered(&format!("{pct:.1}%"), cx, pie_y + 96.0, 17.0, Rgba::WHITE, true);
            c.draw_text_centered(lbl, cx, pie_y + 166.0, 16.5, Rgba::WHITE, true);
        }

        if has_cfgs {
            let rx = 40.0 + left_w + 32.0;
            let rw = w as f32 - rx - 40.0;
            c.fill_rounded_rect(rx, 196.0, rw, cfg_box_h, 14.0, Rgba(0, 0, 0, 125));
            c.stroke_rounded_rect(rx, 196.0, rw, cfg_box_h, 14.0, 1.5, Rgba(255, 255, 255, 48));
            c.draw_text_centered("Group Configs", rx + rw * 0.5, 210.0, 24.0, Rgba::hex(0xFDE047, 255), true);

            let half = rw * 0.5;
            c.draw_line(rx + half, 256.0, rx + half, 196.0 + cfg_box_h - 24.0, 1.5, Rgba(255, 255, 255, 55));

            c.draw_text("❌ Đang tắt:", rx + 22.0, 256.0, 19.0, Rgba::hex(0xFF6B6B, 255), "sans-serif", true);
            for (i, item) in off_cfgs.iter().take(20).enumerate() {
                let s = c.ellipsize(&format!("• {item}"), half - 32.0, 16.5, false);
                c.draw_text(&s, rx + 22.0, 290.0 + (i as f32) * 26.0, 16.5, Rgba::WHITE, "sans-serif", false);
            }

            c.draw_text(
                "✅ Đang bật:",
                rx + half + 20.0,
                256.0,
                19.0,
                Rgba::hex(0x4ECB71, 255),
                "sans-serif",
                true,
            );
            for (i, item) in on_cfgs.iter().take(20).enumerate() {
                let s = c.ellipsize(&format!("• {item}"), half - 32.0, 16.5, false);
                c.draw_text(
                    &s,
                    rx + half + 20.0,
                    290.0 + (i as f32) * 26.0,
                    16.5,
                    Rgba::WHITE,
                    "sans-serif",
                    false,
                );
            }
        }

        c.encode_png()
    }

    /// `listadmin-canvas.js`: `1200px` 3-column Admin Hierarchy card (`Quản trị Tối cao`, `Quản trị Bot đa-nhóm`, `Quản trị Nhóm`).
    pub(crate) fn render_list_admin_v3(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        let high = extract_person_list(data, "highAdmins");
        let bot = extract_person_list(data, "botAdmins");
        let grp = if high.is_empty() && bot.is_empty() && data.get("groupAdmins").is_none() {
            extract_person_list(data, "rows")
        } else {
            extract_person_list(data, "groupAdmins")
        };

        let max_n = high.len().max(bot.len()).max(grp.len()).max(1);
        let h = (165 + max_n * 86 + 36) as u32;
        let mut c = Canvas2dCompat::new(1200, h, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            1200.0,
            h as f32,
            Rgba::hex(0x0C101C, 255),
            Rgba::hex(0x111827, 255),
            Rgba::hex(0x1E1B4B, 255),
        );
        c.draw_text_centered(
            str_any(data, &["title"], "DANH SÁCH QUẢN TRỊ VIÊN"),
            600.0,
            34.0,
            32.0,
            Rgba::WHITE,
            true,
        );
        c.draw_text_centered(
            str_any(data, &["subtitle"], "Hệ thống phân quyền quản trị viên Bot & Nhóm"),
            600.0,
            78.0,
            17.0,
            Rgba::hex(0x94A3B8, 255),
            false,
        );

        let cols = [
            ("Quản trị Tối cao", &high, Rgba::hex(0xEF4444, 255)),
            ("Quản trị Bot đa-nhóm", &bot, Rgba::hex(0xF59E0B, 255)),
            ("Quản trị Nhóm", &grp, Rgba::hex(0x3B82F6, 255)),
        ];
        let col_w = 372.0f32;
        for (ci, (title, items, col)) in cols.iter().enumerate() {
            let cx = 24.0 + (ci as f32) * (col_w + 18.0);
            c.fill_rounded_rect(cx, 118.0, col_w, 48.0, 10.0, *col);
            c.draw_text(
                &format!("{title} ({})", items.len()),
                cx + 16.0,
                131.0,
                17.5,
                Rgba::WHITE,
                "sans-serif",
                true,
            );
            if items.is_empty() {
                c.fill_rounded_rect(cx, 178.0, col_w, 84.0, 10.0, Rgba(255, 255, 255, 10));
                c.draw_text_centered(
                    "Chưa có quản trị viên",
                    cx + col_w * 0.5,
                    210.0,
                    15.5,
                    Rgba::hex(0x64748B, 255),
                    false,
                );
            } else {
                for (ri, (name, role, avt)) in items.iter().take(30).enumerate() {
                    let ry = 178.0 + (ri as f32) * 86.0;
                    c.fill_rounded_rect(cx, ry, col_w, 76.0, 12.0, Rgba(255, 255, 255, 16));
                    c.fill_rounded_rect(cx + 10.0, ry + 23.0, 30.0, 30.0, 8.0, *col);
                    c.draw_text_centered(&format!("{}", ri + 1), cx + 25.0, ry + 28.0, 15.0, Rgba::WHITE, true);
                    let avt_b = self.images().get_sync(avt);
                    c.draw_avatar_or_monogram(
                        cx + 76.0,
                        ry + 38.0,
                        24.0,
                        avt_b.as_deref().map(Vec::as_slice),
                        name,
                        *col,
                    );
                    let sname = c.ellipsize(name, col_w - 124.0, 17.0, true);
                    let srole = c.ellipsize(role, col_w - 124.0, 14.0, false);
                    c.draw_text(&sname, cx + 112.0, ry + 16.0, 17.0, Rgba::WHITE, "sans-serif", true);
                    c.draw_text(
                        &srole,
                        cx + 112.0,
                        ry + 44.0,
                        14.0,
                        Rgba::hex(0x94A3B8, 255),
                        "sans-serif",
                        false,
                    );
                }
            }
        }
        c.encode_png()
    }

    /// `listbots-canvas.js`: `900px` Sub-Bot Fleet card (`Danh Sách Bot Con`).
    pub(crate) fn render_list_bots_v3(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        let bots = data
            .get("bots")
            .or_else(|| data.get("rows"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = bots.len().clamp(1, 30);
        let h = (180 + count * 126 + 36) as u32;
        let mut c = Canvas2dCompat::new(900, h, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            900.0,
            h as f32,
            Rgba::hex(0x0F172A, 255),
            Rgba::hex(0x1E1B4B, 255),
            Rgba::hex(0x111827, 255),
        );
        c.fill_rounded_rect(30.0, 26.0, 840.0, 104.0, 22.0, Rgba::hex(0x5E72E4, 235));
        c.draw_text_centered("Danh Sách Bot Con", 450.0, 42.0, 34.0, Rgba::WHITE, true);
        c.draw_text_centered(
            "Bot Management System",
            450.0,
            88.0,
            18.5,
            Rgba(255, 255, 255, 225),
            false,
        );

        if bots.is_empty() {
            c.fill_rounded_rect(30.0, 154.0, 840.0, 110.0, 16.0, Rgba(255, 255, 255, 16));
            c.draw_text_centered(
                "Không có bot con nào được tạo",
                450.0,
                196.0,
                20.0,
                Rgba::hex(0xCBD5E1, 255),
                false,
            );
            return c.encode_png();
        }

        for (i, b) in bots.iter().take(30).enumerate() {
            let y = 154.0 + (i as f32) * 126.0;
            c.fill_rounded_rect(30.0, y, 840.0, 112.0, 16.0, Rgba(255, 255, 255, 22));
            c.fill_rounded_rect(50.0, y + 36.0, 40.0, 40.0, 10.0, Rgba::hex(0x6366F1, 255));
            c.draw_text_centered(&format!("{}", i + 1), 70.0, y + 44.0, 19.0, Rgba::WHITE, true);

            let bname = str_any(b, &["displayName", "name", "left"], "Bot Con");
            let bid = str_any(b, &["id", "botKey", "name"], "-");
            let status = str_any(b, &["status", "right"], "running");
            let expiry = str_any(b, &["expiryAt", "expiry"], "Vĩnh viễn");
            let avt_b = self.images().get_sync(str_any(b, &["avatar"], ""));
            c.draw_avatar_or_monogram(
                142.0,
                y + 56.0,
                34.0,
                avt_b.as_deref().map(Vec::as_slice),
                bname,
                Rgba::hex(0x34D399, 255),
            );

            let status_icon = match status {
                "running" => "✅",
                "stopped" => "⏹️",
                "trialExpired" => "⏰",
                "expired" => "❌",
                _ => "📊",
            };
            c.draw_text(
                &c.ellipsize(&format!("🤖 {bname} (ID: {bid})"), 630.0, 20.0, true),
                196.0,
                y + 18.0,
                20.0,
                Rgba::WHITE,
                "sans-serif",
                true,
            );
            c.draw_text(
                &format!("⏰ Thời hạn: {expiry}"),
                196.0,
                y + 50.0,
                16.5,
                Rgba::hex(0xCBD5E1, 255),
                "sans-serif",
                false,
            );
            c.draw_text(
                &format!("📊 Trạng thái: {status_icon} {status}"),
                196.0,
                y + 78.0,
                16.5,
                Rgba::hex(0x38BDF8, 255),
                "sans-serif",
                true,
            );
        }
        c.encode_png()
    }

    /// `listblocked-canvas.js` & `listblockbot-cavas.js`: Blocked/Muted/Whitelisted member list card.
    pub(crate) fn render_member_moderation_list(
        &self,
        kind: CardKind,
        data: &Value,
    ) -> Result<Vec<u8>, GfxError> {
        let items = extract_person_list(data, "users");
        let items = if items.is_empty() {
            extract_person_list(data, "rows")
        } else {
            items
        };

        let (headline, sub, accent) = match kind {
            CardKind::ListBlocked => (
                "BLOCK-LIST-IN-GROUP",
                "Danh Sách Chặn Của Cộng Đồng",
                Rgba::hex(0xE74C3C, 255),
            ),
            CardKind::ListBlockBot => (
                "BOT-BLOCK-LIST",
                "Danh Sách Chặn Sử Dụng Bot",
                Rgba::hex(0xF97316, 255),
            ),
            CardKind::ListMute => (
                "MUTE-LIST-IN-GROUP",
                "Danh Sách Thành Viên Đang Bị Cấm Chat",
                Rgba::hex(0xF59E0B, 255),
            ),
            _ => (
                "WHITELIST-IN-GROUP",
                "Danh Sách Miễn Trừ Kiểm Duyệt (Whitelist)",
                Rgba::hex(0x10B981, 255),
            ),
        };

        if items.is_empty() {
            let mut c = Canvas2dCompat::new(560, 160, self.fonts().clone())?;
            c.clear(Rgba::hex(0x0B0F19, 255));
            c.draw_text_centered(
                str_any(data, &["emptyText"], "Danh sách hiện đang trống"),
                280.0,
                62.0,
                21.0,
                Rgba::WHITE,
                true,
            );
            c.draw_text_centered("Tạo bởi Thanh Hung", 280.0, 122.0, 15.0, accent, true);
            return c.encode_png();
        }

        let cols = if items.len() > 15 { 2usize } else { 1usize };
        let per_col = items.len().div_ceil(cols).min(25);
        let col_w = 460.0f32;
        let w = (col_w * (cols as f32) + 40.0) as u32;
        let h = (118 + per_col * 74 + 44) as u32;

        let mut c = Canvas2dCompat::new(w, h, self.fonts().clone())?;
        c.clear(Rgba::hex(0x090D16, 255));
        c.draw_text_centered(headline, w as f32 * 0.5, 20.0, 28.0, Rgba::hex(0x4DA3FF, 255), true);
        c.draw_text_centered(sub, w as f32 * 0.5, 58.0, 21.0, Rgba::WHITE, true);

        for (idx, (name, role, avt)) in items.iter().take(50).enumerate() {
            let col = idx / per_col;
            let row = idx % per_col;
            let cx = 20.0 + (col as f32) * col_w;
            let cy = 110.0 + (row as f32) * 74.0;
            c.fill_rounded_rect(cx, cy, col_w - 16.0, 66.0, 10.0, Rgba(255, 255, 255, 16));
            c.fill_rounded_rect(cx + 10.0, cy + 19.0, 28.0, 28.0, 6.0, accent);
            c.draw_text_centered(&format!("{}", idx + 1), cx + 24.0, cy + 24.0, 14.5, Rgba::WHITE, true);
            let avt_b = self.images().get_sync(avt);
            c.draw_avatar_or_monogram(
                cx + 70.0,
                cy + 33.0,
                22.0,
                avt_b.as_deref().map(Vec::as_slice),
                name,
                accent,
            );
            c.draw_text(
                &c.ellipsize(name, col_w - 128.0, 17.5, true),
                cx + 104.0,
                cy + 12.0,
                17.5,
                Rgba::WHITE,
                "sans-serif",
                true,
            );
            c.draw_text(
                &c.ellipsize(role, col_w - 128.0, 14.0, false),
                cx + 104.0,
                cy + 38.0,
                14.0,
                accent,
                "sans-serif",
                false,
            );
        }
        c.draw_text_centered("Tạo bởi Thanh Hung", w as f32 * 0.5, h as f32 - 30.0, 15.5, Rgba::hex(0xFDE047, 255), true);
        c.encode_png()
    }

    /// `lich.js`: Vietnamese Solar + Lunar Calendar Card (Daily detail OR 7-col Monthly Grid).
    pub(crate) fn render_calendar_card_v3(&self, data: &Value) -> Result<Vec<u8>, GfxError> {
        if let Some(days) = data.get("days").and_then(Value::as_array)
            && !days.is_empty()
        {
            let mut c = Canvas2dCompat::new(980, 720, self.fonts().clone())?;
            c.fill_linear_gradient_rect(
                0.0,
                0.0,
                980.0,
                720.0,
                Rgba::hex(0x7F1D1D, 255),
                Rgba::hex(0x1E1B4B, 255),
                Rgba::hex(0x0F172A, 255),
            );
            c.draw_text_centered(
                str_any(data, &["title"], "LỊCH VẠN NIÊN THÁNG"),
                490.0,
                28.0,
                32.0,
                Rgba::hex(0xFDE047, 255),
                true,
            );
            let weekdays = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
            let cell_w = 128.0f32;
            let cell_h = 86.0f32;
            for (wi, wd) in weekdays.iter().enumerate() {
                let wx = 42.0 + (wi as f32) * cell_w;
                c.fill_rounded_rect(wx, 86.0, cell_w - 8.0, 38.0, 8.0, Rgba(255, 255, 255, 28));
                c.draw_text_centered(wd, wx + (cell_w - 8.0) * 0.5, 95.0, 18.0, Rgba::WHITE, true);
            }
            for (idx, cell) in days.iter().take(42).enumerate() {
                let col = (idx % 7) as f32;
                let row = (idx / 7) as f32;
                let cx = 42.0 + col * cell_w;
                let cy = 136.0 + row * (cell_h + 6.0);
                let solar = str_any(cell, &["solar", "day"], "");
                let lunar = str_any(cell, &["lunar"], "");
                let is_today = cell.get("isToday").and_then(Value::as_bool).unwrap_or(false);
                c.fill_rounded_rect(
                    cx,
                    cy,
                    cell_w - 8.0,
                    cell_h,
                    10.0,
                    if is_today {
                        Rgba::hex(0xDC2626, 220)
                    } else {
                        Rgba(15, 23, 42, 185)
                    },
                );
                if !solar.is_empty() {
                    c.draw_text(solar, cx + 12.0, cy + 10.0, 26.0, Rgba::WHITE, "sans-serif", true);
                    c.draw_text_right(
                        lunar,
                        cx + cell_w - 18.0,
                        cy + 52.0,
                        15.0,
                        Rgba::hex(0xFDE047, 255),
                        true,
                    );
                }
            }
            return c.encode_png();
        }

        let mut c = Canvas2dCompat::new(860, 500, self.fonts().clone())?;
        c.fill_linear_gradient_rect(
            0.0,
            0.0,
            860.0,
            500.0,
            Rgba::hex(0x7F1D1D, 255),
            Rgba::hex(0x450A0A, 255),
            Rgba::hex(0x0F172A, 255),
        );
        c.fill_rounded_rect(32.0, 32.0, 796.0, 436.0, 24.0, Rgba(15, 23, 42, 200));
        c.stroke_rounded_rect(32.0, 32.0, 796.0, 436.0, 24.0, 2.0, Rgba::hex(0xFBBF24, 210));
        c.draw_text_centered(
            str_any(data, &["title", "weekday"], "LỊCH VẠN NIÊN VIỆT NAM"),
            430.0,
            56.0,
            26.0,
            Rgba::hex(0xFDE047, 255),
            true,
        );
        c.draw_text_centered(
            str_any(data, &["solarDate", "date"], "Hôm nay"),
            430.0,
            106.0,
            54.0,
            Rgba::WHITE,
            true,
        );
        c.draw_text_centered(
            &format!("Âm lịch: {}", str_any(data, &["lunarDate", "lunar"], "Đang tra cứu")),
            430.0,
            188.0,
            28.0,
            Rgba::hex(0x34D399, 255),
            true,
        );
        c.draw_text_centered(
            str_any(data, &["canChi", "zodiac"], ""),
            430.0,
            242.0,
            21.0,
            Rgba::hex(0xE2E8F0, 255),
            false,
        );
        let hoang_dao = str_any(data, &["hoangDao", "auspiciousHours"], "");
        if !hoang_dao.is_empty() {
            let lines = c.fonts().wrap_text(
                &format!("Giờ Hoàng Đạo: {hoang_dao}"),
                720.0,
                18.5,
                "sans-serif",
                false,
                3,
            );
            for (i, ln) in lines.iter().enumerate() {
                c.draw_text_centered(
                    ln,
                    430.0,
                    304.0 + (i as f32) * 30.0,
                    18.5,
                    Rgba::hex(0xFDE68A, 255),
                    false,
                );
            }
        }
        c.encode_png()
    }
}

fn val_compact(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.trim().to_string()
    } else if let Some(n) = v.as_u64() {
        format_compact_u64(n)
    } else if let Some(n) = v.as_i64() {
        if n >= 0 {
            format_compact_u64(n as u64)
        } else {
            n.to_string()
        }
    } else {
        String::new()
    }
}

fn format_compact_u64(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1}B", (n as f64) / 1_000_000_000.0)
    } else if n >= 1_000_000 {
        format!("{:.1}M", (n as f64) / 1_000_000.0)
    } else if n >= 10_000 {
        format!("{:.1}K", (n as f64) / 1_000.0)
    } else {
        n.to_string()
    }
}

fn extract_person_list(data: &Value, key: &str) -> Vec<(String, String, String)> {
    data.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|it| {
                    let name = str_any(it, &["name", "displayName", "zaloName", "left"], "(Không tên)").to_string();
                    let role = str_any(it, &["role", "reason", "right", "uid"], "").to_string();
                    let avt = str_any(it, &["avatar", "avatarUrl", "photo"], "").to_string();
                    (name, role, avt)
                })
                .collect()
        })
        .unwrap_or_default()
}
