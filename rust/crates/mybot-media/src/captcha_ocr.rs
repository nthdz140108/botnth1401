//! Pure-Rust CAPTCHA OCR (`imageproc` + `ocrs`) & QR Code Reader/Writer (`rqrr` + `qrcode`).

use std::path::{Path, PathBuf};

use image::{DynamicImage, GrayImage, ImageFormat, Luma};
use imageproc::contrast::{ThresholdType, otsu_level, threshold};
use imageproc::filter::median_filter;
use qrcode::QrCode;

use crate::MediaError;

pub struct CaptchaAndQrEngine {
    ocr: Option<ocrs::OcrEngine>,
}

impl std::fmt::Debug for CaptchaAndQrEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptchaAndQrEngine")
            .field("ocr_loaded", &self.ocr.is_some())
            .finish()
    }
}

impl Default for CaptchaAndQrEngine {
    fn default() -> Self {
        Self::load_from_assets(Path::new("../assets"))
    }
}

impl CaptchaAndQrEngine {
    pub fn load_from_assets(assets_root: &Path) -> Self {
        let det_candidates = [
            assets_root.join("models/text-detection.rten"),
            PathBuf::from("assets/models/text-detection.rten"),
        ];
        let rec_candidates = [
            assets_root.join("models/text-recognition.rten"),
            PathBuf::from("assets/models/text-recognition.rten"),
        ];

        let det_path = det_candidates.into_iter().find(|p| p.is_file());
        let rec_path = rec_candidates.into_iter().find(|p| p.is_file());

        let ocr = match (det_path, rec_path) {
            (Some(det), Some(rec)) => {
                let det_model = rten::Model::load_file(det).ok();
                let rec_model = rten::Model::load_file(rec).ok();
                match (det_model, rec_model) {
                    (Some(detection_model), Some(recognition_model)) => {
                        ocrs::OcrEngine::new(ocrs::OcrEngineParams {
                            detection_model: Some(detection_model),
                            recognition_model: Some(recognition_model),
                            ..Default::default()
                        })
                        .ok()
                    }
                    _ => None,
                }
            }
            _ => None,
        };

        Self { ocr }
    }

    /// Denoises and binarizes noisy CAPTCHA images (such as PhatNguoi traffic CAPTCHAs).
    pub fn preprocess_captcha_grayscale(img: &DynamicImage) -> GrayImage {
        let gray = img.to_luma8();
        let denoised = median_filter(&gray, 1, 1);
        let level = otsu_level(&denoised);
        threshold(&denoised, level, ThresholdType::Binary)
    }

    /// Runs OCR on a CAPTCHA image using `ocrs` when weights are loaded.
    pub fn solve_captcha(&self, image_bytes: &[u8]) -> Result<String, MediaError> {
        let img = image::load_from_memory(image_bytes)
            .map_err(|e| MediaError::Decode(format!("decode captcha: {e}")))?;
        let binarized = Self::preprocess_captcha_grayscale(&img);
        let rgb = DynamicImage::ImageLuma8(binarized).into_rgb8();

        if let Some(ref engine) = self.ocr {
            let source = ocrs::ImageSource::from_bytes(rgb.as_raw(), rgb.dimensions())
                .map_err(|e| MediaError::Inference(format!("ocrs source: {e}")))?;
            let input = engine
                .prepare_input(source)
                .map_err(|e| MediaError::Inference(format!("ocrs input: {e}")))?;
            let text = engine
                .get_text(&input)
                .map_err(|e| MediaError::Inference(format!("ocrs text: {e}")))?;
            let cleaned: String = text
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            return Ok(cleaned);
        }

        Ok(String::new())
    }

    /// Decodes all QR codes inside an image (`!scanqr`) in pure Rust via `rqrr`.
    pub fn decode_qr_image(image_bytes: &[u8]) -> Result<Vec<String>, MediaError> {
        let img = image::load_from_memory(image_bytes)
            .map_err(|e| MediaError::Decode(format!("decode QR image: {e}")))?
            .to_luma8();
        let mut prepared = rqrr::PreparedImage::prepare(img);
        let grids = prepared.detect_grids();
        let mut results = Vec::with_capacity(grids.len());
        for grid in grids {
            if let Ok((_meta, content)) = grid.decode() {
                results.push(content);
            }
        }
        Ok(results)
    }

    /// Encodes a payload into a crisp PNG QR image (`!qrcode` / `!qrlogin` / VietQR).
    pub fn encode_qr_png(payload: &str, min_dimension_px: u32) -> Result<Vec<u8>, MediaError> {
        let code = QrCode::new(payload.as_bytes())
            .map_err(|e| MediaError::Decode(format!("encode QR: {e}")))?;
        let img = code
            .render::<Luma<u8>>()
            .min_dimensions(min_dimension_px.max(180), min_dimension_px.max(180))
            .quiet_zone(true)
            .build();
        let mut out = Vec::new();
        DynamicImage::ImageLuma8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
            .map_err(|e| MediaError::Decode(format!("write QR PNG: {e}")))?;
        Ok(out)
    }
}
