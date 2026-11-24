import axios from "axios";
import { LRUCache } from "lru-cache";
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library";
import jsQR from "jsqr";
import sharp from "sharp";
import { imageBufferCache } from "../../utils/image-buffer-cache.js";
import { getGlobalPrefix } from "../service.js";
import { removeMention } from "../../utils/format-util.js";
import { checkExstentionFileRemote, checkLinkIsValid } from "../../utils/util.js";
import { sendMessageCompleteRequest, sendMessageWarningRequest } from "../chat-zalo/chat-style/chat-style.js";

const TIME_SHOW_SCAN_QR = 600000;
const QR_SCAN_CACHE_TTL = 5 * 60 * 1000;
const QR_SCAN_CACHE_MAX = 200;
const MAX_QR_INPUT_BYTES = 15 * 1024 * 1024;
const qrScanResultCache = new LRUCache({ max: QR_SCAN_CACHE_MAX, ttl: QR_SCAN_CACHE_TTL });

async function fetchImageBuffer(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: MAX_QR_INPUT_BYTES,
    maxBodyLength: MAX_QR_INPUT_BYTES,
  });
  return Buffer.from(response.data);
}

function decodeRawRgbaBuffer(rawData, width, height) {
  const clamped = new Uint8ClampedArray(rawData.buffer, rawData.byteOffset, rawData.byteLength);
  const jsqrResult = jsQR(clamped, width, height, {
    inversionAttempts: "attemptBoth",
  });
  if (jsqrResult?.data) {
    return { success: true, data: parseQRContent(jsqrResult.data) };
  }

  try {
    const pixelCount = width * height;
    const luminances = new Uint8ClampedArray(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const offset = i * 4;
      const r = clamped[offset];
      const g = clamped[offset + 1];
      const b = clamped[offset + 2];
      luminances[i] = ((r + g * 2 + b) >> 2) & 0xff;
    }
    const source = new RGBLuminanceSource(luminances, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const reader = new QRCodeReader();
    const zxingResult = reader.decode(bitmap);
    if (zxingResult?.getText()) {
      return { success: true, data: parseQRContent(zxingResult.getText()) };
    }
  } catch {
    // Not found in ZXing pass
  }

  return null;
}

export async function scanQRCode(imageUrl) {
  try {
    if (!imageUrl || typeof imageUrl !== "string") {
      return { success: false, error: "URL ảnh không hợp lệ" };
    }

    const cached = qrScanResultCache.get(imageUrl);
    if (cached) {
      return cached;
    }

    const originalBuffer = await imageBufferCache.getBuffer(imageUrl).catch(() => fetchImageBuffer(imageUrl));
    const metadata = await sharp(originalBuffer).metadata().catch(() => null);
    if (!metadata || !["jpeg", "png", "webp", "gif"].includes(metadata.format)) {
      const unsupported = { success: false, error: "Định dạng ảnh không được hỗ trợ" };
      qrScanResultCache.set(imageUrl, unsupported);
      return unsupported;
    }

    // Pass 1: Direct RGBA decode via Sharp (no Cairo canvas allocation)
    const pass1 = await sharp(originalBuffer)
      .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fastDecoded = decodeRawRgbaBuffer(pass1.data, pass1.info.width, pass1.info.height);
    if (fastDecoded) {
      qrScanResultCache.set(imageUrl, fastDecoded);
      return fastDecoded;
    }

    // Pass 2: High-contrast greyscale sharpen fallback
    const pass2 = await sharp(originalBuffer)
      .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
      .greyscale()
      .linear(1.35, -20)
      .sharpen({ sigma: 1.5 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .catch(() => null);

    if (pass2) {
      const enhancedDecoded = decodeRawRgbaBuffer(pass2.data, pass2.info.width, pass2.info.height);
      if (enhancedDecoded) {
        qrScanResultCache.set(imageUrl, enhancedDecoded);
        return enhancedDecoded;
      }
    }

    const notFound = { success: false, error: "Không tìm thấy mã QR" };
    qrScanResultCache.set(imageUrl, notFound);
    return notFound;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function parseQRContent(content) {
  try {
    if (content.includes("bankid=")) {
      const params = new URLSearchParams(content);
      return {
        type: "bank_transfer",
        bankId: params.get("bankid"),
        accountNumber: params.get("account"),
        accountName: params.get("name"),
      };
    }

    return {
      type: "text",
      content,
    };
  } catch {
    return {
      type: "unknown",
      content,
    };
  }
}

export async function handleScanQRCommand(api, message, aliasCommand) {
  const prefix = getGlobalPrefix();
  const content = removeMention(message);
  let text = content.replace(`${prefix}${aliasCommand}`, "").trim();

  const quote = message.data?.quote;
  if (quote) {
    try {
      const parseMessage = JSON.parse(quote.attach);
      const href = parseMessage?.href;
      if (href) {
        text = href;
      }
    } catch {}
  }

  if (!text) {
    await sendMessageWarningRequest(
      api,
      message,
      { caption: "Vui lòng reply tin nhắn chứa nội dung hoặc link QRCode cần quét!" },
      30000
    );
    return;
  }

  const ext = await checkExstentionFileRemote(text);
  if (ext !== "png" && ext !== "jpg" && ext !== "jpeg" && ext !== "webp") {
    await sendMessageWarningRequest(
      api,
      message,
      { caption: "Link hoặc định dạng file Không phải là QRCode!" },
      30000
    );
    return;
  }

  const result = await scanQRCode(text);
  if (!result.success) {
    await sendMessageCompleteRequest(
      api,
      message,
      { caption: "Không tìm thấy QRCode trong ảnh!" },
      30000
    );
    return;
  }

  if (checkLinkIsValid(result.data.content)) {
    const targetExt = await checkExstentionFileRemote(result.data.content);
    if (targetExt === "png" || targetExt === "jpg" || targetExt === "jpeg") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Ảnh Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendImage(result.data.content, message, "", TIME_SHOW_SCAN_QR);
    } else if (targetExt === "mp4") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Video Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendVideo({
        videoUrl: result.data.content,
        thumbnail: "",
        threadId: message.threadId,
        threadType: message.type,
        message: { text: "" },
        ttl: TIME_SHOW_SCAN_QR,
      });
    } else if (targetExt === "gif") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Gif Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendGif(result.data.content, message, "", TIME_SHOW_SCAN_QR);
    } else if (targetExt === "webp") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Sticker Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendCustomSticker(
        message,
        result.data.content,
        result.data.content,
        null,
        null,
        TIME_SHOW_SCAN_QR
      );
    } else if (targetExt === "aac" || targetExt === "mp3" || targetExt === "m4a") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Voice Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendVoice(
        { threadId: message.threadId, type: message.type },
        result.data.content,
        TIME_SHOW_SCAN_QR
      );
    } else if (["apk", "ipa", "zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(targetExt)) {
      await sendMessageCompleteRequest(api, message, { caption: "Quét File Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendFile(message, result.data.content, TIME_SHOW_SCAN_QR, result.data.content, null, targetExt, null);
    } else {
      await sendMessageCompleteRequest(api, message, { caption: `Quét QRCode Hoàn Tất, Nội Dung:\n${result.data.content}` }, TIME_SHOW_SCAN_QR);
    }
  } else {
    await sendMessageCompleteRequest(api, message, { caption: `Quét QRCode Hoàn Tất, Nội Dung:\n${result.data.content}` }, TIME_SHOW_SCAN_QR);
  }
}
