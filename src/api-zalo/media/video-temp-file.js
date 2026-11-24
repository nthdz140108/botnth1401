import fs from "fs";
import path from "path";
import https from "https";
import { randomUUID } from "crypto";
import axios from "axios";
import { tempDir } from "../../utils/io-json.js";

export const DOWNLOAD_TIMEOUT_MS = 120000;
export const MAX_DOWNLOAD_ATTEMPTS = 3;
export const RETRY_BASE_DELAYS_MS = [1000, 2000];
export const DEFAULT_HOST_SPACING_MS = 500;
export const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNABORTED",
]);

export class TemporaryFileCleanupError extends Error {
  constructor(filePath, lastError) {
    super(`Failed to clean up temporary file: ${filePath}`);
    this.name = "TemporaryFileCleanupError";
    this.filePath = filePath;
    this.cause = lastError;
  }
}

export class VideoDownloadError extends Error {
  constructor(
    message,
    {
      status = null,
      url = "",
      hostname = "",
      retryAfterMs = null,
      code = null,
      cause = null,
    } = {}
  ) {
    super(message);
    this.name = "VideoDownloadError";
    this.status = status;
    this.url = url;
    this.hostname = hostname;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
    this.cause = cause;
  }
}

export function extractHostname(urlStr) {
  if (typeof urlStr !== "string" || !urlStr.trim()) return "";
  try {
    const parsed = new URL(urlStr.trim());
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function parseRetryAfter(headerValue, now = Date.now()) {
  if (!headerValue) return null;
  const str = String(headerValue).trim();
  if (/^\d+$/.test(str)) {
    const seconds = parseInt(str, 10);
    return Math.max(0, seconds * 1000);
  }
  const parsedDate = Date.parse(str);
  if (!isNaN(parsedDate)) {
    return Math.max(0, parsedDate - now);
  }
  return null;
}

export function isRetryableHttpOrNetworkError(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 404 || status === 429) return false;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  if (error?.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;
  return /timeout/i.test(error?.message || "");
}

export class HostnameLimiter {
  constructor({
    maxConcurrent = 1,
    minSpacingMs = DEFAULT_HOST_SPACING_MS,
    clock = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.minSpacingMs = minSpacingMs;
    this.clock = clock;
    this.sleep = sleep;
    this.activePerHost = new Map();
    this.queuesPerHost = new Map();
    this.lastRequestPerHost = new Map();
  }

  async acquire(hostname) {
    if (!hostname) return () => {};
    const host = hostname.toLowerCase();

    while ((this.activePerHost.get(host) || 0) >= this.maxConcurrent) {
      if (!this.queuesPerHost.has(host)) {
        this.queuesPerHost.set(host, []);
      }
      await new Promise((resolve) => {
        this.queuesPerHost.get(host).push(resolve);
      });
    }

    const currentActive = (this.activePerHost.get(host) || 0) + 1;
    this.activePerHost.set(host, currentActive);

    const lastTime = this.lastRequestPerHost.get(host) || 0;
    const now = this.clock();
    const elapsed = now - lastTime;
    if (elapsed < this.minSpacingMs) {
      await this.sleep(this.minSpacingMs - elapsed);
    }
    this.lastRequestPerHost.set(host, this.clock());

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = Math.max(0, (this.activePerHost.get(host) || 1) - 1);
      if (count === 0) {
        this.activePerHost.delete(host);
      } else {
        this.activePerHost.set(host, count);
      }
      const queue = this.queuesPerHost.get(host);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        if (queue.length === 0) this.queuesPerHost.delete(host);
        next();
      }
    };
  }

  async schedule(hostname, task) {
    const release = await this.acquire(hostname);
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export const defaultHostnameLimiter = new HostnameLimiter();

function ensureTempDir() {
  fs.mkdirSync(tempDir, { recursive: true });
}

export function createTempVideoPaths(prefix = "video") {
  ensureTempDir();
  const baseName = `${prefix}_${randomUUID()}`;
  return {
    partPath: path.join(tempDir, `${baseName}.part`),
    finalPath: path.join(tempDir, `${baseName}.mp4`),
  };
}

export function calculateBackoffWithJitter(attemptIndex, baseDelays = RETRY_BASE_DELAYS_MS) {
  const base = baseDelays[attemptIndex] ?? baseDelays[baseDelays.length - 1] ?? 1000;
  const jitter = Math.floor(Math.random() * 200); // 0-200ms jitter
  return base + jitter;
}

export async function downloadVideoToTempFile(
  videoUrl,
  {
    axiosImpl = axios,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    limiter = defaultHostnameLimiter,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clockFn = Date.now,
  } = {}
) {
  const hostname = extractHostname(videoUrl);
  const { partPath, finalPath } = createTempVideoPaths("video");
  const client = axiosImpl?.request ? axiosImpl : axios;
  const agent = typeof videoUrl === "string" && videoUrl.startsWith("https:")
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  const downloadTask = async () => {
    let lastError;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const requestFn = client.request ? client.request.bind(client) : client;
        const response = await requestFn({
          method: "GET",
          url: videoUrl,
          responseType: "stream",
          timeout: timeoutMs,
          httpsAgent: agent,
          maxRedirects: 5,
          validateStatus: () => true,
        });

        const status = response?.status;
        if (status >= 400) {
          const retryAfterHeader = response?.headers?.["retry-after"];
          const retryAfterMs = parseRetryAfter(retryAfterHeader, clockFn());
          const httpErr = new VideoDownloadError(
            `HTTP ${status} while downloading video`,
            {
              status,
              url: videoUrl,
              hostname,
              retryAfterMs,
            }
          );
          throw httpErr;
        }

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(partPath);
          const cleanup = (error) => {
            response?.data?.destroy?.();
            writer.destroy();
            reject(error);
          };

          response?.data?.on?.("error", cleanup);
          writer.on("error", cleanup);
          writer.on("finish", resolve);
          response?.data?.pipe?.(writer);
        });

        fs.renameSync(partPath, finalPath);
        return finalPath;
      } catch (error) {
        lastError = error instanceof VideoDownloadError
          ? error
          : new VideoDownloadError(
              error?.message || "Error downloading video",
              {
                status: error?.response?.status ?? error?.status ?? null,
                url: videoUrl,
                hostname,
                code: error?.code ?? null,
                cause: error,
              }
            );

        if (fs.existsSync(partPath)) {
          try {
            fs.unlinkSync(partPath);
          } catch {}
        }

        if (!isRetryableHttpOrNetworkError(lastError) || attempt === MAX_DOWNLOAD_ATTEMPTS) {
          break;
        }

        const delay = calculateBackoffWithJitter(attempt - 1);
        await sleepFn(delay);
      }
    }

    throw lastError;
  };

  if (limiter && hostname) {
    return await limiter.schedule(hostname, downloadTask);
  } else {
    return await downloadTask();
  }
}

export async function removeTemporaryFile(filePath, { fsImpl = fs } = {}) {
  if (!filePath) return;
  try {
    await fsImpl.promises.unlink(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);
    if (!retryable.has(error?.code)) throw error;

    const delays = [0, 100, 250, 500, 1000, 2000];
    let lastError = error;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise((resolve) => setTimeout(resolve, delays[i]));
      try {
        await fsImpl.promises.unlink(filePath);
        lastError = null;
        break;
      } catch (retryError) {
        if (retryError?.code === "ENOENT") return;
        lastError = retryError;
        if (!retryable.has(retryError?.code)) throw retryError;
      }
    }
    if (lastError) throw new TemporaryFileCleanupError(filePath, lastError);
  }

  try {
    await fsImpl.promises.access(filePath);
    throw new TemporaryFileCleanupError(filePath, new Error("temporary file still exists after cleanup"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
