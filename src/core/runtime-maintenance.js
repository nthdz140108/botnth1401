import { pruneLinkPlatformCache, saveCache as saveLinkPlatformCache } from "../utils/link-platform-cache.js";
import { imageBufferCache } from "../utils/image-buffer-cache.js";
import { pruneMessageCache, flushMessageCache } from "../utils/message-cache.js";
import { sweepUnleasedTempFiles } from "../utils/temp-lease-manager.js";
import { pruneTemporaryTrainingData, flushTrainingData } from "../service-debug/chat-bot/bot-learning/dqt-bot.js";
import { flushAllGroupSettingsSync, readGroupSettings, writeGroupSettings } from "../utils/group-settings-store.js";
import { getGlobalStateClaimRegistry } from "./state-claim-registry.js";

function pruneExpiredMutesInGroupSettings(nowMs = Date.now()) {
  try {
    const settings = readGroupSettings();
    if (!settings || typeof settings !== "object") return 0;
    const nowSec = Math.floor(nowMs / 1000);
    let removed = 0;
    for (const groupCfg of Object.values(settings)) {
      const muteList = groupCfg?.muteList;
      if (!muteList || typeof muteList !== "object") continue;
      for (const [uid, entry] of Object.entries(muteList)) {
        const timeMute = Number(entry?.timeMute);
        // timeMute === -1 means permanent mute until !unmute; > 0 means Unix seconds expiry
        if (Number.isFinite(timeMute) && timeMute > 0 && timeMute <= nowSec) {
          delete muteList[uid];
          removed += 1;
        }
      }
    }
    if (removed > 0) {
      writeGroupSettings(settings);
    }
    return removed;
  } catch {
    return 0;
  }
}

