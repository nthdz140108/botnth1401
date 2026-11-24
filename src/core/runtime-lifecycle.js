import path from "node:path";
import { fileURLToPath } from "node:url";
import schedule from "node-schedule";
import { createInboundDispatcher } from "./inbound-dispatcher.js";
import { createFastPathDispatcher } from "./fast-path-dispatcher.js";
import { createWorkloadBroker } from "./workload-broker.js";
import { createReconnectCoordinator } from "./reconnect-coordinator.js";
import { createNativeProcessPool } from "./native-process-pool.js";
import { createRuntimeMaintenance } from "./runtime-maintenance.js";
import { createLongRunningHealth } from "./long-running-health.js";
import { MediaJobStore } from "../service-debug/media/media-job-store.js";
import { processMediaTask } from "../workers/media-worker.js";
import { getBotRuntimeMetrics, registerHealthProvider } from "../observability/runtime-metrics.js";
import { getTransportLimiterStats } from "../api-zalo/transport-limiter.js";
import { getListenerRuntimeState } from "../runtime/listener-state.js";
import { getResourceProfile } from "../utils/resource-profile.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";
import { getRankStore } from "../service-debug/info-service/rank-store.js";
import { getMessageCacheStore } from "../utils/message-cache.js";
import { stopCacheService } from "../utils/link-platform-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultWorkersDir = path.resolve(__dirname, "..", "workers");

const botLifecycles = new Map();

function createLightweightInboundCoordinator({ concurrency = 32 } = {}) {
  return {
    spoolStore: null,
    async replay() {
      return { replayed: 0 };
    },
    async close() {},
    stats() {
      return {
        concurrency,
        panicked: false,
        queued: 0,
      };
    },
  };
}

