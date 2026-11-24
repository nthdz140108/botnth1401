import { performance } from "node:perf_hooks";
import process from "node:process";
import { createLatencyTracker, getGlobalLatencyTracker } from "./latency-tracker.js";

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function emptyLatencyWindow() {
  return {
    samples: [],
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
    count: 0,
  };
}

function finalizeLatency(window) {
  const sorted = [...window.samples].sort((a, b) => a - b);
  window.p50 = percentile(sorted, 50);
  window.p95 = percentile(sorted, 95);
  window.p99 = percentile(sorted, 99);
  window.max = sorted.length ? sorted[sorted.length - 1] : 0;
  window.count = sorted.length;
  return window;
}

export function computeHeapSlope(memoryHistory = []) {
  if (memoryHistory.length < 2) return { slopeBytesPerSec: 0, slopeMbPerHour: 0 };
  const first = memoryHistory[0];
  const last = memoryHistory[memoryHistory.length - 1];
  const deltaSec = (last.timestamp - first.timestamp) / 1000;
  if (deltaSec <= 0) return { slopeBytesPerSec: 0, slopeMbPerHour: 0 };
  const deltaBytes = last.heapUsed - first.heapUsed;
  const slopeBytesPerSec = deltaBytes / deltaSec;
  const slopeMbPerHour = (slopeBytesPerSec * 3600) / (1024 * 1024);
  return {
    slopeBytesPerSec: Number(slopeBytesPerSec.toFixed(2)),
    slopeMbPerHour: Number(slopeMbPerHour.toFixed(2)),
  };
}

export function createRuntimeMetrics(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const logger = options.logger || console;
  const sampleIntervalMs = Number(options.sampleIntervalMs ?? 1000);
  const maxSamples = Number(options.maxSamples ?? 4096);
  const botId = options.botId || "admin";

  let startedAt = clock();
  let inboundTotal = 0;
  let inboundActive = 0;
  let inboundPendingMax = 0;
  let inboundByKind = new Map();
  let activeThreads = new Set();
  const unacked = new Set();
  let ackedCount = 0;
  let spoolBytes = 0;
  let spoolCount = 0;
  let spoolReplayedCount = 0;
  const outboundByOperation = new Map();
  const eventLoopWindow = emptyLatencyWindow();
  let lastMemory = { heapUsed: 0, heapTotal: 0, rss: 0, external: 0 };
  let lastLoopSampleAt = 0;
  let maintenanceStatus = { status: "idle", lastRunAt: null, lastResult: null };
  let workerStats = { count: 0, busy: 0, restarted: 0 };
  let storageMode = "json";
  let queueDepths = {};

  const memoryHistory = []; // { timestamp, heapUsed, rss }
  const MAX_MEMORY_HISTORY = 360; // 360 points (e.g. 6 hours if sampled every min, or 6 mins if 1s)

  const latencyTracker = options.latencyTracker || createLatencyTracker({ clock: performance.now, maxSamples });

  let monitorTimer = null;

  function recordLoopLag() {
    const expected = lastLoopSampleAt + sampleIntervalMs;
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    lastLoopSampleAt = now;
    eventLoopWindow.samples.push(Number(lag.toFixed(3)));
    if (eventLoopWindow.samples.length > maxSamples) {
      eventLoopWindow.samples.splice(0, eventLoopWindow.samples.length - maxSamples);
    }
    try {
      lastMemory = process.memoryUsage();
      memoryHistory.push({
        timestamp: clock(),
        heapUsed: lastMemory.heapUsed,
        rss: lastMemory.rss,
      });
      if (memoryHistory.length > MAX_MEMORY_HISTORY) {
        memoryHistory.shift();
      }
    } catch {}
  }

  function start() {
    if (monitorTimer) return;
    lastLoopSampleAt = performance.now();
    monitorTimer = setInterval(recordLoopLag, sampleIntervalMs);
    monitorTimer.unref?.();
  }

  function stop() {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function recordInbound({ kind, threadId } = {}) {
    inboundTotal += 1;
    inboundActive += 1;
    if (inboundActive > inboundPendingMax) inboundPendingMax = inboundActive;
    inboundByKind.set(kind || "unknown", (inboundByKind.get(kind || "unknown") || 0) + 1);
    if (threadId !== undefined && threadId !== null) activeThreads.add(String(threadId));
  }

  function recordAck({ eventId } = {}) {
    inboundActive = Math.max(0, inboundActive - 1);
    ackedCount += 1;
    if (eventId !== undefined && eventId !== null) unacked.delete(String(eventId));
  }

  function trackPending(eventId) {
    if (eventId !== undefined && eventId !== null) unacked.add(String(eventId));
  }

  function recordSpool({ eventId, bytes = 0 } = {}) {
    spoolCount += 1;
    spoolBytes += Number(bytes) || 0;
    if (eventId !== undefined && eventId !== null) unacked.add(String(eventId));
  }

  function recordSpoolReplay(count = 1) {
    spoolReplayedCount += Number(count) || 0;
  }

  function recordOutbound({ operation, status, durationMs = 0 } = {}) {
    const key = operation || "unknown";
    const entry = outboundByOperation.get(key) || { total: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0, byStatus: {} };
    entry.total += 1;
    entry.totalDurationMs += Number(durationMs) || 0;
    entry.maxDurationMs = Math.max(entry.maxDurationMs, Number(durationMs) || 0);
    const statusKey = status || "unknown";
    entry.byStatus[statusKey] = (entry.byStatus[statusKey] || 0) + 1;
    if (status && status !== "success" && status !== "ok") entry.errors += 1;
    outboundByOperation.set(key, entry);
  }

  function setMaintenance(status) {
    maintenanceStatus = { ...maintenanceStatus, ...status, updatedAt: new Date().toISOString() };
  }

  function setWorkers(stats) {
    workerStats = { ...workerStats, ...stats };
  }

  function setStorageMode(mode) {
    storageMode = mode || storageMode;
  }

  function setQueueDepth(name, depth) {
    queueDepths[name] = depth;
  }

  function resetWindow() {
    startedAt = clock();
    inboundTotal = 0;
    inboundActive = 0;
    inboundPendingMax = 0;
    inboundByKind = new Map();
    ackedCount = 0;
    unacked.clear();
    spoolCount = 0;
    spoolReplayedCount = 0;
    outboundByOperation.clear();
    eventLoopWindow.samples = [];
    queueDepths = {};
  }

  function snapshot() {
    finalizeLatency(eventLoopWindow);
    const outbound = {};
    for (const [operation, entry] of outboundByOperation) {
      outbound[operation] = {
        total: entry.total,
        errors: entry.errors,
        avgDurationMs: entry.total ? Number((entry.totalDurationMs / entry.total).toFixed(2)) : 0,
        maxDurationMs: entry.maxDurationMs,
        byStatus: { ...entry.byStatus },
      };
    }
    const byKind = {};
    for (const [kind, count] of inboundByKind) byKind[kind] = count;

    const slope = computeHeapSlope(memoryHistory);
    const latencySnapshot = latencyTracker?.snapshot ? latencyTracker.snapshot(botId) : {};

    return {
      botId,
      windowStartedAt: new Date(startedAt).toISOString(),
      sampledAt: new Date(clock()).toISOString(),
      eventLoop: {
        p50: Number(eventLoopWindow.p50.toFixed(2)),
        p95: Number(eventLoopWindow.p95.toFixed(2)),
        p99: Number(eventLoopWindow.p99.toFixed(2)),
        max: Number(eventLoopWindow.max.toFixed(2)),
        samples: eventLoopWindow.count,
      },
      memory: {
        heapUsed: lastMemory.heapUsed || 0,
        heapTotal: lastMemory.heapTotal || 0,
        rss: lastMemory.rss || 0,
        external: lastMemory.external || 0,
        slopeBytesPerSec: slope.slopeBytesPerSec,
        slopeMbPerHour: slope.slopeMbPerHour,
      },
      inbound: {
        total: inboundTotal,
        active: inboundActive,
        pendingMax: inboundPendingMax,
        activeThreads: activeThreads.size,
        unacked: unacked.size,
        byKind,
      },
      ack: {
        total: ackedCount,
      },
      spool: {
        count: spoolCount,
        bytes: spoolBytes,
        replayed: spoolReplayedCount,
      },
      outbound,
      latency: latencySnapshot,
      queues: { ...queueDepths },
      workers: { ...workerStats },
      storage: { mode: storageMode },
      maintenance: { ...maintenanceStatus },
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        uptimeSec: Number(process.uptime().toFixed(1)),
      },
    };
  }

  return {
    botId,
    start,
    stop,
    recordInbound,
    recordAck,
    trackPending,
    recordSpool,
    recordSpoolReplay,
    recordOutbound,
    setMaintenance,
    setWorkers,
    setStorageMode,
    setQueueDepth,
    resetWindow,
    snapshot,
    latencyTracker,
    getMemoryHistory: () => [...memoryHistory],
  };
}

