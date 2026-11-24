import { getGlobalRuntimeMetrics } from "../observability/runtime-metrics.js";

export function createLongRunningHealth(options = {}) {
  const {
    metrics = getGlobalRuntimeMetrics(),
    maintenance = null,
    intervalMs = 300_000, // 5 minutes
    maxHeapMb = 450,
    maxHeapSlopeMbPerHour = 25,
    maxEventLoopDelayMs = 150,
    logger = console,
  } = options;

  let timer = null;
  let running = false;
  let consecutiveHighSlopeCount = 0;
  const history = [];

  async function checkHealth() {
    const now = Date.now();
    const snap = metrics?.snapshot?.() || {};
    const heapUsedMb = (snap.memory?.heapUsed || process.memoryUsage().heapUsed) / (1024 * 1024);
    const slopeMbPerHour = snap.memory?.slopeMbPerHour ?? 0;
    const eventLoopP99 = snap.eventLoop?.p99 ?? 0;

    const record = {
      timestamp: now,
      heapUsedMb,
      slopeMbPerHour,
      eventLoopP99,
      warnings: [],
    };

    // 1. Check Event Loop Delay
    if (eventLoopP99 > maxEventLoopDelayMs) {
      const msg = `EVENT_LOOP_LAG: p99=${eventLoopP99.toFixed(1)}ms exceeded threshold ${maxEventLoopDelayMs}ms`;
      record.warnings.push(msg);
      logger.warn?.(`[long-running-health] ${msg}`);
    }

    // 2. Check Heap Slope and Limit
    if (slopeMbPerHour > maxHeapSlopeMbPerHour) {
      consecutiveHighSlopeCount++;
      if (consecutiveHighSlopeCount >= 3) {
        const msg = `HIGH_HEAP_SLOPE: heap growing at ${slopeMbPerHour.toFixed(1)}MB/hr for ${consecutiveHighSlopeCount} consecutive windows`;
        record.warnings.push(msg);
        logger.warn?.(`[long-running-health] ${msg}. Triggering aggressive cleanup...`);
        try {
          await maintenance?.runContinuousPrune?.(now);
          if (typeof global.gc === "function") global.gc();
        } catch {}
      }
    } else {
      consecutiveHighSlopeCount = Math.max(0, consecutiveHighSlopeCount - 1);
    }

    if (heapUsedMb > maxHeapMb) {
      const msg = `HEAP_NEAR_LIMIT: heapUsed=${heapUsedMb.toFixed(1)}MB exceeded ${maxHeapMb}MB`;
      record.warnings.push(msg);
      logger.warn?.(`[long-running-health] ${msg}. Triggering aggressive cleanup...`);
      try {
        await maintenance?.runContinuousPrune?.(now);
        if (typeof global.gc === "function") global.gc();
      } catch {}
    }

    // 3. Regular 5-minute continuous pruning
    try {
      if (maintenance && typeof maintenance.runContinuousPrune === "function") {
        await maintenance.runContinuousPrune(now);
      }
    } catch (err) {
      logger.error?.(`[long-running-health] continuous prune error: ${err.message}`);
    }

    history.push(record);
    if (history.length > 100) history.shift();

    return record;
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      checkHealth().catch((err) => logger.error?.(`[long-running-health] check error: ${err.message}`));
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function status() {
    const latest = history[history.length - 1] || null;
    return {
      running,
      intervalMs,
      maxHeapMb,
      maxHeapSlopeMbPerHour,
      maxEventLoopDelayMs,
      consecutiveHighSlopeCount,
      latest,
      historyCount: history.length,
    };
  }

  return {
    start,
    stop,
    checkHealth,
    status,
  };
}
