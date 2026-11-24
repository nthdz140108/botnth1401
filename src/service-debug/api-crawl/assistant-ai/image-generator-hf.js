/**
 * AI Image Generator Module — Powered by Hugging Face Inference API
 *
 * Model: stabilityai/stable-diffusion-xl-base-1.0 (Free Serverless Tier)
 * Provider: hf-inference
 * Permission: adminLevelHigh (Quản trị viên cấp cao / Admin tối cao)
 *
 * Replaces Gemini Web browser (Puppeteer) with headless HTTP requests.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getActiveRuntimeContext } from "../../../utils/io-json.js";
import {
  generateStickerImageHF,
  hasHuggingFaceConfig,
  getHuggingFaceConfig,
  HfInferenceError,
  __test as __hfTest,
} from "../../chat-zalo/chat-special/send-sticker/sticker/hf.js";
import { resolveInstanceAuthorization } from "../../../utils/instance-authorization.js";
import { removeMention } from "../../../utils/format-util.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageWarning,
} from "../../chat-zalo/chat-style/chat-style.js";

async function resolvePrefix() {
  try {
    const { getGlobalPrefix } = await import("../../service.js");
    return getGlobalPrefix ? getGlobalPrefix() : "!";
  } catch {
    return "!";
  }
}


export { hasHuggingFaceConfig, getHuggingFaceConfig, HfInferenceError };

/**
 * Check whether the message sender is an Admin Tối Cao (adminLevelHigh)
 */
export function checkAdminLevelHigh(message, options = {}, api = null) {
  if (options?.isAdminLevelHighest === true) return true;
  try {
    const senderId =
      message?.data?.uidFrom ||
      message?.data?.senderId ||
      message?.senderID ||
      message?.senderId ||
      "";
    const auth = resolveInstanceAuthorization({
      senderId,
      threadId: message?.threadId || "",
      instanceUid: String(api?.getBotId?.() || api?.getOwnId?.() || api?.currentUserId || "").trim(),
    });
    return Boolean(auth?.isAdminLevelHigh);
  } catch {
    return false;
  }
}

/**
 * Pick an attachment from quote or message
 */
function pickAttachment(message) {
  const candidates = [];
  const quote = message && message.data && message.data.quote;
  if (quote) {
    if (typeof quote.attach === "string") {
      try {
        const parsed = JSON.parse(quote.attach);
        if (parsed && typeof parsed === "object") candidates.push(parsed);
      } catch {}
    }
    if (Array.isArray(quote.attachments)) candidates.push(...quote.attachments);
    if (quote.attachment) candidates.push(quote.attachment);
  }
  if (Array.isArray(message?.attachments)) candidates.push(...message.attachments);
  if (message?.attachment) candidates.push(message.attachment);

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const url = c.hdUrl || c.href || c.oriUrl || c.normalUrl || c.thumbUrl || c.url || c.fileUrl;
    if (url) {
      return { attachment: c, url };
    }
  }
  return null;
}

/**
 * Download reply/quote image attachment buffer
 */
export async function downloadQuoteAttachment(api, message) {
  const found = pickAttachment(message);
  if (!found) return null;
  const { attachment, url } = found;
  const claimedMime = attachment.mimeType || attachment.mime || "image/png";
  let buffer = null;
  let mime = claimedMime;

  if (api && typeof api.downloadAttachment === "function") {
    try {
      const result = await api.downloadAttachment(attachment);
      if (result && Buffer.isBuffer(result.buffer)) {
        buffer = result.buffer;
        mime = result.mimeType || mime;
      } else if (result && typeof result.path === "string") {
        buffer = fs.readFileSync(result.path);
        mime = result.mimeType || mime;
      }
    } catch {}
  }

  if (!buffer && url) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; MyBot/1.0)" },
      });
      clearTimeout(timer);
      if (res.ok) {
        const ab = await res.arrayBuffer();
        buffer = Buffer.from(ab);
        mime = res.headers.get("content-type") || mime;
      }
    } catch {}
  }

  if (buffer && buffer.length > 0) {
    return { buffer, mimeType: mime };
  }
  return null;
}

/**
 * Generate an AI image via Hugging Face and write it to a temporary file.
 * Returns { filePath, imageBuffer, mimeType, provider, model }
 */
