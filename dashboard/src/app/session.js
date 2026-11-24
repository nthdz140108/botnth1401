const initialSession = {
  status: "idle",
  authenticated: false,
  username: "",
  csrfToken: "",
  expiresAt: null,
  error: "",
};

let sessionState = { ...initialSession };
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener(sessionState);
}

function normalizeExpiration(expiresAt) {
  if (!expiresAt) return null;
  if (expiresAt instanceof Date) return expiresAt.toISOString();
  return String(expiresAt);
}

export function getDashboardSession() {
  return sessionState;
}

export function subscribeDashboardSession(listener) {
  listeners.add(listener);
  listener(sessionState);
  return () => listeners.delete(listener);
}

export function setDashboardSession(partial) {
  sessionState = { ...sessionState, ...partial };
  notify();
  return sessionState;
}

export function markDashboardSignedOut(error = "") {
  sessionState = { ...initialSession, status: error ? "signed-out" : "idle", error };
  notify();
  return sessionState;
}

export function markDashboardAuthenticated({ username, csrfToken, expiresAt }) {
  sessionState = {
    ...initialSession,
    status: "authenticated",
    authenticated: true,
    username: String(username || ""),
    csrfToken: String(csrfToken || ""),
    expiresAt: normalizeExpiration(expiresAt),
    error: "",
  };
  notify();
  return sessionState;
}

export function getDashboardCsrfToken() {
  return sessionState.csrfToken || readCookie("mybot_csrf");
}

export function readCookie(name) {
  if (typeof document === "undefined") return "";
  const cookie = document.cookie || "";
  for (const part of cookie.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey !== name) continue;
    return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { data: text };
  }
}

function normalizeError(body, response) {
  if (typeof body?.error === "object" && body.error) return body.error.message || body.error.code || response.statusText || `Request failed (${response.status})`;
  return body?.error || response.statusText || `Request failed (${response.status})`;
}

function createAuthError(body, response) {
  const error = new Error(normalizeError(body, response));
  error.status = response.status;
  error.requestId = body.requestId || response.headers.get("X-Request-ID") || "";
  error.code = typeof body?.error === "object" && body.error ? body.error.code || "" : typeof body?.error === "string" ? body.error : "";
  error.data = body.data;
  return error;
}

async function requestJson(path, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body === "object" && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Blob) && !(options.body instanceof FormData)) {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const response = await fetchImpl(path, {
    ...options,
    credentials: options.credentials || "include",
    headers,
    body: options.body && headers.get("Content-Type")?.includes("application/json") ? JSON.stringify(options.body) : options.body,
  });
  const body = await readBody(response);
  if (!response.ok) throw createAuthError(body, response);
  return body;
}

export async function loadDashboardSession(options = {}) {
  setDashboardSession({ status: "loading", error: "" });
  try {
    const body = await requestJson("/api/auth/session", options);
    if (!body.authenticated) {
      return markDashboardSignedOut();
    }
    return markDashboardAuthenticated(body);
  } catch (error) {
    if (error.status === 401) return markDashboardSignedOut();
    setDashboardSession({ status: "error", error: error.code || error.message || "AUTH_SESSION_FAILED" });
    throw error;
  }
}

export async function loginDashboardSession({ username, password, fetch: fetchImpl } = {}) {
  const body = await requestJson("/api/auth/login", {
    method: "POST",
    fetch: fetchImpl,
    headers: { "Content-Type": "application/json" },
    body: { username, password },
  });
  return markDashboardAuthenticated(body);
}

export async function logoutDashboardSession(options = {}) {
  try {
    await requestJson("/api/auth/logout", {
      method: "POST",
      fetch: options.fetch,
      headers: options.headers,
    });
  } finally {
    markDashboardSignedOut();
  }
}

export function clearDashboardSession(error = "AUTH_REQUIRED") {
  return markDashboardSignedOut(error);
}
