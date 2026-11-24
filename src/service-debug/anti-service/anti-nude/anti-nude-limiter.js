import { performance } from "node:perf_hooks";

export class AntiNudeTaskLimiter {
  constructor({ maxConcurrency = 2, maxQueueSize = 32 } = {}) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueueSize = maxQueueSize;
    this.runningCount = 0;
    this.queue = [];
    this.drainResolvers = [];
  }

  get stats() {
    return {
      running: this.runningCount,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      maxQueueSize: this.maxQueueSize,
    };
  }

  async run(taskFn) {
    if (this.queue.length >= this.maxQueueSize) {
      const err = new Error(`ANTI_NUDE_OVERLOADED: Queue capacity of ${this.maxQueueSize} exceeded (running: ${this.runningCount})`);
      err.code = "OVERLOADED";
      throw err;
    }

    if (this.runningCount < this.maxConcurrency) {
      this.runningCount++;
      return this._execute(taskFn, 0);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        taskFn,
        enqueuedAt: performance.now(),
        resolve,
        reject,
      });
    });
  }

  async _execute(taskFn, queueWaitMs) {
    try {
      return await taskFn({ queueWaitMs: Number(queueWaitMs.toFixed(2)) });
    } finally {
      this.runningCount--;
      this._drain();
      this._checkIdle();
    }
  }

  _drain() {
    if (this.queue.length === 0 || this.runningCount >= this.maxConcurrency) {
      return;
    }
    const next = this.queue.shift();
    if (!next) return;

    this.runningCount++;
    const queueWaitMs = performance.now() - next.enqueuedAt;
    this._execute(next.taskFn, queueWaitMs)
      .then(next.resolve)
      .catch(next.reject);
  }

  _checkIdle() {
    if (this.runningCount === 0 && this.queue.length === 0) {
      while (this.drainResolvers.length > 0) {
        const resolve = this.drainResolvers.shift();
        resolve?.();
      }
    }
  }

  async drain() {
    if (this.runningCount === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  clear() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      const err = new Error("Limiter cleared");
      err.code = "CLEARED";
      item.reject(err);
    }
    this._checkIdle();
  }
}
