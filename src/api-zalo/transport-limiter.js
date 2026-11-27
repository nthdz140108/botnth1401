import PQueue from "p-queue";
import Bottleneck from "bottleneck";
import { bindRequestPolicy } from "./request-policy.js";

export const LANE_CONFIGS = Object.freeze({
  "fast-text": {
    maxConcurrent: Number(process.env.OUTBOUND_FAST_MAX_CONCURRENT || 8),
    minTime: Number(process.env.OUTBOUND_FAST_MIN_TIME_MS || 0),
    highWater: 500,
  },
  control: {
    maxConcurrent: Number(process.env.OUTBOUND_CONTROL_MAX_CONCURRENT || 8),
    minTime: Number(process.env.OUTBOUND_CONTROL_MIN_TIME_MS || 0),
    highWater: 500,
  },
  heavy: {
    maxConcurrent: Number(process.env.OUTBOUND_HEAVY_MAX_CONCURRENT || 2),
    minTime: Number(process.env.OUTBOUND_HEAVY_MIN_TIME_MS || 50),
    highWater: 100,
  },
  broadcast: {
    maxConcurrent: Number(process.env.OUTBOUND_BROADCAST_MAX_CONCURRENT || 3),
    minTime: Number(process.env.OUTBOUND_BROADCAST_MIN_TIME_MS || 50),
    highWater: 200,
  },
});

export const METHOD_TO_LANE = Object.freeze({
  sendMessage: "fast-text",
  sendPrivate: "fast-text",
  sendSticker: "fast-text",
  sendCustomSticker: "fast-text",
  sendImage: "fast-text",
  sendFile: "fast-text",
  sendGif: "fast-text",

  addReaction: "control",
  deleteMessage: "control",
  undoMessage: "control",
  zDeleteMessage: "control",

  uploadAttachment: "heavy",
  sendVideo: "heavy",
  sendVoice: "heavy",
  uploadThumbnail: "heavy",
  zSendLocalImage: "heavy",
  zSendLocalImages: "heavy",

  sendMessageForward: "broadcast",
  sendTodo: "broadcast",
  sendToDo: "broadcast",
  sendBankCard: "broadcast",
});

const limitersByApi = new WeakMap();
const allActiveLaneLimiters = new Set();

