import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { getGlobalPrefix } from "../../../service.js";
import { MessageType } from "../../../../api-zalo/index.js";
import { tempDir } from "../../../../utils/io-json.js";
import { removeMention } from "../../../../utils/format-util.js";
import { getVideoMetadata } from "../../../../api-zalo/utils.js";
import { removeBackground } from "../../../utilities/remove-background.js";
import { appContext } from "../../../../api-zalo/context.js";
import { sendMessageComplete, sendMessageProcessingRequest, sendMessageWarning, sendMessageFailed } from "../../chat-style/chat-style.js";
import { buildWebpFfmpegOptions } from "./sticker-ffmpeg.js";
import { deleteFile } from "../../../../utils/util.js";
import { getMessageCacheByMsgId } from "../../../../utils/message-cache.js";
import { getFfmpegExecutableSync } from "../../../../utils/runtime-dependencies.js";
import {
  collectMediaCandidates,
  downloadFirstValidCandidate,
  normalizeMediaUrl,
} from "./sticker-media.js";
import { fileTypeFromFile } from "file-type";

function ensureTempDir() {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
}

function isValidFileSync(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function extractDirectMediaUrl(content) {
  if (!content) return null;
  const match = String(content).match(/https?:\/\/\S+/i);
  return match ? normalizeMediaUrl(match[0]) : null;
}

function getQuotedMessageId(quote) {
  return quote?.msgId || quote?.globalMsgId || quote?.cliMsgId || null;
}

function parseRecentMessages(recentMessageRaw) {
  if (!recentMessageRaw) return [];

  if (Array.isArray(recentMessageRaw)) return recentMessageRaw;

  if (typeof recentMessageRaw === "string") {
    try {
      const parsed = JSON.parse(recentMessageRaw);
      return Array.isArray(parsed?.groupMsgs) ? parsed.groupMsgs : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(recentMessageRaw?.groupMsgs) ? recentMessageRaw.groupMsgs : [];
}

async function loadQuotedContext(api, message) {
  const quote = message?.data?.quote;
  const quotedMsgId = getQuotedMessageId(quote);
  const cachedMessage = quotedMsgId ? getMessageCacheByMsgId(String(quotedMsgId)) : null;
  const shouldQueryGroupHistory =
    message?.type === MessageType.GroupMessage &&
    quotedMsgId &&
    typeof api?.getRecentMessages === "function";

  if (!shouldQueryGroupHistory) {
    return { cachedMessage, recentMessages: [] };
  }

  const threadId = message.threadId || message.idTo;
  if (!threadId) {
    return { cachedMessage, recentMessages: [] };
  }

  try {
    const recentMessageRaw = await api.getRecentMessages(threadId, quotedMsgId, 50);
    return { cachedMessage, recentMessages: parseRecentMessages(recentMessageRaw) };
  } catch (error) {
    console.error("Lỗi khi lấy lịch sử tin nhắn cho quote:", error.message);
    return { cachedMessage, recentMessages: [] };
  }
}

async function resolveMediaUrlFromQuote(api, message) {
  const { cachedMessage, recentMessages } = await loadQuotedContext(api, message);
  const candidates = collectMediaCandidates(message, cachedMessage, recentMessages);
  return candidates[0]?.url || null;
}

async function detectMediaKind(filePath) {
  try {
    const metadata = await getVideoMetadata(filePath);
    if (metadata?.width && metadata?.height) {
      return { isValid: true, isVideo: true };
    }
  } catch {
    // Not a readable video.
  }

  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata?.width && metadata?.height) {
      return { isValid: true, isVideo: false };
    }
  } catch {
    // Not a readable image either.
  }

  return { isValid: false, isVideo: false };
}

function getDetectedFileInfo(inputPath, detectedType) {
  const ext = `.${detectedType?.ext?.toLowerCase() || path.extname(inputPath).replace(/^\./, "").toLowerCase()}`;
  const mime = detectedType?.mime?.toLowerCase() || "";
  return { ext, mime };
}

async function convertMediaToWebp(inputPath, outputPath, dependencies = {}) {
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath);
  const sharpImpl = dependencies.sharpImpl || sharp;
  const ffmpegImpl = dependencies.ffmpegImpl || ffmpeg;
  const fileTypeFromFileImpl = dependencies.fileTypeFromFileImpl || fileTypeFromFile;

  if (!isValidFileSync(resolvedInputPath)) {
    throw new Error(`File đầu vào không tồn tại hoặc rỗng: ${resolvedInputPath}`);
  }

  await fs.promises.mkdir(path.dirname(resolvedOutputPath), { recursive: true });

  if (resolvedInputPath === resolvedOutputPath) {
    return true;
  }

  const detectedType = await fileTypeFromFileImpl(resolvedInputPath).catch(() => null);
  const { ext: detectedExt, mime: detectedMime } = getDetectedFileInfo(resolvedInputPath, detectedType);
  const isAnimated = [".mp4", ".mov", ".webm", ".gif"].includes(detectedExt) || detectedMime.startsWith("video/");
  const sharpSupportedExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"]);
  const sharpSupportedMime = detectedMime.startsWith("image/") && detectedMime !== "image/jxl";
  const canUseSharp = !isAnimated && (sharpSupportedExts.has(detectedExt) || sharpSupportedMime);

  const convertWithSharp = async () => {
    await sharpImpl(resolvedInputPath)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, effort: 6 })
      .toFile(resolvedOutputPath);
  };

  const convertWithFfmpeg = () => {
    const options = buildWebpFfmpegOptions(detectedExt);
    return new Promise((resolve, reject) => {
      const cmd = ffmpegImpl(resolvedInputPath);
      const ffmpegBin = dependencies.ffmpegBin || getFfmpegExecutableSync();
      if (ffmpegBin && typeof cmd.setFfmpegPath === "function") {
        cmd.setFfmpegPath(ffmpegBin);
      }
      cmd
        .outputOptions(options)
        .toFormat("webp")
        .on("start", (commandLine) => {
          console.log(`FFmpeg command: ${commandLine}`);
        })
        .on("end", () => resolve(true))
        .on("error", (error) => {
          const stderrTail = String(error?.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n");
          console.error("Lỗi khi chuyển đổi sang WebP:", {
            inputPath: resolvedInputPath,
            outputPath: resolvedOutputPath,
            detectedExt,
            detectedMime,
            message: error.message,
            stderrTail,
          });
          const msg = String(error?.message || "");
          if (msg.includes("3221225785") || msg.includes("0xC0000139")) {
            error.code = "FFMPEG_INCOMPATIBLE";
            reject(new Error("Lỗi khi chuyển đổi sang WebP: Phiên bản FFmpeg không tương thích với hệ điều hành (mã 0xC0000139)"));
            return;
          }
          reject(new Error(`Lỗi khi chuyển đổi sang WebP: ${error.message}`));
        })
        .save(resolvedOutputPath);
    });
  };

  if (canUseSharp) {
    try {
      await convertWithSharp();
      return true;
    } catch (error) {
      console.error("Sharp thất bại, chuyển sang FFmpeg:", {
        inputPath: resolvedInputPath,
        outputPath: resolvedOutputPath,
        detectedExt,
        detectedMime,
        message: error.message,
      });
    }
  }

  try {
    await convertWithFfmpeg();
    return true;
  } catch (ffmpegError) {
    if (canUseSharp) {
      throw new Error(`Lỗi khi chuyển đổi ảnh sang WebP: ${ffmpegError.message}`);
    }
    throw ffmpegError;
  }
}

