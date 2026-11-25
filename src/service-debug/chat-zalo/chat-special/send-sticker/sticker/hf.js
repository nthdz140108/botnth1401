/**
 * Hugging Face Inference API Adapter for Sticker & AI Image Commands
 *
 * Provides resilient calls with:
 * - Dynamic HF_TOKEN reload without process restart
 * - Max 2 attempts total (1 initial + at most 1 retry)
 * - Retries only on network errors, 429, 503, respecting Retry-After
 * - Output byte validation (ensures valid image bytes, not JSON or HTML errors)
 * - Mode-aware I2I -> T2I fallback ("sticker" vs "photo")
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { InferenceClient } from "@huggingface/inference";
import { fileTypeFromBuffer } from "file-type";

export const DEFAULT_T2I_MODEL = "stabilityai/stable-diffusion-xl-base-1.0";
export const FALLBACK_T2I_MODEL = "black-forest-labs/FLUX.1-schnell";
export const DEFAULT_I2I_MODEL = "stabilityai/stable-diffusion-xl-refiner-1.0";
export const DEFAULT_PROVIDER = "hf-inference";
export const DEFAULT_TIMEOUT_MS = 90000;

const hfFallbackStorage = new AsyncLocalStorage();

export function runWithHfFallbackTracker(fn) {
  const state = { usedT2iFallback: false, reason: null };
  return hfFallbackStorage.run(state, () => fn(state));
}

export function getHfFallbackState() {
  return hfFallbackStorage.getStore() || null;
}

export class HfInferenceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "HfInferenceError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }
}

export function getHuggingFaceConfig() {
  const token = process.env.HF_TOKEN ? String(process.env.HF_TOKEN).trim() : "";
  const t2iModel = process.env.HF_STICKER_T2I_MODEL ? String(process.env.HF_STICKER_T2I_MODEL).trim() : DEFAULT_T2I_MODEL;
  const i2iModel = process.env.HF_STICKER_I2I_MODEL ? String(process.env.HF_STICKER_I2I_MODEL).trim() : DEFAULT_I2I_MODEL;
  const provider = process.env.HF_STICKER_PROVIDER ? String(process.env.HF_STICKER_PROVIDER).trim() : DEFAULT_PROVIDER;
  const timeoutRaw = process.env.HF_STICKER_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) > 0
    ? Number(timeoutRaw)
    : DEFAULT_TIMEOUT_MS;

  return {
    token,
    t2iModel,
    i2iModel,
    provider,
    timeoutMs,
    enabled: Boolean(token),
  };
}

export function hasHuggingFaceConfig() {
  const cfg = getHuggingFaceConfig();
  return cfg.enabled;
}

let sharedClient = null;
let sharedClientSignature = "";
let isMockClient = false;

export function getInferenceClient() {
  if (isMockClient && sharedClient) {
    return sharedClient;
  }
  const cfg = getHuggingFaceConfig();
  if (!cfg.token) {
    throw new HfInferenceError("HF_CONFIG_MISSING", "Thiếu HF_TOKEN trong cấu hình (.env.local)");
  }
  const effectiveProvider = cfg.provider && cfg.provider !== "auto" ? cfg.provider : "hf-inference";
  const nextSignature = `${cfg.token}::${effectiveProvider}`;
  if (sharedClient && sharedClientSignature === nextSignature) {
    return sharedClient;
  }
  sharedClient = new InferenceClient(cfg.token, { defaultProvider: effectiveProvider });
  sharedClientSignature = nextSignature;
  return sharedClient;
}

export function setMockClientForTests(client) {
  sharedClient = client;
  isMockClient = Boolean(client);
  sharedClientSignature = "";
}

export function resetSharedClientForTests() {
  sharedClient = null;
  isMockClient = false;
  sharedClientSignature = "";
}

export async function validateImageBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HfInferenceError("HF_INVALID_RESPONSE", "Hugging Face không trả về dữ liệu ảnh");
  }

  const firstByte = buffer[0];
  if (firstByte === 0x7B /* { */ || firstByte === 0x3C /* < */) {
    const textPreview = buffer.slice(0, 500).toString("utf8");
    try {
      const parsed = JSON.parse(textPreview);
      const msg = parsed.error || parsed.message || "Lỗi phản hồi JSON từ Hugging Face";
      throw new HfInferenceError("HF_INVALID_RESPONSE", `HF trả về JSON: ${msg}`);
    } catch (e) {
      if (e instanceof HfInferenceError) throw e;
      if (textPreview.includes("<html") || textPreview.includes("<!DOCTYPE")) {
        throw new HfInferenceError("HF_INVALID_RESPONSE", "HF trả về trang HTML thay vì ảnh");
      }
    }
  }

  const type = await fileTypeFromBuffer(buffer).catch(() => null);
  const mime = type?.mime || "";
  if (mime.startsWith("image/")) {
    return { buffer, mimeType: mime };
  }

  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { buffer, mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { buffer, mimeType: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { buffer, mimeType: "image/webp" };
  }

  throw new HfInferenceError("HF_INVALID_RESPONSE", `Dữ liệu nhận được không phải là ảnh hợp lệ (MIME: ${mime || "unknown"})`);
}

