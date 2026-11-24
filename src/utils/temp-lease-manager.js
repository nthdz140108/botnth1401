import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProjectRoot, getBotName } from "./env.js";

const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const HARD_MAX_LEASE_TTL_MS = 60 * 60 * 1000; // 60 minutes hard ceiling
const DEFAULT_UNLEASED_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const activeLeases = new Map();
let syncTimer = null;
let exitHookRegistered = false;

function normalizeLeaseKey(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function getCanonicalTempRoot(projectRoot = getProjectRoot()) {
  const root = projectRoot || getProjectRoot();
  return path.join(root, ".runtime", "temp");
}

export function getBotTempDir(botId = null, projectRoot = getProjectRoot()) {
  const safeBot = String(botId || getBotName() || "admin")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_") || "admin";
  const dir = path.join(getCanonicalTempRoot(projectRoot), safeBot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function getLeaseRegistryDir(projectRoot = getProjectRoot()) {
  return path.join(getCanonicalTempRoot(projectRoot), ".leases");
}

function getProcessLeaseFilePath(projectRoot = getProjectRoot()) {
  return path.join(getLeaseRegistryDir(projectRoot), `pid-${process.pid}.json`);
}

function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  if (num === process.pid) return true;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function flushProcessLeaseRegistrySync() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const now = Date.now();
  for (const [key, entry] of activeLeases.entries()) {
    if (!entry || entry.expiresAt <= now) {
      activeLeases.delete(key);
    }
  }

  const leaseFile = getProcessLeaseFilePath();
  if (activeLeases.size === 0) {
    try {
      if (fs.existsSync(leaseFile)) fs.unlinkSync(leaseFile);
    } catch {}
    return;
  }

  const leasesPayload = {};
  for (const [key, entry] of activeLeases.entries()) {
    leasesPayload[key] = {
      path: entry.filePath,
      acquiredAt: entry.acquiredAt,
      expiresAt: entry.expiresAt,
    };
  }

  let tmpPath = null;
  try {
    const dir = path.dirname(leaseFile);
    fs.mkdirSync(dir, { recursive: true });
    tmpPath = `${leaseFile}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ pid: process.pid, updatedAt: now, leases: leasesPayload }),
      "utf8"
    );
    fs.renameSync(tmpPath, leaseFile);
  } catch {
    try {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function scheduleRegistrySync() {
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", () => {
      try {
        const leaseFile = getProcessLeaseFilePath();
        if (fs.existsSync(leaseFile)) fs.unlinkSync(leaseFile);
      } catch {}
    });
  }
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    flushProcessLeaseRegistrySync();
  }, 150);
  syncTimer.unref?.();
}

export function allocateTempPath(extOrName = ".tmp", { botId = null, prefix = "tmp", projectRoot = getProjectRoot() } = {}) {
  const dir = getBotTempDir(botId, projectRoot);
  const raw = String(extOrName || ".tmp").trim();
  const ext = raw.startsWith(".") ? raw : path.extname(raw) || `.${raw}`;
  const safePrefix = String(prefix || "tmp").replace(/[^a-zA-Z0-9._-]/g, "_");
  const unique = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return path.join(dir, `${safePrefix}-${unique}${ext}`);
}

export function acquireTempLease(filePath, ttlMs = DEFAULT_LEASE_TTL_MS, options = {}) {
  const key = normalizeLeaseKey(filePath);
  if (!key) return null;
  let resolvedTtl = ttlMs;
  let resolvedOptions = options && typeof options === "object" ? options : {};
  if (ttlMs && typeof ttlMs === "object") {
    resolvedOptions = ttlMs;
    resolvedTtl = resolvedOptions.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  }
  const { flushImmediate = false } = resolvedOptions;
  const now = Date.now();
  const boundedTtl = Math.min(Math.max(1000, Number(resolvedTtl) || DEFAULT_LEASE_TTL_MS), HARD_MAX_LEASE_TTL_MS);
  const entry = {
    key,
    filePath: path.resolve(filePath),
    acquiredAt: now,
    expiresAt: now + boundedTtl,
  };
  activeLeases.set(key, entry);
  if (flushImmediate) {
    flushProcessLeaseRegistrySync();
  } else {
    scheduleRegistrySync();
  }
  return entry;
}

export function renewTempLease(filePath, ttlMs = DEFAULT_LEASE_TTL_MS) {
  return acquireTempLease(filePath, ttlMs);
}

export function releaseTempLease(filePath, { flushImmediate = false } = {}) {
  const key = normalizeLeaseKey(filePath);
  if (!key) return false;
  const existed = activeLeases.delete(key);
  if (existed) {
    if (flushImmediate) {
      flushProcessLeaseRegistrySync();
    } else {
      scheduleRegistrySync();
    }
  }
  return existed;
}

export async function releaseAndDeleteTempFile(filePath) {
  releaseTempLease(filePath);
  if (!filePath) return false;
  try {
    await fs.promises.unlink(path.resolve(filePath));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return false;
  }
}

export async function withTempFile(ext = ".tmp", fn, { ttlMs = DEFAULT_LEASE_TTL_MS, botId = null, prefix = "tmp", projectRoot = getProjectRoot() } = {}) {
  const filePath = allocateTempPath(ext, { botId, prefix, projectRoot });
  acquireTempLease(filePath, ttlMs, { flushImmediate: true });
  try {
    return await fn(filePath);
  } finally {
    await releaseAndDeleteTempFile(filePath);
  }
}

export function loadActiveCrossProcessLeases({ projectRoot = getProjectRoot(), now = Date.now() } = {}) {
  const leasedKeys = new Map();

  for (const [key, entry] of activeLeases.entries()) {
    if (entry && entry.expiresAt > now && now - entry.acquiredAt <= HARD_MAX_LEASE_TTL_MS) {
      leasedKeys.set(key, entry.expiresAt);
    } else {
      activeLeases.delete(key);
    }
  }

  const leaseDir = getLeaseRegistryDir(projectRoot);
  if (!fs.existsSync(leaseDir)) {
    return leasedKeys;
  }

  try {
    for (const fileName of fs.readdirSync(leaseDir)) {
      if (!fileName.startsWith("pid-") || !fileName.endsWith(".json")) continue;
      const fullPath = path.join(leaseDir, fileName);
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        const pid = Number(parsed?.pid);
        if (!isProcessAlive(pid)) {
          try {
            fs.unlinkSync(fullPath);
          } catch {}
          continue;
        }
        const leases = parsed?.leases || {};
        for (const [key, item] of Object.entries(leases)) {
          const expiresAt = Number(item?.expiresAt) || 0;
          const acquiredAt = Number(item?.acquiredAt) || 0;
          if (expiresAt > now && (acquiredAt === 0 || now - acquiredAt <= HARD_MAX_LEASE_TTL_MS)) {
            const prev = leasedKeys.get(key) || 0;
            if (expiresAt > prev) leasedKeys.set(key, expiresAt);
          }
        }
      } catch {
        // Ignore transient partial read
      }
    }
  } catch {}

  return leasedKeys;
}

export function isTempFileLeased(filePath, { projectRoot = getProjectRoot(), now = Date.now(), leasedMap = null } = {}) {
  const key = normalizeLeaseKey(filePath);
  if (!key) return false;
  const activeEntry = activeLeases.get(key);
  if (activeEntry && activeEntry.expiresAt > now && now - activeEntry.acquiredAt <= HARD_MAX_LEASE_TTL_MS) {
    return true;
  }
  const map = leasedMap || loadActiveCrossProcessLeases({ projectRoot, now });
  const exp = map.get(key);
  return Boolean(exp && exp > now);
}

export async function sweepUnleasedTempFiles({
  projectRoot = getProjectRoot(),
  extraTempDirs = [],
  maxUnleasedAgeMs = DEFAULT_UNLEASED_MAX_AGE_MS,
  now = Date.now(),
  dryRun = false,
} = {}) {
  flushProcessLeaseRegistrySync();
  const leasedMap = loadActiveCrossProcessLeases({ projectRoot, now });

  const candidateRoots = new Set([
    getCanonicalTempRoot(projectRoot),
    path.join(projectRoot, "assets", "temp"),
    path.join(projectRoot, "temp"),
    ...extraTempDirs.filter(Boolean).map((d) => path.resolve(d)),
  ]);

  const instancesDir = path.join(projectRoot, "mybot", "instances");
  if (fs.existsSync(instancesDir)) {
    try {
      for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidateRoots.add(path.join(instancesDir, entry.name, "temp"));
        }
      }
    } catch {}
  }

  let deletedFiles = 0;
  let deletedBytes = 0;
  let skippedLeased = 0;
  let skippedFresh = 0;
  const errors = [];

  async function walkTempDir(dirPath, isRoot = false) {
    if (!fs.existsSync(dirPath)) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".leases" || entry.name === ".gitkeep") continue;
      const fullPath = path.join(dirPath, entry.name);
      let lstat;
      try {
        lstat = await fs.promises.lstat(fullPath);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) continue;

      if (lstat.isDirectory()) {
        await walkTempDir(fullPath, false);
        if (!dryRun && !isRoot) {
          try {
            const remaining = await fs.promises.readdir(fullPath);
            if (remaining.length === 0) {
              await fs.promises.rmdir(fullPath);
            }
          } catch {}
        }
        continue;
      }

      if (!lstat.isFile()) continue;

      if (isTempFileLeased(fullPath, { projectRoot, now, leasedMap })) {
        skippedLeased += 1;
        continue;
      }

      const ageMs = now - lstat.mtimeMs;
      if (ageMs < maxUnleasedAgeMs) {
        skippedFresh += 1;
        continue;
      }

      if (!dryRun) {
        try {
          await fs.promises.unlink(fullPath);
          deletedFiles += 1;
          deletedBytes += lstat.size;
        } catch (err) {
          if (err?.code !== "ENOENT") {
            errors.push({ path: fullPath, code: err?.code, message: err?.message });
          }
        }
      } else {
        deletedFiles += 1;
        deletedBytes += lstat.size;
      }
    }
  }

  for (const rootDir of candidateRoots) {
    await walkTempDir(rootDir, true);
  }

  return {
    deletedFiles,
    deletedBytes,
    skippedLeased,
    skippedFresh,
    activeLeaseCount: leasedMap.size,
    errors,
  };
}

export function getActiveLeaseSnapshot() {
  return Array.from(activeLeases.values());
}

export function clearAllProcessLeasesForTest() {
  activeLeases.clear();
  flushProcessLeaseRegistrySync();
}
