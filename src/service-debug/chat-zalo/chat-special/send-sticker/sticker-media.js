import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { fileTypeFromFile } from "file-type";
import { getVideoMetadata } from "../../../../api-zalo/utils.js";
import { MessageType } from "../../../../api-zalo/models/Message.js";
import { configureFluentFfmpeg, getFfmpegExecutableSync } from "../../../../utils/runtime-dependencies.js";
import { buildWebpFfmpegOptions } from "./sticker-ffmpeg.js";

configureFluentFfmpeg();

const PRIMARY_URL_KEYS = ["hdUrl", "oriUrl", "href", "normalUrl", "rawUrl"];
const FALLBACK_URL_KEYS = ["attachUrl", "previewUrl", "thumbUrl", "url"];

function normalizeMediaUrl(mediaUrl) {
  if (!mediaUrl) return null;

  let value = String(mediaUrl)
    .replace(/\\\//g, "/")
    .trim();

  if (!value) return null;

  if (/^https?%3A%2F%2F/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the original string if it is not URI-encoded.
    }
  }

  // Zalo mobile often exposes sticker/image assets as JXL/HEIC/HEIF URLs even when
  // a JPG variant is available on the same CDN path.
  if (value.includes("/jxl/") || value.includes("/heic/") || value.includes("/heif/") || /\.(jxl|heic|heif)(?=([?#]|$))/i.test(value)) {
    value = value
      .replace(/\/(jxl|heic|heif)\//g, "/jpg/")
      .replace(/\.(jxl|heic|heif)(?=([?#]|$))/gi, ".jpg");
  }

  return value;
}

function isHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^https?:\/\//i.test(url.trim());
}

function pushCandidate(candidates, seen, url, source, quality) {
  const normalized = normalizeMediaUrl(url);
  if (!isHttpUrl(normalized) || seen.has(normalized)) return;

  seen.add(normalized);
  candidates.push({ url: normalized, source, quality });
}

function collectUrlsFromObject(candidates, seen, value, sourcePrefix, baseQuality) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectUrlsFromObject(candidates, seen, item, `${sourcePrefix}[${index}]`, baseQuality);
    }
    return;
  }

  for (const key of PRIMARY_URL_KEYS) {
    if (value[key]) {
      pushCandidate(candidates, seen, value[key], `${sourcePrefix}.${key}`, baseQuality + (PRIMARY_URL_KEYS.length - PRIMARY_URL_KEYS.indexOf(key)));
    }
  }

  for (const key of FALLBACK_URL_KEYS) {
    if (value[key]) {
      pushCandidate(candidates, seen, value[key], `${sourcePrefix}.${key}`, baseQuality - (FALLBACK_URL_KEYS.indexOf(key) + 1));
    }
  }

  if (typeof value.attach === "string") {
    const parsed = parseMaybeJson(value.attach);
    if (parsed && parsed !== value.attach) {
      collectUrlsFromObject(candidates, seen, parsed, `${sourcePrefix}.attach`, baseQuality);
    }
  } else if (value.attach && typeof value.attach === "object") {
    collectUrlsFromObject(candidates, seen, value.attach, `${sourcePrefix}.attach`, baseQuality);
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;

  const text = value.trim();
  if (!text) return null;

  if (!(text.startsWith("{") || text.startsWith("["))) return value;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectContentUrl(candidates, seen, value, source, quality) {
  if (!value) return;

  if (typeof value === "string") {
    const directMatch = value.match(/https?:\/\/\S+/i);
    if (directMatch) {
      pushCandidate(candidates, seen, directMatch[0], source, quality);
    }
    return;
  }

  if (typeof value === "object") {
    collectUrlsFromObject(candidates, seen, value, source, quality);
  }
}

function collectMediaCandidates(message, cachedMessage, recentMessages = []) {
  const candidates = [];
  const seen = new Set();

  const quote = message?.data?.quote;
  if (quote) {
    collectContentUrl(candidates, seen, quote, "quote", 100);
    const parsedAttach = parseMaybeJson(quote.attach);
    if (parsedAttach && parsedAttach !== quote.attach) {
      collectContentUrl(candidates, seen, parsedAttach, "quote.attach", 90);
    }
  }

  collectContentUrl(candidates, seen, cachedMessage, "cache", 80);

  const quotedMsgId = quote?.msgId || quote?.globalMsgId || quote?.cliMsgId || null;
  const matchedRecent =
    quotedMsgId && Array.isArray(recentMessages)
      ? recentMessages.filter((item) => {
          const id = item?.msgId || item?.globalMsgId || item?.cliMsgId || item?.data?.msgId || item?.data?.cliMsgId;
          return id && String(id) === String(quotedMsgId);
        })
      : [];
  const messagesToScan = matchedRecent.length > 0 ? matchedRecent : (quotedMsgId ? [] : recentMessages);

  for (const [index, recentMessage] of messagesToScan.entries()) {
    collectContentUrl(candidates, seen, recentMessage, `recentMessages[${index}]`, 70 - index);
  }

  return candidates.sort((a, b) => b.quality - a.quality);
}

function isValidFileSync(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
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
    configureFluentFfmpeg();
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

async function resolveMediaUrlFromQuote(api, message, dependencies = {}) {
  const quote = message?.data?.quote;
  if (!quote) return null;

  const quotedMsgId = quote?.msgId || quote?.globalMsgId || quote?.cliMsgId || null;
  const cachedMessage = dependencies.cachedMessage || null;
  const recentMessages = Array.isArray(dependencies.recentMessages)
    ? dependencies.recentMessages
    : [];

  let fallbackRecentMessages = recentMessages;
  if (
    fallbackRecentMessages.length === 0 &&
    message?.type === MessageType.GroupMessage &&
    quotedMsgId &&
    typeof api?.getRecentMessages === "function"
  ) {
    const threadId = message.threadId || message.idTo;
    if (threadId) {
      try {
        const recentMessageRaw = await api.getRecentMessages(threadId, quotedMsgId, 50);
        fallbackRecentMessages = parseRecentMessages(recentMessageRaw);
      } catch {
        fallbackRecentMessages = [];
      }
    }
  }

  const candidates = collectMediaCandidates(message, cachedMessage, fallbackRecentMessages);
  return candidates[0]?.url || null;
}

function resolveFileExtension(url, fileType, fallbackExt = "bin") {
  const fromDetected = fileType?.ext ? `.${fileType.ext.toLowerCase()}` : "";
  if (fromDetected) return fromDetected.replace(/^\./, "");

  try {
    const pathnameExt = path.extname(new URL(url).pathname).replace(/^\./, "").toLowerCase();
    if (pathnameExt) return pathnameExt;
  } catch {
    // Ignore invalid URLs and fall back below.
  }

  return String(fallbackExt || "bin").replace(/^\./, "").toLowerCase() || "bin";
}

function sanitizeCandidateForLog(candidate) {
  if (!candidate?.url) return "<missing>";

  try {
    const url = new URL(candidate.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return candidate.url.split("?")[0];
  }
}

async function downloadFirstValidCandidate(candidates, dependencies = {}) {
  const {
    fetchImpl = globalThis.fetch,
    tempDir,
    now = () => Date.now(),
    createId = () => randomUUID(),
    fileTypeFromBuffer: detectFileTypeFromBuffer = fileTypeFromBuffer,
    writeFile = fs.promises.writeFile,
    mkdir = fs.promises.mkdir,
    access = fs.promises.access,
  } = dependencies;

  if (!tempDir) {
    throw new Error("Thiếu thư mục tạm để tải media");
  }

  const resolvedTempDir = path.resolve(tempDir);
  await mkdir(resolvedTempDir, { recursive: true });

  try {
    await access(resolvedTempDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Không có quyền ghi vào thư mục tạm: ${resolvedTempDir}`);
  }

  let lastError = null;
  const seen = new Set();

  for (const candidate of candidates || []) {
    const normalizedUrl = normalizeMediaUrl(candidate?.url);
    if (!isHttpUrl(normalizedUrl) || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    try {
      const response = await fetchImpl(normalizedUrl);
      if (!response?.ok) {
        lastError = new Error(`HTTP ${response?.status || "unknown"}`);
        continue;
      }

      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      if (contentType.startsWith("text/html")) {
        lastError = new Error("Response HTML");
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        lastError = new Error("File rỗng");
        continue;
      }

      const fileType = await detectFileTypeFromBuffer(buffer).catch(() => null);
      const detectedMime = String(fileType?.mime || contentType).toLowerCase();
      if (detectedMime.startsWith("text/html") || detectedMime.startsWith("text/plain")) {
        lastError = new Error(`Không phải media hợp lệ: ${detectedMime || contentType || "unknown"}`);
        continue;
      }

      const ext = resolveFileExtension(normalizedUrl, fileType);
      const filePath = path.resolve(resolvedTempDir, `sticker_source_${now()}_${createId()}.${ext}`);
      await writeFile(filePath, buffer);

      const stat = await fs.promises.stat(filePath);
      if (!stat.size) {
        await fs.promises.unlink(filePath).catch(() => {});
        lastError = new Error("File tải xuống rỗng");
        continue;
      }

      return {
        filePath,
        mediaType: detectedMime || contentType || "application/octet-stream",
        source: candidate?.source || "unknown",
        url: normalizedUrl,
      };
    } catch (error) {
      lastError = error;
      console.error(`Bỏ qua candidate media ${sanitizeCandidateForLog(candidate)}: ${error.message}`);
    }
  }

  throw lastError || new Error("Không tải được media từ bất kỳ URL nào");
}

export {
  collectMediaCandidates,
  convertMediaToWebp,
  downloadFirstValidCandidate,
  detectMediaKind,
  normalizeMediaUrl,
  resolveMediaUrlFromQuote,
  sanitizeCandidateForLog,
};