function parseRetryAfter(err) {
  const headers = err?.response?.headers;
  if (!headers) return null;
  const raw = typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(10, seconds);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    const diff = Math.max(0, (date - Date.now()) / 1000);
    return Math.min(10, diff);
  }
  return null;
}

function isRetryableError(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 429 || status === 503) return true;
  const msg = String(err?.message || "").toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("503") || msg.includes("service unavailable")) {
    return true;
  }
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    err?.name === "AbortError"
  ) {
    return true;
  }
  return false;
}

function classifyHfError(err) {
  if (!err) return new HfInferenceError("HF_ERROR", "Lỗi không xác định từ Hugging Face");
  if (err instanceof HfInferenceError) return err;

  const status = err.status || err.statusCode || err.response?.status;
  const retryAfter = parseRetryAfter(err);
  const msgLower = String(err.message || "").toLowerCase();

  if (
    status === 402 ||
    msgLower.includes("payment required") ||
    msgLower.includes("subscription required") ||
    msgLower.includes("insufficient balance") ||
    msgLower.includes("does not have access to provider") ||
    msgLower.includes("requires a pro subscription")
  ) {
    return new HfInferenceError("HF_PAID_MODEL_ERROR", "Model hoặc provider yêu cầu nạp tiền/trả phí. Hệ thống chỉ hỗ trợ model miễn phí.", { cause: err, status });
  }
  if (status === 401 || status === 403) {
    return new HfInferenceError("HF_UNAUTHENTICATED", "HF_TOKEN không hợp lệ hoặc thiếu quyền truy cập inference provider", { cause: err, status });
  }
  if (status === 429) {
    return new HfInferenceError("HF_RATE_LIMIT", "Hugging Face bị giới hạn tần suất (429 Rate Limit)", { cause: err, status, retryAfter });
  }
  if (status === 503) {
    return new HfInferenceError("HF_SERVICE_UNAVAILABLE", "Hugging Face service đang bận hoặc model đang khởi động (503)", { cause: err, status, retryAfter });
  }
  if (err.name === "AbortError" || msgLower.includes("timeout")) {
    return new HfInferenceError("HF_TIMEOUT", "Hết thời gian chờ Hugging Face phản hồi (timeout)", { cause: err, status });
  }

  return new HfInferenceError("HF_ERROR", err.message || "Lỗi Hugging Face Inference", { cause: err, status, retryAfter });
}

