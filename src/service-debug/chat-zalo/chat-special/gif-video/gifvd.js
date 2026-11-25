import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { fileTypeFromFile } from "file-type";
import { MessageMention } from "../../../../api-zalo/models/index.js";
import { MessageType } from "../../../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../../../service.js";
import {
  sendMessageWarningRequest,
  sendMessageProcessingRequest,
} from "../../chat-style/chat-style.js";
import { tempDir } from "../../../../utils/io-json.js";
import { deleteFile } from "../../../../utils/util.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
} from "../../../../utils/runtime-dependencies.js";
import {
  getQuoteData,
  safeThreadType,
} from "../../../../commands/shared/command-input-utils.js";
import { downloadMedia } from "./downloadMedia.js";

configureFluentFfmpeg();

const NON_VIDEO_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".jxl",
  ".heic",
  ".bmp",
  ".svg",
  ".gif",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".pdf",
  ".zip",
  ".rar",
  ".7z",
  ".txt",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
]);

function inspectQuotedVideoCandidate(quote) {
  if (!quote || typeof quote !== "object") return { ok: false, reason: "missing" };

  let attachData = null;
  if (quote.attach) {
    if (typeof quote.attach === "object") {
      attachData = quote.attach;
    } else if (typeof quote.attach === "string") {
      try {
        attachData = JSON.parse(quote.attach);
      } catch {
        return { ok: false, reason: "invalid-json" };
      }
    }
  }

  const rawUrl =
    attachData?.hdUrl ||
    attachData?.oriUrl ||
    attachData?.href ||
    attachData?.normalUrl ||
    attachData?.fileUrl ||
    quote.hdUrl ||
    quote.href ||
    "";

  const cleanedUrl = typeof rawUrl === "string" ? rawUrl.replace(/\\\//g, "/").trim() : "";
  if (!cleanedUrl) {
    return { ok: false, reason: "no-url" };
  }

  const mime = String(attachData?.mimeType || attachData?.mime || "").toLowerCase();
  if (
    mime &&
    (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("text/"))
  ) {
    return { ok: false, reason: "not-video" };
  }

  let ext = "";
  try {
    ext = path.extname(new URL(cleanedUrl).pathname).toLowerCase();
  } catch {
    ext = path.extname(cleanedUrl.split("?")[0]).toLowerCase();
  }

  if (ext && NON_VIDEO_EXTENSIONS.has(ext)) {
    return { ok: false, reason: "not-video" };
  }

  // cliMsgType === 3 trên Zalo thường là ảnh tĩnh (trừ khi có trường duration của video)
  if (Number(quote.cliMsgType) === 3 && !attachData?.duration && !/\.mp4|\.mov|\.webm/i.test(ext)) {
    return { ok: false, reason: "not-video" };
  }

  let decodedUrl = cleanedUrl;
  try {
    decodedUrl = new URL(cleanedUrl).toString();
  } catch {
    try {
      decodedUrl = decodeURIComponent(cleanedUrl);
    } catch {}
  }

  return { ok: true, videoUrl: decodedUrl };
}

export async function handleVideoToGifCommand(api, message, aliasCommand = "gifvd") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "gifvd";
  const msgType = safeThreadType(message, MessageType.DirectMessage);
  const isGroup = msgType === MessageType.GroupMessage;

  let videoPath = null;
  let outputGifPath = null;
  const senderName = message.data?.dName || "Người dùng";
  const senderId = message.data?.uidFrom;

  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const quote = getQuoteData(message);
    const candidate = inspectQuotedVideoCandidate(quote);

    if (!candidate.ok) {
      let warningText = `${senderName}, vui lòng reply một tin nhắn chứa video! Ví dụ: ${prefix}${cmdName} (reply vào video).`;
      if (candidate.reason === "not-video") {
        warningText = `${senderName}, tin nhắn được reply không phải là video! Vui lòng reply đúng một video rồi gõ ${prefix}${cmdName}.`;
      } else if (candidate.reason === "invalid-json") {
        warningText = `${senderName}, dữ liệu đính kèm không hợp lệ. Vui lòng thử lại với video khác.`;
      }
      await sendMessageWarningRequest(api, message, { caption: warningText }, 30000);
      return;
    }

    await sendMessageProcessingRequest(
      api,
      message,
      {
        caption: `${senderName}, đang chuyển video thành GIF độ nét 320p, vui lòng chờ...`,
      },
      60000,
    );

    const jobId = randomUUID();
    videoPath = path.join(tempDir, `temp_video_${jobId}.mp4`);
    await downloadMediaWithRetry(candidate.videoUrl, videoPath, 3, 3000);

    const detected = await fileTypeFromFile(videoPath).catch(() => null);
    if (detected && !detected.mime.startsWith("video/")) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `${senderName}, tệp đính kèm (${detected.mime}) không phải là video hợp lệ! Vui lòng reply đúng video.`,
        },
        30000,
      );
      return;
    }

    outputGifPath = path.join(tempDir, `output_gif_${jobId}.gif`);
    await convertVideoToGif(videoPath, outputGifPath, 15);

    if (!fs.existsSync(outputGifPath)) {
      throw new Error(`File GIF không tồn tại tại: ${outputGifPath}`);
    }
    const fileStats = fs.statSync(outputGifPath);
    const maxSize = 10 * 1024 * 1024;
    if (fileStats.size > maxSize) {
      throw new Error(`File GIF quá lớn (${(fileStats.size / 1024 / 1024).toFixed(2)}MB). Giới hạn là 10MB.`);
    }
    if (fileStats.size === 0) {
      throw new Error("File GIF rỗng hoặc không hợp lệ.");
    }

    await sendMessageWithRetry(
      api,
      {
        msg: `${senderName}, đây là GIF từ video của bạn!`,
        attachments: [outputGifPath],
        ...(isGroup && senderId
          ? { mentions: [MessageMention(senderId, senderName.length, 0)] }
          : {}),
        ttl: 3600000,
      },
      threadId,
      msgType,
      3,
      5000,
    );
  } catch (error) {
    console.error("[gifvd] Lỗi khi chuyển video thành GIF:", error?.message || error);
    const msg = String(error?.message || "");
    let errorMessage = `${senderName}, lỗi khi chuyển video thành GIF. Vui lòng thử lại sau.`;
    if (msg.includes("429")) {
      errorMessage = `${senderName}, máy chủ đang bận, vui lòng thử lại sau vài phút.`;
    } else if (msg.includes("Invalid data found") || msg.includes("Stream")) {
      errorMessage = `${senderName}, video không hợp lệ hoặc bị hỏng. Vui lòng thử video khác.`;
    } else if (/ffprobe|ffmpeg/i.test(msg)) {
      errorMessage = `${senderName}, lỗi xử lý video (FFmpeg). Vui lòng thử lại hoặc chạy setup:media.`;
    } else if (msg.includes("File GIF quá lớn")) {
      errorMessage = `${senderName}, ${msg}`;
    } else if (error?.code === 115) {
      errorMessage = `${senderName}, không thể tải file GIF lên Zalo. Vui lòng thử lại sau.`;
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
    if (videoPath) {
      await deleteFile(videoPath).catch(() => {});
    }
    if (outputGifPath) {
      await deleteFile(outputGifPath).catch(() => {});
    }
  }
}

async function downloadMediaWithRetry(url, destination, maxRetries = 5, initialDelay = 10000) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await downloadMedia(url, destination);
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

async function convertVideoToGif(inputPath, outputPath, fps = 15) {
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
      reject(new Error("Quá thời gian chuyển đổi video thành GIF (30s)"));
    }, 30000);

    cmd
      .setDuration(10)
      .outputOptions([
        "-vf",
        `fps=${fps},scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`,
        "-c:v",
        "gif",
        "-loop",
        "0",
      ])
      .toFormat("gif")
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
        reject(new Error(`Lỗi khi chuyển video thành GIF: ${err.message}`));
      })
      .save(outputPath);
  });
}

async function sendMessageWithRetry(api, messagePayload, threadId, msgType, maxRetries = 3, initialDelay = 5000) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await api.sendMessage(messagePayload, threadId, msgType);
      return;
    } catch (error) {
      if (error?.code === 115 && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
}
