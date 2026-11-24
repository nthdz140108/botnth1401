import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_DELAY_MS = 250;

export const PROVIDER_ERROR_CODES = Object.freeze({
  MISSING_CONFIGURATION: "PROVIDER_MISSING_CONFIGURATION",
  TIMEOUT: "PROVIDER_TIMEOUT",
  INVALID_RESPONSE: "PROVIDER_INVALID_RESPONSE",
  RATE_LIMIT: "PROVIDER_RATE_LIMIT",
  UNSUPPORTED_URL: "PROVIDER_UNSUPPORTED_URL",
  MEDIA_SIZE_LIMIT: "PROVIDER_MEDIA_SIZE_LIMIT",
  NETWORK_ERROR: "PROVIDER_NETWORK_ERROR",
});

export function createProviderError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = details.status || inferStatus(code);
  error.retryable = details.retryable ?? isRetryableCode(code);
  if (details.provider) error.provider = details.provider;
  if (details.correlationId) error.correlationId = details.correlationId;
  if (details.url) error.url = sanitizeUrl(details.url);
  if (details.cause) error.cause = details.cause;
  if (details.expected !== undefined) error.expected = details.expected;
  if (details.received !== undefined) error.received = details.received;
  return error;
}

export function normalizeProviderFailure(error, provider, correlationId) {
  if (!error) {
    return createProviderError(PROVIDER_ERROR_CODES.INVALID_RESPONSE, "Provider returned an empty error", { provider, correlationId });
  }
  if (error.code && String(error.code).startsWith("PROVIDER_")) {
    return attachContext(error, provider, correlationId);
  }
  if (error.name === "AbortError" || error.code === "ETIMEDOUT" || /\btimeout\b|\btimed out\b/i.test(error.message || "")) {
    return createProviderError(PROVIDER_ERROR_CODES.TIMEOUT, providerMessage(provider, "provider timeout"), { provider, correlationId, cause: error });
  }
  if (error.status === 429 || error.response?.status === 429) {
    return createProviderError(PROVIDER_ERROR_CODES.RATE_LIMIT, providerMessage(provider, "provider rate limited"), { provider, correlationId, status: 429, cause: error });
  }
  if (error.code === "ERR_INVALID_URL" || /unsupported url/i.test(error.message || "")) {
    return createProviderError(PROVIDER_ERROR_CODES.UNSUPPORTED_URL, providerMessage(provider, "unsupported URL"), { provider, correlationId, cause: error });
  }
  return createProviderError(PROVIDER_ERROR_CODES.NETWORK_ERROR, providerMessage(provider, "provider request failed"), { provider, correlationId, cause: error });
}

