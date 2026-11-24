//! Cross-Platform Vietnamese + Emoji Font Manager (`assets/fonts/*.ttf` + Linux `/usr/share/fonts`).
//!
//! Automatically maps Windows-centric V3 Canvas font names (`Tahoma`, `Segoe UI`, `Arial`) onto
//! bundled `NotoSans-Regular.ttf`, `BeVietnamPro-Bold.ttf`, `UTMAvoBold.ttf`, and `NotoEmoji-Bold.ttf`
//! so Vietnamese diacritics (`ắ, ặ, ể, ữ, đ`) render identically on headless Ubuntu 24.04 LTS.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ab_glyph::{Font, FontArc, PxScale, ScaleFont};
use dashmap::DashMap;

#[derive(Clone)]
pub struct FontManager {
    fonts: Arc<DashMap<String, FontArc>>,
    fallback_chain: Arc<Vec<FontArc>>,
}

impl Default for FontManager {
    fn default() -> Self {
        Self::load_from_assets(Path::new("../assets"))
    }
}

impl FontManager {
    pub fn load_from_assets(assets_root: &Path) -> Self {
        let fonts = DashMap::new();
        let mut chain = Vec::new();

        #[allow(unused_mut)]
        let mut search_dirs: Vec<PathBuf> = vec![
            assets_root.join("fonts"),
            PathBuf::from("assets/fonts"),
            PathBuf::from("../assets/fonts"),
            PathBuf::from("../../assets/fonts"),
            PathBuf::from("../../../assets/fonts"),
        ];
        #[cfg(target_os = "linux")]
        {
            search_dirs.push(PathBuf::from("/usr/share/fonts/truetype/noto"));
            search_dirs.push(PathBuf::from("/usr/share/fonts/truetype/liberation2"));
            search_dirs.push(PathBuf::from("/usr/share/fonts/truetype/dejavu"));
        }

        let known_files = [
            ("regular", "NotoSans-Regular.ttf"),
            ("bold", "BeVietnamPro-Bold.ttf"),
            ("arial", "arial.ttf"),
            ("utm-avo-bold", "UTMAvoBold.ttf"),
            ("emoji", "NotoEmoji-Bold.ttf"),
            ("svn-bear", "SVN-Bear.ttf"),
            ("svn-dancing", "SVN-Dancing.ttf"),
            ("svn-transformer", "SVN-Transformer.ttf"),
            ("junicode-bold", "Junicode-Bold.ttf"),
        ];

        for (alias, filename) in known_files {
            for dir in &search_dirs {
                let candidate = dir.join(filename);
                if candidate.is_file()
                    && let Ok(bytes) = std::fs::read(&candidate)
                    && let Ok(arc) = FontArc::try_from_vec(bytes)
                {
                    fonts.insert(alias.to_string(), arc.clone());
                    if matches!(alias, "regular" | "bold" | "arial" | "emoji") {
                        chain.push(arc);
                    }
                    break;
                }
            }
        }

        // Linux system font fallback (`LiberationSans` / `DejaVuSans` / `NotoColorEmoji`)
        #[cfg(target_os = "linux")]
        for (alias, sys_file) in [
            ("liberation-sans", "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"),
            ("dejavu-sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            ("noto-color-emoji", "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"),
        ] {
            if let Ok(bytes) = std::fs::read(sys_file)
                && let Ok(arc) = FontArc::try_from_vec(bytes)
            {
                fonts.insert(alias.to_string(), arc.clone());
                chain.push(arc);
            }
        }

        Self {
            fonts: Arc::new(fonts),
            fallback_chain: Arc::new(chain),
        }
    }

    pub fn has_loaded_fonts(&self) -> bool {
        !self.fallback_chain.is_empty()
    }

    pub fn resolve_family(&self, family: &str, bold: bool) -> Option<FontArc> {
        let norm = family.trim().to_ascii_lowercase();
        let target_key = if norm.contains("emoji") {
            "emoji"
        } else if norm.contains("dancing") {
            "svn-dancing"
        } else if norm.contains("bear") {
            "svn-bear"
        } else if norm.contains("transformer") {
            "svn-transformer"
        } else if norm.contains("avo") {
            "utm-avo-bold"
        } else if bold || norm.contains("bold") || norm.contains("vietnam") {
            "bold"
        } else if norm.contains("arial") || norm.contains("tahoma") || norm.contains("segoe") {
            if self.fonts.contains_key("regular") {
                "regular"
            } else {
                "arial"
            }
        } else {
            "regular"
        };

        if let Some(f) = self.fonts.get(target_key) {
            return Some(f.value().clone());
        }
        self.fallback_chain.first().cloned()
    }

    /// Selects the first font in `(preferred + fallback_chain)` containing a real glyph for `ch`.
    pub fn pick_font_for_char(&self, preferred: Option<&FontArc>, ch: char) -> Option<FontArc> {
        if let Some(pref) = preferred
            && pref.glyph_id(ch).0 != 0
        {
            return Some(pref.clone());
        }
        for f in self.fallback_chain.iter() {
            if f.glyph_id(ch).0 != 0 {
                return Some(f.clone());
            }
        }
        preferred.cloned().or_else(|| self.fallback_chain.first().cloned())
    }

    pub fn measure_text_width(&self, text: &str, px_size: f32, family: &str, bold: bool) -> f32 {
        if text.is_empty() {
            return 0.0;
        }
        let pref = self.resolve_family(family, bold);
        if pref.is_none() && self.fallback_chain.is_empty() {
            // Built-in bitmap fallback width (`0.58 * px_size` per char)
            return (text.chars().count() as f32) * px_size * 0.58;
        }
        let scale = PxScale::from(px_size.max(1.0));
        let mut width = 0.0f32;
        for ch in text.chars() {
            if let Some(font) = self.pick_font_for_char(pref.as_ref(), ch) {
                let sf = font.as_scaled(scale);
                width += sf.h_advance(sf.glyph_id(ch));
            } else {
                width += px_size * 0.55;
            }
        }
        width
    }

    pub fn wrap_text(
        &self,
        text: &str,
        max_width: f32,
        px_size: f32,
        family: &str,
        bold: bool,
        max_lines: usize,
    ) -> Vec<String> {
        let mut lines = Vec::new();
        for raw_line in text.split('\n') {
            let mut current = String::new();
            for word in raw_line.split_whitespace() {
                let candidate = if current.is_empty() {
                    word.to_string()
                } else {
                    format!("{current} {word}")
                };
                if self.measure_text_width(&candidate, px_size, family, bold) <= max_width
                    || current.is_empty()
                {
                    current = candidate;
                } else {
                    lines.push(current);
                    current = word.to_string();
                    if max_lines > 0 && lines.len() >= max_lines {
                        break;
                    }
                }
            }
            if !current.is_empty() && (max_lines == 0 || lines.len() < max_lines) {
                lines.push(current);
            }
            if max_lines > 0 && lines.len() >= max_lines {
                break;
            }
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    }
}
