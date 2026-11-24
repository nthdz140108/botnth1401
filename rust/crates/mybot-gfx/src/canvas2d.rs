//! HTML5 `CanvasRenderingContext2D`-compatible 2D vector & typography surface (`Canvas2dCompat`).
//!
//! Uses `tiny-skia` SIMD premultiplied RGBA8 rasterization + `ab_glyph` glyph outlining +
//! `fast_image_resize` Lanczos3 scaling + `gif` animated frame encoding, with optional
//! `linux-skia` (`skia-safe`) feature support on Ubuntu Pro Max deployments.

use std::io::Cursor;

use ab_glyph::{Font, PxScale, ScaleFont, point};
use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use gif::{Encoder as GifEncoder, Frame as GifFrame, Repeat};
use image::{DynamicImage, ImageFormat, RgbaImage};
use qrcode::QrCode;
use tiny_skia::{
    Color, FillRule, GradientStop, LineCap, LineJoin, LinearGradient, Paint, PathBuilder, Pixmap,
    Point, Rect, SpreadMode, Stroke, Transform,
};

use crate::font_manager::FontManager;

#[derive(Debug, thiserror::Error)]
pub enum GfxError {
    #[error("invalid canvas dimensions {0}x{1}")]
    InvalidDimensions(u32, u32),
    #[error("image decode/encode error: {0}")]
    Image(#[from] image::ImageError),
    #[error("gif encode error: {0}")]
    Gif(#[from] gif::EncodingError),
    #[error("qr generation error: {0}")]
    Qr(String),
}

#[derive(Debug, Clone, Copy)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    pub const WHITE: Self = Self(255, 255, 255, 255);
    pub const BLACK: Self = Self(0, 0, 0, 255);

    pub const fn hex(rgb: u32, alpha: u8) -> Self {
        Self(
            ((rgb >> 16) & 0xFF) as u8,
            ((rgb >> 8) & 0xFF) as u8,
            (rgb & 0xFF) as u8,
            alpha,
        )
    }

    #[inline]
    pub fn to_skia(self) -> Color {
        Color::from_rgba8(self.0, self.1, self.2, self.3)
    }
}

pub struct Canvas2dCompat {
    pixmap: Pixmap,
    fonts: FontManager,
}

impl Canvas2dCompat {
    pub fn new(width: u32, height: u32, fonts: FontManager) -> Result<Self, GfxError> {
        let pixmap =
            Pixmap::new(width.max(1), height.max(1)).ok_or(GfxError::InvalidDimensions(width, height))?;
        Ok(Self { pixmap, fonts })
    }

    pub fn width(&self) -> u32 {
        self.pixmap.width()
    }

    pub fn height(&self) -> u32 {
        self.pixmap.height()
    }

    pub fn fonts(&self) -> &FontManager {
        &self.fonts
    }