async function runTextToImageOnce(client, { model, inputs, provider, timeoutMs }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("HF request timeout")), timeoutMs);
  try {
    const rawRes = await client.textToImage(
      {
        model,
        inputs,
        ...(provider ? { provider } : {}),
      },
      {
        signal: controller.signal,
        ...(provider ? { provider } : {}),
      },
    );
    let buf = null;
    if (rawRes && typeof rawRes.arrayBuffer === "function") {
      buf = Buffer.from(await rawRes.arrayBuffer());
    } else if (Buffer.isBuffer(rawRes)) {
      buf = rawRes;
    } else if (rawRes instanceof ArrayBuffer) {
      buf = Buffer.from(rawRes);
    }
    if (!buf) {
      throw new HfInferenceError("HF_INVALID_RESPONSE", "Hugging Face không trả về dữ liệu ảnh hợp lệ");
    }
    const validated = await validateImageBuffer(buf);
    return {
      imageBuffer: validated.buffer,
      mimeType: validated.mimeType || "image/png",
      provider: provider || "hf-inference",
      model,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateStickerImageHF({
  prompt,
  referenceBuffer,
  referenceMimeType,
  mode = "sticker",
}) {
  const cfg = getHuggingFaceConfig();
  if (!cfg.enabled) {
    throw new HfInferenceError("HF_CONFIG_MISSING", "Chưa cấu hình HF_TOKEN trong runtime (.env.local)");
  }

  const client = getInferenceClient();
  const isImageToImage = Boolean(referenceBuffer && referenceBuffer.length > 0);
  const targetModel = isImageToImage ? cfg.i2iModel : cfg.t2iModel;
  const provider = cfg.provider && cfg.provider !== "auto" ? cfg.provider : undefined;

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error("HF request timeout")), cfg.timeoutMs);

    try {
      let rawResult;
      const requestOptions = {
        signal: controller.signal,
        ...(provider ? { provider } : {}),
      };

      if (isImageToImage) {
        const inputBlob = new Blob([referenceBuffer], { type: referenceMimeType || "image/png" });
        rawResult = await client.imageToImage(
          {
            model: targetModel,
            inputs: inputBlob,
            parameters: {
              prompt: String(prompt || ""),
            },
            ...(provider ? { provider } : {}),
          },
          requestOptions
        );
      } else {
        rawResult = await client.textToImage(
          {
            model: targetModel,
            inputs: String(prompt || ""),
            ...(provider ? { provider } : {}),
          },
          requestOptions
        );
      }

      clearTimeout(timeoutId);

      let buffer;
      let mimeType = "image/png";
      if (rawResult && typeof rawResult.arrayBuffer === "function") {
        const ab = await rawResult.arrayBuffer();
        buffer = Buffer.from(ab);
        if (rawResult.type) mimeType = rawResult.type;
      } else if (Buffer.isBuffer(rawResult)) {
        buffer = rawResult;
      } else if (rawResult instanceof ArrayBuffer) {
        buffer = Buffer.from(rawResult);
      } else {
        throw new HfInferenceError("HF_INVALID_RESPONSE", "Hugging Face không trả về dữ liệu ảnh hợp lệ");
      }

      const validated = await validateImageBuffer(buffer);

      return {
        imageBuffer: validated.buffer,
        mimeType: validated.mimeType || mimeType,
        provider: provider || "hf-inference",
        model: targetModel,
        usedT2iFallback: false,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const classified = classifyHfError(err);
      lastError = classified;

      if (attempt === 1 && isRetryableError(err)) {
        const waitSec = classified.retryAfter ?? 1.5;
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }

      if (
        isImageToImage &&
        (classified.code === "HF_PAID_MODEL_ERROR" ||
          classified.code === "HF_UNAUTHENTICATED" ||
          classified.code === "HF_TIMEOUT" ||
          classified.status === 404 ||
          classified.status === 410 ||
          classified.status === 400)
      ) {
        const trimmedPrompt = String(prompt || "").trim();
        const fallbackPrompt =
          mode === "photo"
            ? trimmedPrompt || "High quality detailed illustration"
            : trimmedPrompt
              ? `Chibi sticker, cute, white border, ${trimmedPrompt}`
              : "Chibi sticker, cute, high quality, white border, transparent background";

        const candidateModels = [cfg.t2iModel];
        if (!process.env.HF_STICKER_T2I_MODEL && cfg.t2iModel !== FALLBACK_T2I_MODEL) {
          candidateModels.push(FALLBACK_T2I_MODEL);
        }
        for (const candidateModel of candidateModels) {
          try {
            const fallbackResult = await runTextToImageOnce(client, {
              model: candidateModel,
              inputs: fallbackPrompt,
              provider,
              timeoutMs: cfg.timeoutMs,
            });
            const tracker = hfFallbackStorage.getStore();
            if (tracker) {
              tracker.usedT2iFallback = true;
              tracker.reason = classified.code;
            }
            return {
              ...fallbackResult,
              usedT2iFallback: true,
            };
          } catch {
            // Try next fallback model or surface original error
          }
        }
      }

      if (
        !isImageToImage &&
        !process.env.HF_STICKER_T2I_MODEL &&
        targetModel !== FALLBACK_T2I_MODEL &&
        (classified.status === 404 || classified.status === 410)
      ) {
        try {
          const t2iFallback = await runTextToImageOnce(client, {
            model: FALLBACK_T2I_MODEL,
            inputs: String(prompt || ""),
            provider,
            timeoutMs: cfg.timeoutMs,
          });
          return {
            ...t2iFallback,
            usedT2iFallback: false,
          };
        } catch {
          // Surface original classified error
        }
      }

      throw classified;
    }
  }

  throw lastError;
}

export const __test = {
  isRetryableError,
  parseRetryAfter,
  classifyHfError,
  validateImageBuffer,
  setMockClientForTests,
  resetSharedClientForTests,
};
