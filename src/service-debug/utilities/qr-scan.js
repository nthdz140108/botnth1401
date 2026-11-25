import axios from "axios";
import { LRUCache } from "lru-cache";
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library";
import jsQR from "jsqr";
import sharp from "sharp";
import { imageBufferCache } from "../../utils/image-buffer-cache.js";
import { getGlobalPrefix } from "../service.js";
import { extractCommandBody } from "../../commands/shared/command-input-utils.js";
import { checkExstentionFileRemote, checkLinkIsValid } from "../../utils/util.js";
import { sendMessageCompleteRequest, sendMessageWarningRequest } from "../chat-zalo/chat-style/chat-style.js";

const TIME_SHOW_SCAN_QR = 600000;
const QR_SCAN_CACHE_TTL = 5 * 60 * 1000;
const QR_SCAN_CACHE_MAX = 200;
const MAX_QR_INPUT_BYTES = 15 * 1024 * 1024;
const qrScanResultCache = new LRUCache({ max: QR_SCAN_CACHE_MAX, ttl: QR_SCAN_CACHE_TTL });

const BIN_TO_BANK_NAME = Object.freeze({
  "970436": "Vietcombank",
  "970407": "Techcombank",
  "970422": "MB Bank",
  "970416": "ACB",
  "970441": "VIB",
  "970418": "BIDV",
  "970415": "VietinBank",
  "970423": "TPBank",
  "970432": "VPBank",
  "970405": "Agribank",
  "970403": "Sacombank",
  "970429": "SCB",
  "970437": "HDBank",
  "970448": "OCB",
  "970426": "MSB",
  "970443": "SHB",
  "970431": "Eximbank",
  "970406": "DongA Bank",
  "970412": "PVcomBank",
  "970408": "GPBank",
  "970414": "OceanBank",
  "970428": "Nam A Bank",
  "970419": "NCB",
  "970427": "VietABank",
  "970433": "VietBank",
  "970421": "VRB",
  "970457": "Woori Bank",
  "970458": "UOB",
  "970410": "Standard Chartered",
  "970439": "Public Bank",
  "970424": "Shinhan Bank",
  "458761": "HSBC",
  "970446": "Co-opBank",
  "970449": "LPBank",
  "970438": "BaoViet Bank",
  "970454": "BVBank",
  "963388": "Timo",
  "546034": "CAKE by VPBank",
  "546035": "Ubank",
  "971005": "Viettel Money",
  "971011": "VNPT Money",
  "971025": "MoMo",
});

const SUPPORTED_QR_IMAGE_FORMATS = new Set([
  "jpeg",
  "jpg",
  "png",
  "webp",
  "gif",
  "jxl",
  "heif",
  "avif",
  "tiff",
  "svg",
]);

function parseEmvTlv(payload) {
  const fields = new Map();
  let idx = 0;
  const str = String(payload || "");
  while (idx + 4 <= str.length) {
    const tag = str.slice(idx, idx + 2);
    const lenStr = str.slice(idx + 2, idx + 4);
    if (!/^\d{2}$/.test(lenStr)) break;
    const len = Number(lenStr);
    if (idx + 4 + len > str.length) break;
    const value = str.slice(idx + 4, idx + 4 + len);
    fields.set(tag, value);
    idx += 4 + len;
  }
  return fields;
}

function formatBankTransferSummary({ bankName, bankId, accountNumber, accountName, amount, description }) {
  const bankLabel = bankName
    ? bankId && !bankName.includes(bankId)
      ? `${bankName} (BIN: ${bankId})`
      : bankName
    : bankId || "Không rõ";
  const numericAmount = amount !== null && amount !== undefined && String(amount).trim() !== "" ? Number(amount) : NaN;
  const amountText = Number.isFinite(numericAmount) && numericAmount > 0
    ? `${numericAmount.toLocaleString("vi-VN")} VNĐ`
    : "Không cố định";

  const lines = [
    "🏦 Thông tin chuyển khoản ngân hàng:",
    `• Ngân hàng: ${bankLabel}`,
    `• Số tài khoản: ${accountNumber || "Không rõ"}`,
  ];
  if (accountName) {
    lines.push(`• Chủ tài khoản: ${accountName}`);
  }
  lines.push(`• Số tiền: ${amountText}`);
  lines.push(`• Nội dung: ${description || "Không có"}`);
  return lines.join("\n");
}