export async function createRuntimeLifecycle(options = {}) {
  const {
    projectRoot = process.cwd(),
    botName = "admin",
    api = null,
    handlers = {},
    nsfwProcessPath = path.join(defaultWorkersDir, "nsfw-process.js"),
    canvasProcessPath = path.join(defaultWorkersDir, "canvas-process.js"),
    logger = console,
    refreshSession = null,
    onListenerReconnected = null,
    reconnectBackoffSchedule = [5000, 15000, 30000, 60000],
    reconnectStableResetMs = 15_000,
  } = options;

  if (botLifecycles.has(botName)) {
    const existing = botLifecycles.get(botName);
    if (refreshSession || onListenerReconnected) {
      existing.setReconnectHooks?.({ refreshSession, onListenerReconnected });
    }
    return existing;
  }

  const profile = getResourceProfile(botName);

  // 1. Native Child Process Pools (Canvas & NSFW)
  const nsfwProcessPool = createNativeProcessPool({
    entrypoint: nsfwProcessPath,
    maxProcesses: profile.workers.maxProcesses,
    initialProcesses: profile.workers.initialProcesses,
    onDemand: profile.workers.onDemand,
    idleTimeoutMs: profile.workers.idleTimeoutMs,
    taskTimeoutMs: 15000,
    logger,
  });

  const canvasProcessPool = createNativeProcessPool({
    entrypoint: canvasProcessPath,
    maxProcesses: profile.workers.maxProcesses,
    initialProcesses: profile.workers.initialProcesses,
    onDemand: profile.workers.onDemand,
    idleTimeoutMs: profile.workers.idleTimeoutMs,
    taskTimeoutMs: 30000,
    logger,
  });

  // 2. Media Job Store
  const mediaJobStore = new MediaJobStore({ maxConcurrent: 2, defaultTimeoutMs: 120000 });
  mediaJobStore.registerHandler("extractFrame", (payload) => processMediaTask("extractFrame", payload));
  mediaJobStore.registerHandler("convertWebp", (payload) => processMediaTask("convertWebp", payload));
  mediaJobStore.registerHandler("probeDuration", (payload) => processMediaTask("probeDuration", payload));

  // 3. Pure-JS Storage Layer (Zero SQLite / Zero Disk Spool)
  const botRuntimeCtx = getRuntimeContext(botName, { projectRoot });
  const rankStore = getRankStore(botRuntimeCtx, { projectRoot, logger });
  const messageStore = getMessageCacheStore(botRuntimeCtx);
  const stores = {
    storageMode: "json",
    rankStore,
    messageStore,
    violationStore: null,
    sqliteRuntime: null,
    async close() {
      await rankStore.close?.();
      await messageStore.close?.();
    },
  };

  // 4. Metrics & Dispatchers
  if (api) {
    api.messageStore = messageStore;
    api.botKey = botName;
    api.runtimeContext = botRuntimeCtx;
  }
  const metrics = getBotRuntimeMetrics(botName);
  const fastPathDispatcher = createFastPathDispatcher({
    api,
    botId: botName,
    messageStore,
    handlers,
    metrics,
    logger,
  });
  const dispatcher = createInboundDispatcher({ api, handlers, logger });

  // 5. Workload Broker
  const workloadBroker = createWorkloadBroker({
    botId: botName,
    metrics,
    maxFastConcurrent: 16,
    maxHeavyConcurrent: 3,
    maxBroadcastConcurrent: 3,
    logger,
  });

  // 6. Lightweight Inbound Coordinator Compatibility Shim
  const inboundCoordinator = createLightweightInboundCoordinator({
    concurrency: Number(process.env.INBOUND_SHARDS || 32),
  });

  // 7. Reconnect Coordinator
  let activeApi = api;
  let activeRefreshSession = typeof refreshSession === "function" ? refreshSession : null;
  let activeOnListenerReconnected = typeof onListenerReconnected === "function" ? onListenerReconnected : null;

  const reconnectCoordinator = createReconnectCoordinator({
    backoffSchedule: reconnectBackoffSchedule,
    jitterRatio: 0.2,
    stableResetMs: reconnectStableResetMs,
    getApi: () => activeApi,
    onReconnect: async (currApi, meta = {}) => {
      const attempt = Number(meta?.attempt || 1);
      const reason = meta?.reason || "closed";
      logger.info?.(`[runtime-lifecycle] Reconnecting listener for bot '${botName}' (attempt #${attempt}, reason=${reason})...`);

      const endpointCount = Array.isArray(currApi?.listener?.wsEndpoints)
        ? currApi.listener.wsEndpoints.length
        : 1;
      const reloginThreshold = endpointCount > 1 ? 3 : 2;
      const shouldRefreshSession =
        typeof activeRefreshSession === "function" &&
        reason !== "duplicate_connection" &&
        attempt >= reloginThreshold &&
        (attempt - reloginThreshold) % 2 === 0;

      let targetApi = currApi;
      if (shouldRefreshSession) {
        try {
          logger.info?.(`[runtime-lifecycle] Refreshing Zalo login session for bot '${botName}' before WS reconnect (attempt #${attempt})...`);
          const refreshedApi = await activeRefreshSession(currApi, { attempt, reason });
          if (refreshedApi) {
            targetApi = refreshedApi;
            activeApi = refreshedApi;
          }
        } catch (refreshErr) {
          logger.warn?.(`[runtime-lifecycle] Session refresh failed for '${botName}': ${refreshErr.message}; falling back to direct WS reconnect`);
        }
      }

      if (!targetApi?.listener) {
        throw new Error("Active API listener is unavailable");
      }

      const rotateEndpoint = attempt > 1 && !shouldRefreshSession;
      if (typeof targetApi.listener.startAsync === "function") {
        const res = await targetApi.listener.startAsync({ rotateEndpoint });
        try {
          getListenerRuntimeState().markConnectedForGeneration(res?.generation);
        } catch {}
      } else if (typeof targetApi.listener.start === "function") {
        await targetApi.listener.start();
        try {
          getListenerRuntimeState().markConnected();
        } catch {}
      } else {
        throw new Error("Listener does not expose startAsync or start");
      }

      if (typeof activeOnListenerReconnected === "function") {
        try {
          await activeOnListenerReconnected(targetApi, { attempt, reason });
        } catch {}
      }
    },
    logger,
  });

  // 8. Runtime Maintenance (Zero-Conflict 4-Tier Prune + Unleased Temp Sweep)
  const maintenance = createRuntimeMaintenance({
    stores: {
      rank: rankStore,
      message: messageStore,
      violation: null,
      sqlite: null,
    },
    workers: {
      pruneIdle: async () => {
        await nsfwProcessPool.pruneIdle();
        await canvasProcessPool.pruneIdle();
      },
      close: async () => {
        await nsfwProcessPool.close();
        await canvasProcessPool.close();
      },
    },
    spool: null,
    sqlite: null,
    botUid: botName,
    enableDiskTempSweep: true,
    logger,
  });

  // 9. Maintenance Scheduling (15m Continuous Prune, 23:59 Pre-Midnight, 00:00 Reset)
  const periodicPruneTimer = setInterval(() => {
    maintenance.runContinuousPrune().catch((err) => {
      logger.error?.(`[maintenance] continuous prune error (${botName}): ${err.message}`);
    });
  }, 15 * 60 * 1000);
  periodicPruneTimer.unref?.();

  const preMidnightJob = schedule.scheduleJob(
    `runtime_pre_midnight_${botName}`,
    { rule: "59 23 * * *", tz: "Asia/Ho_Chi_Minh" },
    () => {
      maintenance.runPreMidnight().catch((err) => logger.error?.(`[maintenance] pre-midnight error (${botName}): ${err.message}`));
    }
  );

  const midnightResetJob = schedule.scheduleJob(
    `runtime_midnight_reset_${botName}`,
    { rule: "0 0 * * *", tz: "Asia/Ho_Chi_Minh" },
    () => {
      maintenance.runMidnightReset().catch((err) => logger.error?.(`[maintenance] midnight reset error (${botName}): ${err.message}`));
    }
  );

  // 10. Long-running Health Monitor (5 minutes)
  const healthMonitor = createLongRunningHealth({
    metrics,
    maintenance,
    intervalMs: 300_000,
    logger,
  });
  healthMonitor.start();

  // 11. Health Provider Registration
  registerHealthProvider(`runtime_${botName}`, () => ({
    botId: botName,
    storageMode: stores.storageMode,
    sqlite: null,
    inbound: inboundCoordinator.stats(),
    broker: workloadBroker.snapshot(),
    dispatcher: fastPathDispatcher.stats(),
    outbound: getTransportLimiterStats(),
    reconnect: reconnectCoordinator.stats(),
    maintenance: maintenance.status(),
    health: healthMonitor.status(),
    workers: {
      nsfw: nsfwProcessPool.stats(),
      canvas: canvasProcessPool.stats(),
    },
  }));

  async function shutdown() {
    logger.info?.(`[runtime-lifecycle] Executing graceful shutdown for bot '${botName}'...`);
    clearInterval(periodicPruneTimer);
    try {
      const { shutdownLocmem } = await import("../service-debug/locmem/index.js");
      shutdownLocmem(botRuntimeCtx);
    } catch {}
    stopCacheService();
    preMidnightJob?.cancel();
    midnightResetJob?.cancel();
    healthMonitor.stop();
    await maintenance.shutdown();
    await workloadBroker.shutdown();
    await inboundCoordinator.close();
    await stores.close();
    await nsfwProcessPool.close();
    await canvasProcessPool.close();
    reconnectCoordinator.dispose();
    botLifecycles.delete(botName);
  }

  const lifecycleInstance = {
    projectRoot,
    botName,
    stores,
    dispatcher,
    fastPathDispatcher,
    workloadBroker,
    inboundCoordinator,
    reconnectCoordinator,
    nsfwProcessPool,
    canvasProcessPool,
    nsfwWorkerPool: nsfwProcessPool,
    canvasWorkerPool: canvasProcessPool,
    mediaJobStore,
    maintenance,
    healthMonitor,
    metrics,
    shutdown,
    updateApi: (newApi) => {
      activeApi = newApi;
      if (newApi) {
        newApi.messageStore = messageStore;
        newApi.botKey = botName;
        newApi.runtimeContext = botRuntimeCtx;
      }
      dispatcher.updateApi(newApi);
      fastPathDispatcher.updateApi(newApi);
      reconnectCoordinator.setGetApi(() => newApi);
    },
    setReconnectHooks: ({ refreshSession: nextRefresh, onListenerReconnected: nextOnReconnected } = {}) => {
      if (typeof nextRefresh === "function") activeRefreshSession = nextRefresh;
      if (typeof nextOnReconnected === "function") activeOnListenerReconnected = nextOnReconnected;
    },
    enterStandby: async () => {
      logger.info?.(`[runtime-lifecycle] Entering hot-standby for bot '${botName}'...`);
      reconnectCoordinator.pause?.();
      try {
        const { getOrCreateSendtaskSchedulerManager } = await import("../service-debug/scheduler/sendtask-scheduler-manager.js");
        const schedMgr = getOrCreateSendtaskSchedulerManager();
        schedMgr?.pause?.();
      } catch {}
      try {
        getListenerRuntimeState().markStandby("hot_standby");
      } catch {}
      try {
        if (activeApi?.listener) {
          if (typeof activeApi.listener.stop === "function") {
            activeApi.listener.stop();
          } else if (activeApi.listener.ws) {
            try { activeApi.listener.ws.close(); } catch {}
          }
        }
      } catch (e) {
        logger.warn?.(`[runtime-lifecycle] WS close error on standby for '${botName}': ${e.message}`);
      }
      workloadBroker.pause?.();
      const drainRes = await workloadBroker.drain?.(5000).catch(() => ({ drained: true, pending: 0 }));
      const mem = process.memoryUsage();
      return {
        status: "standby",
        drained: drainRes?.drained ?? true,
        pending: drainRes?.pending ?? 0,
        memory: {
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
          heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
          standby: true,
        },
      };
    },
    resumeFromStandby: async (_options = {}) => {
      logger.info?.(`[runtime-lifecycle] Resuming from hot-standby for bot '${botName}'...`);
      let cookie = activeApi?.cookie;
      if (!cookie) {
        try {
          const { appContext } = await import("../api-zalo/context.js");
          cookie = appContext?.cookie;
        } catch {}
      }
      if (!cookie || (typeof cookie === "object" && Object.keys(cookie).length === 0)) {
        const err = new Error(`Cookie expired or missing for bot '${botName}', cannot resume`);
        err.code = "COOKIE_EXPIRED";
        err.fallback = "QR_LOGIN_REQUIRED";
        throw err;
      }
      workloadBroker.resume?.();
      reconnectCoordinator.resume?.();
      try {
        const { getOrCreateSendtaskSchedulerManager } = await import("../service-debug/scheduler/sendtask-scheduler-manager.js");
        const schedMgr = getOrCreateSendtaskSchedulerManager();
        await schedMgr?.resume?.();
      } catch (e) {
        logger.warn?.(`[runtime-lifecycle] Scheduler resume error for '${botName}': ${e.message}`);
      }
      if (!activeApi?.listener) {
        const err = new Error(`API listener unavailable for bot '${botName}'`);
        err.code = "LISTENER_UNAVAILABLE";
        throw err;
      }
      getListenerRuntimeState().markStarting();
      let handshakeResult = null;
      if (typeof activeApi.listener.startAsync === "function") {
        handshakeResult = await activeApi.listener.startAsync({ rotateEndpoint: true });
        getListenerRuntimeState().markConnectedForGeneration(handshakeResult?.generation);
      } else if (typeof activeApi.listener.start === "function") {
        await activeApi.listener.start({ rotateEndpoint: true });
        getListenerRuntimeState().markConnected();
      }
      const mem = process.memoryUsage();
      return {
        status: "ws_ready",
        generation: handshakeResult?.generation,
        keyExchanged: Boolean(handshakeResult?.keyExchanged),
        memory: {
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
          heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
          standby: false,
        },
      };
    },
  };

  botLifecycles.set(botName, lifecycleInstance);
  return lifecycleInstance;
}

export function getActiveRuntimeLifecycle(botName = null) {
  if (botName) {
    return botLifecycles.get(String(botName)) || null;
  }
  return botLifecycles.values().next().value || null;
}

export function closeAllLifecycles() {
  const all = [...botLifecycles.values()];
  botLifecycles.clear();
  return Promise.all(all.map((l) => l.shutdown()));
}
