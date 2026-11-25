import axios from "axios";
import { LRUCache } from "lru-cache";
import { GoogleGenAI } from "@google/genai";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageQuery,
  sendMessageStateQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { nameServer } from "../../../utils/server-config.js";
import { removeMention } from "../../../utils/format-util.js";
import {
  generateContentWithModelFallback,
  getModelPriority,
  isRetryableGeminiModelError,
} from "./gemini-models.js";
import {
  executeAiImageWorkflow,
  checkAdminLevelHigh,
} from "./image-generator-hf.js";

const MAX_INLINE_MEDIA_BYTES = 15 * 1024 * 1024;
const chatSessions = new LRUCache({
  max: 500,
  ttl: 30 * 60 * 1000,
});

let currentKeyIndex = 0;
let cachedKeySignature = "";
let cachedKeys = [];
let ai = null;
let geminiModel = null;
let mockGenerateFn = null;

export const MODEL_PRIORITY = getModelPriority();

const IMAGE_REQUEST_START_REGEX =
  /^(?:hãy\s+|vui lòng\s+|hộ\s+|giúp\s+|em\s+)*(?:tạo ảnh|vẽ ảnh|tạo hình|make image|generate image|create image|tao anh|ve anh|tao hinh)\b/i;

const IMAGE_REQUEST_STRIP_REGEX =
  /^(?:hãy\s+|vui lòng\s+|hộ\s+|giúp\s+|em\s+)*(?:tạo ảnh|vẽ ảnh|tạo hình|make image|generate image|create image|tao anh|ve anh|tao hinh)\s*(?:cho\s+tôi|giúp\s+tôi|hộ\s+tôi)?\s*:?\s*/i;

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractGeminiPrompt(message, prefix, aliasCommand) {
  const cleaned = (removeMention(message) || String(message?.data?.content || "")).trim();
  if (!cleaned) return "";
  const normalizedPrefix = String(prefix ?? "");
  const normalizedAlias = String(aliasCommand ?? "").trim();
  if (normalizedAlias) {
    const aliasPattern = normalizedAlias.split(/\s+/).map(escapeRegExp).join("\\s+");
    const cmdRegex = new RegExp(
      `^\\s*${escapeRegExp(normalizedPrefix)}\\s*${aliasPattern}(?:\\s+|$)`,
      "i"
    );
    if (cmdRegex.test(cleaned)) {
      return cleaned.replace(cmdRegex, "").trim();
    }
  }
  return cleaned;
}

function resolveGeminiKeys() {
  const raw = String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "");
  if (raw !== cachedKeySignature) {
    cachedKeySignature = raw;
    cachedKeys = raw
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    currentKeyIndex = 0;
    ai = cachedKeys.length > 0 ? new GoogleGenAI({ apiKey: cachedKeys[0] }) : null;
  }
  return cachedKeys;
}

export function initGeminiModel() {
  if (geminiModel) return;
  const now = new Date();
  const currentTime = now.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  geminiModel = {
    model: MODEL_PRIORITY[0],
    generationConfig: {
      temperature: 0.9,
      topK: 40,
      topP: 0.8,
    },
    systemInstruction: `🌸 Bạn chính là **Aimi** – một cô gái AI thông minh, lễ phép nhưng cá tính, được tạo ra bởi **Thanh Hung**. Thời gian hiện tại: ${currentTime}`,
  };
}

function rotateApiKey(keys) {
  if (!keys.length) return;
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;
  ai = new GoogleGenAI({ apiKey: keys[currentKeyIndex] });
}

export async function callGeminiGenerate(contents) {
  initGeminiModel();
  if (typeof mockGenerateFn === "function") {
    return mockGenerateFn(contents);
  }
  const keys = resolveGeminiKeys();
  if (keys.length === 0 || !ai) {
    const err = new Error("GEMINI_API_KEYS / GEMINI_API_KEY is not configured");
    err.code = "MISSING_GEMINI_KEY";
    throw err;
  }

  let triedKeys = 0;
  while (triedKeys < keys.length) {
    try {
      const { model, response } = await generateContentWithModelFallback(
        MODEL_PRIORITY,
        async (modelName) =>
          ai.models.generateContent({
            model: modelName,
            config: {
              ...geminiModel.generationConfig,
              systemInstruction: geminiModel.systemInstruction,
            },
            contents,
          })
      );
      geminiModel.model = model;
      return response;
    } catch (error) {
      if (!isRetryableGeminiModelError(error)) throw error;
      triedKeys += 1;
      if (triedKeys < keys.length) {
        rotateApiKey(keys);
      } else {
        throw new Error("Không còn key Gemini khả dụng.");
      }
    }
  }
  throw new Error("Không thể kết nối Gemini API.");
}

