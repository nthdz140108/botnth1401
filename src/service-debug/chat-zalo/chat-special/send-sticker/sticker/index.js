import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { configureFluentFfmpeg, getFfmpegExecutableSync } from "../../../../../utils/runtime-dependencies.js";

configureFluentFfmpeg();

import { MessageType } from "../../../../../api-zalo/models/Message.js";
import { appContext } from "../../../../../api-zalo/context.js";
import { tempDir } from "../../../../../utils/io-json.js";
import { getGlobalPrefix } from "../../../../service.js";
import { removeMention } from "../../../../../utils/format-util.js";
import { getMessageCacheByMsgId } from "../../../../../utils/message-cache.js";
import { resolveInstanceAuthorization } from "../../../../../utils/instance-authorization.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageProcessingRequest,
  sendMessageWarning,
} from "../../../chat-style/chat-style.js";
import { collectMediaCandidates } from "../sticker-media.js";

import {
  parseStickerArgs,
  extractStickerArgument,
  STICKER_USAGE_GUIDE,
  StickerParseError,
} from "./parser.js";
import { normalizeEffectPlan } from "./effects.js";
import { downloadWithRetry } from "./download.js";
import { generateStickerImage, deleteBrokerJob, hasHuggingFaceConfig } from "./ai.js";
import { HfInferenceError } from "./hf.js";
import { removeBackground } from "../../../../utilities/remove-background.js";
import {
  STICKER_SIZE,
  MAX_DURATION_SEC,
  TARGET_FPS,
  hasAnyEffects,
  applyStaticEffects,
  applyEffectsToFrames,
  compositeSpinFrames,
  renderTextSticker,
  renderTextVideoFrames,
} from "./render.js";
import {
  encodeAdaptiveAnimatedWebp,
  encodeAnimatedWebp,
  encodeStaticWebp,
  generatePreviewPng,
  getWebpMetadata,
  MAX_OUTPUT_BYTES,
} from "./encode.js";

const MAX_BYTES = 50 * 1024 * 1024;

function ensureTempDir() {
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url ?? "").split("?")[0];
  }
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
  let recentMessages = [];
  if (message?.type === MessageType.GroupMessage && quotedMsgId && typeof api?.getRecentMessages === "function") {
    const threadId = message.threadId || message.idTo;
    if (threadId) {
      try {
        const recentMessageRaw = await api.getRecentMessages(threadId, quotedMsgId, 50);
        recentMessages = parseRecentMessages(recentMessageRaw);
      } catch (error) {
        console.error("Lỗi khi lấy lịch sử tin nhắn cho quote:", error.message);
      }
    }
  }
  return { cachedMessage, recentMessages };
}

function buildMediaCandidates(message, cachedMessage, recentMessages) {
  return collectMediaCandidates(message, cachedMessage, recentMessages);
}

async function resolveMediaForRequest(api, message, request) {
  if (request.payload?.kind === "media" && request.payload.url) {
    return [{ url: request.payload.url, source: "url", quality: 1000 }];
  }
  const { cachedMessage, recentMessages } = await loadQuotedContext(api, message);
  return buildMediaCandidates(message, cachedMessage, recentMessages);
}

async function writeFrames(framesDir, frameBuffers) {
  await fs.promises.mkdir(framesDir, { recursive: true });
  for (let index = 0; index < frameBuffers.length; index += 1) {
    await fs.promises.writeFile(
      path.join(framesDir, `frame_${String(index).padStart(4, "0")}.png`),
      frameBuffers[index]
    );
  }
}

