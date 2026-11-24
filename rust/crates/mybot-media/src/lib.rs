//! Ephemeral RAM Media Scratchpad (`/dev/shm/mybot`), NSFW ONNX/Heuristic Classifier,
//! Pure-Rust CAPTCHA/QR Engine (`ocrs` + `rqrr`), URL Video Pools, and `ffmpeg`/`yt-dlp` Runner.

pub mod captcha_ocr;
pub mod cli_media;
pub mod nsfw_ort;
pub mod ram_scratchpad;
pub mod video_pools;

pub use captcha_ocr::CaptchaAndQrEngine;
pub use cli_media::CliMediaRunner;
pub use nsfw_ort::{NsfwClassifier, NsfwScores};
pub use ram_scratchpad::{DEFAULT_SCRATCHPAD_QUOTA_BYTES, RamScratchpad, ScratchFile};
pub use video_pools::{PoolCleanResult, PoolHealthReport, VideoPoolManager};

use std::sync::Once;
use thiserror::Error;

static RUSTLS_INIT: Once = Once::new();

pub fn ensure_rustls_provider() {
    RUSTLS_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("RAM scratchpad quota exceeded: {0}")]
    QuotaExceeded(String),
    #[error("Media decode/encode error: {0}")]
    Decode(String),
    #[error("AI inference error: {0}")]
    Inference(String),
    #[error("Media subprocess error: {0}")]
    Subprocess(String),
    #[error("Media subprocess timed out: {0}")]
    Timeout(String),
    #[error("Invalid media format or argument: {0}")]
    InvalidFormat(String),
    #[error("Resource not found: {0}")]
    NotFound(String),
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use image::{ImageBuffer, Rgba};

    use super::*;

    #[tokio::test]
    async fn ram_scratchpad_enforces_quota_and_unlinks_on_drop() {
        let tmp = tempfile::tempdir().unwrap();
        let pad = RamScratchpad::new_with_quota(tmp.path().join("shm"), 128 * 1024).unwrap();
        assert_eq!(pad.quota_bytes(), 128 * 1024);

        let file_path;
        {
            let scratch = pad
                .write_temp_bytes("clip", "mp4", &[1u8, 2, 3, 4, 5])
                .await
                .unwrap();
            file_path = scratch.path().to_path_buf();
            assert!(file_path.is_file());
            assert_eq!(pad.available_bytes(), 64 * 1024);

            // Requesting > total quota fails immediately
            let over = pad.allocate_file("huge", "mp4", 256 * 1024).await;
            assert!(matches!(over, Err(MediaError::QuotaExceeded(_))));
        }

        // RAII Drop must unlink file and restore 100% quota
        assert!(!file_path.exists());
        assert_eq!(pad.available_bytes(), 128 * 1024);
    }

    #[tokio::test]
    async fn qr_roundtrip_nsfw_scoring_sticker_webp_and_video_pools_work() {
        // 1. QR encode (`qrcode`) + QR decode (`rqrr`) pure-Rust roundtrip
        let payload = "https://zalo.me/g/mybot-v4-ubuntu-rust";
        let qr_png = CaptchaAndQrEngine::encode_qr_png(payload, 280).unwrap();
        let decoded = CaptchaAndQrEngine::decode_qr_image(&qr_png).unwrap();
        assert_eq!(decoded, vec![payload.to_string()]);

        // 2. Pure-Rust WebP circle-cropped sticker conversion into RAM scratchpad
        let tmp = tempfile::tempdir().unwrap();
        let src_png = tmp.path().join("avatar.png");
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(120, 120, |_, _| Rgba([16, 185, 129, 255]));
        img.save(&src_png).unwrap();

        let runner = CliMediaRunner::new(
            RamScratchpad::new_with_quota(tmp.path().join("ram"), 16 * 1024 * 1024).unwrap(),
            2,
            2,
        );
        let sticker = runner
            .convert_to_webp_sticker(&src_png, true, 10)
            .await
            .unwrap();
        let sticker_bytes = sticker.read_bytes().unwrap();
        assert!(sticker_bytes.starts_with(b"RIFF"));
        assert_eq!(&sticker_bytes[8..12], b"WEBP");

        // 3. NSFW classifier scores neutral emerald image as safe
        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let nsfw = NsfwClassifier::default();
        let scores = nsfw.classify_image_bytes(&png_bytes).unwrap();
        assert!(!scores.is_explicit(0.75));
        assert!(scores.neutral > 0.8);

        // 4. VideoPoolManager loads real V3 `data-send/*.txt` pools (`girl`, `anime`, `cosplay`, ...)
        let pools = VideoPoolManager::load_from_project_root(Path::new("../../.."));
        let counts = pools.pool_counts();
        assert!(counts.get("girl").copied().unwrap_or(0) > 10);
        assert!(counts.get("anime").copied().unwrap_or(0) > 0);
        let u1 = pools.pick_url("vdgirl").unwrap();
        let u2 = pools.pick_url("vdgirl").unwrap();
        assert!(u1.starts_with("http"));
        assert_ne!(u1, u2);
    }
}