export function createLaneLimiter(laneName, config = {}) {
  const baseConfig = LANE_CONFIGS[laneName] || LANE_CONFIGS["fast-text"];
  const maxConcurrent = Number(config?.maxConcurrent ?? baseConfig.maxConcurrent);
  const minTime = Number(config?.minTime ?? baseConfig.minTime);

  let rejectedCount = 0;
  let adaptiveBackoffMs = 0;
  let backoffUntil = 0;

  // For zero-tick immediate concurrency (fast-text / control), use PQueue
  const queue = new PQueue({ concurrency: maxConcurrent });

  // For spacing / backoff when minTime > 0 or adaptive backoff active
  let lastDispatchedAt = 0;

  function notifyRateLimit(retryAfterMs = 2000) {
    adaptiveBackoffMs = Math.min(30000, Math.max(500, retryAfterMs));
    backoffUntil = Date.now() + adaptiveBackoffMs;
    setTimeout(() => {
      if (Date.now() >= backoffUntil) {
        adaptiveBackoffMs = 0;
      }
    }, adaptiveBackoffMs + 100).unref?.();
  }

  async function schedule(task) {
    return queue.add(bindRequestPolicy(async () => {
      // 1. Check adaptive backoff
      const now = Date.now();
      if (now < backoffUntil) {
        const delay = backoffUntil - now;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // 2. Check minTime spacing if configured
      if (minTime > 0) {
        const timeSinceLast = Date.now() - lastDispatchedAt;
        if (timeSinceLast < minTime) {
          await new Promise((resolve) => setTimeout(resolve, minTime - timeSinceLast));
        }
      }

      lastDispatchedAt = Date.now();
      return task();
    }));
  }

  function counts() {
    return {
      QUEUED: queue.size,
      RUNNING: queue.pending,
      EXECUTING: queue.pending,
      DONE: 0,
    };
  }

  function getStats() {
    return {
      lane: laneName,
      maxConcurrent,
      minTime,
      adaptiveBackoffMs,
      queued: queue.size,
      running: queue.pending,
      executing: queue.pending,
      rejectedCount,
    };
  }

  const limiterProxy = {
    schedule,
    counts,
    updateSettings: () => {},
    on: () => {},
  };

  return {
    lane: laneName,
    limiter: limiterProxy,
    schedule,
    notifyRateLimit,
    getStats,
    counts,
  };
}

export function createApiTransportLanes(options = {}) {
  // Support options passed as { "fast-text": {...} } OR legacy top-level { maxConcurrent, minTime }
  const topLevelConfig = {};
  if (options.maxConcurrent !== undefined) topLevelConfig.maxConcurrent = options.maxConcurrent;
  if (options.minTime !== undefined) topLevelConfig.minTime = options.minTime;

  const lanes = {
    "fast-text": createLaneLimiter("fast-text", { ...topLevelConfig, ...options["fast-text"] }),
    control: createLaneLimiter("control", { ...topLevelConfig, ...options.control }),
    heavy: createLaneLimiter("heavy", { ...topLevelConfig, ...options.heavy }),
    broadcast: createLaneLimiter("broadcast", { ...topLevelConfig, ...options.broadcast }),
  };

  const laneSetItem = {
    getStats: () => {
      const res = {};
      for (const [k, l] of Object.entries(lanes)) {
        res[k] = l.getStats();
      }
      return res;
    },
  };
  allActiveLaneLimiters.add(laneSetItem);

  return {
    lanes,
    getLane: (laneName) => lanes[laneName] || lanes["fast-text"],
    getStats: laneSetItem.getStats,
  };
}

export function isDeliveryRejection(error) {
  const code = Number(error?.code ?? error?.error_code ?? NaN);
  if ([-200, -201, -202, -203, -204].includes(code)) return true;
  if (error?.name === "SendMessageFailedException") return true;
  if (error?.name === "ZaloApiError" && String(error?.message).includes("Tham số không hợp lệ")) return true;
  return false;
}

export function getTransportLimiterFor(api, options = {}) {
  if (!api) throw new Error("api instance is required");
  if (!limitersByApi.has(api)) {
    limitersByApi.set(api, createApiTransportLanes(options));
  }
  return limitersByApi.get(api);
}

export function wrapWithLimiter(api, options = {}) {
  const transportLanes = getTransportLimiterFor(api, options);
  const wrappedMethods = [];

  for (const [method, laneName] of Object.entries(METHOD_TO_LANE)) {
    const original = api[method];
    if (typeof original !== "function" || original.__transportLimited) continue;

    const lane = transportLanes.getLane(laneName);

    const limited = function (...args) {
      return lane.schedule(async () => {
        try {
          return await original.apply(api, args);
        } catch (error) {
          const status = Number(error?.status ?? error?.statusCode ?? NaN);
          const code = Number(error?.code ?? error?.error_code ?? NaN);

          if (status === 429 || code === 429) {
            lane.notifyRateLimit(2000);
          }

          if (isDeliveryRejection(error)) {
            error.__deliveryRejection = true;
          }
          throw error;
        }
      });
    };

    Object.defineProperty(limited, "__transportLimited", { value: true });
    Object.defineProperty(limited, "__original", { value: original });
    Object.defineProperty(limited, "__lane", { value: laneName });
    if (typeof original.prepare === "function") limited.prepare = original.prepare.bind(api);
    api[method] = limited;
    wrappedMethods.push(method);
  }

  // Also support .limiter for backward compatibility with tests checking api limiter
  const primaryLimiter = transportLanes.getLane("fast-text");

  return {
    wrappedMethods,
    limiter: primaryLimiter.limiter,
    stats: transportLanes.getStats,
  };
}

export function getTransportLimiterStats() {
  const summary = {
    configured: true,
    lanes: {
      "fast-text": { queued: 0, running: 0, rejectedCount: 0 },
      control: { queued: 0, running: 0, rejectedCount: 0 },
      heavy: { queued: 0, running: 0, rejectedCount: 0 },
      broadcast: { queued: 0, running: 0, rejectedCount: 0 },
    },
    totalQueued: 0,
    totalRunning: 0,
  };

  for (const item of allActiveLaneLimiters) {
    try {
      const stats = item.getStats();
      for (const [laneName, lStats] of Object.entries(stats)) {
        if (!summary.lanes[laneName]) summary.lanes[laneName] = { queued: 0, running: 0, rejectedCount: 0 };
        summary.lanes[laneName].queued += lStats.queued;
        summary.lanes[laneName].running += lStats.running;
        summary.lanes[laneName].rejectedCount += lStats.rejectedCount;
        summary.totalQueued += lStats.queued;
        summary.totalRunning += lStats.running;
      }
    } catch {}
  }

  return summary;
}

export function __isDeliveryRejection(error) {
  return isDeliveryRejection(error);
}

// Backward compatibility helper
export function createTransportLimiter(options = {}) {
  const lane = createLaneLimiter("fast-text", options);
  return {
    limiter: lane.limiter,
    stats: lane,
    getStats: lane.getStats,
  };
}
