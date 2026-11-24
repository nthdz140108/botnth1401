import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import schedule from "node-schedule";
import chalk from "chalk";
import { checkUrlStatus } from "./util.js";
import { getBotInfoSync, getProjectRoot } from "./env.js";
import { createBotRuntimeContext } from "./bot-runtime-context.js";

const LEGACY_CACHE_FILE_PATH = path.join(getProjectRoot(), "assets", "json-data", "cache-link.json");
const MAX_LINK_CACHE_ENTRIES = 2_000;
const LINK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const METADATA_KEYS = new Set(["title", "artist", "width", "height", "duration", "platform", "timestamp", "ts"]);

export function resolveBotDataFilePath(fileName = "cache-link.json", customContext = null) {
  const safeName = path.basename(String(fileName || "cache-link.json"));
  const ctx = customContext
    ? (customContext.dataDir ? customContext : createBotRuntimeContext(customContext))
    : createBotRuntimeContext(getBotInfoSync() || {});
  const dataDir = path.resolve(
    ctx.dataDir || path.join(getProjectRoot(), "mybot", "instances", ctx.uid || "admin", "data")
  );
  const resolved = path.resolve(dataDir, safeName);
  if (!resolved.startsWith(dataDir + path.sep)) {
    throw new Error("Invalid bot data file path");
  }
  return resolved;
}

let cacheSaveJob = null;

export const cacheState = {
  data: {
    youtube: {},
    tiktok: {},
    zingmp3: {},
    soundcloud: {},
    nhaccuatui: {},
  },
  hasChanges: false,
};

function getEntryLatestTimestamp(entry) {
  if (!entry || typeof entry !== "object") return 0;
  let latest = Number(entry.timestamp || entry.ts) || 0;
  for (const [subKey, subVal] of Object.entries(entry)) {
    if (METADATA_KEYS.has(subKey)) continue;
    if (subVal && typeof subVal === "object") {
      const subTs = Number(subVal.timestamp || subVal.ts) || 0;
      if (subTs > latest) latest = subTs;
    }
  }
  return latest;
}

export function pruneLinkPlatformCache(now = Date.now()) {
  let pruned = false;
  const cutoff = now - LINK_CACHE_TTL_MS;

  for (const platform of Object.keys(cacheState.data)) {
    const entries = cacheState.data[platform];
    if (!entries || typeof entries !== "object") continue;

    for (const contentId of Object.keys(entries)) {
      const entry = entries[contentId];
      if (!entry || typeof entry !== "object") {
        delete entries[contentId];
        pruned = true;
        continue;
      }

      // 1. Prune quality sub-entries (3-level nested structure: platform -> id -> quality)
      let remainingSubEntries = 0;
      let hadSubEntries = false;
      for (const [subKey, subVal] of Object.entries(entry)) {
        if (METADATA_KEYS.has(subKey)) continue;
        if (subVal && typeof subVal === "object") {
          hadSubEntries = true;
          const subTs = Number(subVal.timestamp || subVal.ts) || 0;
          if (!subVal.fileUrl || (subTs > 0 && subTs < cutoff)) {
            delete entry[subKey];
            pruned = true;
          } else {
            remainingSubEntries += 1;
          }
        }
      }

      // 2. Prune top-level entry if expired or if all quality sub-entries expired
      const topTs = Number(entry.timestamp || entry.ts) || 0;
      const hasTopUrl = Boolean(entry.fileUrl);
      if (hasTopUrl && topTs > 0 && topTs < cutoff) {
        if (remainingSubEntries === 0) {
          delete entries[contentId];
        } else {
          delete entry.fileUrl;
          delete entry.timestamp;
        }
        pruned = true;
      } else if (!hasTopUrl && (hadSubEntries || remainingSubEntries === 0) && remainingSubEntries === 0) {
        delete entries[contentId];
        pruned = true;
      }
    }

    // 3. Enforce max 2,000 entries per platform (oldest first)
    const remainingKeys = Object.keys(entries);
    if (remainingKeys.length > MAX_LINK_CACHE_ENTRIES) {
      remainingKeys
        .sort((a, b) => getEntryLatestTimestamp(entries[a]) - getEntryLatestTimestamp(entries[b]))
        .slice(0, remainingKeys.length - MAX_LINK_CACHE_ENTRIES)
        .forEach((k) => {
          delete entries[k];
        });
      pruned = true;
    }
  }

  if (pruned) cacheState.hasChanges = true;
  return pruned;
}

async function loadCache(customContext = null) {
  const cacheFilePath = resolveBotDataFilePath("cache-link.json", customContext);
  try {
    let rawData = null;
    try {
      rawData = await fs.readFile(cacheFilePath, "utf8");
    } catch {
      const ctx = customContext
        ? (customContext.dataDir ? customContext : createBotRuntimeContext(customContext))
        : createBotRuntimeContext(getBotInfoSync() || {});
      if ((ctx.uid || "admin") === "admin" && fsSync.existsSync(LEGACY_CACHE_FILE_PATH)) {
        rawData = await fs.readFile(LEGACY_CACHE_FILE_PATH, "utf8");
      } else {
        throw new Error("Cache file missing");
      }
    }
    const parsed = JSON.parse(rawData.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cacheState.data = {
        youtube: {},
        tiktok: {},
        zingmp3: {},
        soundcloud: {},
        nhaccuatui: {},
        ...parsed,
      };
    }
    pruneLinkPlatformCache();
    console.log(chalk.magentaBright("Đã nạp dữ liệu cache từ file thành công"));
  } catch (error) {
    await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
    await fs.writeFile(cacheFilePath, JSON.stringify(cacheState.data, null, 2), "utf8");
  }
}

