import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { fileTypeFromFile } from "file-type";
import { MessageMention } from "../../../../api-zalo/models/index.js";
import { MessageType } from "../../../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../../../service.js";
import { sendMessageWarningRequest, sendMessageProcessingRequest } from "../../chat-style/chat-style.js";
import { tempDir } from "../../../../utils/io-json.js";
import { deleteFile } from "../../../../utils/util.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
  getFfprobeExecutableSync,
} from "../../../../utils/runtime-dependencies.js";
import {
  extractCleanArgs,
  getQuoteData,
  safeThreadType,
} from "../../../../commands/shared/command-input-utils.js";
import { prepareLocalVideoMedia } from "../send-video/video-media-prepare.js";
import { downloadMedia } from "./downloadMedia.js";

const execFileAsync = promisify(execFile);
configureFluentFfmpeg();

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".jxl", ".heic", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".flv", ".m4v", ".3gp"]);
const MAX_CLIP_DURATION_SEC = 180;

function extractUploadedUrl(uploadResult, fields) {
  const first = Array.isArray(uploadResult) ? uploadResult[0] : uploadResult;
  if (!first || typeof first !== "object") return "";
  for (const field of fields) {
    const val = first[field];
    if (typeof val === "string" && /^https?:\/\//i.test(val.trim())) {
      return val.trim();
    }
  }
  return "";
}

function normalizeAttachUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  const cleaned = rawUrl.replace(/\\\//g, "/").trim();
  if (!cleaned) return "";
  try {
    return new URL(cleaned).toString();
  } catch {
    try {
      return decodeURIComponent(cleaned);
    } catch {
      return cleaned;
    }
  }
}

function parseQuoteAttachment(quote) {
  if (!quote || typeof quote !== "object") return null;
  let attachData = null;
  if (quote.attach) {
    if (typeof quote.attach === "object") {
      attachData = quote.attach;
    } else if (typeof quote.attach === "string") {
      try {
        attachData = JSON.parse(quote.attach);
      } catch {
        attachData = null;
      }
    }
  }

  const rawUrl =
    attachData?.hdUrl ||
    attachData?.oriUrl ||
    attachData?.href ||
    attachData?.normalUrl ||
    attachData?.fileUrl ||
    attachData?.thumbUrl ||
    quote.hdUrl ||
    quote.href ||
    "";

  const mediaUrl = normalizeAttachUrl(rawUrl);
  if (!mediaUrl) return null;

  let urlExt = "";
  try {
    urlExt = path.extname(new URL(mediaUrl).pathname).toLowerCase();
  } catch {
    urlExt = path.extname(mediaUrl.split("?")[0]).toLowerCase();
  }

  const rawMime = String(attachData?.mimeType || attachData?.mime || "").toLowerCase();
  const cliMsgType = Number(quote.cliMsgType);
  const hintImage =
    rawMime.startsWith("image/") ||
    IMAGE_EXTENSIONS.has(urlExt) ||
    cliMsgType === 3;
  const hintVideo =
    rawMime.startsWith("video/") ||
    VIDEO_EXTENSIONS.has(urlExt) ||
    Boolean(attachData?.duration || attachData?.params?.includes?.("duration"));

  return {
    mediaUrl,
    urlExt,
    hintImage: hintImage && !hintVideo,
    hintVideo,
  };
}

export function parseEditVideoOptions(rawArgs = []) {
  const tokens = Array.isArray(rawArgs) ? rawArgs.map((t) => String(t).trim()).filter(Boolean) : [];
  let startSec = 0;
  let endSec = 10;
  let mute = false;
  let speed = 1;

  const numericTokens = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();

    if (lower === "mute" || lower === "-mute" || lower === "--mute" || lower === "tatam") {
      mute = true;
      continue;
    }

    if (lower === "speed" || lower === "-speed" || lower === "--speed" || lower === "sp") {
      const nextVal = Number(tokens[i + 1]);
      if (!Number.isFinite(nextVal) || nextVal < 0.25 || nextVal > 4) {
        return { error: "Tốc độ video (speed) phải nằm trong khoảng từ 0.25 đến 4.0 (ví dụ: speed 1.5)." };
      }
      speed = nextVal;
      i += 1;
      continue;
    }

    const speedMatch = /^(?:speed|sp)[=:(\s]?(\d+(?:\.\d+)?)\)?$/i.exec(token);
    if (speedMatch) {
      const val = Number(speedMatch[1]);
      if (!Number.isFinite(val) || val < 0.25 || val > 4) {
        return { error: "Tốc độ video (speed) phải nằm trong khoảng từ 0.25 đến 4.0 (ví dụ: speed 1.5)." };
      }
      speed = val;
      continue;
    }

    if (/^\d+(?:\.\d+)?$/.test(token)) {
      numericTokens.push(Number(token));
      continue;
    }

    return { error: `Tham số không hợp lệ: "${token}".` };
  }

  if (numericTokens.length === 1) {
    startSec = 0;
    endSec = numericTokens[0];
  } else if (numericTokens.length >= 2) {
    startSec = numericTokens[0];
    endSec = numericTokens[1];
  }

  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    return { error: "Khoảng thời gian cắt không hợp lệ (giây kết thúc phải lớn hơn giây bắt đầu và >= 0)." };
  }

  const clipDuration = endSec - startSec;
  if (clipDuration > MAX_CLIP_DURATION_SEC) {
    return { error: `Độ dài đoạn video tối đa là ${MAX_CLIP_DURATION_SEC} giây.` };
  }

  return {
    startSec,
    endSec,
    duration: clipDuration,
    mute,
    speed,
    error: null,
  };
}