function parseVietQrEmvCo(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith("000201")) return null;
  const root = parseEmvTlv(trimmed);
  if (root.size === 0) return null;

  let bankId = "";
  let accountNumber = "";
  const merchantRaw = root.get("38") || root.get("26") || root.get("27") || "";
  if (merchantRaw) {
    const merchant = parseEmvTlv(merchantRaw);
    const beneficiaryRaw = merchant.get("01") || "";
    if (beneficiaryRaw) {
      const beneficiary = parseEmvTlv(beneficiaryRaw);
      bankId = beneficiary.get("00") || "";
      accountNumber = beneficiary.get("01") || "";
    }
  }

  if (!bankId && !accountNumber) return null;

  const additionalRaw = root.get("62") || "";
  const additional = additionalRaw ? parseEmvTlv(additionalRaw) : new Map();
  const description = additional.get("08") || additional.get("01") || "";
  const amount = root.get("54") || "";
  const accountName = root.get("59") || "";
  const bankName = BIN_TO_BANK_NAME[bankId] || "";

  const formatted = formatBankTransferSummary({
    bankName,
    bankId,
    accountNumber,
    accountName,
    amount,
    description,
  });

  return {
    type: "bank_transfer",
    bankId,
    bankName: bankName || bankId,
    accountNumber,
    accountName,
    amount,
    description,
    rawContent: trimmed,
    content: formatted,
  };
}

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
    const metadata = await sharp(originalBuffer, { animated: false }).metadata().catch(() => null);
    if (!metadata || (!SUPPORTED_QR_IMAGE_FORMATS.has(metadata.format) && !metadata.width)) {
      const unsupported = { success: false, error: "Định dạng ảnh không được hỗ trợ" };
      qrScanResultCache.set(imageUrl, unsupported);
      return unsupported;
    }

    // Normalize animated/exotic formats (.gif, .jxl, .webp) to a crisp static frame via Sharp
    const normalizedBuffer = ["gif", "jxl", "webp", "heif", "avif"].includes(metadata.format)
      ? await sharp(originalBuffer, { animated: false, pages: 1 }).png().toBuffer()
      : originalBuffer;

    // Pass 1: Direct RGBA decode via Sharp (no Cairo canvas allocation)
    const pass1 = await sharp(normalizedBuffer)
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
    const pass2 = await sharp(normalizedBuffer)
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

export function parseQRContent(content) {
  try {
    const rawStr = String(content ?? "");
    const emvParsed = parseVietQrEmvCo(rawStr);
    if (emvParsed) {
      return emvParsed;
    }

    if (rawStr.includes("bankid=")) {
      const queryPart = rawStr.includes("?") ? rawStr.slice(rawStr.indexOf("?") + 1) : rawStr;
      const params = new URLSearchParams(queryPart);
      const bankId = params.get("bankid") || "";
      const accountNumber = params.get("account") || "";
      const accountName = params.get("name") || "";
      const amount = params.get("amount") || "";
      const description = params.get("addInfo") || params.get("content") || params.get("memo") || "";
      const bankName = BIN_TO_BANK_NAME[bankId] || bankId;
      const formatted = formatBankTransferSummary({
        bankName,
        bankId,
        accountNumber,
        accountName,
        amount,
        description,
      });
      return {
        type: "bank_transfer",
        bankId,
        bankName,
        accountNumber,
        accountName,
        amount,
        description,
        rawContent: rawStr,
        content: formatted,
      };
    }

    return {
      type: "text",
      content: rawStr,
    };
  } catch {
    return {
      type: "unknown",
      content: String(content ?? ""),
    };
  }
}

