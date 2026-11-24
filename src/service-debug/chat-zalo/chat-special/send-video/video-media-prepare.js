import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { tempDir } from "../../../../utils/io-json.js";
import { getFfmpegExecutableSync, getFfprobeExecutableSync } from "../../../../utils/runtime-dependencies.js";

const execFileAsync = promisify(execFile);

/**
 * Lỗi môi trường: thiếu ffmpeg/ffprobe hoặc binary không chạy được.
 * Đây là lỗi dừng NGAY của cả lượt gửi (không quét thêm candidate).
 */
export class VideoToolMissingError extends Error {
  constructor(tool, cause = null) {
    super(`Required media tool "${tool}" is missing or not executable`);
    this.name = "VideoToolMissingError";
    this.code = "VIDEO_TOOL_MISSING";
    this.tool = tool;
    this.cause = cause;
  }
}

/**
 * Lỗi thuộc về chính file MP4: không đọc được, hỏng, quá ngắn để có metadata
 * hợp lệ hoặc không trích được frame. Caller được phép bỏ qua sang file khác.
 */
export class VideoFileUnreadableError extends Error {
  constructor(message, { stage = "", cause = null } = {}) {
    super(message);
    this.name = "VideoFileUnreadableError";
    this.code = "VIDEO_FILE_UNREADABLE";
    this.stage = stage;
    this.cause = cause;
  }
}

export function isToolMissingError(error) {
  if (!error) return false;
  const code = String(error.code || error.status || error.exitCode || "");
  const msg = String(error.message || "");
  if (
    error.code === "ENOENT" ||
    error.errno === -4058 ||
    code === "3221225785" ||
    code === "0xC0000139" ||
    msg.includes("3221225785") ||
    msg.includes("0xC0000139") ||
    msg.includes("ENTRYPOINT_NOT_FOUND")
  ) {
    return true;
  }
  return /spawn .* ENOENT|is not recognized|command not found|no such file or directory/i.test(
    msg,
  );
}

async function defaultRunTool(binary, args) {
  let resolvedBinary = binary;
  if (binary === "ffmpeg") {
    resolvedBinary = getFfmpegExecutableSync() || binary;
  } else if (binary === "ffprobe") {
    resolvedBinary = getFfprobeExecutableSync() || binary;
  }
  return execFileAsync(resolvedBinary, args, { timeout: binary === 'ffmpeg' ? 180000 : 15000, windowsHide: true });
}

/**
 * Đọc metadata thật từ file MP4 bằng ffprobe và trích frame đầu ra JPEG bằng ffmpeg.
 * Trả về { filePath, thumbnailPath, metadata: { duration, width, height, fileSize } }
 * (duration tính bằng ms) hoặc ném VideoToolMissingError / VideoFileUnreadableError.
 *
 * @param {string} filePath Đường dẫn tuyệt đối tới file .mp4
 * @param {object} [options]
 * @param {object} [options.fsImpl=fs] FS injectable cho test
 * @param {(binary: string, args: string[]) => Promise<{stdout: string, stderr: string}>} [options.runTool]
 * @param {string} [options.tempDirectory] Thư mục chứa thumbnail tạm
 */
export async function prepareLocalVideoMedia(filePath, { fsImpl = fs, runTool = defaultRunTool, tempDirectory = tempDir, normalize = false } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new VideoFileUnreadableError("Video path is empty", { stage: "stat" });
  }

  let stat;
  try {
    stat = await fsImpl.promises.stat(filePath);
  } catch (error) {
    throw new VideoFileUnreadableError("Video file is not readable", { stage: "stat", cause: error });
  }
  if (!stat || stat.size <= 0 || (typeof stat.isFile === "function" && !stat.isFile())) {
    throw new VideoFileUnreadableError("Video file is empty or not a regular file", { stage: "stat" });
  }

  let stdout;
  try {
    ({ stdout } = await runTool("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]));
  } catch (error) {
    if (isToolMissingError(error)) throw new VideoToolMissingError("ffprobe", error);
    throw new VideoFileUnreadableError("ffprobe could not analyze the video file", { stage: "probe", cause: error });
  }

  let probed;
  try {
    probed = JSON.parse(stdout);
  } catch (error) {
    throw new VideoFileUnreadableError("ffprobe returned malformed metadata", { stage: "probe", cause: error });
  }

  const videoStream = Array.isArray(probed?.streams) ? probed.streams.find((s) => s?.codec_type === "video") : null;
  const audioStreams = (probed?.streams || []).filter(s => s.codec_type === 'audio');
  if (normalize && videoStream && (videoStream.codec_name !== 'h264' ||
      !String(probed.format?.format_name || '').includes('mp4') ||
      audioStreams.some(s => s.codec_name !== 'aac') ||
      (videoStream.pix_fmt && videoStream.pix_fmt !== 'yuv420p'))) {
    await fsImpl.promises.mkdir(tempDirectory, { recursive: true });
    const converted = path.join(tempDirectory, `video-normalized-${randomUUID()}.mp4`);
    try {
      await runTool('ffmpeg', ['-v', 'error', '-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart', converted]);
      return await prepareLocalVideoMedia(converted, { fsImpl, runTool, tempDirectory });
    } catch (error) {
      await fsImpl.promises.unlink(converted).catch(() => {});
      if (isToolMissingError(error)) throw new VideoToolMissingError('ffmpeg', error);
      throw error;
    }
  }
  const durationMs = Math.round(Number(probed?.format?.duration ?? videoStream?.duration ?? 0) * 1000);
  const width = Math.round(Number(videoStream?.width) || 0);
  const height = Math.round(Number(videoStream?.height) || 0);
  const fileSize = stat.size;

  if (!videoStream || durationMs <= 0 || width <= 0 || height <= 0 || fileSize <= 0) {
    throw new VideoFileUnreadableError("Video metadata is incomplete (duration/width/height/fileSize)", { stage: "probe" });
  }

  try {
    await fsImpl.promises.mkdir(tempDirectory, { recursive: true });
  } catch {
    // Thư mục tạm đã tồn tại hoặc FS giả lập trong test: bỏ qua
  }
  const thumbnailPath = path.join(tempDirectory, `vd-thumb_${randomUUID()}.jpg`);

  try {
    // Frame ĐẦU TIÊN (không seek): an toàn cả với video rất ngắn.
    await runTool("ffmpeg", ["-v", "error", "-y", "-i", filePath, "-vframes", "1", thumbnailPath]);
  } catch (error) {
    try {
      await fsImpl.promises.unlink(thumbnailPath);
    } catch {
      // Không có gì để dọn
    }
    if (isToolMissingError(error)) throw new VideoToolMissingError("ffmpeg", error);
    throw new VideoFileUnreadableError("Could not extract a preview frame from the video", { stage: "frame", cause: error });
  }

  let thumbnailStat;
  try {
    thumbnailStat = await fsImpl.promises.stat(thumbnailPath);
  } catch (error) {
    throw new VideoFileUnreadableError("Thumbnail frame was not written", { stage: "thumbnail", cause: error });
  }
  if (!thumbnailStat || thumbnailStat.size <= 0) {
    try {
      await fsImpl.promises.unlink(thumbnailPath);
    } catch {
      // Không có gì để dọn
    }
    throw new VideoFileUnreadableError("Thumbnail frame is empty", { stage: "thumbnail" });
  }

  return {
    filePath,
    thumbnailPath,
    metadata: { duration: durationMs, width, height, fileSize },
  };
}
