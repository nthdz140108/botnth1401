import PQueue from "p-queue";

export function createWorkloadBroker(options = {}) {
  const {
    botId = "admin",
    metrics = null,
    maxFastConcurrent = 16,
    maxFastQueueSize = 200,
    maxHeavyConcurrent = 2,
    maxHeavyQueueSize = 30,
    maxBroadcastConcurrent = 3,
    maxBroadcastQueueSize = 30,
    controlTimeoutMs = 10000,
    heavyTimeoutMs = 120000,
    broadcastTimeoutMs = 60000,
    logger = console,
  } = options;

  let closed = false;
  let paused = false;
  let nextJobSeq = 0;

  // Fast queue: high concurrency for lightweight text/lookup commands, bounded backlog
  const fastQueue = new PQueue({ concurrency: maxFastConcurrent });

  // Heavy queue: only for ACKed background work (ffmpeg, downloads, large uploads)
  const heavyQueue = new PQueue({ concurrency: maxHeavyConcurrent });

  // Broadcast queue: dedicated for SendTask / bulk
  const broadcastQueue = new PQueue({ concurrency: maxBroadcastConcurrent });

  // Control queue: highest priority, never blocked by fast/heavy/broadcast
  const controlQueue = new PQueue({ concurrency: 16 });

  const statsCounters = {
    fastRuns: 0,
    fastRejected: 0,
    controlRuns: 0,
    heavySubmitted: 0,
    heavyCompleted: 0,
    heavyFailed: 0,
    heavyRejected: 0,
    broadcastSubmitted: 0,
    broadcastCompleted: 0,
    broadcastFailed: 0,
    broadcastRejected: 0,
  };

  function createOverloadError(lane, maxQueueSize) {
    const err = new Error(`Hệ thống đang xử lý quá nhiều tác vụ (${lane}, hàng đợi > ${maxQueueSize}). Vui lòng thử lại sau ít giây!`);
    err.code = "LANE_OVERLOADED";
    err.lane = lane;
    return err;
  }

  /**
   * Runs a lightweight text/lookup command on the fast lane with bounded concurrency & backlog.
   */
  async function runFast(kind, task) {
    if (closed) throw new Error("WorkloadBroker is closed");
    if (paused) {
      const err = new Error("WorkloadBroker is in standby mode. New tasks are rejected.");
      err.code = "BOT_STANDBY";
      throw err;
    }
    if (fastQueue.size >= maxFastQueueSize) {
      statsCounters.fastRejected++;
      throw createOverloadError("fast", maxFastQueueSize);
    }
    statsCounters.fastRuns++;
    metrics?.recordInbound?.({ kind: `fast:${kind}` });
    return fastQueue.add(() => task());
  }

  /**
   * Runs a control event (admin, moderation, reaction, undo, delete) with high priority and bounded timeout.
   */
  async function runControl(kind, task) {
    if (closed) throw new Error("WorkloadBroker is closed");
    statsCounters.controlRuns++;

    return controlQueue.add(async () => {
      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Control task ${kind} timed out after ${controlTimeoutMs}ms`);
          err.code = "CONTROL_TIMEOUT";
          reject(err);
        }, controlTimeoutMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([task(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }

  /**
   * Submits a heavy workload (yt-dlp, ffmpeg, AI, large upload).
   */
  function submitHeavy(kind, payload, task, customOptions = {}) {
    if (closed) throw new Error("WorkloadBroker is closed");
    if (paused) {
      const err = new Error("WorkloadBroker is in standby mode. Heavy tasks are rejected.");
      err.code = "BOT_STANDBY";
      const rejectedPromise = Promise.reject(err);
      rejectedPromise.catch(() => {});
      return { jobId: `heavy-standby-${Date.now()}`, promise: rejectedPromise, rejected: true };
    }
    if (heavyQueue.size >= maxHeavyQueueSize) {
      statsCounters.heavyRejected++;
      const err = createOverloadError("heavy", maxHeavyQueueSize);
      logger.warn?.(`[workload-broker] Heavy queue full (${heavyQueue.size}/${maxHeavyQueueSize}) for ${kind}`);
      const rejectedPromise = Promise.reject(err);
      rejectedPromise.catch(() => {});
      return { jobId: `heavy-rejected-${Date.now()}`, promise: rejectedPromise, rejected: true };
    }

    nextJobSeq++;
    const jobId = `heavy-${botId}-${Date.now()}-${nextJobSeq}`;
    statsCounters.heavySubmitted++;

    const timeoutMs = customOptions.timeoutMs || heavyTimeoutMs;

    const promise = heavyQueue.add(async () => {
      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Heavy task ${jobId} (${kind}) timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      });

      try {
        const result = await Promise.race([task(jobId, payload), timeoutPromise]);
        statsCounters.heavyCompleted++;
        return result;
      } catch (err) {
        statsCounters.heavyFailed++;
        logger.error?.(`[workload-broker] Heavy job ${jobId} failed: ${err.message}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });

    return { jobId, promise };
  }

  /**
   * Submits a broadcast workload (bulk message, SendTask).
   */
  function submitBroadcast(payload, task, customOptions = {}) {
    if (closed) throw new Error("WorkloadBroker is closed");
    if (paused) {
      const err = new Error("WorkloadBroker is in standby mode. Broadcast tasks are rejected.");
      err.code = "BOT_STANDBY";
      const rejectedPromise = Promise.reject(err);
      rejectedPromise.catch(() => {});
      return { jobId: `bcast-standby-${Date.now()}`, promise: rejectedPromise, rejected: true };
    }
    if (broadcastQueue.size >= maxBroadcastQueueSize) {
      statsCounters.broadcastRejected++;
      const err = createOverloadError("broadcast", maxBroadcastQueueSize);
      logger.warn?.(`[workload-broker] Broadcast queue full (${broadcastQueue.size}/${maxBroadcastQueueSize})`);
      const rejectedPromise = Promise.reject(err);
      rejectedPromise.catch(() => {});
      return { jobId: `bcast-rejected-${Date.now()}`, promise: rejectedPromise, rejected: true };
    }

    nextJobSeq++;
    const jobId = `bcast-${botId}-${Date.now()}-${nextJobSeq}`;
    statsCounters.broadcastSubmitted++;

    const timeoutMs = customOptions.timeoutMs || broadcastTimeoutMs;

    const promise = broadcastQueue.add(async () => {
      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Broadcast task ${jobId} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      });

      try {
        const result = await Promise.race([task(jobId, payload), timeoutPromise]);
        statsCounters.broadcastCompleted++;
        return result;
      } catch (err) {
        statsCounters.broadcastFailed++;
        logger.error?.(`[workload-broker] Broadcast job ${jobId} failed: ${err.message}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });

    return { jobId, promise };
  }

  function snapshot() {
    return {
      botId,
      fastQueue: {
        size: fastQueue.size,
        pending: fastQueue.pending,
        concurrency: fastQueue.concurrency,
      },
      heavyQueue: {
        size: heavyQueue.size,
        pending: heavyQueue.pending,
        concurrency: heavyQueue.concurrency,
      },
      broadcastQueue: {
        size: broadcastQueue.size,
        pending: broadcastQueue.pending,
        concurrency: broadcastQueue.concurrency,
      },
      controlQueue: {
        size: controlQueue.size,
        pending: controlQueue.pending,
        concurrency: controlQueue.concurrency,
      },
      counters: { ...statsCounters },
      closed,
      paused,
    };
  }

  function pause() {
    paused = true;
    try { fastQueue.pause(); } catch {}
    try { heavyQueue.pause(); } catch {}
    try { broadcastQueue.pause(); } catch {}
  }

  function resume() {
    paused = false;
    try { fastQueue.start(); } catch {}
    try { heavyQueue.start(); } catch {}
    try { broadcastQueue.start(); } catch {}
  }

  async function drain(timeoutMs = 5000) {
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    const idlePromise = Promise.all([
      fastQueue.onIdle(),
      heavyQueue.onIdle(),
      broadcastQueue.onIdle(),
      controlQueue.onIdle(),
    ]);
    await Promise.race([idlePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    const pendingTotal = fastQueue.pending + heavyQueue.pending + broadcastQueue.pending + controlQueue.pending;
    return {
      drained: pendingTotal === 0,
      pending: pendingTotal,
    };
  }

  async function shutdown() {
    closed = true;
    fastQueue.clear();
    heavyQueue.clear();
    broadcastQueue.clear();
    controlQueue.clear();
    await Promise.all([
      fastQueue.onIdle(),
      heavyQueue.onIdle(),
      broadcastQueue.onIdle(),
      controlQueue.onIdle(),
    ]);
  }

  return {
    botId,
    runFast,
    runControl,
    submitHeavy,
    submitBroadcast,
    snapshot,
    pause,
    resume,
    drain,
    get isPaused() {
      return paused;
    },
    shutdown,
  };
}
