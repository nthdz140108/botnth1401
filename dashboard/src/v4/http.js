import { clearDashboardSession, getDashboardCsrfToken } from "../app/session.js";

/**
 * Unwraps `{ success: true, data: ... }` or direct payload envelopes uniformly
 * across both Rust V4 (`mybotd`) and Node.js V3 (`dashboard/server.js`).
 */
export async function v4Fetch(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("X-CSRF-Token")) {
    const csrf = getDashboardCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  let body = options.body;
  if (
    body !== undefined &&
    body !== null &&
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer)
  ) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    body = JSON.stringify(body);
  }

  const response = await fetch(path, {
    method,
    headers,
    body,
    credentials: "include",
    cache: "no-store",
    signal: options.signal,
  });

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { rawText: text };
    }
  }

  if (!response.ok) {
    const errObj = parsed?.error;
    const code =
      typeof errObj === "object" && errObj
        ? errObj.code || ""
        : typeof errObj === "string"
          ? errObj
          : parsed?.code || "";
    const message =
      typeof errObj === "object" && errObj
        ? errObj.message || errObj.code
        : typeof errObj === "string"
          ? errObj
          : parsed?.message || `Yêu cầu thất bại (HTTP ${response.status})`;

    if (response.status === 401 || code === "AUTH_REQUIRED") {
      clearDashboardSession("AUTH_REQUIRED");
    }
    const err = new Error(message);
    err.status = response.status;
    err.code = code;
    err.details = parsed?.data || errObj?.details || null;
    throw err;
  }

  if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "data")) {
    return parsed.data;
  }
  return parsed;
}

export function normalizeBotRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.botKey || raw.id || raw.uid || "");
  const isMain = Boolean(raw.isMain || id === "admin" || id === "main");
  const cookieDead = Boolean(raw.cookieDead || raw.status === "cookie_dead" || raw.status === "cookie_expired");
  const rawStatus = String(raw.status || "stopped").toLowerCase();
  const wsConnected = Boolean(raw.wsConnected ?? raw.connected ?? (rawStatus === "running" || rawStatus === "online"));

  // Real status resolution: 'online', 'connecting', 'hot_standby', 'cookie_expired', 'error', 'stopped'
  let resolvedStatus = "stopped";
  if (cookieDead || rawStatus.includes("cookie")) {
    resolvedStatus = "cookie_expired";
  } else if (rawStatus === "hot_standby" || rawStatus === "standby") {
    resolvedStatus = "hot_standby";
  } else if (rawStatus === "connecting" || rawStatus === "starting" || rawStatus === "launching" || rawStatus === "restarting") {
    resolvedStatus = "connecting";
  } else if (rawStatus === "error" || rawStatus === "errored" || rawStatus === "crashed") {
    resolvedStatus = "error";
  } else if (wsConnected || rawStatus === "running" || rawStatus === "online") {
    resolvedStatus = "online";
  } else {
    resolvedStatus = rawStatus;
  }

  const updatedAt = raw.updatedAt || raw.lastSeenAt || raw.startedAt || new Date().toISOString();

  return {
    ...raw,
    id,
    botKey: id,
    uid: String(raw.uid || id),
    displayName: raw.displayName || raw.name || (isMain ? "Bot Admin Chính" : id),
    avatar: raw.avatar || "",
    isMain,
    cookieDead,
    deadReason: raw.cookieDeadReason || raw.statusReason || raw.lastError || "",
    status: resolvedStatus,
    wsConnected: resolvedStatus === "online",
    prefix: raw.prefix || "!",
    ownerUid: raw.ownerUid || "",
    expiryAt: raw.expiryPolicy || raw.expiryAt || "Never",
    uptimeSecs: Number(raw.uptimeSecs ?? raw.supervisor?.uptime ?? 0),
    hasCookie: raw.hasCookie !== undefined ? Boolean(raw.hasCookie) : !cookieDead,
    updatedAt,
  };
}

export function formatRelativeTimeVi(isoString) {
  if (!isoString) return { relative: "--", exactIso: "" };
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (Number.isNaN(diffMs)) return { relative: "--", exactIso: String(isoString) };

  const exactIso = date.toISOString();
  if (diffMs < 5000) return { relative: "vừa xong", exactIso };
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return { relative: `${diffSec} giây trước`, exactIso };
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return { relative: `${diffMin} phút trước`, exactIso };
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return { relative: `${diffHours} giờ trước`, exactIso };
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return { relative: `${diffDays} ngày trước`, exactIso };
  return { relative: formatDateVi(exactIso), exactIso };
}

export function formatDurationVi(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}p`;
  const d = Math.floor(h / 24);
  return `${d} ngày ${h % 24}h`;
}

export function formatBytesVi(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return "0 MB";
  const mb = b / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatExpiryVi(expiry) {
  if (!expiry || expiry === "Never" || expiry === "permanent" || expiry === "-1" || expiry === -1) {
    return "Vĩnh viễn";
  }
  if (typeof expiry === "object") {
    if (expiry.type === "permanent" || expiry.kind === "permanent") return "Vĩnh viễn";
    if (expiry.at) return formatDateVi(expiry.at);
  }
  return formatDateVi(expiry);
}

export function formatDateVi(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