async function processAndSendSticker(api, message, mediaPath) {
  const outputWebp = path.resolve(tempDir, `sticker_${randomUUID()}.webp`);

  try {
    await convertMediaToWebp(mediaPath, outputWebp);

    if (!isValidFileSync(outputWebp)) {
      throw new Error("File WebP đầu ra rỗng");
    }

    const stickerData = await getVideoMetadata(outputWebp);
    const uploadResult = await api.uploadAttachment([outputWebp], appContext.send2meId, MessageType.DirectMessage);
    const finalUrl = uploadResult?.[0]?.fileUrl || uploadResult?.[0]?.normalUrl;

    if (!finalUrl) {
      throw new Error("Không tải được sticker lên máy chủ");
    }

    await sendMessageComplete(api, message, "Sticker của bạn đây!", true);
    await api.sendCustomSticker(message, finalUrl, finalUrl, stickerData.width, stickerData.height, 3600000);
    return true;
  } finally {
    await deleteFile(outputWebp);
  }
}

async function buildStickerCandidates(api, message) {
  const content = removeMention(message);
  const directMediaUrl = extractDirectMediaUrl(content);
  const { cachedMessage, recentMessages } = await loadQuotedContext(api, message);
  const quoteCandidates = collectMediaCandidates(message, cachedMessage, recentMessages);
  const directCandidates = directMediaUrl
    ? [{ url: directMediaUrl, source: "message.content", quality: 1000 }]
    : [];
  return [...directCandidates, ...quoteCandidates];
}

async function createDownloadedMedia(api, message) {
  const candidates = await buildStickerCandidates(api, message);
  if (!candidates.length) {
    return null;
  }

  return downloadFirstValidCandidate(candidates, { tempDir });
}

export { handleStickerCommand } from "./sticker/index.js";

export {
  buildWebpFfmpegOptions,
  collectMediaCandidates,
  convertMediaToWebp,
  detectMediaKind,
  downloadFirstValidCandidate,
  normalizeMediaUrl,
  resolveMediaUrlFromQuote,
};