async function extractFramesFromVideo(inputPath, framesDir, fps = TARGET_FPS, duration = MAX_DURATION_SEC) {
  await fs.promises.mkdir(framesDir, { recursive: true });
  const ffmpegBin = getFfmpegExecutableSync();
  if (!ffmpegBin) {
    const err = new Error("FFmpeg không khả dụng trên hệ thống");
    err.code = "MISSING_DEPENDENCY";
    throw err;
  }
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    cmd.setFfmpegPath(ffmpegBin);
    cmd
      .outputOptions([
        "-vf", `fps=${fps},scale=${STICKER_SIZE}:-2:flags=lanczos`,
        "-t", String(duration),
      ])
      .save(path.join(framesDir, "frame_%04d.png"))
      .on("end", () => resolve())
      .on("error", (err) => {
        const msg = String(err?.message || "");
        if (msg.includes("3221225785") || msg.includes("0xC0000139")) {
          err.code = "FFMPEG_INCOMPATIBLE";
        }
        reject(err);
      });
  });
}

async function extractFramesFromAnimatedImage(inputPath, framesDir, maxDuration = MAX_DURATION_SEC, fps = TARGET_FPS) {
  await fs.promises.mkdir(framesDir, { recursive: true });
  const meta = await sharp(inputPath, { animated: true }).metadata();
  const pages = meta.pages || 1;
  const maxFrames = Math.min(pages, maxDuration * fps);
  for (let i = 0; i < maxFrames; i += 1) {
    const frameBuffer = await sharp(inputPath, { page: i }).ensureAlpha().png().toBuffer();
    await fs.promises.writeFile(
      path.join(framesDir, `frame_${String(i).padStart(4, "0")}.png`),
      frameBuffer
    );
  }
}

async function encodeSpinFromImage(plan, buffer, jobDir) {
  const framesDir = path.join(jobDir, "spin_frames");
  const frameCount = 24;
  const frames = await compositeSpinFrames(buffer, { frameCount });
  await writeFrames(framesDir, frames);
  const outputPath = path.join(jobDir, "spin.webp");
  await encodeAnimatedWebp({
    framesDir,
    outputPath,
    fps: TARGET_FPS,
    quality: 80,
    speed: plan.animation.speed || 1,
    duration: Math.min(MAX_DURATION_SEC, frameCount / TARGET_FPS),
  });
  return { outputPath, firstFrame: frames[0] };
}

async function uploadAndSend(api, message, previewBuffer, stickerBuffer, senderName, options = {}) {
  const previewPath = path.join(tempDir, `sticker_prev_${randomUUID()}.png`);
  const webpPath = path.join(tempDir, `sticker_upload_${randomUUID()}.webp`);

  await fs.promises.writeFile(previewPath, previewBuffer);
  await fs.promises.writeFile(webpPath, stickerBuffer);

  try {
    const meta = await getWebpMetadata(stickerBuffer);
    const width = meta?.width ?? STICKER_SIZE;
    const height = meta?.height ?? STICKER_SIZE;

    const previewUpload = await api.uploadAttachment([previewPath], appContext.send2meId, MessageType.DirectMessage);
    const previewUrl = previewUpload?.[0]?.fileUrl || previewUpload?.[0]?.normalUrl;
    if (!previewUrl) {
      throw new Error("Không tải được ảnh xem trước sticker lên máy chủ");
    }

    const webpUpload = await api.uploadAttachment([webpPath], appContext.send2meId, MessageType.DirectMessage);
    const stickerUrl = webpUpload?.[0]?.fileUrl || webpUpload?.[0]?.normalUrl;
    if (!stickerUrl) {
      throw new Error("Không tải được file sticker lên máy chủ");
    }

    const stickerKind = options?.stickerKind || "photo";
    await api.sendCustomSticker(message, previewUrl, stickerUrl, width, height, 3600000, { stickerKind });

    // Only send success message AFTER upload and sendCustomSticker succeed
    await sendMessageComplete(api, message, `${senderName} Sticker của bạn đây!`, true);
  } finally {
    await fs.promises.unlink(previewPath).catch(() => {});
    await fs.promises.unlink(webpPath).catch(() => {});
  }
}