const healthProviders = new Map();

export function registerHealthProvider(name, provider) {
  if (typeof provider !== "function") throw new Error("health provider must be a function");
  healthProviders.set(name, provider);
}

export function unregisterHealthProvider(name) {
  healthProviders.delete(name);
}

export async function collectHealthExtensions() {
  const extensions = {};
  for (const [name, provider] of healthProviders) {
    try {
      extensions[name] = await provider();
    } catch (error) {
      extensions[name] = { error: error.message };
    }
  }
  return extensions;
}

const botMetricsRegistry = new Map();
let globalMetrics = null;

export function getBotRuntimeMetrics(botId = "admin", options = {}) {
  const key = String(botId || "admin");
  if (!botMetricsRegistry.has(key)) {
    const metrics = createRuntimeMetrics({ ...options, botId: key });
    metrics.start();
    botMetricsRegistry.set(key, metrics);
  }
  return botMetricsRegistry.get(key);
}

export function getGlobalRuntimeMetrics(options = {}) {
  if (!globalMetrics) {
    globalMetrics = createRuntimeMetrics(options);
    globalMetrics.start();
    registerHealthProvider("runtime", () => globalMetrics.snapshot());
  }
  return globalMetrics;
}

export function buildRuntimeFingerprint({ botId = null, commit = null, storageMode = "json" } = {}) {
  return {
    pid: process.pid,
    botId,
    commit: commit || process.env.GIT_COMMIT || null,
    nodeVersion: process.version,
    platform: process.platform,
    storageMode,
    startedAt: new Date().toISOString(),
  };
}