function buildAtempoFilterChain(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1.0) > 0.001 || filters.length === 0) {
    filters.push(`atempo=${remaining.toFixed(4)}`);
  }
  return filters.join(",");
}

async function hasAudioStream(filePath) {
  const ffprobeBin = getFfprobeExecutableSync() || "ffprobe";
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", filePath],
      { timeout: 10000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout || "{}");
    return Array.isArray(parsed.streams) && parsed.streams.length > 0;
  } catch {
    return false;
  }
}

export async function handleCutVideoCommand(api, message, aliasCommand = "editvideo") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "editvideo";
  const msgType = safeThreadType(message, MessageType.DirectMessage);
  const isGroup = msgType === MessageType.GroupMessage;

  let mediaPath = null;
  let normalizedImagePath = null;
  let outputVideoPath = null;
  let preparedThumbnailPath = null;

  const senderName = message.data?.dName || "Người dùng";
  const senderId = message.data?.uidFrom;

  try {
    const quote = getQuoteData(message);
    if (!quote || (!quote.attach && !quote.href && !quote.hdUrl)) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption:
            `${senderName}, vui lòng reply một tin nhắn chứa video hoặc ảnh!\n` +
            `Cú pháp: ${prefix}${cmdName} [giây_đầu] [giây_cuối] [mute|speed <x>]\n` +
            `Ví dụ: ${prefix}${cmdName} 0 10 hoặc ${prefix}${cmdName} 5 15 speed 1.5`,
        },
        30000,
      );
      return;
    }

    const parsedAttach = parseQuoteAttachment(quote);
    if (!parsedAttach?.mediaUrl) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `${senderName}, không tìm thấy dữ liệu video hoặc ảnh hợp lệ trong tin nhắn được reply.`,
        },
        30000,
      );
      return;
    }

    const rawArgs = extractCleanArgs(message, prefix, cmdName);
    const options = parseEditVideoOptions(rawArgs);
    if (options.error) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption:
            `${senderName}, ${options.error}\n` +
            `Cú pháp: ${prefix}${cmdName} [giây_đầu] [giây_cuối] [mute|speed <x>]`,
        },
        30000,
      );
      return;
    }

    await sendMessageProcessingRequest(
      api,
      message,
      {
        caption: `${senderName}, đang xử lý video (${options.startSec}s -> ${options.endSec}s${options.mute ? ", tắt tiếng" : ""}${options.speed !== 1 ? `, tốc độ ${options.speed}x` : ""}), vui lòng chờ...`,
      },
      60000,
    );

    await fs.mkdir(tempDir, { recursive: true });
    const jobId = randomUUID();
    const initialExt = parsedAttach.urlExt || (parsedAttach.hintImage ? ".jpg" : ".mp4");
    mediaPath = path.join(tempDir, `editvideo_in_${jobId}${initialExt}`);

    await downloadMediaWithRetry(parsedAttach.mediaUrl, mediaPath, 4, 4000);
    const mediaStats = await fs.stat(mediaPath);
    if (mediaStats.size === 0) {
      throw new Error("File đầu vào tải xuống rỗng hoặc không hợp lệ.");
    }

    const detectedType = await fileTypeFromFile(mediaPath).catch(() => null);
    const isImage = detectedType
      ? detectedType.mime.startsWith("image/") && detectedType.mime !== "image/gif"
      : parsedAttach.hintImage;

    outputVideoPath = path.join(tempDir, `editvideo_out_${jobId}.mp4`);

    if (isImage) {
      normalizedImagePath = path.join(tempDir, `editvideo_img_${jobId}.png`);
      await sharp(mediaPath).png().toFile(normalizedImagePath);
      await imageToVideo(normalizedImagePath, outputVideoPath, { duration: options.duration });
    } else {
      await processVideoSegment(mediaPath, outputVideoPath, options);
    }

    const outputStats = await fs.stat(outputVideoPath);
    if (outputStats.size === 0) {
      throw new Error("File video sau khi xử lý bị rỗng.");
    }

    const prepared = await prepareLocalVideoMedia(outputVideoPath);
    preparedThumbnailPath = prepared.thumbnailPath;

    const uploadedVideo = await api.uploadAttachment([outputVideoPath], threadId, msgType);
    const videoUrl = extractUploadedUrl(uploadedVideo, ["fileUrl", "hdUrl", "normalUrl"]);
    if (!videoUrl) {
      throw new Error("Không nhận được URL video sau khi tải lên máy chủ Zalo.");
    }

    const uploadedThumb = await api.uploadAttachment([prepared.thumbnailPath], threadId, msgType);
    const thumbnailUrl = extractUploadedUrl(uploadedThumb, ["fileUrl", "hdUrl", "normalUrl", "thumbUrl"]);
    if (!thumbnailUrl) {
      throw new Error("Không nhận được URL thumbnail sau khi tải lên máy chủ Zalo.");
    }

    const captionText = `[ ${senderName} ]`;
    await api.sendVideo({
      videoUrl,
      threadId,
      threadType: msgType,
      message: {
        text: captionText,
        type: msgType,
        ...(isGroup && senderId
          ? { mentions: [MessageMention(senderId, senderName.length, 2, false)] }
          : {}),
      },
      videoAlreadyUploaded: true,
      thumbnail: thumbnailUrl,
      localThumbnailSource: outputVideoPath,
      duration: prepared.metadata.duration,
      width: prepared.metadata.width,
      height: prepared.metadata.height,
      fileSize: prepared.metadata.fileSize,
      ttl: 3600000,
    });
  } catch (error) {
    console.error("[editvideo] Chi tiết lỗi:", error);
    const msg = String(error?.message || error || "");
    let errorMessage = `${senderName}, lỗi khi xử lý hoặc gửi video: ${msg}. Vui lòng thử lại sau.`;
    if (msg.includes("429")) {
      errorMessage = `${senderName}, máy chủ đang bận, vui lòng thử lại sau ít phút.`;
    } else if (/ffprobe|ffmpeg|VIDEO_TOOL_MISSING/i.test(msg)) {
      errorMessage = `${senderName}, công cụ xử lý video (FFmpeg/FFprobe) chưa sẵn sàng hoặc file media không hợp lệ.`;
    }

    await api.sendMessage(
      {
        msg: errorMessage,
        quote: message,
      },
      threadId,
      msgType,
    );
  } finally {
    const cleanTargets = [mediaPath, normalizedImagePath, outputVideoPath, preparedThumbnailPath].filter(Boolean);
    for (const target of cleanTargets) {
      await deleteFile(target).catch(() => {});
    }
  }
}

