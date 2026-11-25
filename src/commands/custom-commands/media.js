import fs from "node:fs";
import { fileTypeFromBuffer } from "file-type";
import {
  resolveMediaUrlFromQuote,
  downloadFirstValidCandidate,
} from "../../service-debug/chat-zalo/chat-special/send-sticker/sticker-media.js";
import { tempDir } from "../../utils/io-json.js";
import { MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, MAX_VIDEO_BYTES } from "./store.js";
import {
  MEDIA_KIND_TEXT,
  MEDIA_KIND_IMAGE,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
} from "./media-constants.js";

export {
  MEDIA_KIND_TEXT,
  MEDIA_KIND_IMAGE,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
};

export function classifyMime(mime) {
  const normalized = String(mime || "").toLowerCase().split(";")[0].trim();
  if (normalized.startsWith("image/")) return MEDIA_KIND_IMAGE;
  if (normalized.startsWith("audio/")) return MEDIA_KIND_AUDIO;
  if (normalized.startsWith("video/")) return MEDIA_KIND_VIDEO;
  return null;
}

export function maxBytesForKind(kind) {
  if (kind === MEDIA_KIND_IMAGE) return MAX_IMAGE_BYTES;
  if (kind === MEDIA_KIND_AUDIO) return MAX_AUDIO_BYTES;
  if (kind === MEDIA_KIND_VIDEO) return MAX_VIDEO_BYTES;
  return 0;
}

export function mediaKindOf(customCommand) {
  const media = customCommand?.media;
  if (!media?.type && !media?.kind) return MEDIA_KIND_TEXT;
  return media.kind || classifyMime(media.type) || MEDIA_KIND_TEXT;
}

export function validateDownloadedMedia(buffer, contentType, detectedType) {
  const mime = String(detectedType?.mime || contentType || "").toLowerCase();
  const kind = classifyMime(mime);
  if (!kind) {
    const error = new Error("File không phải ảnh/audio/video hợp lệ.");
    error.code = "INVALID_MEDIA_KIND";
    throw error;
  }
  if (!buffer.length || buffer.length === 0) {
    const error = new Error("File media rỗng.");
    error.code = "EMPTY_MEDIA";
    throw error;
  }
  const maxBytes = maxBytesForKind(kind);
  if (buffer.length > maxBytes) {
    const error = new Error(`Media vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)}MB.`);
    error.code = "MEDIA_TOO_LARGE";
    error.maxBytes = maxBytes;
    throw error;
  }
  return { kind, mime, size: buffer.length };
}

export async function resolveMediaFromMessage(api, message, dependencies = {}) {
  if (!message?.data?.quote) return null;
  const quote = message?.data?.quote;

  const cachedMessage = dependencies.cachedMessage || null;
  const recentMessages = Array.isArray(dependencies.recentMessages)
    ? dependencies.recentMessages
    : [];
  const url = await resolveMediaUrlFromQuote(api, message, {
    cachedMessage,
    recentMessages,
  });
  if (!url) return null;

  const tempBase = dependencies.tempDir || tempDir;
  const { filePath, mediaType } = await downloadFirstValidCandidate(
    [{ url }],
    { tempDir: tempBase },
  );
  try {
    const stat = await fs.promises.stat(filePath);
    const buffer = await fs.promises.readFile(filePath);
    const detected = await fileTypeFromBuffer(buffer).catch(() => null);
    const { kind } = validateDownloadedMedia(buffer, mediaType, detected);
    return { filePath, mediaType: detected?.mime || mediaType, kind, size: stat.size, url };
  } catch (error) {
    await cleanupTempFile(filePath);
    throw error;
  }
}

export function mediaKindToMime(kind) {
  const byKind = {
    [MEDIA_KIND_IMAGE]: "image/jpeg",
    [MEDIA_KIND_AUDIO]: "audio/mpeg",
    [MEDIA_KIND_VIDEO]: "video/mp4",
  };
  return byKind[kind] || "application/octet-stream";
}

export async function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
}
