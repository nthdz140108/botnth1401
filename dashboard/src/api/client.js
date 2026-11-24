import { clearDashboardSession, getDashboardCsrfToken } from "../app/session.js";

const SECRET_KEY = /(?:pass(word)?|secret|token|cookie|credential|api[-_]?key|auth(?:orization)?)/i;
const COOKIE_JAR_KEY = /^(?:raw)?cookies?$/i;

function redactFieldValue(key, item) {
  if (typeof item === "boolean" || item === null || item === undefined) return item;
  if (Array.isArray(item)) {
    return COOKIE_JAR_KEY.test(key) ? "[REDACTED]" : item.map((entry) => redactSecrets(entry));
  }
  if (typeof item === "object") {
    return COOKIE_JAR_KEY.test(key) ? "[REDACTED]" : redactSecrets(item);
  }
  return SECRET_KEY.test(key) ? "[REDACTED]" : item;
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactFieldValue(key, item)]));
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { data: text }; }
}

function isMutatingMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "GET").toUpperCase());
}

/** Fetch an API endpoint and return the dashboard's normalized response envelope. */
export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const requestId = headers.get("X-Request-ID") || makeRequestId();
  headers.set("X-Request-ID", requestId);
  if (isMutatingMethod(options.method) && !headers.has("X-CSRF-Token")) {
    const csrfToken = getDashboardCsrfToken();
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  let requestBody = options.body;
  if (requestBody && typeof requestBody === "object" && !(requestBody instanceof ArrayBuffer) && !(requestBody instanceof Blob) && !(requestBody instanceof FormData)) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (headers.get("Content-Type")?.includes("application/json")) requestBody = JSON.stringify(requestBody);
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const { fetch: _fetch, allowSensitive, ...requestOptions } = options;
  const response = await fetchImpl(path, { ...requestOptions, credentials: requestOptions.credentials || "include", body: requestBody, headers });
  const body = await readBody(response);
  const responseRequestId = body.requestId || response.headers.get("X-Request-ID") || requestId;
  if (!response.ok) {
    const error = body.error && typeof body.error === "object" ? body.error.message || body.error.code : body.error;
    const result = {
      success: false,
      data: body.data,
      error: error || response.statusText || `Request failed (${response.status})`,
      requestId: responseRequestId,
      status: response.status,
      code: typeof body.error === "object" && body.error ? body.error.code || "" : typeof body.error === "string" ? body.error : "",
    };
    const failure = new Error(result.error);
    Object.assign(failure, result);
    if (result.code === "AUTH_REQUIRED" || result.status === 401) clearDashboardSession("AUTH_REQUIRED");
    throw failure;
  }
  const rawPayload = body.data !== undefined ? body.data : body;
  const result = {
    success: body.success !== false,
    data: allowSensitive === true ? rawPayload : redactSecrets(rawPayload),
    requestId: responseRequestId,
  };
  if (body.error !== undefined) result.error = body.error;
  if (body.jobId !== undefined) result.jobId = body.jobId;
  if (body.status !== undefined) result.status = body.status;
  return result;
}

export default { apiRequest, redactSecrets };
