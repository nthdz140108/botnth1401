import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { fileTypeFromBuffer } from "file-type";
import { getGlobalPrefix } from "../../../service.js";
import { MessageMention, MessageType } from "../../../../api-zalo/index.js";
import {
  sendMessageProcessingRequest,
  sendMessageWarningRequest,
} from "../../../chat-zalo/chat-style/chat-style.js";
import {
  allocateTempPath,
  withTempFile,
  releaseAndDeleteTempFile,
} from "../../../../utils/temp-lease-manager.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
} from "../../../../utils/runtime-dependencies.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuoteData,
} from "../../../../commands/shared/command-input-utils.js";
import { normalizeMediaUrl } from "./sticker-media.js";

const DOWNLOAD_TIMEOUT_MS = 20000;
const AI_UPSCALE_TIMEOUT_MS = 12000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_4K_EDGE = 3840;
const MIN_TINY_TARGET_EDGE = 1024;

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

async function fetchUrlBuffer(rawUrl, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const candidates = [];
  const normalized = normalizeMediaUrl(rawUrl);
  if (normalized && isHttpUrl(normalized)) {
    candidates.push(normalized);
  }
  const trimmedRaw = String(rawUrl || "").replace(/\\\//g, "/").trim();
  if (isHttpUrl(trimmedRaw) && !candidates.includes(trimmedRaw)) {
    candidates.push(trimmedRaw);
  }

  let lastError = null;
  for (const candidateUrl of candidates) {
    try {
      const res = await fetch(candidateUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "image/png,image/webp,image/jpeg,image/*;q=0.9,*/*;q=0.5",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastError = new Error(`Tải ảnh thất bại (HTTP ${res.status})`);
        continue;
      }
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      if (contentType.startsWith("text/html")) {
        lastError = new Error("Đường dẫn không trả về dữ liệu hình ảnh");
        continue;
      }
      const arrBuf = await res.arrayBuffer();
      if (arrBuf.byteLength === 0) {
        lastError = new Error("Dữ liệu ảnh tải về bị rỗng");
        continue;
      }
      if (arrBuf.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("Kích thước ảnh vượt quá giới hạn 25MB");
      }
      return Buffer.from(arrBuf);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Không thể tải ảnh từ đường dẫn được cung cấp");
}

async function resolveInputBuffer(inputSource, options = {}) {
  if (Buffer.isBuffer(inputSource)) {
    return inputSource;
  }
  if (inputSource instanceof Uint8Array) {
    return Buffer.from(inputSource);
  }
  if (typeof inputSource === "string" && inputSource.trim()) {
    const trimmed = inputSource.trim();
    if (isHttpUrl(trimmed)) {
      return fetchUrlBuffer(trimmed, options.timeoutMs || DOWNLOAD_TIMEOUT_MS);
    }
    return fs.promises.readFile(path.resolve(trimmed));
  }
  throw new Error("Nguồn ảnh đầu vào không hợp lệ");
}

async function decodeToSharpCompatibleBuffer(rawBuffer) {
  try {
    const meta = await sharp(rawBuffer, { failOn: "none" }).metadata();
    if (meta?.width && meta?.height) {
      return { buffer: rawBuffer, metadata: meta };
    }
  } catch {
    // Fall through to FFmpeg conversion for JXL/HEIC/exotic containers
  }

  const detected = await fileTypeFromBuffer(rawBuffer).catch(() => null);
  const ext = detected?.ext ? `.${detected.ext}` : ".img";
  const tmpIn = allocateTempPath(ext, { prefix: "decode_in" });
  const tmpOut = allocateTempPath(".png", { prefix: "decode_out" });

  try {
    await fs.promises.writeFile(tmpIn, rawBuffer);
    configureFluentFfmpeg();
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(tmpIn);
      const ffmpegBin = getFfmpegExecutableSync();
      if (ffmpegBin) cmd.setFfmpegPath(ffmpegBin);
      cmd
        .outputOptions(["-frames:v", "1", "-y"])
        .toFormat("png")
        .on("end", resolve)
        .on("error", reject)
        .save(tmpOut);
    });
    const converted = await fs.promises.readFile(tmpOut);
    const meta = await sharp(converted, { failOn: "none" }).metadata();
    if (!meta?.width || !meta?.height) {
      throw new Error("Không đọc được kích thước ảnh sau giải mã");
    }
    return { buffer: converted, metadata: meta };
  } catch (err) {
    throw new Error(`Định dạng ảnh không được hỗ trợ hoặc bị lỗi (${err?.message || "decode error"})`);
  } finally {
    await releaseAndDeleteTempFile(tmpIn).catch(() => {});
    await releaseAndDeleteTempFile(tmpOut).catch(() => {});
  }
}

async function tryHuggingFaceAiUpscale(imageBuffer) {
  const hfToken = String(process.env.HF_TOKEN || "").trim();
  const hfModel = String(process.env.HF_UPSCALE_MODEL || "").trim();
  if (!hfToken || !hfModel) return null;

  try {
    const prepped = await sharp(imageBuffer, { failOn: "none" })
      .rotate()
      .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    const endpoint = `https://router.huggingface.co/hf-inference/models/${hfModel
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfToken}`,
        "Content-Type": "image/png",
        Accept: "image/*",
      },
      body: prepped,
      signal: AbortSignal.timeout(AI_UPSCALE_TIMEOUT_MS),
    });

    if (!res.ok) return null;
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;

    const outBuf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(outBuf, { failOn: "none" }).metadata().catch(() => null);
    if (meta?.width && meta?.height) {
      return { buffer: outBuf, metadata: meta };
    }
  } catch {
    // Seamlessly fall back to offline sharp enhancement
  }
  return null;
}