export function extractQuotedMediaUrl(quote) {
  if (!quote || typeof quote !== "object") return null;
  const rawAttach = quote.attach ?? quote.attachment ?? null;
  if (!rawAttach) return null;

  let parsed = rawAttach;
  if (typeof rawAttach === "string") {
    const trimmed = rawAttach.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(parsed)) {
    parsed = parsed[0] || null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const candidates = [
    parsed.hdUrl,
    parsed.normalUrl,
    parsed.href,
    parsed.url,
    parsed.oriUrl,
    parsed.thumb,
    parsed.thumbUrl,
  ];
  for (const url of candidates) {
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) {
      return url.trim();
    }
  }
  return null;
}

function inferMimeType(headersMime, url, buf) {
  const cleanHeader = String(headersMime || "").split(";")[0].trim().toLowerCase();
  if (cleanHeader && cleanHeader !== "application/octet-stream" && cleanHeader !== "binary/octet-stream") {
    return cleanHeader;
  }
  if (Buffer.isBuffer(buf) && buf.length >= 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
      return "image/webp";
    }
  }
  const lowerUrl = String(url || "").toLowerCase();
  if (lowerUrl.includes(".png")) return "image/png";
  if (lowerUrl.includes(".webp")) return "image/webp";
  if (lowerUrl.includes(".gif")) return "image/gif";
  if (lowerUrl.includes(".mp4")) return "video/mp4";
  if (lowerUrl.includes(".mp3")) return "audio/mp3";
  if (lowerUrl.includes(".m4a") || lowerUrl.includes(".aac")) return "audio/aac";
  return "image/jpeg";
}

async function fetchMediaInlineData(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    timeout: 25000,
    maxContentLength: MAX_INLINE_MEDIA_BYTES,
    maxBodyLength: MAX_INLINE_MEDIA_BYTES,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length > MAX_INLINE_MEDIA_BYTES) {
    const err = new Error("Media không hợp lệ hoặc vượt quá 15MB.");
    err.code = "MEDIA_INVALID";
    throw err;
  }

  const mimeType = inferMimeType(response.headers?.["content-type"], mediaUrl, buffer);
  return {
    data: buffer.toString("base64"),
    mimeType,
  };
}

export async function analyzeQuotedMediaWithGemini(promptText, message) {
  const mediaUrl = extractQuotedMediaUrl(message?.data?.quote);
  if (!mediaUrl) {
    const err = new Error("Không tìm thấy media đính kèm trong tin nhắn được reply.");
    err.code = "MEDIA_MISSING";
    throw err;
  }

  const inlineData = await fetchMediaInlineData(mediaUrl);
  const effectivePrompt =
    String(promptText || "").trim() || "Hãy mô tả và phân tích chi tiết hình ảnh này bằng tiếng Việt.";
  const contents = [
    {
      role: "user",
      parts: [
        { inlineData },
        { text: `${effectivePrompt}\n\n(Trả lời bằng tiếng Việt)` },
      ],
    },
  ];
  const result = await callGeminiGenerate(contents);
  return {
    text: String(result?.text || "").trim(),
  };
}

const requestQueue = [];
let isProcessing = false;
const DELAY_BETWEEN_REQUESTS = 1500;
const MAX_GEMINI_QUEUE = 40;

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;
  try {
    while (requestQueue.length > 0) {
      const { question, userId, resolve, reject } = requestQueue.shift();
      if (!question || question.trim() === "") {
        reject(new Error("empty question"));
        continue;
      }
      try {
        initGeminiModel();
        const session = getChatSession(userId);
        const priorHistory = session.history.slice(-20).map((item) => ({
          role: item.role === "assistant" ? "model" : item.role,
          parts: item.parts,
        }));
        const contents = [
          ...priorHistory,
          { role: "user", parts: [{ text: question }] },
        ];
        const result = await callGeminiGenerate(contents);
        const response = result?.text || "";
        session.lastInteraction = Date.now();
        session.history.push(
          { role: "user", parts: [{ text: question }] },
          { role: "model", parts: [{ text: response }] }
        );
        if (session.history.length > 20) {
          session.history = session.history.slice(-20);
        }
        chatSessions.set(String(userId), session);
        resolve(response);
      } catch (error) {
        reject(error);
      }
      if (requestQueue.length > 0) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUESTS));
      }
    }
  } finally {
    isProcessing = false;
  }
}

function getChatSession(userId) {
  const key = String(userId || "anon");
  let session = chatSessions.get(key);
  if (!session) {
    session = { history: [], lastInteraction: Date.now() };
    chatSessions.set(key, session);
  }
  return session;
}