async function detectMediaDescriptor(filePath, mediaType) {
  const mime = String(mediaType || "").toLowerCase();
  if (mime.startsWith("video/")) {
    return {
      kind: "video",
      mime,
      filePath,
    };
  }
  if (mime.startsWith("image/")) {
    try {
      const meta = await sharp(filePath, { animated: true }).metadata();
      const pages = meta.pages || 1;
      if (pages > 1) {
        return {
          kind: "animated-image",
          mime,
          filePath,
          pages,
          width: meta.width,
          height: meta.height,
        };
      }
      return {
        kind: "static-image",
        mime,
        filePath,
        width: meta.width,
        height: meta.height,
      };
    } catch {
      return {
        kind: "static-image",
        mime,
        filePath,
      };
    }
  }
  return {
    kind: "unknown",
    mime,
    filePath,
  };
}

async function handleStaticPipeline(api, message, plan, jobDir, initialBuffer, senderName, options = {}) {
  let working = initialBuffer;
  if (plan.meta.removeBackground) {
    const cleaned = await removeBackground(working);
    if (cleaned) working = cleaned;
  }

  const composed = await applyStaticEffects(working, plan);

  if (plan.animation.spin) {
    const { outputPath: spinPath, firstFrame } = await encodeSpinFromImage(plan, composed, jobDir);
    const outputWebp = await fs.promises.readFile(spinPath);
    const previewBuffer = await generatePreviewPng(firstFrame);
    await uploadAndSend(api, message, previewBuffer, outputWebp, senderName, options);
    return;
  }

  const stickerBuffer = await encodeStaticWebp({ input: composed, quality: 80 });
  const previewBuffer = await generatePreviewPng(composed);
  await uploadAndSend(api, message, previewBuffer, stickerBuffer, senderName, options);
}

async function handleAnimatedPipeline(api, message, plan, jobDir, framesDir, senderName, options = {}) {
  const frameFiles = (await fs.promises.readdir(framesDir))
    .filter((file) => file.endsWith(".png"))
    .sort();
  if (!frameFiles.length) {
    throw new Error("Không thể trích xuất khung hình từ media");
  }

  let frameBuffers = await Promise.all(
    frameFiles.map((file) => fs.promises.readFile(path.join(framesDir, file)))
  );

  frameBuffers = await applyEffectsToFrames(frameBuffers, plan);

  const finalFramesDir = path.join(jobDir, "final_frames");
  await writeFrames(finalFramesDir, frameBuffers);

  const outputPath = path.join(jobDir, "sticker.webp");
  await encodeAdaptiveAnimatedWebp({
    framesDir: finalFramesDir,
    outputPath,
    speed: plan.animation.speed || 1,
  });

  const stickerBuffer = await fs.promises.readFile(outputPath);
  const previewBuffer = await generatePreviewPng(frameBuffers[0]);
  await uploadAndSend(api, message, previewBuffer, stickerBuffer, senderName, options);
}

function classifyError(error) {
  if (error?.code === "FFMPEG_INCOMPATIBLE" || String(error?.message).includes("3221225785") || String(error?.message).includes("0xC0000139")) return "ffmpeg-incompatible";
  if (error?.code === "MISSING_DEPENDENCY" || error?.code === "VIDEO_TOOL_MISSING") return "missing-dependency";
  if (error?.code === "SIZE_LIMIT") return "media-too-large";
  if (error?.code === "AI_NO_IMAGE") return "ai-no-image";
  if (error?.code === "HF_CONFIG_MISSING") return "hf-config-missing";
  if (error?.code === "HF_UNAUTHENTICATED") return "hf-unauthenticated";
  if (error?.code === "HF_RATE_LIMIT") return "hf-rate-limit";
  if (error?.code === "HF_SERVICE_UNAVAILABLE") return "hf-service-unavailable";
  if (error?.code === "HF_INVALID_RESPONSE") return "hf-invalid-response";
  if (error?.code === "HF_TIMEOUT") return "hf-timeout";
  if (error?.code === "MEDIA_TOO_COMPLEX") return "media-too-complex";
  if (error instanceof StickerParseError) return "syntax";
  if (error?.message?.startsWith("File")) return "media-detection";
  if (error?.message?.startsWith("Không tải")) return "media-download";
  if (error?.message?.includes("upload") || error?.message?.includes("tải lên")) return "upload";
  if (error?.message?.includes("sendCustomSticker") || error?.message?.includes("Sticker")) return "send";
  return "process";
}

