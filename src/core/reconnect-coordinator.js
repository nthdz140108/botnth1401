const DEFAULT_BACKOFF_MS = [5000, 15000, 30000, 60000];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createReconnectCoordinator(options = {}) {
  const {
    backoffSchedule = DEFAULT_BACKOFF_MS,
    jitterRatio = 0.2,
    stableResetMs = 15_000,
    getApi: initialGetApi = null,
    onReconnect,
    logger = console,
    clock = () => Date.now(),
  } = options;

  let currentGetApi = typeof initialGetApi === "function" ? initialGetApi : null;
  if (typeof onReconnect !== "function") throw new Error("onReconnect callback is required");

  let attempts = 0;
  let timer = null;
  let stableTimer = null;
  let disposed = false;
  let paused = false;
  let connecting = false;
  let lastReason = null;
  let totalReconnects = 0;
  const listeners = new Set();

  function clearStableTimer() {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  }

  function computeDelay() {
    const rawBase = backoffSchedule[Math.min(attempts, backoffSchedule.length - 1)];
    const base = (lastReason === "duplicate_connection" && rawBase >= 1000)
      ? Math.max(rawBase, 15_000)
      : rawBase;
    const jitter = base * jitterRatio * (Math.random() * 2 - 1);
    return Math.max(1, Math.round(base + jitter));
  }

  async function attemptReconnect(reason) {
    if (disposed || paused || connecting) return;
    clearStableTimer();
    connecting = true;
    lastReason = reason || lastReason;
    const delay = computeDelay();
    attempts += 1;
    logger.warn?.(
      `[reconnect-coordinator] scheduling reconnect #${attempts} in ${delay}ms (reason=${lastReason})`
    );
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (disposed) return;
      try {
        const activeApi = typeof currentGetApi === "function" ? currentGetApi() : null;
        await onReconnect(activeApi, { attempt: attempts, reason: lastReason, timestamp: clock() });
        totalReconnects += 1;
        connecting = false;
        if (stableResetMs > 0) {
          clearStableTimer();
          stableTimer = setTimeout(() => {
            stableTimer = null;
            if (!disposed && !connecting && !timer) {
              attempts = 0;
              lastReason = null;
            }
          }, stableResetMs);
          stableTimer.unref?.();
        } else {
          attempts = 0;
          lastReason = null;
        }
      } catch (error) {
        connecting = false;
        if (error?.code === "DUPLICATE_CONNECTION" || /code 3000|another.*connection/i.test(error?.message || "")) {
          lastReason = "duplicate_connection";
        }
        logger.error?.(`[reconnect-coordinator] reconnect attempt #${attempts} failed: ${error.message}`);
        schedule(lastReason);
      }
    }, delay);
    timer.unref?.();
  }

  function schedule(reason) {
    if (disposed || paused) return false;
    if (reason === "duplicate_connection") {
      lastReason = "duplicate_connection";
    }
    if (timer || connecting) return false;
    clearStableTimer();
    attemptReconnect(reason);
    return true;
  }

  function pause() {
    paused = true;
    clearStableTimer();
    connecting = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function resume() {
    paused = false;
  }

  function notifySuccess() {
    clearStableTimer();
    attempts = 0;
    lastReason = null;
    connecting = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function reset() {
    clearStableTimer();
    attempts = 0;
    connecting = false;
    lastReason = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function dispose() {
    disposed = true;
    reset();
    listeners.clear();
  }

  function setGetApi(fn) {
    if (typeof fn === "function") {
      currentGetApi = fn;
    }
  }

  function stats() {
    return {
      attempts,
      pendingTimer: Boolean(timer),
      connecting,
      paused,
      lastReason,
      totalReconnects,
      disposed,
    };
  }

  return {
    schedule,
    notifySuccess,
    reset,
    pause,
    resume,
    dispose,
    setGetApi,
    stats,
    get isConnecting() {
      return connecting;
    },
    get isPaused() {
      return paused;
    },
  };
}