export async function upscaleImageTo4KFile(inputSource, outputFilePath, options = {}) {
  const rawBuffer = await resolveInputBuffer(inputSource, options);
  const decoded = await decodeToSharpCompatibleBuffer(rawBuffer);

  const aiEnhanced = await tryHuggingFaceAiUpscale(decoded.buffer);
  const workingBuffer = aiEnhanced ? aiEnhanced.buffer : decoded.buffer;

  const orientedMeta = await sharp(workingBuffer, { failOn: "none" }).rotate().metadata();
  const srcWidth = Math.max(1, orientedMeta.width || 512);
  const srcHeight = Math.max(1, orientedMeta.height || 512);
  const longEdge = Math.max(srcWidth, srcHeight);

  let targetLongEdge = longEdge * 2;
  if (longEdge < 512) {
    targetLongEdge = Math.max(targetLongEdge, MIN_TINY_TARGET_EDGE);
  }
  targetLongEdge = Math.min(MAX_4K_EDGE, targetLongEdge);

  const scaleFactor = targetLongEdge / longEdge;
  const targetWidth = Math.max(1, Math.round(srcWidth * scaleFactor));
  const targetHeight = Math.max(1, Math.round(srcHeight * scaleFactor));

  let pipeline = sharp(workingBuffer, { failOn: "none" }).rotate();

  if (longEdge <= 960 || options.denoise === true) {
    pipeline = pipeline.median(1);
  }

  pipeline = pipeline
    .resize(targetWidth, targetHeight, {
      kernel: sharp.kernel.lanczos3,
      fit: "fill",
    })
    .sharpen({ sigma: 1.2, m1: 1.0, m2: 2.5 })
    .modulate({ saturation: 1.04 });

  const resolvedOutPath = outputFilePath
    ? path.resolve(outputFilePath)
    : allocateTempPath(".png", { prefix: "enhanced_4k" });

  await fs.promises.mkdir(path.dirname(resolvedOutPath), { recursive: true });

  const outExt = path.extname(resolvedOutPath).toLowerCase();
  if (outExt === ".jpg" || outExt === ".jpeg") {
    await pipeline.jpeg({ quality: 95, mozjpeg: true }).toFile(resolvedOutPath);
  } else if (outExt === ".webp") {
    await pipeline.webp({ quality: 95 }).toFile(resolvedOutPath);
  } else {
    await pipeline.png({ compressionLevel: 6, adaptiveFiltering: true }).toFile(resolvedOutPath);
  }

  return resolvedOutPath;
}

function extractImageUrlFromMessage(message, prefix, aliasCommand) {
  const quote = getQuoteData(message);
  if (quote) {
    if (quote.attach) {
      try {
        const attachData =
          typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
        const candidate =
          attachData?.hdUrl ||
          attachData?.oriUrl ||
          attachData?.href ||
          attachData?.normalUrl ||
          attachData?.thumbUrl ||
          attachData?.url;
        if (candidate && typeof candidate === "string") {
          const cleaned = candidate.replace(/\\\//g, "/").trim();
          try {
            return /^https?%3A%2F%2F/i.test(cleaned)
              ? decodeURIComponent(cleaned)
              : cleaned;
          } catch {
            return cleaned;
          }
        }
      } catch {}
    }

    const quotedMsg = String(quote.msg || quote.content || "").trim();
    const quotedUrl = quotedMsg.match(/https?:\/\/\S+/i);
    if (quotedUrl) return quotedUrl[0];
  }

  const argBody = extractCommandBody(message, prefix, aliasCommand);
  const directUrl = argBody.match(/https?:\/\/\S+/i);
  return directUrl ? directUrl[0] : "";
}

export async function handleEnhanceImageCommand(api, message, aliasCommand = "lamnet") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "lamnet";
  const senderName = message?.data?.dName || "Bạn";
  const senderId = message?.data?.uidFrom || "";
  const threadType = safeThreadType(
    message,
    message?.threadId && senderId && String(message.threadId) === String(senderId)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );
  const msgCtx = message?.type === threadType ? message : { ...message, type: threadType };

  const mediaUrl = extractImageUrlFromMessage(msgCtx, prefix, effectiveAlias);
  if (!mediaUrl) {
    await sendMessageWarningRequest(
      api,
      msgCtx,
      {
        caption: `Vui lòng reply vào tin nhắn chứa ảnh cần làm nét và dùng lệnh ${prefix}${effectiveAlias}.`,
      },
      30000
    );
    return;
  }

  try {
    await sendMessageProcessingRequest(
      api,
      msgCtx,
      { caption: "⏳ Đang nâng cấp độ nét ảnh chuẩn 4K, vui lòng chờ giây lát..." },
      12000
    );

    await withTempFile(
      ".png",
      async (enhancedPath) => {
        await upscaleImageTo4KFile(mediaUrl, enhancedPath);
        await api.sendMessage(
          {
            msg: `[ ${senderName} ]\n\n🖼️ Ảnh đã được làm nét hoàn tất!`,
            attachments: [enhancedPath],
            ...(senderId
              ? { mentions: [MessageMention(senderId, senderName.length, 2, false)] }
              : {}),
            ttl: 3600000,
          },
          msgCtx.threadId,
          threadType
        );
      },
      { prefix: "lamnet_4k" }
    );
  } catch (error) {
    await sendMessageWarningRequest(
      api,
      msgCtx,
      {
        caption: `Không thể làm nét ảnh: ${error?.message || "Lỗi xử lý hình ảnh"}`,
      },
      30000
    );
  }
}
