import fs from "node:fs";
import path from "node:path";

function atomicWriteJsonSync(filePath, data, fsImpl = fs) {
  const dir = path.dirname(filePath);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  const tempPath = path.join(
    dir,
    `.tmp-rank-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  fsImpl.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fsImpl.renameSync(tempPath, filePath);
}

const stores = new Map();

export function createRankStore(context, options = {}) {
  const {
    flushIntervalMs = Number(process.env.RANK_FLUSH_INTERVAL_MS || 10000),
    logger = console,
    fsImpl = fs,
    projectRoot = null,
  } = options;

  if (!context) throw new Error("rank store requires a runtime context");

  const rawPath = context.rankInfoPath || path.join(context.dataDir || "", "rank-info.json");
  const filePath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(projectRoot || process.cwd(), rawPath);

  let data = { groups: {} };
  let dirty = false;
  let closed = false;
  let timer = null;
  let lastError = null;

  function loadFromDisk() {
    try {
      if (!fsImpl.existsSync(filePath)) return;
      const raw = fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = {
          groups: parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)
            ? parsed.groups
            : {},
        };
      }
    } catch (error) {
      logger.warn?.(`[rank-store] load failed for ${filePath}: ${error.message}`);
    }
  }

  function shouldMirrorLegacy() {
    if (context.uid !== "admin") return false;
    const legacyPath = path.resolve(projectRoot || process.cwd(), "assets", "json-data", "rank-info.json");
    return path.resolve(filePath) !== legacyPath;
  }

  function flush() {
    if (!dirty) return { flushed: false };
    try {
      atomicWriteJsonSync(filePath, data, fsImpl);
      if (shouldMirrorLegacy()) {
        try {
          atomicWriteJsonSync(
            path.resolve(projectRoot || process.cwd(), "assets", "json-data", "rank-info.json"),
            data,
            fsImpl
          );
        } catch {}
      }
      dirty = false;
      lastError = null;
      return { flushed: true };
    } catch (error) {
      lastError = error;
      logger.error?.(`[rank-store] flush failed for ${filePath}: ${error.message}`);
      return { flushed: false, error };
    }
  }

  function scheduleFlush() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  loadFromDisk();

  return {
    increment(groupId, userId, userName, groupName) {
      if (!groupId || !userId) return null;
      if (!data.groups[groupId]) data.groups[groupId] = { users: [] };
      const group = data.groups[groupId];
      if (groupName && group.nameGroup !== groupName) group.nameGroup = groupName;
      if (!Array.isArray(group.users)) group.users = [];
      let entry = group.users.find((u) => u.UID === userId);
      if (entry) {
        entry.Rank = (entry.Rank || 0) + 1;
        if (userName) entry.UserName = userName;
      } else {
        entry = { UserName: userName || "Thành viên", UID: userId, Rank: 1 };
        group.users.push(entry);
      }
      dirty = true;
      scheduleFlush();
      return entry;
    },
    snapshot(threadId = null) {
      if (threadId === null || threadId === undefined) {
        return JSON.parse(JSON.stringify(data));
      }
      const group = data.groups[String(threadId)];
      return group ? JSON.parse(JSON.stringify(group)) : { users: [] };
    },
    replace(nextData) {
      if (nextData && typeof nextData === "object" && !Array.isArray(nextData)) {
        data = {
          groups: nextData.groups && typeof nextData.groups === "object" && !Array.isArray(nextData.groups)
            ? JSON.parse(JSON.stringify(nextData.groups))
            : {},
        };
      } else {
        data = { groups: {} };
      }
      // Administrative writes go straight to disk to preserve legacy semantics.
      dirty = true;
      flush();
      return this.snapshot();
    },
    reset() {
      data = { groups: {} };
      dirty = true;
      flush();
    },
    flush,
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      closed = true;
      return flush();
    },
    get path() {
      return filePath;
    },
    get isDirty() {
      return dirty;
    },
    get error() {
      return lastError;
    },
  };
}

export function getRankStore(context, options = {}) {
  if (!context) throw new Error("context required");
  const rawPath = context.rankInfoPath || path.join(context.dataDir || "", "rank-info.json");
  const root = options.projectRoot || process.cwd();
  const key = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(root, rawPath);
  if (!stores.has(key)) {
    stores.set(key, createRankStore(context, { ...options, projectRoot: root }));
  }
  return stores.get(key);
}

export function closeAllRankStores() {
  const all = [...stores.values()];
  stores.clear();
  return Promise.all(all.map((store) => store.close()));
}