export async function handleStickerCommand(api, message, options = {}) {
  ensureTempDir();
  const senderName = message?.data?.dName ?? "Bạn";
  const jobId = randomUUID();
  const rawText = removeMention(message ?? {}) || message?.data?.content || "";
  const prefix = getGlobalPrefix();
  const escapedPrefix = prefix ? `(?:${String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?` : "";
  const isAiAlias =
    /^(?:stickerai|stkai|sticker\s+ai|stk\s+ai)$/i.test(String(options?.aliasCommand || "").trim()) ||
    new RegExp(`^${escapedPrefix}\\s*(?:stickerai|stkai)(?:\\s|$)`, "i").test(rawText.trim());
  const forceAiMode = Boolean(options?.forceAiMode || isAiAlias);
  const argumentText = extractStickerArgument(rawText, options?.aliasCommand, prefix);

  let request;
  try {
    request = parseStickerArgs(argumentText, {
      hasMediaReference: Boolean(message?.data?.quote),
      forceAiMode,
    });
  } catch (error) {
    if (error instanceof StickerParseError) {
      await sendMessageWarning(api, message, `${senderName} ${error.message}`, true);
      return;
    }
    throw error;
  }

  // Phân quyền: Sticker sử dụng AI chỉ dành riêng cho Admin tối cao (adminLevelHigh)
  let isAdminLevelHighest = Boolean(options?.isAdminLevelHighest);
  if (!isAdminLevelHighest) {
    try {
      const senderId = message?.data?.uidFrom || message?.data?.senderId || message?.senderId || "";
      const auth = resolveInstanceAuthorization({
        senderId,
        threadId: message?.threadId || "",
        instanceUid: String(
          api?.getBotId?.() || api?.getOwnId?.() || api?.currentUserId || appContext?.uid || "",
        ).trim(),
      });
      if (auth?.isAdminLevelHigh) {
        isAdminLevelHighest = true;
      }
    } catch {}
  }

  if (request.source === "ai" && !isAdminLevelHighest) {
    await sendMessageWarning(
      api,
      message,
      `${senderName}, tính năng tạo sticker AI chỉ dành riêng cho Admin tối cao (Quản trị viên cấp cao).`,
      true
    );
    return;
  }

  const plan = normalizeEffectPlan(request);
  const hasEffects = hasAnyEffects(plan);
  const isAiSource = request.source === "ai" || request.source === "text" || request.source === "textvd";
  let stickerKind = (hasEffects || isAiSource) ? "ai" : "photo";

  await sendMessageProcessingRequest(
    api,
    message,
    { caption: `${senderName} Ok, đang tạo sticker, chờ một chút!` },
    6000
  );

  const jobDir = path.join(tempDir, `sticker-job-${jobId}`);
  const cleanupPaths = new Set();
  let brokerJobId = null;

  let lastMediaBuffer = null;
  let lastMediaMime = null;
  let usedFallback = false;

  const isSendOrUploadError = (err) => {
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("upload") || msg.includes("tải lên") || msg.includes("sendcustomsticker");
  };

  const tryAiFallback = async (causeErr) => {
    if (!isAdminLevelHighest) return false;
    if (usedFallback) return false;
    if (!hasHuggingFaceConfig()) return false;
    if (causeErr instanceof StickerParseError) return false;
    if (causeErr instanceof HfInferenceError) return false;
    if (isSendOrUploadError(causeErr)) return false;

    usedFallback = true;
    stickerKind = "ai";

    try {
      let prompt = "Biến chủ thể thành sticker dễ thương, viền rõ và nền trong suốt.";
      if (request.source === "text" && request.payload?.text) {
        prompt = `Tạo sticker minh họa cho: ${request.payload.text}`;
      } else if (request.source === "textvd" && request.payload?.text) {
        prompt = `Tạo sticker minh họa cho: ${request.payload.text}`;
      } else if (request.source === "ai" && request.payload?.prompt) {
        prompt = request.payload.prompt;
      }

      const aiResult = await generateStickerImage({
        prompt,
        referenceBuffer: lastMediaBuffer,
        referenceMimeType: lastMediaMime,
      });

      if (aiResult.filePath) cleanupPaths.add(aiResult.filePath);
      await handleStaticPipeline(api, message, plan, jobDir, aiResult.imageBuffer, senderName, { stickerKind: "ai" });
      return true;
    } catch (fallbackErr) {
      throw fallbackErr;
    }
  };

  try {
    await fs.promises.mkdir(jobDir, { recursive: true });

    if (request.source === "media") {
      const candidates = await resolveMediaForRequest(api, message, request);
      if (!candidates.length) {
        await sendMessageWarning(
          api,
          message,
          `${senderName}, hãy reply vào ảnh/video hoặc dán URL media trực tiếp rồi dùng lại lệnh.\n\n${STICKER_USAGE_GUIDE}`,
          true
        );
        return;
      }

      try {
        const downloaded = await downloadWithRetry(candidates, {
          tempDir,
          fileTypeFromBuffer: (await import("file-type")).fileTypeFromBuffer,
        });
        cleanupPaths.add(downloaded.filePath);

        const imageBuffer = await fs.promises.readFile(downloaded.filePath);
        lastMediaBuffer = imageBuffer;
        lastMediaMime = downloaded.mediaType;

        const descriptor = await detectMediaDescriptor(downloaded.filePath, downloaded.mediaType);

        if (descriptor.kind === "video" || descriptor.kind === "animated-image") {
          if (plan.meta.removeBackground) {
            await sendMessageWarning(api, message, `${senderName}, chưa hỗ trợ xóa phông cho sticker video hoặc ảnh động!`, true);
            return;
          }
          const framesDir = path.join(jobDir, "media_frames");
          if (descriptor.kind === "video") {
            await extractFramesFromVideo(downloaded.filePath, framesDir);
          } else {
            await extractFramesFromAnimatedImage(downloaded.filePath, framesDir);
          }
          await handleAnimatedPipeline(api, message, plan, jobDir, framesDir, senderName, { stickerKind });
        } else {
          if (plan.animation.speed !== null && !plan.animation.spin) {
            await sendMessageWarning(api, message, `${senderName}, hiệu ứng speed (sp) chỉ áp dụng cho sticker động, video hoặc khi có hiệu ứng spin!`, true);
            return;
          }
          await handleStaticPipeline(api, message, plan, jobDir, imageBuffer, senderName, { stickerKind });
        }
      } catch (localErr) {
        const handled = await tryAiFallback(localErr).catch(() => false);
        if (!handled) throw localErr;
      }
    } else if (request.source === "text") {
      if (plan.animation.speed !== null && !plan.animation.spin) {
        await sendMessageWarning(api, message, `${senderName}, hiệu ứng speed (sp) chỉ áp dụng cho sticker động, video hoặc khi có hiệu ứng spin!`, true);
        return;
      }
      try {
        const pngBuffer = await renderTextSticker({ text: request.payload.text });
        await handleStaticPipeline(api, message, plan, jobDir, pngBuffer, senderName, { stickerKind: "ai" });
      } catch (localErr) {
        const handled = await tryAiFallback(localErr).catch(() => false);
        if (!handled) throw localErr;
      }
    } else if (request.source === "textvd") {
      if (plan.meta.removeBackground) {
        await sendMessageWarning(api, message, `${senderName}, chưa hỗ trợ xóa phông cho textvd!`, true);
        return;
      }
      try {
        const totalFrames = Math.min(30, TARGET_FPS * MAX_DURATION_SEC);
        const frameBuffers = await renderTextVideoFrames({
          text: request.payload.text,
          color: request.payload.color,
          frames: totalFrames,
        });
        const framesDir = path.join(jobDir, "textvd_frames");
        await writeFrames(framesDir, frameBuffers);
        await handleAnimatedPipeline(api, message, plan, jobDir, framesDir, senderName, { stickerKind: "ai" });
      } catch (localErr) {
        const handled = await tryAiFallback(localErr).catch(() => false);
        if (!handled) throw localErr;
      }
    } else if (request.source === "ai") {
      if (!hasHuggingFaceConfig()) {
        await sendMessageWarning(
          api,
          message,
          `${senderName}, stk ai chưa có HF_TOKEN trong .env.local. Hãy bổ sung token Hugging Face để dùng tiếp.`,
          true
        );
        return;
      }

      let referenceBuffer = null;
      let referenceMimeType = null;
      if (request.payload.reference) {
        const candidates = await resolveMediaForRequest(api, message, { source: "media", payload: { kind: "media", reference: "reply" } });
        if (candidates.length) {
          const downloaded = await downloadWithRetry(candidates, {
            tempDir,
            fileTypeFromBuffer: (await import("file-type")).fileTypeFromBuffer,
          });
          cleanupPaths.add(downloaded.filePath);

          const desc = await detectMediaDescriptor(downloaded.filePath, downloaded.mediaType);
          if (desc.kind === "video" || desc.kind === "animated-image") {
            const firstFrameDir = path.join(jobDir, "ai_first_frame");
            if (desc.kind === "video") {
              await extractFramesFromVideo(downloaded.filePath, firstFrameDir, 1, 1);
            } else {
              await extractFramesFromAnimatedImage(downloaded.filePath, firstFrameDir, 1, 1);
            }
            const frameFiles = (await fs.promises.readdir(firstFrameDir)).filter((f) => f.endsWith(".png")).sort();
            if (frameFiles.length) {
              referenceBuffer = await fs.promises.readFile(path.join(firstFrameDir, frameFiles[0]));
              referenceMimeType = "image/png";
            }
          } else {
            referenceBuffer = await fs.promises.readFile(downloaded.filePath);
            referenceMimeType = downloaded.mediaType;
          }
        }
      }

      const aiResult = await generateStickerImage({
        prompt: request.payload.prompt,
        referenceBuffer,
        referenceMimeType,
      });

      if (aiResult.filePath) cleanupPaths.add(aiResult.filePath);
      if (aiResult.jobId) brokerJobId = aiResult.jobId;

      await handleStaticPipeline(api, message, plan, jobDir, aiResult.imageBuffer, senderName, { stickerKind: "ai" });
    }
  } catch (error) {
    const category = classifyError(error);
    console.error(`[sticker:${category}]`, error?.message ?? error);
    const friendlyMessage = category === "ffmpeg-incompatible"
      ? `${senderName} Lỗi media: Phiên bản FFmpeg hiện tại không tương thích với Windows Server (mã 0xC0000139). Vui lòng cập nhật bản build tương thích.`
      : `${senderName} Lỗi (${category}): ${error?.message ?? error}`;
    await sendMessageFailed(api, message, friendlyMessage, true);
  } finally {
    for (const filePath of cleanupPaths) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
    await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    if (brokerJobId) {
      await deleteBrokerJob(brokerJobId).catch(() => {});
    }
  }
}

export const __test = {
  classifyError,
  buildMediaCandidates,
  parseRecentMessages,
  loadQuotedContext,
  detectMediaDescriptor,
  uploadAndSend,
  MAX_BYTES,
};
