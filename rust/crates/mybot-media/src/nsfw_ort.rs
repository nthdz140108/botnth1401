//! NSFW Image & Video Frame Classifier (`!antinsfw`).
//!
//! Uses ONNX Runtime AVX2 (`ort` feature `ort-avx2` on Linux Ubuntu) when an `.onnx` MobileNetV2
//! model is present at `assets/models/nsfw_mobilenet_v2_224.onnx`, with a deterministic pure-Rust
//! YCbCr/HSV skin-density & color-entropy fallback when running without external model weights.

use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView, imageops::FilterType};
use serde::{Deserialize, Serialize};

use crate::MediaError;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NsfwScores {
    pub drawings: f32,
    pub hentai: f32,
    pub neutral: f32,
    pub porn: f32,
    pub sexy: f32,
}

impl NsfwScores {
    /// Combined explicitness probability `[0.0, 1.0]`.
    pub fn explicit_score(&self) -> f32 {
        (self.porn + self.hentai + self.sexy * 0.45).clamp(0.0, 1.0)
    }

    pub fn is_explicit(&self, threshold: f32) -> bool {
        let t = threshold.clamp(0.15, 0.99);
        self.porn >= t || (self.porn + self.hentai) >= t || self.explicit_score() >= (t + 0.08).min(0.98)
    }
}

pub struct NsfwClassifier {
    model_path: Option<PathBuf>,
    #[cfg(feature = "ort-avx2")]
    session: Option<parking_lot::Mutex<ort::session::Session>>,
}

impl std::fmt::Debug for NsfwClassifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NsfwClassifier")
            .field("model_path", &self.model_path)
            .field("ort_enabled", &self.is_ort_active())
            .finish()
    }
}

impl Default for NsfwClassifier {
    fn default() -> Self {
        Self::load_from_assets(Path::new("../assets"))
    }
}

impl NsfwClassifier {
    pub fn load_from_assets(assets_root: &Path) -> Self {
        let candidates = [
            assets_root.join("models/nsfw_mobilenet_v2_224.onnx"),
            PathBuf::from("assets/models/nsfw_mobilenet_v2_224.onnx"),
            PathBuf::from("../assets/models/nsfw_mobilenet_v2_224.onnx"),
        ];
        let found = candidates.into_iter().find(|p| p.is_file());

        #[cfg(feature = "ort-avx2")]
        let session = found.as_ref().and_then(|path| {
            ort::session::Session::builder()
                .ok()?
                .with_intra_threads(2)
                .ok()?
                .commit_from_file(path)
                .ok()
                .map(parking_lot::Mutex::new)
        });

        Self {
            model_path: found,
            #[cfg(feature = "ort-avx2")]
            session,
        }
    }

    pub fn is_ort_active(&self) -> bool {
        #[cfg(feature = "ort-avx2")]
        {
            return self.session.is_some();
        }
        #[cfg(not(feature = "ort-avx2"))]
        {
            false
        }
    }

    pub fn classify_image_bytes(&self, image_bytes: &[u8]) -> Result<NsfwScores, MediaError> {
        let img = image::load_from_memory(image_bytes)
            .map_err(|e| MediaError::Decode(format!("decode image for NSFW check: {e}")))?;
        self.classify_dynamic_image(&img)
    }

    pub fn classify_dynamic_image(&self, img: &DynamicImage) -> Result<NsfwScores, MediaError> {
        let resized = img.resize_exact(224, 224, FilterType::Triangle);

        #[cfg(feature = "ort-avx2")]
        if let Some(ref session_lock) = self.session {
            if let Ok(scores) = Self::run_ort_inference(session_lock, &resized) {
                return Ok(scores);
            }
        }

        Ok(Self::heuristic_skin_and_chroma_scores(&resized))
    }