export const handleEditVideoCommand = handleCutVideoCommand;

async function downloadMediaWithRetry(url, destination, maxRetries = 4, initialDelay = 4000) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await downloadMedia(url, destination);
      const stats = await fs.stat(destination);
      if (stats.size === 0) {
        throw new Error("File tải xuống rỗng.");
      }
      return;
    } catch (error) {
      if (String(error?.message || "").includes("429") && attempt < maxRetries) {
        const retryAfter = error.response?.headers?.["retry-after"]
          ? Number.parseInt(error.response.headers["retry-after"], 10) * 1000
          : delay;
        await new Promise((resolve) => setTimeout(resolve, retryAfter || delay));
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
}

async function processVideoSegment(inputPath, outputPath, { startSec = 0, duration = 10, mute = false, speed = 1 } = {}) {
  configureFluentFfmpeg();
  const includeAudio = !mute && (await hasAudioStream(inputPath));

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    cmd.setFfmpegPath(ffmpegBin);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cmd.kill("SIGKILL");
      } catch {}
      reject(new Error("Quá thời gian xử lý video (60s)"));
    }, 60000);

    const vfParts = [];
    if (speed !== 1) {
      vfParts.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
    }
    vfParts.push("scale=ceil(iw/2)*2:ceil(ih/2)*2");

    const outOpts = [
      "-map",
      "0:v:0",
      "-vf",
      vfParts.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ];

    if (mute || !includeAudio) {
      outOpts.push("-an");
    } else {
      outOpts.push("-map", "0:a:0?");
      if (speed !== 1) {
        outOpts.push("-af", buildAtempoFilterChain(speed));
      }
      outOpts.push("-c:a", "aac", "-strict", "-2");
    }

    cmd
      .setStartTime(startSec)
      .setDuration(duration)
      .outputOptions(outOpts)
      .toFormat("mp4")
      .on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      })
      .on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Lỗi khi xử lý video: ${err.message}`));
      })
      .save(outputPath);
  });
}

async function imageToVideo(inputPath, outputPath, { duration = 10 } = {}) {
  configureFluentFfmpeg();
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    cmd.setFfmpegPath(ffmpegBin);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cmd.kill("SIGKILL");
      } catch {}
      reject(new Error("Quá thời gian chuyển đổi ảnh thành video (45s)"));
    }, 45000);

    cmd
      .loop(duration)
      .outputOptions([
        "-c:v",
        "libx264",
        "-t",
        String(duration),
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "-movflags",
        "+faststart",
      ])
      .toFormat("mp4")
      .on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      })
      .on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Lỗi khi chuyển đổi ảnh thành video: ${err.message}`));
      })
      .save(outputPath);
  });
}
