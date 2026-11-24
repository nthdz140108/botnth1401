import path from "path";
import fs from "fs";
import { LRUCache } from "lru-cache";
import { formatTime } from "./format-util.js";
import { getBotInfoSync } from "./env.js";
import { getResourceProfile } from "./resource-profile.js";
import {
  createBotRuntimeContext,
  getRuntimeContext,
  ensureRuntimeDirectories,
} from "./bot-runtime-context.js";
import { getRuntimeInstanceDescriptor } from "../core/runtime-instance.js";

const MESSAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for !antiundo / !undo
const MAX_PENDING_WRITES = 500;
const instances = new Map();

function flushAllMessageCachesSync() {
  for (const store of instances.values()) {
    try {
      store.flush();
    } catch {}
  }
}

process.once("beforeExit", flushAllMessageCachesSync);
process.once("exit", flushAllMessageCachesSync);

export function createMessageCacheStore(customContext = null) {
  let ctx = customContext;
  if (!ctx || !ctx.messageJsonPath) {
    if (typeof ctx === "string") {
      ctx = getRuntimeContext(ctx);
    } else if (ctx && typeof ctx === "object" && ctx.uid) {
      ctx = getRuntimeContext(ctx.uid);
    } else {
      const botInfo = getBotInfoSync() || {};
      ctx = createBotRuntimeContext(botInfo);
    }
  }
  ensureRuntimeDirectories(ctx);
  const messageJsonPath = ctx.messageJsonPath;
  const botKey = ctx?.botName || ctx?.uid || process.env.BOT_NAME || process.env.MYBOT_CHILD_NAME;
  const profile = getResourceProfile(botKey);
  const maxEntries = Number.isInteger(ctx?.maxEntries) && ctx.maxEntries > 0
    ? ctx.maxEntries
    : (profile.messageCacheMaxEntries || 5_000);

  let hasPendingChanges = false;
  let flushTimer = null;
  const pendingWrites = new Map();

  // Strictly bounded RAM LRU (NO dispose -> pendingWrites leak!)
  const lru = new LRUCache({
    max: maxEntries,
    ttl: MESSAGE_CACHE_TTL_MS,
  });

  const idIndex = new LRUCache({
    max: maxEntries * 3,
    ttl: MESSAGE_CACHE_TTL_MS,
  });

  const negativeDiskLookup = new LRUCache({
    max: Math.max(1000, maxEntries),
    ttl: 60_000,
  });

  function readDisk() {
    try {
      if (!messageJsonPath) return {};
      fs.mkdirSync(path.dirname(messageJsonPath), { recursive: true });
      if (!fs.existsSync(messageJsonPath)) {
        fs.writeFileSync(messageJsonPath, "{}", "utf-8");
        return {};
      }
      const data = fs.readFileSync(messageJsonPath, "utf-8").replace(/^\uFEFF/, "");
      if (!data.trim()) return {};
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeDisk(data) {
    let tmp = null;
    try {
      if (!messageJsonPath) return false;
      fs.mkdirSync(path.dirname(messageJsonPath), { recursive: true });
      tmp = `${messageJsonPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
      fs.renameSync(tmp, messageJsonPath);
      return true;
    } catch (error) {
      try {
        if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
      console.error("Lỗi khi ghi file message.json:", error);
      return false;
    }
  }

  function trimDiskMap(diskMap, now = Date.now()) {
    const cutoff = now - MESSAGE_CACHE_TTL_MS;
    let changed = false;
    for (const key of Object.keys(diskMap)) {
      const entry = diskMap[key];
      const ts = Number(entry?.timestamp) || 0;
      if (!entry || (ts > 0 && ts < cutoff)) {
        delete diskMap[key];
        changed = true;
      }
    }
    const maxDiskEntries = Math.max(maxEntries, Math.min(maxEntries * 2, 15_000));
    const remainingKeys = Object.keys(diskMap);
    if (remainingKeys.length > maxDiskEntries) {
      remainingKeys
        .sort((a, b) => (Number(diskMap[a]?.timestamp) || 0) - (Number(diskMap[b]?.timestamp) || 0))
        .slice(0, remainingKeys.length - maxDiskEntries)
        .forEach((k) => {
          delete diskMap[k];
        });
      changed = true;
    }
    return changed;
  }

  function loadInitial() {
    try {
      const now = Date.now();
      const cutoff = now - MESSAGE_CACHE_TTL_MS;
      const disk = readDisk();
      const entries = Object.entries(disk)
        .filter(([, entry]) => entry && (!entry.timestamp || Number(entry.timestamp) >= cutoff))
        .sort((a, b) => (Number(a[1]?.timestamp) || 0) - (Number(b[1]?.timestamp) || 0));

      for (const [key, entry] of entries.slice(-maxEntries)) {
        lru.set(key, entry);
        idIndex.set(key, key);
        if (entry?.cliMsgId) {
          idIndex.set(String(entry.cliMsgId), key);
        }
        if (entry?.msgId) {
          idIndex.set(String(entry.msgId), key);
        }
        if (entry?.globalMsgId) {
          idIndex.set(String(entry.globalMsgId), key);
        }
      }
    } catch {}
  }

  loadInitial();

  function schedulePeriodicFlush() {
    if (flushTimer || !messageJsonPath) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 60_000);
    flushTimer.unref?.();
  }

  function update(data) {
    try {
      const rawData = data?.data || data || {};
      const cliMsgId = String(rawData.cliMsgId || data?.cliMsgId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const msgId = String(rawData.msgId || data?.msgId || cliMsgId);
      const timestamp = formatTime(new Date());
      const filterData = {
        timestamp: Number(rawData.ts || rawData.timestamp || data?.timestamp) || Date.now(),
        timestampString: rawData.timestampString || timestamp,
        msgId,
        cliMsgId,
        msgType: rawData.msgType || data?.msgType || "chat.text",
        uidFrom: rawData.uidFrom || data?.uidFrom || "",
        idTo: rawData.idTo || data?.idTo || "",
        dName: rawData.dName || data?.dName || "",
        content: rawData.content ?? data?.content ?? "",
        threadId: String(data?.threadId || rawData.threadId || rawData.idTo || ""),
        type: data?.type ?? rawData.type ?? 0,
        isUndo: Boolean(rawData.isUndo ?? data?.isUndo),
      };
      lru.set(cliMsgId, filterData);
      idIndex.set(cliMsgId, cliMsgId);
      idIndex.set(msgId, cliMsgId);
      negativeDiskLookup.delete(cliMsgId);
      negativeDiskLookup.delete(msgId);
      const rawGlobal = rawData.globalMsgId || data?.globalMsgId;
      if (rawGlobal) {
        idIndex.set(String(rawGlobal), cliMsgId);
        negativeDiskLookup.delete(String(rawGlobal));
      }

      if (messageJsonPath) {
        pendingWrites.set(cliMsgId, filterData);
        hasPendingChanges = true;
        if (pendingWrites.size >= MAX_PENDING_WRITES) {
          flush();
        } else {
          schedulePeriodicFlush();
        }
      }
    } catch (error) {
      console.error("Lỗi khi cập nhật message cache:", error.message);
    }
  }

  function getByMsgId(msgId) {
    if (!msgId) return null;
    const strMsgId = String(msgId).trim();
    if (!strMsgId) return null;

    // 1. Fast in-memory lookup (O(1))
    const direct = lru.get(strMsgId);
    if (direct) return direct;

    const indexedCli = idIndex.get(strMsgId);
    if (indexedCli) {
      const entry = lru.get(indexedCli) || pendingWrites.get(indexedCli);
      if (entry) return entry;
    }

    const pendingDirect = pendingWrites.get(strMsgId);
    if (pendingDirect) return pendingDirect;

    if (negativeDiskLookup.has(strMsgId)) return null;

    // 2. Cache miss: Disk fallback ONLY when not found in memory (avoid scanning on fast path)
    if (messageJsonPath) {
      try {
        const cutoff = Date.now() - MESSAGE_CACHE_TTL_MS;
        const diskData = readDisk();

        // Direct key match on disk
        if (diskData[strMsgId]) {
          const entry = diskData[strMsgId];
          if (!entry?.timestamp || Number(entry.timestamp) >= cutoff) {
            const canonicalKey = String(entry.cliMsgId || strMsgId);
            lru.set(canonicalKey, entry);
            idIndex.set(canonicalKey, canonicalKey);
            idIndex.set(strMsgId, canonicalKey);
            if (entry.msgId) idIndex.set(String(entry.msgId), canonicalKey);
            if (entry.globalMsgId) idIndex.set(String(entry.globalMsgId), canonicalKey);
            return entry;
          }
        }

        // Secondary match in disk entries
        for (const [key, entry] of Object.entries(diskData)) {
          if (entry?.timestamp && Number(entry.timestamp) < cutoff) continue;
          if (
            String(entry?.msgId) === strMsgId ||
            String(entry?.cliMsgId) === strMsgId ||
            String(entry?.globalMsgId) === strMsgId ||
            key === strMsgId
          ) {
            const canonicalKey = String(entry?.cliMsgId || key);
            lru.set(canonicalKey, entry);
            idIndex.set(canonicalKey, canonicalKey);
            idIndex.set(strMsgId, canonicalKey);
            if (entry?.msgId) idIndex.set(String(entry.msgId), canonicalKey);
            if (entry?.globalMsgId) idIndex.set(String(entry.globalMsgId), canonicalKey);
            return entry;
          }
        }
        negativeDiskLookup.set(strMsgId, true);
      } catch {}
    }

    return null;
  }

  function markUndo(msgId) {
    const entry = getByMsgId(msgId);
    if (entry) {
      entry.isUndo = true;
      if (entry.cliMsgId) {
        lru.set(entry.cliMsgId, entry);
        if (messageJsonPath) {
          pendingWrites.set(String(entry.cliMsgId), { ...entry });
          hasPendingChanges = true;
          schedulePeriodicFlush();
        }
      }
      return true;
    }
    return false;
  }

  function flush(now = Date.now()) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!messageJsonPath) {
      pendingWrites.clear();
      hasPendingChanges = false;
      return true;
    }
    if (!hasPendingChanges && pendingWrites.size === 0) return true;
    try {
      const existing = readDisk();
      for (const [key, entry] of pendingWrites.entries()) {
        existing[key] = entry;
      }
      trimDiskMap(existing, now);
      const success = writeDisk(existing);
      if (success) {
        pendingWrites.clear();
        hasPendingChanges = false;
      }
      return success;
    } catch (error) {
      console.error("Lỗi khi flush message cache:", error);
      return false;
    }
  }

  function prune(now = Date.now()) {
    const cutoff = now - MESSAGE_CACHE_TTL_MS;
    lru.purgeStale();
    idIndex.purgeStale();

    for (const [key, entry] of lru.entries()) {
      if (entry?.timestamp && Number(entry.timestamp) < cutoff) {
        lru.delete(key);
      }
    }

    for (const [key, entry] of pendingWrites.entries()) {
      if (entry?.timestamp && Number(entry.timestamp) < cutoff) {
        pendingWrites.delete(key);
      }
    }

    if (messageJsonPath) {
      try {
        const diskData = readDisk();
        for (const [key, entry] of pendingWrites.entries()) {
          diskData[key] = entry;
        }
        const changed = trimDiskMap(diskData, now) || pendingWrites.size > 0;
        if (changed) {
          if (writeDisk(diskData)) {
            pendingWrites.clear();
            hasPendingChanges = false;
          }
        }
      } catch {}
    }
  }

  function getAll() {
    const result = {};
    for (const [key, value] of lru.entries()) {
      result[key] = value;
    }
    return result;
  }

  function close() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return flush();
  }

  return {
    lru,
    idIndex,
    update,
    getByMsgId,
    markUndo,
    flush,
    close,
    prune,
    getAll,
    readDisk,
    writeDisk,
  };
}

export function getMessageCacheStore(customContext = null) {
  let ctx = customContext;
  if (!ctx || !ctx.messageJsonPath) {
    if (typeof ctx === "string") {
      ctx = getRuntimeContext(ctx);
    } else if (ctx && typeof ctx === "object" && ctx.uid) {
      ctx = getRuntimeContext(ctx.uid);
    } else {
      const botInfo = getBotInfoSync() || {};
      ctx = createBotRuntimeContext(botInfo);
    }
  }
  const uid = String(ctx?.uid || "default");
  if (!instances.has(uid)) {
    instances.set(uid, createMessageCacheStore(ctx));
  }
  return instances.get(uid);
}

export function registerMessageCacheAlias(aliasUid, canonicalUidOrStore) {
  if (!aliasUid) return;
  const sAlias = String(aliasUid);
  if (canonicalUidOrStore && typeof canonicalUidOrStore === "object" && canonicalUidOrStore.getByMsgId) {
    instances.set(sAlias, canonicalUidOrStore);
  } else if (canonicalUidOrStore) {
    const sCanonical = String(canonicalUidOrStore);
    if (instances.has(sCanonical)) {
      instances.set(sAlias, instances.get(sCanonical));
    }
  }
}

export function resolveMessageCacheStore(apiOrContextOrUid = null) {
  if (!apiOrContextOrUid) {
    return ensureDefaultStore();
  }
  if (typeof apiOrContextOrUid.getByMsgId === "function" && typeof apiOrContextOrUid.update === "function") {
    return apiOrContextOrUid;
  }
  if (apiOrContextOrUid.messageStore && typeof apiOrContextOrUid.messageStore.getByMsgId === "function") {
    return apiOrContextOrUid.messageStore;
  }
  if (apiOrContextOrUid.runtimeContext) {
    return getMessageCacheStore(apiOrContextOrUid.runtimeContext);
  }
  const botKey = apiOrContextOrUid.botKey || apiOrContextOrUid.botName;
  if (botKey) {
    return getMessageCacheStore(botKey);
  }
  const liveUid = apiOrContextOrUid.currentUserId || apiOrContextOrUid.botUid || (typeof apiOrContextOrUid === "string" ? apiOrContextOrUid : apiOrContextOrUid.uid);
  if (liveUid) {
    const sUid = String(liveUid);
    if (instances.has(sUid)) {
      return instances.get(sUid);
    }
    try {
      const descriptor = getRuntimeInstanceDescriptor();
      if (descriptor && (descriptor.liveZaloUid === sUid || descriptor.configuredUid === sUid || descriptor.botKey === sUid)) {
        return getMessageCacheStore(descriptor.botKey);
      }
    } catch {}
    return getMessageCacheStore(sUid);
  }

  return ensureDefaultStore();
}

export function resetMessageCacheInstances() {
  instances.clear();
  _defaultStore = null;
}

let _defaultStore = null;
function ensureDefaultStore() {
  if (!_defaultStore) {
    const botInfo = getBotInfoSync() || {};
    _defaultStore = getMessageCacheStore(createBotRuntimeContext(botInfo));
  }
  return _defaultStore;
}

export function getMessageLRUCache() {
  return ensureDefaultStore().lru;
}

export const getMessageCache = () => {
  return ensureDefaultStore().getAll();
};

export function getMessageCacheByMsgId(msgId) {
  return ensureDefaultStore().getByMsgId(msgId);
}

export function readMessageJson() {
  return ensureDefaultStore().readDisk();
}

export function writeMessageJson(data) {
  return ensureDefaultStore().writeDisk(data);
}

export function flushMessageCache() {
  return ensureDefaultStore().flush();
}

export function pruneMessageCache(now = Date.now()) {
  return ensureDefaultStore().prune(now);
}

export function updateMessageCache(data, apiOrContext = null) {
  if (apiOrContext) {
    return resolveMessageCacheStore(apiOrContext).update(data);
  }
  return ensureDefaultStore().update(data);
}

export function markUndoMessage(msgId) {
  return ensureDefaultStore().markUndo(msgId);
}
