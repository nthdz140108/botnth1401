import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Normalizes options for acquire/release lock helpers.
 *
 * @param {number|object} options
 * @returns {{ timeoutMs: number, staleMs: number, pollIntervalMs: number, root: string }}
 */
function normalizeLockOptions(options = {}) {
  if (typeof options === "number") {
    return {
      timeoutMs: options,
      staleMs: 30000,
      pollIntervalMs: 50,
      root: process.cwd(),
    };
  }
  return {
    timeoutMs: options.timeoutMs ?? 30000,
    staleMs: options.staleMs ?? 30000,
    pollIntervalMs: options.pollIntervalMs ?? 50,
    root: options.root ? path.resolve(options.root) : process.cwd(),
  };
}

/**
 * Resolves the lock file path for a given botKey.
 *
 * @param {string} botKey
 * @param {string} root
 * @returns {{ lockDir: string, lockFile: string }}
 */
function resolveLockPaths(botKey, root = process.cwd()) {
  const safeKey = encodeURIComponent(String(botKey || "").trim());
  const lockDir = path.resolve(root, ".runtime", "locks");
  const lockFile = path.join(lockDir, `${safeKey}.lock`);
  return { lockDir, lockFile };
}

/**
 * Acquires an atomic file lock at .runtime/locks/${botKey}.lock.
 * Contains { pid: process.pid, timestamp: Date.now(), token: randomUUID() }.
 * Automatically breaks stale locks older than 30s (or staleMs).
 *
 * @param {string} botKey
 * @param {number|object} options - timeoutMs or options object
 * @returns {Promise<{ botKey: string, token: string, lockPath: string, pid: number, timestamp: number }>}
 */
export async function acquireBotLock(botKey, options = {}) {
  if (!botKey || typeof botKey !== "string") {
    throw new Error("botKey is required and must be a string");
  }

  const { timeoutMs, staleMs, pollIntervalMs, root } = normalizeLockOptions(options);
  const { lockDir, lockFile } = resolveLockPaths(botKey, root);

  await fs.mkdir(lockDir, { recursive: true });

  const token = randomUUID();
  const startTime = Date.now();

  while (true) {
    const timestamp = Date.now();
    const payload = JSON.stringify({ pid: process.pid, timestamp, token }, null, 2);

    try {
      await fs.writeFile(lockFile, payload, { flag: "wx" });
      return {
        botKey,
        token,
        lockPath: lockFile,
        pid: process.pid,
        timestamp,
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }

      // Check whether existing lock is stale
      let isStale = false;
      try {
        const existingRaw = await fs.readFile(lockFile, "utf8");
        const existing = JSON.parse(existingRaw);
        if (typeof existing?.timestamp === "number") {
          const age = Date.now() - existing.timestamp;
          if (age > staleMs) {
            isStale = true;
          }
        } else {
          // Unparseable timestamp, treat as stale
          isStale = true;
        }
      } catch (readErr) {
        if (readErr.code === "ENOENT") {
          // Lock was released in the meantime, retry immediately
          continue;
        }
        // If file is unreadable/corrupt, check file mtime
        try {
          const stat = await fs.stat(lockFile);
          if (Date.now() - stat.mtimeMs > staleMs) {
            isStale = true;
          }
        } catch {
          // File disappeared or cannot stat, retry
          continue;
        }
      }

      if (isStale) {
        try {
          await fs.unlink(lockFile);
          // Retry acquisition immediately
          continue;
        } catch (unlinkErr) {
          if (unlinkErr.code !== "ENOENT") {
            // Ignored, another contender may have unlinked it
          }
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        const timeoutError = new Error(
          `Lock acquisition timed out for bot "${botKey}" after ${timeoutMs}ms (lock at ${lockFile})`
        );
        timeoutError.code = "LOCK_TIMEOUT";
        timeoutError.botKey = botKey;
        throw timeoutError;
      }

      const remaining = timeoutMs - elapsed;
      const sleepTime = Math.min(pollIntervalMs, Math.max(10, remaining));
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }
}

/**
 * Safely releases the bot lock if the provided token matches.
 *
 * @param {string} botKey
 * @param {string|object} token - token string or lock object
 * @param {number|object} options
 * @returns {Promise<boolean>}
 */
export async function releaseBotLock(botKey, token, options = {}) {
  if (!botKey) return false;
  const expectedToken = typeof token === "object" && token !== null ? token.token : token;
  if (!expectedToken) return false;

  const { root } = normalizeLockOptions(options);
  const { lockFile } = resolveLockPaths(botKey, root);

  try {
    const raw = await fs.readFile(lockFile, "utf8");
    const existing = JSON.parse(raw);
    if (existing?.token === expectedToken) {
      await fs.unlink(lockFile);
      return true;
    }
    return false;
  } catch (err) {
    if (err.code === "ENOENT") {
      return true;
    }
    return false;
  }
}

/**
 * Runs an async callback wrapped in a bot lock.
 *
 * @template T
 * @param {string} botKey
 * @param {(lock: { botKey: string, token: string, lockPath: string, pid: number, timestamp: number }) => Promise<T>} fn
 * @param {number|object} options
 * @returns {Promise<T>}
 */
export async function withBotLock(botKey, fn, options = {}) {
  const lock = await acquireBotLock(botKey, options);
  try {
    return await fn(lock);
  } finally {
    await releaseBotLock(botKey, lock.token, options).catch(() => {});
  }
}

/**
 * Reads metadata of the existing lock for botKey if present.
 *
 * @param {string} botKey
 * @param {number|object} options
 * @returns {Promise<{ pid: number, timestamp: number, token: string, ageMs: number }|null>}
 */
export async function getBotLockInfo(botKey, options = {}) {
  const { root } = normalizeLockOptions(options);
  const { lockFile } = resolveLockPaths(botKey, root);
  try {
    const raw = await fs.readFile(lockFile, "utf8");
    const data = JSON.parse(raw);
    return {
      ...data,
      ageMs: Date.now() - (data.timestamp || 0),
    };
  } catch {
    return null;
  }
}