export async function callGeminiAPI(api, message, question, userId) {
  if (requestQueue.length >= MAX_GEMINI_QUEUE) {
    throw new Error("Hàng đợi Gemini đang đầy, vui lòng thử lại sau ít giây.");
  }
  return new Promise((resolve, reject) => {
    requestQueue.push({ api, message, question, userId, resolve, reject });
    processQueue();
  });
}

export async function askGeminiCommand(api, message, aliasCommand, options = {}) {
  initGeminiModel();
  const userId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  const question = extractGeminiPrompt(message, prefix, aliasCommand || "gemini");
  const hasQuotedMedia = Boolean(extractQuotedMediaUrl(message.data?.quote));
  const isAnalysisAlias = /^(?:analysis-image|analysis)$/i.test(String(aliasCommand || "").trim());

  if (isAnalysisAlias && !hasQuotedMedia) {
    await sendMessageQuery(
      api,
      message,
      `Vui lòng reply (trả lời) vào hình ảnh hoặc media cần phân tích!\nVí dụ: Reply ảnh + ${prefix}${aliasCommand || "analysis-image"} [câu hỏi tùy chọn]`
    );
    return;
  }

  if (question === "" && !hasQuotedMedia) {
    await sendMessageQuery(api, message, "Vui lòng nhập câu hỏi cần giải đáp!");
    return;
  }

  if (question.toLowerCase() === "reset") {
    chatSessions.delete(String(userId));
    await sendMessageComplete(api, message, "Đã xóa lịch sử cuộc trò chuyện của bạn!", false);
    return;
  }

  const isImageRequest = IMAGE_REQUEST_START_REGEX.test(question);
  if (isImageRequest) {
    const isAdmin = Boolean(options?.isAdminLevelHighest) || checkAdminLevelHigh(message, options, api);
    if (!isAdmin) {
      await sendMessageFailed(
        api,
        message,
        `⚠️ ${senderName ? `${senderName}, ` : ""}tính năng tạo ảnh AI chỉ dành riêng cho Admin tối cao (Quản trị viên cấp cao).`,
        true
      );
      return;
    }
    const cleanPrompt = question.replace(IMAGE_REQUEST_STRIP_REGEX, "").trim() || question;

    return executeAiImageWorkflow({
      api,
      message,
      prompt: cleanPrompt,
      aliasCommand,
      isAdminLevelHighest: true,
      mode: "photo",
      customSuccessCaption: `Ảnh đã được tạo theo yêu cầu: ${cleanPrompt}`,
    });
  }

  if (resolveGeminiKeys().length === 0 && typeof mockGenerateFn !== "function") {
    await sendMessageFailed(api, message, "Chưa cấu hình GEMINI_API_KEYS hoặc GEMINI_API_KEY.", true);
    return;
  }

  if (hasQuotedMedia) {
    try {
      const r = await analyzeQuotedMediaWithGemini(
        question || "Hãy mô tả và phân tích chi tiết hình ảnh này bằng tiếng Việt.",
        message
      );
      await sendMessageComplete(api, message, (r.text || "").replace(/\*\*/g, "").trim(), false);
      return;
    } catch (err) {
      const userMsg =
        err?.code === "MEDIA_INVALID"
          ? "Media không hợp lệ hoặc vượt quá 15MB."
          : "Không thể phân tích ảnh qua Gemini API.";
      await sendMessageFailed(api, message, userMsg, true);
      return;
    }
  }

  try {
    const replyText = await callGeminiAPI(api, message, `${senderName}: ${question}`, userId);
    await sendMessageStateQuote(api, message, replyText || "", true, 1800000, false);
  } catch {
    await sendMessageFailed(api, message, "Xin lỗi, có lỗi xảy ra khi xử lý yêu cầu.", true);
  }
}

export async function chatGeminiHandle(api, message, aliasCommand = null) {
  return askGeminiCommand(api, message, aliasCommand || "gemini");
}

export async function viewChatHistory(api, message) {
  const userId = String(message.senderID || message?.data?.uidFrom || "");
  const session = chatSessions.get(userId);
  if (!session || session.history.length === 0) {
    await sendMessageComplete(api, message, "Bạn chưa có lịch sử trò chuyện.", false);
    return;
  }
  const history = session.history
    .map((msg, index) => {
      const role = msg.role === "user" ? "Bạn" : nameServer;
      return `${index + 1}. ${role}: ${msg.parts[0].text}`;
    })
    .join("\n\n");
  await sendMessageComplete(api, message, `Lịch sử trò chuyện:\n\n${history}`, false);
}

export const __test = {
  setMockGenerateForTests(fn) {
    mockGenerateFn = fn;
  },
  clearSessions() {
    chatSessions.clear();
  },
};
