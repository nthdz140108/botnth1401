import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { sendMessageCompleteRequest, sendMessageFailed } from "../../chat-style/chat-style.js";
import { getCachedMedia, setCacheData } from "../../../../utils/link-platform-cache.js";
import { tempDir } from "../../../../utils/io-json.js";
import { getProjectRoot } from "../../../../utils/env.js";
import { getVideoMetadata } from "../../../../api-zalo/utils.js";
import { convertToWebp } from "./create-webp.js";
import { deleteFile } from "../../../../utils/util.js";
import { getGlobalPrefix } from "../../../service.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../../../commands/shared/command-input-utils.js";

const dataStickerPath = path.join(getProjectRoot(), "assets", "resources", "sticker");
const PLATFORM = "ZaloCustomSticker";
const ALLOWED_STICKER_EXTS = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".mp4"]);
const STATIC_OR_ANIMATED_IMAGE_EXTS = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif"]);

function listAvailableStickers() {
  if (!fs.existsSync(dataStickerPath)) {
    return [];
  }
  const entries = fs.readdirSync(dataStickerPath, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry || entry.name.startsWith(".")) return false;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_STICKER_EXTS.has(ext)) return false;
      if (entry.isFile()) return true;
      if (entry.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(dataStickerPath, entry.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi"));
}

function selectStickerFile(files, keyword) {
  const trimmed = String(keyword || "").trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    if (index >= 0 && index < files.length) {
      return files[index];
    }
  }

  const lower = trimmed.toLowerCase();
  return (
    files.find((file) => file.toLowerCase() === lower) ||
    files.find((file) => path.parse(file).name.toLowerCase() === lower) ||
    null
  );
}

async function readStickerDimensions(webpPath, originalPath, ext) {
  try {
    const meta = await sharp(webpPath, { animated: true }).metadata();
    if (meta?.width && meta?.height) {
      const pageHeight = meta.pageHeight || meta.height;
      return { width: meta.width, height: pageHeight, duration: 0 };
    }
  } catch {
    // Fallback below if sharp metadata fails on exotic container
  }

  if (!STATIC_OR_ANIMATED_IMAGE_EXTS.has(ext)) {
    try {
      const videoMeta = await getVideoMetadata(originalPath);
      if (videoMeta?.width && videoMeta?.height) {
        return {
          width: videoMeta.width,
          height: videoMeta.height,
          duration: videoMeta.duration || 0,
        };
      }
    } catch {}
  }

  return { width: 512, height: 512, duration: 0 };
}

async function convertStickerAssetToWebp(stickerPath, outputWebpPath, ext) {
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
    await sharp(stickerPath)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84, effort: 4 })
      .toFile(outputWebpPath);
    return;
  }

  if (ext === ".gif") {
    try {
      await sharp(stickerPath, { animated: true })
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78, loop: 0 })
        .toFile(outputWebpPath);
      return;
    } catch {
      await convertToWebp(stickerPath, outputWebpPath);
      return;
    }
  }

  const ok = await convertToWebp(stickerPath, outputWebpPath);
  if (!ok || !fs.existsSync(outputWebpPath)) {
    throw new Error("Không thể chuyển đổi media sang định dạng sticker WebP.");
  }
}

export async function handleSendCustomerStickerVideo(api, message, aliasCommand = "stickercustom") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "stickercustom";
  const keyword = extractCommandBody(message, prefix, cmdName);
  const files = listAvailableStickers();

  if (!keyword) {
    if (files.length === 0) {
      await sendMessageCompleteRequest(
        api,
        message,
        {
          caption:
            `📦 Kho sticker tùy chỉnh hiện đang trống.\n` +
            `👉 Thêm sticker mới bằng lệnh: ${prefix}dlrsrc sticker|<tên_sticker> (reply ảnh/sticker/video hoặc kèm link).`,
        },
        120000,
      );
      return;
    }

    const fileList = files
      .map((file, index) => `${index + 1}. ${path.parse(file).name} (${path.extname(file).slice(1).toLowerCase()})`)
      .join("\n");
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption:
          `🎨 Danh sách sticker đã lưu trữ (${files.length}):\n${fileList}\n\n` +
          `👉 Dùng lệnh: ${prefix}${cmdName} <STT hoặc tên sticker> để gửi sticker.`,
      },
      1800000,
    );
    return;
  }

  await sendCustomerStickerVideo(api, message, files, keyword, prefix, cmdName);
}

async function sendCustomerStickerVideo(api, message, files, keyword, prefix, cmdName) {
  if (files.length === 0) {
    await sendMessageFailed(
      api,
      message,
      `Kho sticker tùy chỉnh đang trống! Hãy thêm sticker bằng ${prefix}dlrsrc sticker|<tên_sticker>.`,
      false,
    );
    return;
  }

  const stickerFile = selectStickerFile(files, keyword);
  if (!stickerFile) {
    await sendMessageFailed(
      api,
      message,
      `Không tìm thấy sticker "${keyword}"! Gõ ${prefix}${cmdName} để xem danh sách và số thứ tự.`,
      false,
    );
    return;
  }

  const parsed = path.parse(stickerFile);
  const fileExt = parsed.ext.toLowerCase();
  const stickerPath = path.join(dataStickerPath, stickerFile);
  const nameLocalSticker = parsed.name;
  const threadType = safeThreadType(message);
  let pathWebp = null;

  try {
    const cachedSticker = await getCachedMedia(PLATFORM, stickerFile, fileExt, nameLocalSticker);
    let webpUrl;
    let width;
    let height;

    if (cachedSticker?.fileUrl) {
      webpUrl = cachedSticker.fileUrl;
      width = cachedSticker.width || 512;
      height = cachedSticker.height || 512;
    } else {
      let uploadFile = stickerPath;
      if (fileExt !== ".webp") {
        fs.mkdirSync(tempDir, { recursive: true });
        pathWebp = path.join(tempDir, `sticker_${randomUUID()}.webp`);
        await convertStickerAssetToWebp(stickerPath, pathWebp, fileExt);
        uploadFile = pathWebp;
      }

      const linkUploadZalo = await api.uploadAttachment([uploadFile], message.threadId, threadType);
      webpUrl =
        linkUploadZalo?.[0]?.fileUrl ||
        linkUploadZalo?.[0]?.hdUrl ||
        linkUploadZalo?.[0]?.normalUrl ||
        "";
      if (!webpUrl) {
        throw new Error("Tải sticker lên máy chủ Zalo thất bại.");
      }

      const dimensions = await readStickerDimensions(uploadFile, stickerPath, fileExt);
      width = dimensions.width;
      height = dimensions.height;

      setCacheData(
        PLATFORM,
        stickerFile,
        {
          fileUrl: webpUrl,
          title: nameLocalSticker,
          width,
          height,
          duration: dimensions.duration,
        },
        fileExt,
      );
    }

    await api.sendCustomSticker(message, webpUrl, webpUrl, width, height);
  } catch (error) {
    console.error("[stickercustom] Lỗi khi gửi sticker:", error);
    await sendMessageFailed(
      api,
      message,
      `Không thể gửi sticker "${nameLocalSticker}": ${error?.message || "Lỗi xử lý media"}`,
      false,
    );
  } finally {
    if (pathWebp) await deleteFile(pathWebp).catch(() => {});
  }
}
