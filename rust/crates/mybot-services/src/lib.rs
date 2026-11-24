//! External AI, Media Crawler, Vietnamese Lunar Calendar, TTS & Reply Wizard Hub (`mybot-services`).

pub mod ai_clients;
pub mod crawlers;
pub mod reply_wizard;
pub mod tts_lunar;

pub use ai_clients::AiServiceHub;
pub use crawlers::{
    GoldPriceItem, MediaCrawlerHub, MediaSearchItem, PhatNguoiViolation, VietQrSpec,
    detect_vehicle_type, is_valid_license_plate,
};
pub use reply_wizard::{InteractionWizard, WizardPayload, WizardSession};
pub use tts_lunar::{
    LunarDateInfo, build_google_tts_url, fetch_tts_audio_bytes, solar_to_vietnamese_lunar,
};

use mybot_media::MediaError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Media processing error: {0}")]
    Media(#[from] MediaError),
    #[error("Missing provider API secret: {0}")]
    MissingSecret(String),
    #[error("Upstream service error: {0}")]
    Upstream(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vietnamese_lunar_calendar_and_reply_wizard_and_vietqr_work() {
        // 1. Tết Ất Tỵ 2025: Solar 29/01/2025 == Mùng 1 Tháng Giêng Năm Ất Tỵ!
        let tet_2025 = solar_to_vietnamese_lunar(29, 1, 2025);
        assert_eq!(tet_2025.lunar_day, 1);
        assert_eq!(tet_2025.lunar_month, 1);
        assert_eq!(tet_2025.lunar_year, 2025);
        assert!(!tet_2025.is_leap_month);
        assert_eq!(tet_2025.can_chi_year, "Ất Tỵ");
        assert_eq!(tet_2025.auspicious_hours.len(), 6);

        // 2. Tết Bính Ngọ 2026: Solar 17/02/2026 == Mùng 1 Tháng Giêng Năm Bính Ngọ!
        let tet_2026 = solar_to_vietnamese_lunar(17, 2, 2026);
        assert_eq!(tet_2026.lunar_day, 1);
        assert_eq!(tet_2026.lunar_month, 1);
        assert_eq!(tet_2026.can_chi_year, "Bính Ngọ");

        // 3. Multi-turn numbered media selection wizard
        let wizard = InteractionWizard::default();
        wizard.register(WizardSession {
            bot_key: "main".into(),
            thread_id: "g_100".into(),
            sender_uid: "u_99".into(),
            prompt_msg_id: Some("m_1".into()),
            payload: WizardPayload::MediaSelection {
                platform: "youtube".into(),
                audio_only: true,
                items: vec![
                    MediaSearchItem {
                        id: "1".into(),
                        title: "Bài hát 1".into(),
                        author: "Ca sĩ A".into(),
                        duration: "210s".into(),
                        url: "https://youtu.be/1".into(),
                        thumbnail: None,
                        platform: "youtube".into(),
                    },
                    MediaSearchItem {
                        id: "2".into(),
                        title: "Bài hát 2".into(),
                        author: "Ca sĩ B".into(),
                        duration: "195s".into(),
                        url: "https://youtu.be/2".into(),
                        thumbnail: None,
                        platform: "youtube".into(),
                    },
                ],
            },
        });

        let picked = wizard
            .try_consume_media_choice("main", "g_100", "u_99", "2")
            .expect("should pick #2");
        assert_eq!(picked.0, "youtube");
        assert!(picked.1);
        assert_eq!(picked.2.title, "Bài hát 2");
        // Consumed once -> invalidated
        assert!(wizard.try_consume_media_choice("main", "g_100", "u_99", "1").is_none());

        // 4. VietQR QuickLink & TTS URL
        let qr = MediaCrawlerHub::build_vietqr(
            "vcb",
            "0123456789",
            "NGUYEN VAN A",
            Some(50_000),
            "Thue Bot V4",
        );
        assert!(qr.image_url.contains("VCB-0123456789-compact2.png"));
        assert!(qr.image_url.contains("amount=50000"));
        assert!(build_google_tts_url("Xin chào Việt Nam", "vi").contains("tl=vi"));
    }
}