export async function withProviderRetry(operation, options = {}) {
  const {
    retries = 2,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    provider = "unknown",
    correlationId = null,
    shouldRetry = (error) => Boolean(error?.retryable),
    onAttempt = null,
  } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      onAttempt?.({ attempt: attempt + 1, retries: retries + 1, provider, correlationId });
      return await withTimeout(operation, timeoutMs);
    } catch (error) {
      lastError = normalizeProviderFailure(error, provider, correlationId);
      if (attempt >= retries || !shouldRetry(lastError)) throw lastError;
      await delay(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError || createProviderError(PROVIDER_ERROR_CODES.NETWORK_ERROR, "Provider request failed", { provider, correlationId });
}

export async function withTimeout(operation, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && /\btimeout\b|\btimed out\b/i.test(String(error?.message || error?.cause?.message || ""))) {
      throw createProviderError(PROVIDER_ERROR_CODES.TIMEOUT, "Provider timeout", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  return parseResponseJson(response, { url, provider: options.provider, correlationId: options.correlationId });
}

export async function parseResponseJson(response, context = {}) {
  const { url = null, provider = "unknown", correlationId = null } = context;
  if (!response || typeof response.ok !== "boolean") {
    throw createProviderError(PROVIDER_ERROR_CODES.INVALID_RESPONSE, providerMessage(provider, "invalid response object"), { provider, correlationId, url });
  }
  if (response.status === 429) {
    throw createProviderError(PROVIDER_ERROR_CODES.RATE_LIMIT, providerMessage(provider, "provider rate limited"), { provider, correlationId, status: 429, url });
  }
  if (!response.ok) {
    throw createProviderError(PROVIDER_ERROR_CODES.INVALID_RESPONSE, providerMessage(provider, `provider responded with ${response.status}`), { provider, correlationId, status: response.status, url });
  }
  try {
    return await response.json();
  } catch (error) {
    throw createProviderError(PROVIDER_ERROR_CODES.INVALID_RESPONSE, providerMessage(provider, "provider returned malformed JSON"), { provider, correlationId, status: response.status, url, cause: error });
  }
}

export async function downloadToFile(url, filePath, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw createProviderError(response.status === 429 ? PROVIDER_ERROR_CODES.RATE_LIMIT : PROVIDER_ERROR_CODES.INVALID_RESPONSE, `Failed to download ${sanitizeUrl(url)}`, {
      provider: options.provider,
      correlationId: options.correlationId,
      status: response.status,
      url,
    });
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (options.maxBytes && buffer.byteLength > options.maxBytes) {
    throw createProviderError(PROVIDER_ERROR_CODES.MEDIA_SIZE_LIMIT, `Media exceeds limit of ${options.maxBytes} bytes`, {
      provider: options.provider,
      correlationId: options.correlationId,
      url,
      received: buffer.byteLength,
      expected: options.maxBytes,
    });
  }
  await fs.writeFile(filePath, buffer);
  return { filePath, bytesWritten: buffer.byteLength };
}

export async function uploadAttachment(api, files, threadId, type, options = {}) {
  if (!api?.uploadAttachment) {
    throw createProviderError(PROVIDER_ERROR_CODES.MISSING_CONFIGURATION, "Missing uploadAttachment adapter", {
      provider: options.provider,
      correlationId: options.correlationId,
    });
  }
  return api.uploadAttachment(files, threadId, type);
}

export async function cleanupTempFiles(paths, options = {}) {
  const uniquePaths = [...new Set((paths || []).filter((value) => typeof value === "string" && value.trim()))];
  const results = [];
  for (const tempPath of uniquePaths) {
    try {
      await fs.rm(tempPath, { force: true, recursive: true });
      results.push({ path: tempPath, deleted: true });
    } catch (error) {
      results.push({ path: tempPath, deleted: false, error: error.message });
    }
  }
  return { provider: options.provider || "unknown", correlationId: options.correlationId || null, results };
}

export function sanitizeUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("?")[0].split("#")[0];
  }
}

function providerMessage(provider, message) {
  return provider && provider !== "unknown" ? `${provider}: ${message}` : message;
}

function inferStatus(code) {
  switch (code) {
    case PROVIDER_ERROR_CODES.MISSING_CONFIGURATION:
      return 400;
    case PROVIDER_ERROR_CODES.TIMEOUT:
      return 504;
    case PROVIDER_ERROR_CODES.RATE_LIMIT:
      return 429;
    case PROVIDER_ERROR_CODES.UNSUPPORTED_URL:
      return 422;
    case PROVIDER_ERROR_CODES.MEDIA_SIZE_LIMIT:
      return 413;
    case PROVIDER_ERROR_CODES.INVALID_RESPONSE:
    case PROVIDER_ERROR_CODES.NETWORK_ERROR:
    default:
      return 502;
  }
}

function isRetryableCode(code) {
  return [PROVIDER_ERROR_CODES.TIMEOUT, PROVIDER_ERROR_CODES.RATE_LIMIT, PROVIDER_ERROR_CODES.NETWORK_ERROR].includes(code);
}

function attachContext(error, provider, correlationId) {
  if (provider && !error.provider) error.provider = provider;
  if (correlationId && !error.correlationId) error.correlationId = correlationId;
  if (!error.status) error.status = inferStatus(error.code);
  if (typeof error.retryable !== "boolean") error.retryable = isRetryableCode(error.code);
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
