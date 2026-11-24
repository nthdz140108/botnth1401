//! Pure-Rust SIMD 2D Card & Animated GIF Graphics Engine (`mybot-gfx`).
//!
//! Replaces `canvas` (Cairo C++) and `sharp` (libvips) with `Canvas2dCompat` (`tiny-skia` +
//! `ab_glyph` + `fast_image_resize` + `gif`, plus optional `linux-skia` `skia-safe` feature)
//! across all V3 Zalo bot card & animation templates.

pub mod canvas2d;
pub mod cards_v3;
pub mod font_manager;
pub mod image_cache;
pub mod renderers;

pub use canvas2d::{Canvas2dCompat, GfxError, Rgba, encode_animated_gif};
pub use font_manager::FontManager;
pub use image_cache::ImageCache;
pub use renderers::{CardKind, CardRenderEngine};

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;

    #[test]
    fn renders_vietnamese_cards_qr_codes_and_animated_gif89a() {
        let fonts = FontManager::load_from_assets(Path::new("../../assets"));
        let engine = CardRenderEngine::new(fonts);
        assert_eq!(CardKind::ALL_40.len(), 40);

        // 1. Welcome card with full Vietnamese diacritics -> valid PNG (`1000x380`)
        let welcome_png = engine
            .render(
                CardKind::Welcome,
                &json!({
                    "memberName": "Nguyễn Đặng Bảo Trâm",
                    "groupName": "Cộng Đồng Zalo Việt Nam",
                    "memberCount": "128"
                }),
                None,
            )
            .expect("welcome png");
        assert!(welcome_png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let decoded = image::load_from_memory(&welcome_png).expect("decode png");
        assert_eq!((decoded.width(), decoded.height()), (1000, 380));

        // 2. VietQR bank card -> valid PNG (`1000x400`)
        let qr_png = engine
            .render(
                CardKind::BankQrCard,
                &json!({
                    "qrPayload": "00020101021238570010A0000007270127000697043601131234567899999",
                    "accountName": "NGUYEN VAN A",
                    "accountNumber": "1234567899999",
                    "bankName": "Vietcombank",
                    "memo": "Chuyen khoan"
                }),
                None,
            )
            .expect("qr png");
        assert!(qr_png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let qr_img = image::load_from_memory(&qr_png).expect("decode qr");
        assert_eq!((qr_img.width(), qr_img.height()), (1000, 400));

        // 3. V3 4x4 Command List grid (`1080x984`)
        let cmd_png = engine
            .render(
                CardKind::CmdList,
                &json!({
                    "title": "DANH SÁCH LỆNH",
                    "page": 1,
                    "totalPages": 5,
                    "totalCommands": 218,
                    "items": [
                        { "name": "!help", "desc": "Xem hướng dẫn sử dụng bot" },
                        { "name": "!zingmp3", "desc": "Tìm kiếm và phát nhạc ZingMP3" }
                    ]
                }),
                None,
            )
            .expect("cmd list png");
        let cmd_img = image::load_from_memory(&cmd_png).expect("decode cmd");
        assert_eq!((cmd_img.width(), cmd_img.height()), (1080, 984));

        // 4. V3 Music Now-Playing Card (`660x200`) & Search Grid
        let music_png = engine
            .render(
                CardKind::MusicCard,
                &json!({
                    "title": "Nơi Này Có Anh",
                    "artists": "Sơn Tùng M-TP",
                    "source": "ZingMP3",
                    "listen": "12.5M"
                }),
                None,
            )
            .expect("music card");
        let music_img = image::load_from_memory(&music_png).expect("decode music");
        assert_eq!((music_img.width(), music_img.height()), (660, 200));

        let search_png = engine
            .render(
                CardKind::MusicSearchCard,
                &json!({
                    "title": "KẾT QUẢ TÌM KIẾM YOUTUBE",
                    "items": (1..=12).map(|i| json!({
                        "title": format!("Bài hát demo số {i}"),
                        "artistsNames": "Nghệ sĩ Việt",
                        "duration": "04:12",
                        "view": "1.2M"
                    })).collect::<Vec<_>>()
                }),
                None,
            )
            .expect("search grid");
        let search_img = image::load_from_memory(&search_png).expect("decode search");
        assert!(search_img.width() >= 900);

        // 5. V3 Info Cards (`UserInfo` 1080px, `GroupInfo` 1000px, `BotInfo` 1420px, `ListAdmin` 1200px, `CalendarCard`)
        let u_img = image::load_from_memory(
            &engine
                .render(
                    CardKind::UserInfo,
                    &json!({ "name": "Trần Minh", "uid": "123456789", "gender": "Nam", "birthday": "01/01/2000" }),
                    None,
                )
                .expect("user info"),
        )
        .unwrap();
        assert_eq!(u_img.width(), 1080);

        let g_img = image::load_from_memory(
            &engine
                .render(
                    CardKind::GroupInfo,
                    &json!({ "groupName": "Nhóm Test V3", "memberCount": 95, "creatorName": "Admin" }),
                    None,
                )
                .expect("group info"),
        )
        .unwrap();
        assert_eq!(g_img.width(), 1000);

        let b_img = image::load_from_memory(
            &engine
                .render(
                    CardKind::BotInfo,
                    &json!({
                        "uptime": "2 giờ 15 phút",
                        "ramUsedPct": 42.5,
                        "diskUsedPct": 31.0,
                        "onConfigs": ["antiSpam", "antiLink"],
                        "offConfigs": ["onlyText"]
                    }),
                    None,
                )
                .expect("bot info"),
        )
        .unwrap();
        assert_eq!(b_img.width(), 1420);

        let adm_img = image::load_from_memory(
            &engine
                .render(
                    CardKind::ListAdmin,
                    &json!({ "highLevelAdmins": [{ "name": "Owner", "uid": "1001" }], "groupAdmins": [] }),
                    None,
                )
                .expect("list admin"),
        )
        .unwrap();
        assert_eq!(adm_img.width(), 1200);

        let cal_img = image::load_from_memory(
            &engine
                .render(
                    CardKind::CalendarCard,
                    &json!({ "solarDate": "03/11/2026", "lunarDate": "24/09/2026" }),
                    None,
                )
                .expect("calendar"),
        )
        .unwrap();
        assert_eq!(cal_img.width(), 860);

        // 6. Multi-frame animated `!giftext` -> valid `GIF89a`
        let gif_bytes = engine
            .render(
                CardKind::GiftextAnimated,
                &json!({ "text": "CHÀO MỪNG ĐẾN VỚI NHÓM" }),
                None,
            )
            .expect("animated gif");
        assert!(gif_bytes.starts_with(b"GIF89a"));
        assert!(gif_bytes.len() > 2048);
    }
}
