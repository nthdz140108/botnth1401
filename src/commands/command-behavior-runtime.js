export function isWithinSchedule(now, windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (list.length === 0) return true;
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return list.some((window) => {
    if (!window || typeof window.from !== "string" || typeof window.to !== "string") return false;
    if (!matchesDays(window.days, day)) return false;
    const from = parseHHMM(window.from);
    const to = parseHHMM(window.to);
    if (from === null || to === null) return false;
    if (to < from) return minutes >= from || minutes <= to;
    return minutes >= from && minutes <= to;
  });
}

function matchesDays(pattern, day) {
  const raw = String(pattern ?? "*").trim();
  if (raw === "*" || raw === "") return true;
  return raw.split(",").some((part) => {
    const trimmed = part.trim();
    const range = trimmed.split("-").map((value) => Number(value.trim()));
    if (range.length === 2 && range.every(Number.isInteger)) {
      return day >= Math.min(...range) && day <= Math.max(...range);
    }
    return Number(trimmed) === day;
  });
}

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function evaluateRestrictions(behavior, { threadId, senderId }) {
  const restrictions = behavior?.restrictions || {};
  const mode = restrictions.mode || "all";
  const allowedUsers = normalizeIds(restrictions.allowedUsers, "userId");
  if (allowedUsers.length > 0 && !allowedUsers.includes(String(senderId))) {
    return { allowed: false, reason: "USER_NOT_ALLOWED" };
  }
  if (mode === "whitelist") {
    const allowedThreads = normalizeIds(restrictions.allowedThreads, "threadId");
    if (!allowedThreads.includes(String(threadId))) return { allowed: false, reason: "THREAD_NOT_WHITELISTED" };
    return { allowed: true, reason: "" };
  }
  if (mode === "blacklist") {
    const blocked = normalizeIds(restrictions.blockedThreads, "threadId");
    if (blocked.includes(String(threadId))) return { allowed: false, reason: "THREAD_BLOCKED" };
  }
  return { allowed: true, reason: "" };
}

function normalizeIds(rows, columnKey) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row?.[columnKey]).filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map((value) => String(value).trim());
}

export function resolveCooldownSeconds(behavior, fallbackSeconds) {
  const override = behavior?.operation?.cooldownOverride;
  if (Number.isInteger(override) && override >= 0) return override;
  const fallback = Number(fallbackSeconds);
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
}

export function cooldownBucket(mode, { userId, threadId }) {
  if (mode === "perThread") return `t:${threadId}`;
  if (mode === "perUserThread") return `ut:${userId}:${threadId}`;
  if (mode === "global") return "*";
  return `u:${userId}`;
}

export function checkHourlyLimit(historyTimestamps, maxUsesPerHour, nowMs) {
  const limit = Number(maxUsesPerHour);
  if (!Number.isInteger(limit) || limit <= 0) return { allowed: true, oldestRemainingMs: 0 };
  const windowStart = nowMs - 60 * 60 * 1000;
  const withinWindow = (Array.isArray(historyTimestamps) ? historyTimestamps : []).filter((ts) => ts > windowStart);
  if (withinWindow.length < limit) return { allowed: true, oldestRemainingMs: 0 };
  const oldest = Math.min(...withinWindow);
  return { allowed: false, oldestRemainingMs: Math.max(1, oldest + 60 * 60 * 1000 - nowMs) };
}
