import { downloadFirstValidCandidate } from "../sticker-media.js";

const MAX_BYTES = 50 * 1024 * 1024;
const RETRY_DELAYS_MS = [500, 1000];
const RETRYABLE_NET_ERRORS = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url ?? "").trim());
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

function shouldRetryStatus(status) {
  return RETRYABLE_HTTP_STATUSES.has(Number(status));
}

function shouldRetryError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  if (RETRYABLE_NET_ERRORS.has(code)) return true;
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("fetch failed") || message.includes("network")) return true;
  if (message.includes("aborted")) return true;
  return false;
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithLimit(url, options = {}) {
  const { timeoutMs = 15000, fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response?.ok) {
      const status = Number(response?.status ?? 0);
      const err = new Error(`HTTP ${status || "unknown"}`);
      err.code = status ? `HTTP_${status}` : "HTTP_UNKNOWN";
      throw err;
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        const err = new Error("File vượt 50 MiB");
        err.code = "SIZE_LIMIT";
        throw err;
      }
      return buffer;
    }
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        controller.abort();
        const err = new Error("File vượt 50 MiB");
        err.code = "SIZE_LIMIT";
        throw err;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCandidateWithRetry(candidate, options) {
  const { fetchImpl, sleep: sleepFn = sleep, fileTypeFromBuffer, tempDir, writeFile, mkdir } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const buffer = await fetchWithLimit(candidate.url, {
        fetchImpl,
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs,
      });
      return { buffer, source: candidate, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const status = Number(error?.code?.replace?.("HTTP_", "") ?? 0);
      const retriable = error?.code === "SIZE_LIMIT"
        ? false
        : status
          ? shouldRetryStatus(status)
          : shouldRetryError(error);
      if (!retriable || attempt >= RETRY_DELAYS_MS.length) break;
      await sleepFn(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError || new Error("Không tải được media");
}

async function writeCandidateBuffer({ buffer, source, options }) {
  const { fileTypeFromBuffer, tempDir, writeFile, mkdir, createId, now } = options;
  const detected = await fileTypeFromBuffer(buffer).catch(() => null);
  const mime = String(detected?.mime ?? "").toLowerCase();
  if (!mime || (!mime.startsWith("image/") && !mime.startsWith("video/"))) {
    throw new Error(`MIME không hợp lệ: ${mime || "unknown"}`);
  }
  const ext = detected?.ext ? `.${detected.ext.toLowerCase()}` : ".bin";
  await mkdir(tempDir, { recursive: true });
  const filename = `sticker_source_${now?.() ?? Date.now()}_${createId?.() ?? Math.random().toString(36).slice(2)}.${ext.replace(/^\./, "")}`;
  const filePath = `${tempDir}/${filename}`;
  await writeFile(filePath, buffer);
  return {
    filePath,
    mediaType: mime,
    source: source?.source ?? "unknown",
    url: source?.url,
  };
}

export async function downloadWithRetry(candidates, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    fileTypeFromBuffer,
    tempDir,
    writeFile = (await import("node:fs")).promises.writeFile,
    mkdir = (await import("node:fs")).promises.mkdir,
    createId,
    now,
    timeoutMs = 15000,
    maxBytes = MAX_BYTES,
  } = options;

  if (!tempDir) {
    throw new Error("Thiếu thư mục tạm");
  }

  const list = Array.isArray(candidates) ? candidates : [candidates];
  let lastError = null;
  for (const candidate of list) {
    if (!isHttpUrl(candidate?.url)) continue;
    try {
      const { buffer, source } = await fetchCandidateWithRetry(candidate, {
        fetchImpl,
        timeoutMs,
        maxBytes,
      });
      return await writeCandidateBuffer({
        buffer,
        source,
        options: { fileTypeFromBuffer, tempDir, writeFile, mkdir, createId, now },
      });
    } catch (error) {
      lastError = error;
      console.error(
        `Bỏ qua candidate media ${sanitizeCandidateForLog(candidate)}: ${error?.message ?? error}`
      );
    }
  }
  throw lastError || new Error("Không tải được media từ bất kỳ URL nào");
}

export async function downloadViaStickerMedia(candidates, options = {}) {
  return downloadFirstValidCandidate(candidates, options);
}

export const __test = {
  MAX_BYTES,
  RETRY_DELAYS_MS,
  shouldRetryError,
  shouldRetryStatus,
};
