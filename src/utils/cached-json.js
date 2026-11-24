import fs from "node:fs";

const DEFAULT_TTL_MS = 5000;

export function createCachedJson({ ttlMs = DEFAULT_TTL_MS, fsImpl = fs } = {}) {
  const cache = new Map();

  function signature(filePath) {
    try {
      const stat = fsImpl.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  function read(filePath, fallback = null) {
    if (!filePath) return fallback;
    const sig = signature(filePath);
    if (sig === null) {
      cache.delete(filePath);
      return fallback;
    }
    const entry = cache.get(filePath);
    const now = Date.now();
    if (entry && entry.sig === sig && now - entry.loadedAt <= ttlMs) {
      return entry.value;
    }
    try {
      const raw = fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) {
        cache.delete(filePath);
        return fallback;
      }
      const value = JSON.parse(raw);
      cache.set(filePath, { sig, value, loadedAt: now });
      return value;
    } catch {
      // On parse/read failure prefer the last known good value within TTL
      if (entry && now - entry.loadedAt <= ttlMs) return entry.value;
      cache.delete(filePath);
      return fallback;
    }
  }

  function invalidate(filePath) {
    if (filePath) cache.delete(filePath);
    else cache.clear();
  }

  function clear() {
    cache.clear();
  }

  return { read, invalidate, clear };
}

const sharedInstance = createCachedJson({ ttlMs: DEFAULT_TTL_MS });

export function readCachedJson(filePath, fallback = null) {
  return sharedInstance.read(filePath, fallback);
}

export function invalidateCachedJson(filePath) {
  sharedInstance.invalidate(filePath);
}
