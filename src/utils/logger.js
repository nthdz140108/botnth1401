import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEY_PATTERN = /(cookie|imei|token|credential|password|secret|authorization|user[-_]?agent)/i;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap
const MAX_DAYS_RETENTION = 7;

export function redactLogEntry(value, isParentSensitive = false) {
  if (value === null || value === undefined) {
    return isParentSensitive ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogEntry(item, isParentSensitive));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const isSensitiveKey = isParentSensitive || SENSITIVE_KEY_PATTERN.test(key);
      if (val && typeof val === "object") {
        out[key] = redactLogEntry(val, isSensitiveKey);
      } else {
        out[key] = isSensitiveKey ? "[REDACTED]" : redactLogEntry(val, false);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    if (isParentSensitive) return "[REDACTED]";
    return value.replace(/\r?\n/g, " ");
  }
  if (isParentSensitive) {
    return "[REDACTED]";
  }
  return value;
}

export function createLogger({
  dir,
  baseName = "bot",
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  flushIntervalMs = 1000,
  fsImpl = fs,
} = {}) {
  if (!dir) throw new Error("logger dir is required");
  let currentDay = null;
  let currentPath = null;
  let stream = null;
  let closed = false;
  const queue = [];
  let timer = null;

  function dayStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function pruneOldDailyLogs() {
    try {
      if (!fsImpl.existsSync(dir)) return;
      const cutoff = Date.now() - MAX_DAYS_RETENTION * 24 * 60 * 60 * 1000;
      const prefix = `${baseName}-`;
      for (const name of fsImpl.readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const full = path.join(dir, name);
        try {
          const st = fsImpl.statSync(full);
          if (st.isFile() && st.mtimeMs < cutoff) {
            fsImpl.unlinkSync(full);
          }
        } catch {}
      }
    } catch {}
  }

  function ensureTargetPath() {
    const stamp = dayStamp();
    if (stamp !== currentDay || !currentPath) {
      currentDay = stamp;
      currentPath = path.join(dir, `${baseName}-${stamp}.ndjson`);
      if (stream) {
        try { stream.destroy?.(); } catch {}
        stream = null;
      }
      pruneOldDailyLogs();
    }
    fsImpl.mkdirSync(dir, { recursive: true });
    // Hard rotate at maxFileBytes keeping at most 1 backup (.1)
    try {
      if (fsImpl.existsSync(currentPath) && fsImpl.statSync(currentPath).size >= maxFileBytes) {
        const rotated = `${currentPath}.1`;
        if (stream) {
          try { stream.destroy?.(); } catch {}
          stream = null;
        }
        try {
          if (fsImpl.existsSync(rotated)) fsImpl.unlinkSync(rotated);
        } catch {}
        try { fsImpl.renameSync(currentPath, rotated); } catch {}
      }
    } catch {}
    return currentPath;
  }

  function log(entry) {
    if (closed) return;
    const safe = redactLogEntry(entry && typeof entry === "object" ? entry : { msg: entry });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe });
    queue.push(line);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  function flush() {
    if (queue.length === 0) return;
    const lines = queue.splice(0, queue.length);
    for (const line of lines) {
      const targetPath = ensureTargetPath();
      if (typeof fsImpl.appendFileSync === "function") {
        try {
          fsImpl.appendFileSync(targetPath, `${line}\n`, "utf8");
        } catch {}
      } else {
        if (!stream) {
          stream = fsImpl.createWriteStream(targetPath, { flags: "a" });
          stream.on("error", () => {});
        }
        stream.write(`${line}\n`);
      }
    }
  }

  async function close() {
    flush();
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await new Promise((resolve) => {
      try {
        stream?.end?.(() => resolve());
        if (!stream) resolve();
      } catch {
        resolve();
      }
    });
  }

  return { log, flush, close };
}
