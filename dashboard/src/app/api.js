import { clearDashboardSession, getDashboardCsrfToken } from "./session.js";
import { redactSecrets } from "../api/client.js";

const normalizeError = (body, response) => typeof body.error === "object" ? body.error.message || body.error.code : body.error || response.statusText || `Request failed (${response.status})`;

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { data: text };
  }
}

export async function apiRequest(path, options = {}) {
  const sensitiveAllowed = options.allowSensitive === true && /\/credential\/reveal(?:\?|$)/i.test(path);
  const headers = new Headers(options.headers || {});
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(String(options.method || "GET").toUpperCase()) && !headers.has("X-CSRF-Token")) {
    const csrfToken = getDashboardCsrfToken();
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  if (options.body && typeof options.body === "object" && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Blob) && !(options.body instanceof FormData)) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const response = await fetchImpl(path, {
    ...options,
    credentials: options.credentials || "include",
    headers,
    body: options.body && headers.get("Content-Type")?.includes("application/json") ? JSON.stringify(options.body) : options.body,
  });
  const rawBody = await readBody(response);
  const body = sensitiveAllowed ? rawBody : redactEnvelope(rawBody);
  if (!response.ok) {
    const error = new Error(normalizeError(body, response));
    error.status = response.status;
    error.requestId = body.requestId || response.headers.get("X-Request-ID") || "";
    error.data = body.data;
    error.code = typeof body.error === "object" && body.error ? body.error.code || "" : typeof body.error === "string" ? body.error : "";
    if (error.code === "AUTH_REQUIRED" || error.status === 401) clearDashboardSession("AUTH_REQUIRED");
    throw error;
  }
  return body;
}

export function normalizeEnvelope(body, { requestId = "" } = {}) {
  const envelope = body && typeof body === "object" ? body : { data: body };
  return {
    success: envelope.success !== false,
    data: redactSecrets(envelope.data !== undefined ? envelope.data : envelope),
    ...(envelope.error !== undefined ? { error: envelope.error } : {}),
    requestId: envelope.requestId || requestId,
    ...(envelope.jobId !== undefined ? { jobId: envelope.jobId } : {}),
    ...(envelope.status !== undefined ? { status: envelope.status } : {}),
  };
}

function redactEnvelope(body) {
  if (!body || typeof body !== "object") return body;
  if (Object.prototype.hasOwnProperty.call(body, "data")) return { ...body, data: redactSecrets(body.data) };
  return redactSecrets(body);
}

export function normalizeMutation(body, metadata) {
  const envelope = normalizeEnvelope(body, metadata);
  if (envelope.jobId && !envelope.status) envelope.status = "queued";
  return envelope;
}

export { redactSecrets };