    pub fn clear(&mut self, color: Rgba) {
        self.pixmap.fill(color.to_skia());
    }

    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, color: Rgba) {
        if let Some(rect) = Rect::from_xywh(x, y, w.max(1.0), h.max(1.0)) {
            let mut paint = Paint::default();
            paint.set_color(color.to_skia());
            paint.anti_alias = true;
            self.pixmap
                .fill_rect(rect, &paint, Transform::identity(), None);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill_linear_gradient_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        start: Rgba,
        mid: Rgba,
        end: Rgba,
    ) {
        let Some(rect) = Rect::from_xywh(x, y, w.max(1.0), h.max(1.0)) else {
            return;
        };
        let mut paint = Paint {
            anti_alias: true,
            ..Default::default()
        };
        if let Some(shader) = LinearGradient::new(
            Point::from_xy(x, y),
            Point::from_xy(x + w, y + h),
            vec![
                GradientStop::new(0.0, start.to_skia()),
                GradientStop::new(0.5, mid.to_skia()),
                GradientStop::new(1.0, end.to_skia()),
            ],
            SpreadMode::Pad,
            Transform::identity(),
        ) {
            paint.shader = shader;
        } else {
            paint.set_color(start.to_skia());
        }
        self.pixmap
            .fill_rect(rect, &paint, Transform::identity(), None);
    }

    pub fn fill_rounded_rect(&mut self, x: f32, y: f32, w: f32, h: f32, radius: f32, color: Rgba) {
        if let Some(path) = build_rounded_rect_path(x, y, w, h, radius) {
            let mut paint = Paint::default();
            paint.set_color(color.to_skia());
            paint.anti_alias = true;
            self.pixmap.fill_path(
                &path,
                &paint,
                FillRule::Winding,
                Transform::identity(),
                None,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stroke_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: f32,
        line_width: f32,
        color: Rgba,
    ) {
        if let Some(path) = build_rounded_rect_path(x, y, w, h, radius) {
            let mut paint = Paint::default();
            paint.set_color(color.to_skia());
            paint.anti_alias = true;
            let stroke = Stroke {
                width: line_width.max(1.0),
                line_cap: LineCap::Round,
                line_join: LineJoin::Round,
                ..Default::default()
            };
            self.pixmap
                .stroke_path(&path, &paint, &stroke, Transform::identity(), None);
        }
    }

    pub fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, color: Rgba) {
        if let Some(path) = PathBuilder::from_circle(cx, cy, r.max(0.5)) {
            let mut paint = Paint::default();
            paint.set_color(color.to_skia());
            paint.anti_alias = true;
            self.pixmap.fill_path(
                &path,
                &paint,
                FillRule::Winding,
                Transform::identity(),
                None,
            );
        }
    }

    pub fn stroke_circle(&mut self, cx: f32, cy: f32, r: f32, line_width: f32, color: Rgba) {
        if let Some(path) = PathBuilder::from_circle(cx, cy, r.max(0.5)) {
            let mut paint = Paint::default();
            paint.set_color(color.to_skia());
            paint.anti_alias = true;
            let stroke = Stroke {
                width: line_width.max(1.0),
                ..Default::default()
            };
            self.pixmap
                .stroke_path(&path, &paint, &stroke, Transform::identity(), None);
        }
    }

    pub fn draw_line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, width: f32, color: Rgba) {
        let mut pb = PathBuilder::new();
        pb.move_to(x1, y1);
        pb.line_to(x2, y2);
        if let Some(path) = pb.finish() {
            let mut paint = Paint::default();
            paint.set_color(color.to_skia());
            paint.anti_alias = true;
            let stroke = Stroke {
                width: width.max(1.0),
                line_cap: LineCap::Round,
                ..Default::default()
            };
            self.pixmap
                .stroke_path(&path, &paint, &stroke, Transform::identity(), None);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn draw_progress_bar(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        ratio: f32,
        track_color: Rgba,
        fill_color: Rgba,
    ) {
        let r = h * 0.5;
        self.fill_rounded_rect(x, y, w, h, r, track_color);
        let clamped = ratio.clamp(0.0, 1.0);
        if clamped > 0.01 {
            self.fill_rounded_rect(x, y, (w * clamped).max(h), h, r, fill_color);
        }
    }

    /// Resizes `img` with SIMD Lanczos3 and composites it onto `(x, y, dst_w, dst_h)` with optional circular mask.
    pub fn draw_image_fit(
        &mut self,
        img: &DynamicImage,
        x: i32,
        y: i32,
        dst_w: u32,
        dst_h: u32,
        circular_mask: bool,
    ) {
        if dst_w == 0 || dst_h == 0 {
            return;
        }
        let rgba = img.to_rgba8();
        let Ok(src_fir) = FirImage::from_vec_u8(
            rgba.width(),
            rgba.height(),
            rgba.into_raw(),
            PixelType::U8x4,
        ) else {
            return;
        };
        let mut dst_fir = FirImage::new(dst_w, dst_h, PixelType::U8x4);
        let mut resizer = Resizer::new();
        let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
        if resizer.resize(&src_fir, &mut dst_fir, &opts).is_err() {
            return;
        }

        let buf = dst_fir.buffer();
        let cx = (dst_w as f32) * 0.5;
        let cy = (dst_h as f32) * 0.5;
        let radius = cx.min(cy);

        for py in 0..dst_h {
            for px in 0..dst_w {
                let mut alpha_scale = 1.0f32;
                if circular_mask {
                    let dx = (px as f32 + 0.5) - cx;
                    let dy = (py as f32 + 0.5) - cy;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist > radius {
                        continue;
                    } else if dist > radius - 1.2 {
                        alpha_scale = (radius - dist) / 1.2;
                    }
                }
                let idx = ((py * dst_w + px) * 4) as usize;
                let a = ((buf[idx + 3] as f32) * alpha_scale) as u8;
                if a > 0 {
                    self.blend_pixel(x + px as i32, y + py as i32, Rgba(buf[idx], buf[idx + 1], buf[idx + 2], a));
                }
            }
        }
    }

    /// Draws circular avatar (real image if `avatar_bytes` decodes, otherwise stylized monogram avatar) + ring border.
    pub fn draw_avatar_or_monogram(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        avatar_bytes: Option<&[u8]>,
        display_name: &str,
        ring_color: Rgba,
    ) {
        self.fill_circle(cx, cy, radius + 4.0, ring_color);
        if let Some(raw) = avatar_bytes
            && let Ok(img) = image::load_from_memory(raw)
        {
            let d = (radius * 2.0) as u32;
            self.draw_image_fit(&img, (cx - radius) as i32, (cy - radius) as i32, d, d, true);
            return;
        }
        self.fill_circle(cx, cy, radius, Rgba::hex(0x1E293B, 255));
        let initial = display_name
            .trim()
            .chars()
            .next()
            .unwrap_or('Z')
            .to_uppercase()
            .to_string();
        self.draw_text_centered(&initial, cx, cy - radius * 0.38, radius * 0.85, Rgba::WHITE, true);
    }

    /// Renders a sharp QR code matrix directly onto the canvas (`bank_qr_card`, `business_card_qr`).
    pub fn draw_qr_code(
        &mut self,
        payload: &str,
        x: f32,
        y: f32,
        size: f32,
        fg: Rgba,
        bg: Rgba,
    ) -> Result<(), GfxError> {
        let code = QrCode::new(payload.as_bytes()).map_err(|e| GfxError::Qr(e.to_string()))?;
        let modules = code.width() as f32;
        let quiet = 2.0;
        let cell = size / (modules + quiet * 2.0);
        self.fill_rounded_rect(x, y, size, size, 12.0, bg);

        for my in 0..code.width() {
            for mx in 0..code.width() {
                if code[(mx, my)] == qrcode::Color::Dark {
                    let rx = x + (mx as f32 + quiet) * cell;
                    let ry = y + (my as f32 + quiet) * cell;
                    self.fill_rect(rx, ry, cell + 0.4, cell + 0.4, fg);
                }
            }
        }
        Ok(())
    }

    /// Rasterizes UTF-8 Vietnamese + Emoji text using `ab_glyph` with per-glyph font fallback
    /// (and built-in vector block fallback when running without external `.ttf` files).
    #[allow(clippy::too_many_arguments)]
    pub fn draw_text(
        &mut self,
        text: &str,
        x: f32,
        y: f32,
        px_size: f32,
        color: Rgba,
        family: &str,
        bold: bool,
    ) {
        if text.is_empty() || color.3 == 0 {
            return;
        }
        let pref = self.fonts.resolve_family(family, bold);
        if pref.is_none() && !self.fonts.has_loaded_fonts() {
            self.draw_builtin_fallback_text(text, x, y, px_size, color);
            return;
        }

        let scale = PxScale::from(px_size.max(1.0));
        let mut cursor_x = x;
        let baseline_y = y + px_size * 0.84;

        for ch in text.chars() {
            if ch == '\n' || ch == '\r' {
                continue;
            }
            if let Some(font) = self.fonts.pick_font_for_char(pref.as_ref(), ch) {
                let sf = font.as_scaled(scale);
                let gid = sf.glyph_id(ch);
                let glyph = gid.with_scale_and_position(scale, point(cursor_x, baseline_y));
                if let Some(outlined) = font.outline_glyph(glyph) {
                    let bounds = outlined.px_bounds();
                    outlined.draw(|gx, gy, cov| {
                        let a = ((cov.clamp(0.0, 1.0)) * (color.3 as f32)) as u8;
                        if a > 0 {
                            let px = bounds.min.x as i32 + gx as i32;
                            let py = bounds.min.y as i32 + gy as i32;
                            self.blend_pixel(px, py, Rgba(color.0, color.1, color.2, a));
                        }
                    });
                }
                cursor_x += sf.h_advance(gid);
            } else {
                cursor_x += px_size * 0.55;
            }
        }
    }

    pub fn draw_text_centered(
        &mut self,
        text: &str,
        center_x: f32,
        y: f32,
        px_size: f32,
        color: Rgba,
        bold: bool,
    ) {
        let w = self.fonts.measure_text_width(text, px_size, "sans-serif", bold);
        self.draw_text(text, center_x - w * 0.5, y, px_size, color, "sans-serif", bold);
    }

    pub fn draw_text_right(
        &mut self,
        text: &str,
        right_x: f32,
        y: f32,
        px_size: f32,
        color: Rgba,
        bold: bool,
    ) {
        let w = self.fonts.measure_text_width(text, px_size, "sans-serif", bold);
        self.draw_text(text, right_x - w, y, px_size, color, "sans-serif", bold);
    }

    pub fn ellipsize(&self, text: &str, max_width: f32, px_size: f32, bold: bool) -> String {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        if self.fonts.measure_text_width(trimmed, px_size, "sans-serif", bold) <= max_width {
            return trimmed.to_string();
        }
        let mut chars: Vec<char> = trimmed.chars().collect();
        while !chars.is_empty() {
            chars.pop();
            let candidate: String = chars.iter().collect();
            let with_dots = format!("{}…", candidate.trim_end());
            if self.fonts.measure_text_width(&with_dots, px_size, "sans-serif", bold) <= max_width {
                return with_dots;
            }
        }
        "…".to_string()
    }

    /// Draws a rounded-rectangle masked image (`event-image.js`, `info.js` covers).
    pub fn draw_rounded_image_fit(
        &mut self,
        img: &DynamicImage,
        x: i32,
        y: i32,
        dst_w: u32,
        dst_h: u32,
        corner_radius: f32,
    ) {
        if dst_w == 0 || dst_h == 0 {
            return;
        }
        let rgba = img.to_rgba8();
        let Ok(src_fir) = FirImage::from_vec_u8(
            rgba.width(),
            rgba.height(),
            rgba.into_raw(),
            PixelType::U8x4,
        ) else {
            return;
        };
        let mut dst_fir = FirImage::new(dst_w, dst_h, PixelType::U8x4);
        let mut resizer = Resizer::new();
        let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
        if resizer.resize(&src_fir, &mut dst_fir, &opts).is_err() {
            return;
        }

        let buf = dst_fir.buffer();
        let r = corner_radius.clamp(0.0, (dst_w.min(dst_h) as f32) * 0.5);
        let wf = dst_w as f32;
        let hf = dst_h as f32;

        for py in 0..dst_h {
            for px in 0..dst_w {
                let fx = px as f32 + 0.5;
                let fy = py as f32 + 0.5;
                let mut alpha_scale = 1.0f32;
                if r > 0.5 {
                    let dx = if fx < r {
                        r - fx
                    } else if fx > wf - r {
                        fx - (wf - r)
                    } else {
                        0.0
                    };
                    let dy = if fy < r {
                        r - fy
                    } else if fy > hf - r {
                        fy - (hf - r)
                    } else {
                        0.0
                    };
                    if dx > 0.0 && dy > 0.0 {
                        let dist = (dx * dx + dy * dy).sqrt();
                        if dist > r {
                            continue;
                        } else if dist > r - 1.2 {
                            alpha_scale = (r - dist) / 1.2;
                        }
                    }
                }
                let idx = ((py * dst_w + px) * 4) as usize;
                let a = ((buf[idx + 3] as f32) * alpha_scale) as u8;
                if a > 0 {
                    self.blend_pixel(
                        x + px as i32,
                        y + py as i32,
                        Rgba(buf[idx], buf[idx + 1], buf[idx + 2], a),
                    );
                }
            }
        }
    }

    /// Draws a filled circular pie chart (`info.js` RAM & Disk Usage).
    #[allow(clippy::too_many_arguments)]
    pub fn draw_pie_chart(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        used_percent: f32,
        used_color: Rgba,
        free_color: Rgba,
    ) {
        let r_int = radius.ceil() as i32;
        let clamped_pct = used_percent.clamp(0.0, 100.0);
        let used_angle_max = (clamped_pct / 100.0) * std::f32::consts::TAU;

        for dy in -r_int..=r_int {
            for dx in -r_int..=r_int {
                let fx = dx as f32;
                let fy = dy as f32;
                let dist = (fx * fx + fy * fy).sqrt();
                if dist > radius {
                    continue;
                }
                let alpha = if dist > radius - 1.2 {
                    ((radius - dist) / 1.2 * 255.0) as u8
                } else {
                    255
                };
                // Angle clockwise from 12 o'clock (-PI/2)
                let mut angle = fy.atan2(fx) + std::f32::consts::FRAC_PI_2;
                if angle < 0.0 {
                    angle += std::f32::consts::TAU;
                }
                let col = if angle <= used_angle_max {
                    Rgba(used_color.0, used_color.1, used_color.2, alpha)
                } else {
                    Rgba(free_color.0, free_color.1, free_color.2, alpha)
                };
                self.blend_pixel(cx as i32 + dx, cy as i32 + dy, col);
            }
        }
        self.stroke_circle(cx, cy, radius, 2.0, Rgba::WHITE);
    }

    pub fn draw_text_with_shadow(
        &mut self,
        text: &str,
        x: f32,
        y: f32,
        px_size: f32,
        color: Rgba,
        bold: bool,
    ) {
        self.draw_text(
            text,
            x + 2.0,
            y + 2.0,
            px_size,
            Rgba(0, 0, 0, 150),
            "sans-serif",
            bold,
        );
        self.draw_text(text, x, y, px_size, color, "sans-serif", bold);
    }

    fn draw_builtin_fallback_text(&mut self, text: &str, x: f32, y: f32, px: f32, color: Rgba) {
        let mut cx = x;
        let w = (px * 0.42).max(2.0);
        let h = (px * 0.72).max(4.0);
        for ch in text.chars() {
            if !ch.is_whitespace() {
                self.fill_rounded_rect(cx, y + px * 0.14, w, h, 2.0, color);
            }
            cx += px * 0.58;
        }
    }

    #[inline]
    fn blend_pixel(&mut self, x: i32, y: i32, src: Rgba) {
        if x < 0 || y < 0 || x >= self.width() as i32 || y >= self.height() as i32 {
            return;
        }
        let w = self.width() as usize;
        let idx = ((y as usize) * w + (x as usize)) * 4;
        let data = self.pixmap.data_mut();
        let sa = (src.3 as u32) & 0xFF;
        if sa == 0 {
            return;
        }
        let inv_sa = 255 - sa;
        // `tiny-skia` stores premultiplied RGBA8
        let sr_p = (src.0 as u32 * sa + 127) / 255;
        let sg_p = (src.1 as u32 * sa + 127) / 255;
        let sb_p = (src.2 as u32 * sa + 127) / 255;

        data[idx] = (sr_p + (data[idx] as u32 * inv_sa + 127) / 255).min(255) as u8;
        data[idx + 1] = (sg_p + (data[idx + 1] as u32 * inv_sa + 127) / 255).min(255) as u8;
        data[idx + 2] = (sb_p + (data[idx + 2] as u32 * inv_sa + 127) / 255).min(255) as u8;
        data[idx + 3] = (sa + (data[idx + 3] as u32 * inv_sa + 127) / 255).min(255) as u8;
    }

    /// Unpremultiplies pixels into an `image::RgbaImage`.
    pub fn to_rgba_image(&self) -> RgbaImage {
        let w = self.width();
        let h = self.height();
        let src = self.pixmap.data();
        let mut out = vec![0u8; src.len()];
        for i in (0..src.len()).step_by(4) {
            let a = src[i + 3] as u32;
            if a == 0 {
                continue;
            } else if a == 255 {
                out[i] = src[i];
                out[i + 1] = src[i + 1];
                out[i + 2] = src[i + 2];
                out[i + 3] = 255;
            } else {
                out[i] = ((src[i] as u32 * 255) / a).min(255) as u8;
                out[i + 1] = ((src[i + 1] as u32 * 255) / a).min(255) as u8;
                out[i + 2] = ((src[i + 2] as u32 * 255) / a).min(255) as u8;
                out[i + 3] = a as u8;
            }
        }
        RgbaImage::from_raw(w, h, out).expect("exact buffer size")
    }

    pub fn encode_png(&self) -> Result<Vec<u8>, GfxError> {
        let img = DynamicImage::ImageRgba8(self.to_rgba_image());
        let mut cursor = Cursor::new(Vec::with_capacity(64 * 1024));
        img.write_to(&mut cursor, ImageFormat::Png)?;
        Ok(cursor.into_inner())
    }

    pub fn encode_webp(&self) -> Result<Vec<u8>, GfxError> {
        let img = DynamicImage::ImageRgba8(self.to_rgba_image());
        let mut cursor = Cursor::new(Vec::with_capacity(48 * 1024));
        img.write_to(&mut cursor, ImageFormat::WebP)?;
        Ok(cursor.into_inner())
    }
}

/// Encodes a sequence of `Canvas2dCompat` frames into an infinitely-looping animated `GIF89a`.
pub fn encode_animated_gif(frames: &[Canvas2dCompat], delay_cs: u16) -> Result<Vec<u8>, GfxError> {
    let Some(first) = frames.first() else {
        return Err(GfxError::InvalidDimensions(0, 0));
    };
    let w = first.width() as u16;
    let h = first.height() as u16;
    let mut buf = Vec::with_capacity(128 * 1024);
    {
        let mut encoder = GifEncoder::new(&mut buf, w, h, &[])?;
        encoder.set_repeat(Repeat::Infinite)?;
        for canvas in frames {
            let mut rgba = canvas.to_rgba_image().into_raw();
            let mut frame = GifFrame::from_rgba_speed(w, h, &mut rgba, 10);
            frame.delay = delay_cs.max(2);
            encoder.write_frame(&frame)?;
        }
    }
    Ok(buf)
}

fn build_rounded_rect_path(
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    radius: f32,
) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let r = radius.clamp(0.0, (w * 0.5).min(h * 0.5));
    let mut pb = PathBuilder::new();
    if r <= 0.5 {
        pb.push_rect(Rect::from_xywh(x, y, w, h)?);
        return pb.finish();
    }
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    pb.finish()
}