function extractAttachmentImageUrl(rawAttach) {
  if (!rawAttach) return "";
  try {
    const parsed = typeof rawAttach === "string" ? JSON.parse(rawAttach) : rawAttach;
    const candidate =
      parsed?.hdUrl ||
      parsed?.oriUrl ||
      parsed?.normalUrl ||
      parsed?.href ||
      parsed?.url ||
      parsed?.thumbUrl ||
      parsed?.thumb ||
      "";
    return typeof candidate === "string" ? candidate.replace(/\\\//g, "/").trim() : "";
  } catch {
    return "";
  }
}

export async function handleScanQRCommand(api, message, aliasCommand) {
  const prefix = getGlobalPrefix();
  let text = extractCommandBody(message, prefix, aliasCommand);

  const quote = message.data?.quote;
  if (quote) {
    const quotedUrl = extractAttachmentImageUrl(quote.attach) || (checkLinkIsValid(quote.msg) ? quote.msg.trim() : "");
    if (quotedUrl) {
      text = quotedUrl;
    }
  }

  if (!text && message.data?.content && typeof message.data.content === "object") {
    text = extractAttachmentImageUrl(message.data.content);
  }

  if (!text) {
    await sendMessageWarningRequest(
      api,
      message,
      { caption: "Vui lòng reply tin nhắn chứa ảnh hoặc gửi kèm link ảnh QRCode cần quét!" },
      30000
    );
    return;
  }

  const ext = String((await checkExstentionFileRemote(text)) || "").toLowerCase();
  const allowedExts = new Set(["png", "jpg", "jpeg", "webp", "gif", "jxl", "avif", "heif", "bmp"]);
  if (ext && !allowedExts.has(ext) && !checkLinkIsValid(text)) {
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
    const isUnsupported = result.error === "Định dạng ảnh không được hỗ trợ";
    if (isUnsupported) {
      await sendMessageWarningRequest(
        api,
        message,
        { caption: "Link hoặc định dạng file Không phải là QRCode!" },
        30000
      );
      return;
    }
    await sendMessageCompleteRequest(
      api,
      message,
      { caption: "Không tìm thấy QRCode trong ảnh!" },
      30000
    );
    return;
  }

  if (result.data?.type === "bank_transfer") {
    await sendMessageCompleteRequest(
      api,
      message,
      { caption: `Quét QRCode Hoàn Tất:\n${result.data.content}` },
      TIME_SHOW_SCAN_QR
    );
    return;
  }

  const decodedContent = String(result.data?.content ?? "");
  if (checkLinkIsValid(decodedContent)) {
    const targetExt = await checkExstentionFileRemote(decodedContent);
    if (targetExt === "png" || targetExt === "jpg" || targetExt === "jpeg") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Ảnh Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendImage(decodedContent, message, "", TIME_SHOW_SCAN_QR);
    } else if (targetExt === "mp4") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Video Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendVideo({
        videoUrl: decodedContent,
        thumbnail: "",
        threadId: message.threadId,
        threadType: message.type,
        message: { text: "" },
        ttl: TIME_SHOW_SCAN_QR,
      });
    } else if (targetExt === "gif") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Gif Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendGif(decodedContent, message, "", TIME_SHOW_SCAN_QR);
    } else if (targetExt === "webp") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Sticker Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendCustomSticker(
        message,
        decodedContent,
        decodedContent,
        null,
        null,
        TIME_SHOW_SCAN_QR
      );
    } else if (targetExt === "aac" || targetExt === "mp3" || targetExt === "m4a") {
      await sendMessageCompleteRequest(api, message, { caption: "Quét Voice Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendVoice(
        { threadId: message.threadId, type: message.type },
        decodedContent,
        TIME_SHOW_SCAN_QR
      );
    } else if (["apk", "ipa", "zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(targetExt)) {
      await sendMessageCompleteRequest(api, message, { caption: "Quét File Từ QRCode Thành Công!" }, TIME_SHOW_SCAN_QR);
      await api.sendFile(message, decodedContent, TIME_SHOW_SCAN_QR, decodedContent, null, targetExt, null);
    } else {
      await sendMessageCompleteRequest(api, message, { caption: `Quét QRCode Hoàn Tất, Nội Dung:\n${decodedContent}` }, TIME_SHOW_SCAN_QR);
    }
  } else {
    await sendMessageCompleteRequest(api, message, { caption: `Quét QRCode Hoàn Tất, Nội Dung:\n${decodedContent}` }, TIME_SHOW_SCAN_QR);
  }
}
