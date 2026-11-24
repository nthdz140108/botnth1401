import fs from "fs";
import path from "path";

export function nowIso() {
  return new Date().toISOString();
}

export function readJsonFile(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

export function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, serialized, "utf8");
    const retryCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
    let renamed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        renamed = true;
        break;
      } catch (err) {
        lastError = err;
        if (!retryCodes.has(err?.code)) throw err;
        sleepSync(15 * (attempt + 1));
      }
    }
    if (!renamed) {
      // Fallback on Windows when an external watcher/lock holds rename target
      try {
        fs.writeFileSync(filePath, serialized, "utf8");
      } catch {
        throw lastError;
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export function updateJsonAtomic(filePath, updater, fallback = {}) {
  const next = updater(readJsonFile(filePath, fallback));
  writeJsonAtomic(filePath, next);
  return next;
}