export async function saveCache(customContext = null) {
  const cacheFilePath = resolveBotDataFilePath("cache-link.json", customContext);
  let tmpPath = null;
  try {
    pruneLinkPlatformCache();
    await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
    tmpPath = `${cacheFilePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await fs.writeFile(tmpPath, JSON.stringify(cacheState.data), "utf8");
    await fs.rename(tmpPath, cacheFilePath);
    tmpPath = null;
    cacheState.hasChanges = false;
  } catch (error) {
    console.error("Lỗi khi ghi file cache:", error);
  } finally {
    if (tmpPath) {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}

function flushCacheSyncOnExit() {
  if (!cacheState.hasChanges) return;
  let tmpPath = null;
  try {
    const cacheFilePath = resolveBotDataFilePath("cache-link.json");
    pruneLinkPlatformCache();
    fsSync.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    tmpPath = `${cacheFilePath}.tmp-${process.pid}-${Date.now()}`;
    fsSync.writeFileSync(tmpPath, JSON.stringify(cacheState.data), "utf8");
    fsSync.renameSync(tmpPath, cacheFilePath);
    tmpPath = null;
    cacheState.hasChanges = false;
  } catch {
    // ignore exit flush errors
  } finally {
    try {
      if (tmpPath && fsSync.existsSync(tmpPath)) fsSync.unlinkSync(tmpPath);
    } catch {}
  }
}

process.once("beforeExit", flushCacheSyncOnExit);
process.once("exit", flushCacheSyncOnExit);

async function checkAndSaveChanges() {
  if (cacheState.hasChanges) {
    cacheState.hasChanges = false;
    await saveCache();
  }
}

export async function initializeCacheService() {
  await loadCache();

  if (cacheSaveJob) {
    try { cacheSaveJob.cancel(); } catch {}
  }
  cacheSaveJob = schedule.scheduleJob("*/30 * * * * *", async () => {
    await checkAndSaveChanges();
  });

  console.log(chalk.magentaBright("Khởi động service quản lý cache link platform hoàn tất"));
}

export function stopCacheService() {
  if (cacheSaveJob) {
    try { cacheSaveJob.cancel(); } catch {}
    cacheSaveJob = null;
  }
  flushCacheSyncOnExit();
}

function getCacheData(platform, id) {
  if (!cacheState.data[platform]) return null;
  const cache = cacheState.data[platform][id];
  if (!cache) return null;
  return cache;
}

export async function getCachedMedia(platform, id, quality = null, title = null) {
  const isValid = await validateCache(platform, id, quality);
  if (!isValid) return null;

  const cachedData = getCacheData(platform, id);
  if (!cachedData) return null;
  if (title && (!cachedData.title || cachedData.title !== title)) {
    cachedData.title = title;
    cacheState.hasChanges = true;
  }
  const linkChoose = quality ? cachedData[quality] : cachedData;

  return {
    fileUrl: linkChoose.fileUrl,
    thumbnail: linkChoose.thumbnail,
    fileSize: linkChoose.fileSize,
    title: linkChoose.title || cachedData.title,
    platform: linkChoose.platform || platform,
    width: linkChoose.width || cachedData.width,
    height: linkChoose.height || cachedData.height,
    duration: linkChoose.duration || cachedData.duration,
  };
}

export async function setCacheData(platform, id, data, quality = null) {
  if (!cacheState.data[platform]) cacheState.data[platform] = {};
  if (!cacheState.data[platform][id]) cacheState.data[platform][id] = {};

  const payload = { ...data };
  if (payload.title) {
    if (!cacheState.data[platform][id].title || cacheState.data[platform][id].title !== payload.title) {
      cacheState.data[platform][id].title = payload.title;
    }
    delete payload.title;
  }

  if (payload.artist) {
    if (!cacheState.data[platform][id].artist || cacheState.data[platform][id].artist !== payload.artist) {
      cacheState.data[platform][id].artist = payload.artist;
    }
    delete payload.artist;
  }

  if (quality) {
    cacheState.data[platform][id][quality] = {
      ...payload,
      timestamp: Date.now(),
    };
  } else {
    cacheState.data[platform][id] = {
      ...cacheState.data[platform][id],
      ...payload,
      timestamp: Date.now(),
    };
  }

  cacheState.hasChanges = true;
}

export async function putInCache(platform, id, data, quality = null, customContext = null) {
  await setCacheData(platform, id, data, quality);
  await saveCache(customContext);
}

function deleteCacheData(platform, id, quality = null) {
  if (!cacheState.data[platform]?.[id]) return;

  if (quality) {
    delete cacheState.data[platform][id][quality];
    const remainingDataKeys = Object.keys(cacheState.data[platform][id]).filter((k) => !METADATA_KEYS.has(k) || k === "fileUrl");
    if (remainingDataKeys.length === 0) {
      delete cacheState.data[platform][id];
    }
  } else {
    delete cacheState.data[platform][id];
  }

  cacheState.hasChanges = true;
}

async function validateCache(platform, id, quality = null) {
  const cacheEntry = getCacheData(platform, id);
  if (!cacheEntry) return false;

  const linkChoose = quality ? cacheEntry[quality] : cacheEntry;
  if (!linkChoose || !linkChoose.fileUrl) return false;

  const ts = Number(linkChoose.timestamp || linkChoose.ts) || 0;
  if (ts > 0 && Date.now() - ts >= LINK_CACHE_TTL_MS) {
    deleteCacheData(platform, id, quality);
    return false;
  }

  const isValid = await checkUrlStatus(linkChoose.fileUrl);
  if (!isValid) {
    deleteCacheData(platform, id, quality);
    return false;
  }

  return true;
}