    /// Aggregates NSFW scores across sampled video frames (e.g. `0%`, `50%`, `85%`).
    pub fn classify_video_frames(&self, frames: &[Vec<u8>]) -> Result<NsfwScores, MediaError> {
        let mut worst = NsfwScores {
            neutral: 1.0,
            ..Default::default()
        };
        for frame in frames {
            if let Ok(score) = self.classify_image_bytes(frame)
                && score.explicit_score() > worst.explicit_score()
            {
                worst = score;
            }
        }
        Ok(worst)
    }

    #[cfg(feature = "ort-avx2")]
    fn run_ort_inference(
        session_lock: &parking_lot::Mutex<ort::session::Session>,
        img224: &DynamicImage,
    ) -> Result<NsfwScores, MediaError> {
        let rgb = img224.to_rgb8();
        let mut input = ndarray::Array4::<f32>::zeros((1, 224, 224, 3));
        for (x, y, px) in rgb.enumerate_pixels() {
            input[[0, y as usize, x as usize, 0]] = f32::from(px[0]) / 255.0;
            input[[0, y as usize, x as usize, 1]] = f32::from(px[1]) / 255.0;
            input[[0, y as usize, x as usize, 2]] = f32::from(px[2]) / 255.0;
        }
        let tensor = ort::value::Tensor::from_array(input)
            .map_err(|e| MediaError::Inference(format!("ort tensor: {e}")))?;
        let mut session = session_lock.lock();
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(|e| MediaError::Inference(format!("ort run: {e}")))?;
        let (_, slice) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| MediaError::Inference(format!("ort output: {e}")))?;
        if slice.len() >= 5 {
            Ok(NsfwScores {
                drawings: slice[0],
                hentai: slice[1],
                neutral: slice[2],
                porn: slice[3],
                sexy: slice[4],
            })
        } else {
            Err(MediaError::Inference("unexpected NSFW output shape".into()))
        }
    }

    /// Fast SIMD-friendly YCbCr + center-weighted skin-region heuristic fallback.
    fn heuristic_skin_and_chroma_scores(img224: &DynamicImage) -> NsfwScores {
        let (w, h) = img224.dimensions();
        let total = (w * h).max(1) as f32;
        let mut skin_pixels = 0u32;
        let mut center_skin_pixels = 0u32;
        let mut center_total = 0u32;

        for (x, y, px) in img224.pixels() {
            let r = f32::from(px[0]);
            let g = f32::from(px[1]);
            let b = f32::from(px[2]);
            let cb = 128.0 - 0.168_736 * r - 0.331_264 * g + 0.5 * b;
            let cr = 128.0 + 0.5 * r - 0.418_688 * g - 0.081_312 * b;

            let is_skin = r > 95.0
                && g > 40.0
                && b > 20.0
                && (r - g).abs() > 15.0
                && r > g
                && r > b
                && (77.0..=127.0).contains(&cb)
                && (133.0..=173.0).contains(&cr);

            let in_center = x >= w / 5 && x <= (w * 4) / 5 && y >= h / 5 && y <= (h * 4) / 5;
            if in_center {
                center_total += 1;
            }
            if is_skin {
                skin_pixels += 1;
                if in_center {
                    center_skin_pixels += 1;
                }
            }
        }

        let global_ratio = skin_pixels as f32 / total;
        let center_ratio = center_skin_pixels as f32 / center_total.max(1) as f32;
        let weighted = (global_ratio * 0.45 + center_ratio * 0.55).clamp(0.0, 1.0);

        let porn = if weighted > 0.62 {
            ((weighted - 0.30) * 1.15).clamp(0.0, 0.96)
        } else {
            (weighted * 0.45).clamp(0.0, 0.40)
        };
        let sexy = (weighted * 0.85).clamp(0.0, 0.90);
        let neutral = (1.0 - porn.max(sexy * 0.7)).clamp(0.02, 1.0);

        NsfwScores {
            drawings: 0.02,
            hentai: 0.01,
            neutral,
            porn,
            sexy,
        }
    }
}
