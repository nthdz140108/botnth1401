//! Subprocess Wrapper for `ffmpeg`, `ffprobe`, and `yt-dlp` with Linux `PR_SET_PDEATHSIG(SIGKILL)`
//! and RAM Scratchpad (`/dev/shm/mybot`) output isolation.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::{MediaError, RamScratchpad, ScratchFile};

#[derive(Clone, Debug)]
pub struct CliMediaRunner {
    scratchpad: RamScratchpad,
    ffmpeg_bin: String,
    ffprobe_bin: String,
    ytdlp_bin: String,
    ffmpeg_sem: Arc<Semaphore>,
    ytdlp_sem: Arc<Semaphore>,
}

impl Default for CliMediaRunner {
    fn default() -> Self {
        Self::new(RamScratchpad::default(), 4, 4)
    }
}

impl CliMediaRunner {
    pub fn new(scratchpad: RamScratchpad, max_ffmpeg: usize, max_ytdlp: usize) -> Self {
        Self {
            scratchpad,
            ffmpeg_bin: std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()),
            ffprobe_bin: std::env::var("FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".into()),
            ytdlp_bin: std::env::var("YTDLP_PATH").unwrap_or_else(|_| "yt-dlp".into()),
            ffmpeg_sem: Arc::new(Semaphore::new(max_ffmpeg.max(1))),
            ytdlp_sem: Arc::new(Semaphore::new(max_ytdlp.max(1))),
        }
    }

    pub fn scratchpad(&self) -> &RamScratchpad {
        &self.scratchpad
    }

    /// Queries media duration in seconds via `ffprobe` (`!editvideo` / 3-frame NSFW sampling).
    pub async fn probe_duration_secs(&self, input_path: &Path) -> Result<f64, MediaError> {
        let mut cmd = Command::new(&self.ffprobe_bin);
        cmd.args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(input_path);
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(6), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffprobe timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffprobe: {e}")))?;
        let text = String::from_utf8_lossy(&res.stdout);
        text.trim()
            .parse::<f64>()
            .map_err(|e| MediaError::Decode(format!("parse ffprobe duration: {e}")))
    }

    fn apply_orphan_guard(cmd: &mut Command) {
        cmd.kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
    }

    pub async fn probe_binary_version(bin: &str, flag: &str) -> Option<String> {
        let mut cmd = Command::new(bin);
        cmd.arg(flag);
        Self::apply_orphan_guard(&mut cmd);
        let out = tokio::time::timeout(Duration::from_secs(4), cmd.output())
            .await
            .ok()?
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .map(|s| s.trim().to_string())
    }

    /// Transcodes any audio input to Zalo-compatible AAC (`/ThanhHung.aac`) inside `/dev/shm/mybot`.
    pub async fn transcode_voice_aac(
        &self,
        input_path: &Path,
        timeout_secs: u64,
    ) -> Result<ScratchFile, MediaError> {
        let _permit = self
            .ffmpeg_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("ffmpeg semaphore closed".into()))?;
        let out = self
            .scratchpad
            .allocate_file("voice", "aac", 4 * 1024 * 1024)
            .await?;

        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args(["-y", "-i"])
            .arg(input_path)
            .args(["-vn", "-c:a", "aac", "-b:a", "96k", "-ar", "44100"])
            .arg(out.path());
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs.max(5)), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffmpeg voice transcode timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffmpeg: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "ffmpeg voice failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        Ok(out)
    }

    /// Converts an image or short clip into a `512x512` WebP Zalo sticker (`!sticker` / `!stkc`).
    pub async fn convert_to_webp_sticker(
        &self,
        input_path: &Path,
        circle_crop: bool,
        timeout_secs: u64,
    ) -> Result<ScratchFile, MediaError> {
        // Pure-Rust fast path for static images when `ffmpeg` is not needed!
        if let Ok(bytes) = tokio::fs::read(input_path).await
            && let Ok(img) = image::load_from_memory(&bytes)
        {
            let mut rgba = img
                .resize_exact(512, 512, image::imageops::FilterType::Lanczos3)
                .to_rgba8();
            if circle_crop {
                let center = 256.0f32;
                let r2 = 252.0f32 * 252.0f32;
                for (x, y, px) in rgba.enumerate_pixels_mut() {
                    let dx = x as f32 - center;
                    let dy = y as f32 - center;
                    if dx * dx + dy * dy > r2 {
                        px[3] = 0;
                    }
                }
            }
            let out = self
                .scratchpad
                .allocate_file("sticker", "webp", 2 * 1024 * 1024)
                .await?;
            let mut buf = Vec::new();
            image::DynamicImage::ImageRgba8(rgba)
                .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::WebP)
                .map_err(|e| MediaError::Decode(format!("encode sticker webp: {e}")))?;
            tokio::fs::write(out.path(), &buf).await?;
            return Ok(out);
        }

        // Animated video/GIF fallback via `ffmpeg` `libwebp`
        let _permit = self
            .ffmpeg_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("ffmpeg semaphore closed".into()))?;
        let out = self
            .scratchpad
            .allocate_file("sticker_anim", "webp", 6 * 1024 * 1024)
            .await?;

        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args(["-y", "-t", "6", "-i"])
            .arg(input_path)
            .args([
                "-vf",
                "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=0x00000000",
                "-vcodec",
                "libwebp",
                "-lossless",
                "0",
                "-q:v",
                "70",
                "-loop",
                "0",
                "-an",
            ])
            .arg(out.path());
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs.max(8)), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffmpeg animated sticker timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffmpeg: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "ffmpeg webp failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        Ok(out)
    }

    /// Cuts a video clip (`!cutvideo`) without re-encoding (`-c copy`) when possible.
    pub async fn cut_video_segment(
        &self,
        input_path: &Path,
        start_secs: f64,
        duration_secs: f64,
        timeout_secs: u64,
    ) -> Result<ScratchFile, MediaError> {
        let _permit = self
            .ffmpeg_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("ffmpeg semaphore closed".into()))?;
        let out = self
            .scratchpad
            .allocate_file("cutvideo", "mp4", 32 * 1024 * 1024)
            .await?;

        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args([
            "-y",
            "-ss",
            &format!("{start_secs:.2}"),
            "-t",
            &format!("{duration_secs:.2}"),
            "-i",
        ])
        .arg(input_path)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(out.path());
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs.max(10)), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffmpeg cutvideo timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffmpeg: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "ffmpeg cutvideo failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        Ok(out)
    }

    /// Extracts metadata JSON via `yt-dlp --dump-single-json --no-playlist`.
    pub async fn ytdlp_extract_info(&self, url_or_query: &str) -> Result<Value, MediaError> {
        let _permit = self
            .ytdlp_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("yt-dlp semaphore closed".into()))?;

        let mut cmd = Command::new(&self.ytdlp_bin);
        cmd.args([
            "--dump-single-json",
            "--no-playlist",
            "--no-warnings",
            "--geo-bypass",
            url_or_query,
        ]);
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(20), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("yt-dlp metadata timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn yt-dlp: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "yt-dlp metadata error: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }

        serde_json::from_slice(&res.stdout)
            .map_err(|e| MediaError::Decode(format!("parse yt-dlp json: {e}")))
    }

    /// Downloads media via `yt-dlp` directly into the `/dev/shm/mybot` RAM scratchpad.
    pub async fn ytdlp_download_to_ram(
        &self,
        url: &str,
        audio_only: bool,
        max_bytes: usize,
    ) -> Result<ScratchFile, MediaError> {
        let _permit = self
            .ytdlp_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("yt-dlp semaphore closed".into()))?;
        let ext = if audio_only { "m4a" } else { "mp4" };
        let out = self
            .scratchpad
            .allocate_file("ytdlp", ext, max_bytes.max(8 * 1024 * 1024))
            .await?;

        let mut cmd = Command::new(&self.ytdlp_bin);
        cmd.args(["--no-playlist", "--no-warnings", "--max-filesize", "48M"]);
        if audio_only {
            cmd.args(["-f", "bestaudio[ext=m4a]/bestaudio"]);
        } else {
            cmd.args(["-f", "best[ext=mp4][height<=720]/best[height<=720]/best"]);
        }
        cmd.arg("-o").arg(out.path()).arg(url);
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(45), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("yt-dlp download timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn yt-dlp: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "yt-dlp download failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        Ok(out)
    }

    /// Converts a video file into an animated GIF via FFmpeg with Node V3 palette optimization (`!gifvd`).
    pub async fn convert_video_to_gif(
        &self,
        input_path: &Path,
        duration_secs: f64,
        fps: u32,
        timeout_secs: u64,
    ) -> Result<ScratchFile, MediaError> {
        let _permit = self
            .ffmpeg_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("ffmpeg semaphore closed".into()))?;
        let out = self
            .scratchpad
            .allocate_file("gifvd", "gif", 10 * 1024 * 1024)
            .await?;

        let mut cmd = Command::new(&self.ffmpeg_bin);
        let filter = format!(
            "fps={fps},scale=160:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse"
        );
        cmd.args(["-y", "-t", &format!("{duration_secs:.2}"), "-i"])
            .arg(input_path)
            .args([
                "-vf",
                &filter,
                "-c:v",
                "gif",
                "-loop",
                "0",
                "-b:v",
                "500k",
            ])
            .arg(out.path());
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs.max(15)), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffmpeg convert_video_to_gif timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffmpeg: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "ffmpeg gif conversion failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        let metadata = tokio::fs::metadata(out.path()).await?;
        if metadata.len() == 0 {
            return Err(MediaError::Subprocess("File GIF rỗng hoặc không hợp lệ".into()));
        }
        if metadata.len() > 10 * 1024 * 1024 {
            return Err(MediaError::Subprocess(format!(
                "File GIF quá lớn ({:.2}MB). Giới hạn là 10MB.",
                metadata.len() as f64 / 1024.0 / 1024.0
            )));
        }
        Ok(out)
    }

    /// Converts a static image into a 10s MP4 video (`!editvideo` parity with Node V3 `imageToVideo`).
    pub async fn image_to_video_mp4(
        &self,
        input_path: &Path,
        duration_secs: f64,
        timeout_secs: u64,
    ) -> Result<ScratchFile, MediaError> {
        let _permit = self
            .ffmpeg_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("ffmpeg semaphore closed".into()))?;
        let out = self
            .scratchpad
            .allocate_file("img2vid", "mp4", 16 * 1024 * 1024)
            .await?;

        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args(["-y", "-loop", "1", "-i"])
            .arg(input_path)
            .args([
                "-c:v",
                "libx264",
                "-t",
                &format!("{duration_secs:.2}"),
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
                "-movflags",
                "+faststart",
            ])
            .arg(out.path());
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs.max(15)), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffmpeg image_to_video timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffmpeg: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "ffmpeg image_to_video failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        let metadata = tokio::fs::metadata(out.path()).await?;
        if metadata.len() == 0 {
            return Err(MediaError::Subprocess("File video sinh ra rỗng".into()));
        }
        Ok(out)
    }

    /// Cuts or edits video segment with fallback re-encoding when stream-copy (`-c copy`) fails.
    pub async fn cut_video_segment_compat(
        &self,
        input_path: &Path,
        start_secs: f64,
        duration_secs: f64,
        timeout_secs: u64,
    ) -> Result<ScratchFile, MediaError> {
        // Fast path: try cut_video_segment first (-c copy)
        if let Ok(file) = self.cut_video_segment(input_path, start_secs, duration_secs, timeout_secs).await {
            if let Ok(meta) = tokio::fs::metadata(file.path()).await && meta.len() > 0 {
                return Ok(file);
            }
        }

        // Fallback: re-encode via x264/aac
        let _permit = self
            .ffmpeg_sem
            .acquire()
            .await
            .map_err(|_| MediaError::Subprocess("ffmpeg semaphore closed".into()))?;
        let out = self
            .scratchpad
            .allocate_file("cutvideo", "mp4", 32 * 1024 * 1024)
            .await?;

        let mut cmd = Command::new(&self.ffmpeg_bin);
        cmd.args([
            "-y",
            "-ss",
            &format!("{start_secs:.2}"),
            "-t",
            &format!("{duration_secs:.2}"),
            "-i",
        ])
        .arg(input_path)
        .args([
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-strict",
            "-2",
            "-movflags",
            "+faststart",
        ])
        .arg(out.path());
        Self::apply_orphan_guard(&mut cmd);

        let res = tokio::time::timeout(Duration::from_secs(timeout_secs.max(15)), cmd.output())
            .await
            .map_err(|_| MediaError::Timeout("ffmpeg cutvideo re-encode timed out".into()))?
            .map_err(|e| MediaError::Subprocess(format!("spawn ffmpeg: {e}")))?;

        if !res.status.success() {
            return Err(MediaError::Subprocess(format!(
                "ffmpeg cutvideo re-encode failed: {}",
                String::from_utf8_lossy(&res.stderr)
            )));
        }
        let metadata = tokio::fs::metadata(out.path()).await?;
        if metadata.len() == 0 {
            return Err(MediaError::Subprocess("File video sinh ra rỗng".into()));
        }
        Ok(out)
    }
}