export function createRuntimeMaintenance(options = {}) {
  const {
    stores = {},
    caches = {},
    workers = null,
    spool = null,
    sqlite = null,
    botUid = null,
    enableDiskTempSweep = false,
    timezone = "Asia/Ho_Chi_Minh",
    clock = () => Date.now(),
    logger = console,
  } = options;

  let lastPreMidnightResult = null;
  let lastMidnightResetResult = null;
  let lastContinuousPruneResult = null;
  let isRunning = false;

  async function runContinuousPrune(now = clock()) {
    const startedAt = now;
    const result = {
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      pruned: {},
      errors: [],
    };

    try {
      // 1. Message Cache & Store Prune (>24h, preserves !antiundo within 24h)
      try {
        if (typeof caches.message?.prune === "function") {
          caches.message.prune(now);
        } else {
          pruneMessageCache(now);
        }
        if (typeof stores.message?.prune === "function") {
          await stores.message.prune(now);
        }
        if (typeof stores.violation?.prune === "function") {
          await stores.violation.prune(now);
        }
        if (spool && typeof spool.prune === "function") {
          await spool.prune({ ackedOnly: true });
        }
        result.pruned.messageCache = "ok";
      } catch (err) {
        result.errors.push(`messageCache: ${err.message}`);
      }

      // 2. Link Platform Cache Prune (7d TTL, max 2000/platform)
      try {
        if (typeof caches.link?.prune === "function") {
          caches.link.prune(now);
        } else {
          pruneLinkPlatformCache(now);
        }
        result.pruned.linkCache = "ok";
      } catch (err) {
        result.errors.push(`linkCache: ${err.message}`);
      }

      // 3. Auto-chat temporary training prune (7d TTL, 100% preserves !learn)
      try {
        if (typeof stores.training?.prune === "function") {
          await stores.training.prune(now);
        } else if (enableDiskTempSweep) {
          pruneTemporaryTrainingData(now);
        }
        result.pruned.trainingTemp = "ok";
      } catch (err) {
        result.errors.push(`trainingTemp: ${err.message}`);
      }

      // 4. Image Buffer Cache Prune
      try {
        if (typeof caches.image?.cleanup === "function") {
          caches.image.cleanup(now);
        } else if (typeof caches.image?.prune === "function") {
          caches.image.prune(now);
        } else {
          imageBufferCache.cleanup(now);
        }
        result.pruned.imageCache = "ok";
      } catch (err) {
        result.errors.push(`imageCache: ${err.message}`);
      }

      // 5. Group Settings Cache & Expired Mute Prune
      try {
        if (typeof caches.group?.purgeStale === "function") {
          caches.group.purgeStale();
          result.pruned.groupCache = "ok";
        }
        if (enableDiskTempSweep) {
          pruneExpiredMutesInGroupSettings(now);
        }
      } catch (err) {
        result.errors.push(`groupCache: ${err.message}`);
      }

      // 6. Cooldown Cache Prune
      try {
        if (typeof caches.cooldown?.prune === "function") {
          caches.cooldown.prune(now);
          result.pruned.cooldownCache = "ok";
        }
      } catch (err) {
        result.errors.push(`cooldownCache: ${err.message}`);
      }

      // 7. State Claim Registry Prune
      try {
        const claims = stores.stateClaims || getGlobalStateClaimRegistry();
        claims.prune(now);
        result.pruned.stateClaims = "ok";
      } catch (err) {
        result.errors.push(`stateClaims: ${err.message}`);
      }

      // 8. Lease-aware Temp File Sweep (only unleased files > 30 minutes old)
      if (enableDiskTempSweep) {
        try {
          const sweepRes = await sweepUnleasedTempFiles({ now });
          result.pruned.tempSweep = sweepRes.deletedFiles;
        } catch (err) {
          result.errors.push(`tempSweep: ${err.message}`);
        }
      }

      // 9. Workers idle prune
      try {
        if (workers && typeof workers.pruneIdle === "function") {
          await workers.pruneIdle();
          result.pruned.workers = "ok";
        }
      } catch (err) {
        result.errors.push(`workers: ${err.message}`);
      }

      // 10. Optional checkpoint hook
      try {
        if (sqlite && typeof sqlite.checkpoint === "function") {
          sqlite.checkpoint();
          result.pruned.sqliteCheckpoint = "ok";
        }
      } catch (err) {
        result.errors.push(`sqliteCheckpoint: ${err.message}`);
      }

      result.completedAt = new Date(clock()).toISOString();
      result.durationMs = clock() - startedAt;
      result.ok = result.errors.length === 0;
      lastContinuousPruneResult = result;
      return result;
    } catch (err) {
      result.ok = false;
      result.errors.push(`continuousPrune: ${err.message}`);
      return result;
    }
  }

  async function runPreMidnight() {
    if (isRunning) return { ok: false, reason: "already_running" };
    isRunning = true;
    const startedAt = clock();
    const result = {
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      timezone,
      steps: {},
      errors: [],
    };

    try {
      // 1. Flush rank/training/message/group stores
      try {
        if (typeof stores.rank?.flush === "function") await stores.rank.flush();
        if (typeof stores.training?.flush === "function") await stores.training.flush();
        else if (enableDiskTempSweep) flushTrainingData();
        if (typeof stores.message?.flush === "function") await stores.message.flush();
        else if (enableDiskTempSweep) flushMessageCache();
        if (typeof stores.sqlite?.flush === "function") await stores.sqlite.flush();
        if (enableDiskTempSweep) flushAllGroupSettingsSync();
        result.steps.flushStores = "done";
      } catch (err) {
        result.errors.push(`flushStores: ${err.message}`);
        result.steps.flushStores = "failed";
      }

      // 2. Prune acknowledged spool records (compatibility hook)
      try {
        if (spool && typeof spool.prune === "function") {
          const pruneRes = await spool.prune({ ackedOnly: true });
          result.steps.pruneSpool = pruneRes || "done";
        } else {
          result.steps.pruneSpool = "skipped";
        }
      } catch (err) {
        result.errors.push(`pruneSpool: ${err.message}`);
        result.steps.pruneSpool = "failed";
      }

      // 3. Prune LRU / link / image / group / cooldown / training caches
      try {
        if (typeof caches.message?.prune === "function") caches.message.prune(startedAt);
        else pruneMessageCache(startedAt);
        if (typeof stores.message?.prune === "function") await stores.message.prune(startedAt);
        if (typeof stores.violation?.prune === "function") await stores.violation.prune(startedAt);
        if (typeof caches.link?.prune === "function") caches.link.prune(startedAt);
        else pruneLinkPlatformCache(startedAt);
        if (enableDiskTempSweep) {
          pruneTemporaryTrainingData(startedAt);
          pruneExpiredMutesInGroupSettings(startedAt);
          await saveLinkPlatformCache().catch(() => {});
          await sweepUnleasedTempFiles({ now: startedAt }).catch(() => {});
        }
        if (typeof caches.image?.cleanup === "function") caches.image.cleanup(startedAt);
        else if (typeof caches.image?.prune === "function") caches.image.prune(startedAt);
        else imageBufferCache.cleanup(startedAt);
        if (typeof caches.group?.purgeStale === "function") caches.group.purgeStale();
        if (typeof caches.cooldown?.prune === "function") caches.cooldown.prune(startedAt);
        result.steps.pruneCaches = "done";
      } catch (err) {
        result.errors.push(`pruneCaches: ${err.message}`);
        result.steps.pruneCaches = "failed";
      }

      // 4. Terminate/shrink idle workers
      try {
        if (workers && typeof workers.pruneIdle === "function") {
          await workers.pruneIdle();
          result.steps.workers = "pruned";
        } else {
          result.steps.workers = "skipped";
        }
      } catch (err) {
        result.errors.push(`workers: ${err.message}`);
        result.steps.workers = "failed";
      }

      // 5. Optional checkpoint hook
      try {
        if (sqlite && typeof sqlite.checkpoint === "function") {
          sqlite.checkpoint();
          result.steps.sqliteCheckpoint = "done";
        } else {
          result.steps.sqliteCheckpoint = "skipped";
        }
      } catch (err) {
        result.errors.push(`sqliteCheckpoint: ${err.message}`);
        result.steps.sqliteCheckpoint = "failed";
      }

      result.completedAt = new Date(clock()).toISOString();
      result.durationMs = clock() - startedAt;
      result.ok = result.errors.length === 0;
      lastPreMidnightResult = result;
      logger.info?.(`[runtime-maintenance] 23:59 Pre-Midnight finished in ${result.durationMs}ms with status=${result.ok ? "OK" : "WARNING"}`);
      return result;
    } finally {
      isRunning = false;
    }
  }

  async function runMidnightReset() {
    const startedAt = clock();
    const result = {
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      timezone,
      resetRank: "skipped",
      locmemPruned: 0,
      errors: [],
    };

    try {
      if (stores.rank && typeof stores.rank.reset === "function") {
        stores.rank.reset();
        result.resetRank = "done";
      } else if (stores.rank && typeof stores.rank.resetAll === "function") {
        stores.rank.resetAll();
        result.resetRank = "done";
      }
      if (botUid) {
        try {
          const { runDailyLocmemRetentionPrune } = await import("../service-debug/locmem/index.js");
          const locRes = runDailyLocmemRetentionPrune(botUid, { retentionDays: 35 });
          result.locmemPruned = locRes.removed || 0;
        } catch {}
      }
      result.completedAt = new Date(clock()).toISOString();
      result.durationMs = clock() - startedAt;
      lastMidnightResetResult = result;
      logger.info?.(`[runtime-maintenance] 00:00 Midnight Reset complete in ${result.durationMs}ms`);
      return result;
    } catch (err) {
      result.ok = false;
      result.errors.push(`midnightReset: ${err.message}`);
      logger.error?.(`[runtime-maintenance] Midnight Reset error: ${err.message}`);
      return result;
    }
  }

  async function shutdown() {
    try {
      if (typeof stores.rank?.flush === "function") await stores.rank.flush();
      if (typeof stores.training?.flush === "function") await stores.training.flush();
      else if (enableDiskTempSweep) flushTrainingData();
      if (typeof stores.message?.flush === "function") await stores.message.flush();
      else if (enableDiskTempSweep) flushMessageCache();
      if (typeof stores.sqlite?.flush === "function") await stores.sqlite.flush();
      if (enableDiskTempSweep) flushAllGroupSettingsSync();
      if (workers && typeof workers.close === "function") await workers.close();
      if (spool && typeof spool.close === "function") await spool.close();
      logger.info?.("[runtime-maintenance] shutdown flush complete");
    } catch (err) {
      logger.error?.(`[runtime-maintenance] shutdown error: ${err.message}`);
    }
  }

  function status() {
    return {
      lastPreMidnight: lastPreMidnightResult,
      lastMidnightReset: lastMidnightResetResult,
      lastContinuousPrune: lastContinuousPruneResult,
      isRunning,
      timezone,
    };
  }

  return {
    runContinuousPrune,
    runPreMidnight,
    runMidnightReset,
    shutdown,
    status,
  };
}