export async function generateAiImageFile({ prompt, referenceBuffer, referenceMimeType }) {
  const result = await generateStickerImageHF({
    prompt,
    referenceBuffer,
    referenceMimeType,
  });

  const ext = result.mimeType && result.mimeType.includes("jpeg") ? "jpg" : "png";
  const tempDir = getActiveRuntimeContext().tempDir;
  fs.mkdirSync(tempDir, { recursive: true });
  const tmpPath = path.join(
    tempDir,
    `ai-img-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`
  );
  fs.writeFileSync(tmpPath, result.imageBuffer);

  return {
    filePath: tmpPath,
    imageBuffer: result.imageBuffer,
    mimeType: result.mimeType,
    provider: result.provider,
    model: result.model,
  };
}

/**
 * Common workflow handler for AI image generation commands:
 * 1. Admin permission check (adminLevelHigh only)
 * 2. Prompt validation
 * 3. HF configuration check
 * 4. Processing status notification
 * 5. Quote reference download (if any)
 * 6. Headless Hugging Face generation
 * 7. Delivery via api.sendMessage
 * 8. Safe temp file cleanup
 */
export async function executeAiImageWorkflow({
  api,
  message,
  prompt,
  aliasCommand = "createimageai",
  isAdminLevelHighest = false,
  customSuccessCaption = null,
}) {
  const senderName = message?.data?.dName || "";
  const prefix = await resolvePrefix();

  // 1. Phân quyền: Chỉ Admin tối cao mới được tạo ảnh AI
  const isAdmin = isAdminLevelHighest || checkAdminLevelHigh(message, { isAdminLevelHighest }, api);
  if (!isAdmin) {
    await sendMessageWarning(
      api,
      message,
      `⚠️ ${senderName ? `${senderName}, ` : ""}tính năng tạo ảnh AI chỉ dành riêng cho Admin tối cao (Quản trị viên cấp cao).`,
      true
    );
    return false;
  }

  // 2. Kiểm tra mô tả ảnh (prompt)
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) {
    await sendMessageWarning(
      api,
      message,
      `Vui lòng nhập mô tả ảnh cần tạo.\nVí dụ:\n${prefix}${aliasCommand} một con rồng đang chơi guitar`,
      true
    );
    return false;
  }

  // 3. Kiểm tra cấu hình HF
  if (!hasHuggingFaceConfig()) {
    await sendMessageWarning(
      api,
      message,
      "Chưa cấu hình HF_TOKEN trong runtime (.env.local), vui lòng liên hệ kỹ thuật.",
      true
    );
    return false;
  }

  // 4. Kiểm tra ảnh đính kèm (nếu người dùng đang reply vào ảnh)
  let referenceBuffer = null;
  let referenceMimeType = null;
  const quote = message?.data?.quote;
  if (quote && (quote.attach || quote.attachment || quote.attachments)) {
    const downloaded = await downloadQuoteAttachment(api, message).catch(() => null);
    if (downloaded) {
      referenceBuffer = downloaded.buffer;
      referenceMimeType = downloaded.mimeType;
    }
  }

  // 5. Sinh ảnh qua HF Inference API (hoàn toàn không mở trình duyệt)
  let generated;
  try {
    generated = await generateAiImageFile({
      prompt: cleanPrompt,
      referenceBuffer,
      referenceMimeType,
    });
  } catch (err) {
    let msg = "Có lỗi xảy ra khi tạo ảnh AI qua Hugging Face.";
    if (err instanceof HfInferenceError) {
      msg = err.message;
    } else if (err?.message) {
      msg = `Lỗi tạo ảnh: ${err.message}`;
    }
    await sendMessageFailed(api, message, msg, true);
    return false;
  }

  // 6. Gửi kết quả
  const caption = customSuccessCaption || `Ảnh đã được tạo theo từ khóa: ${cleanPrompt}`;
  await sendMessageComplete(api, message, caption, true);


  try {
    await api.sendMessage(
      { msg: "", attachments: [generated.filePath], ttl: 3600000 },
      message.threadId,
      message.type
    );
  } finally {
    setTimeout(() => {
      try {
        if (fs.existsSync(generated.filePath)) {
          fs.unlinkSync(generated.filePath);
        }
      } catch {}
    }, 65000).unref?.();
  }

  return true;
}

export const __test = {
  ...__hfTest,
  pickAttachment,
};
