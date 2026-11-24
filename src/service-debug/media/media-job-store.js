import EventEmitter from "node:events";

export class MediaJobStore extends EventEmitter {
  constructor({ maxConcurrent = 2, defaultTimeoutMs = 120000, maxRetries = 2 } = {}) {
    super();
    this.maxConcurrent = maxConcurrent;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxRetries = maxRetries;
    this.jobs = new Map(); // id -> job
    this.runningCount = 0;
    this.handlers = new Map(); // type -> executor fn
  }

  registerHandler(type, handlerFn) {
    this.handlers.set(type, handlerFn);
  }

  submitJob({ id, type, payload = {}, timeoutMs = null, priority = 0 }) {
    const jobId = id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.jobs.has(jobId)) {
      return this.jobs.get(jobId);
    }

    const job = {
      id: jobId,
      type,
      payload,
      status: "queued",
      priority,
      retries: 0,
      maxRetries: this.maxRetries,
      timeoutMs: timeoutMs || this.defaultTimeoutMs,
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };

    this.jobs.set(jobId, job);
    this.emit("queued", job);
    this._processNext();
    return job;
  }

  async waitForJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status === "succeeded") return job.result;
    if (job.status === "failed") throw new Error(job.error || "Job failed");
    if (job.status === "cancelled") throw new Error("Job was cancelled");

    return new Promise((resolve, reject) => {
      const onDone = (updated) => {
        if (updated.id === jobId) {
          this.off("succeeded", onDone);
          this.off("failed", onDone);
          this.off("cancelled", onDone);
          if (updated.status === "succeeded") resolve(updated.result);
          else if (updated.status === "failed") reject(new Error(updated.error || "Job failed"));
          else reject(new Error("Job cancelled"));
        }
      };
      this.on("succeeded", onDone);
      this.on("failed", onDone);
      this.on("cancelled", onDone);
    });
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "queued" || job.status === "running") {
      job.status = "cancelled";
      job.completedAt = Date.now();
      if (job.status === "running") this.runningCount = Math.max(0, this.runningCount - 1);
      this.emit("cancelled", job);
      this._processNext();
      return true;
    }
    return false;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async _processNext() {
    if (this.runningCount >= this.maxConcurrent) return;

    const queued = [...this.jobs.values()]
      .filter((j) => j.status === "queued")
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    if (queued.length === 0) return;
    const job = queued[0];
    const handler = this.handlers.get(job.type);

    if (!handler) {
      job.status = "failed";
      job.error = `No handler registered for job type: ${job.type}`;
      job.completedAt = Date.now();
      this.emit("failed", job);
      return this._processNext();
    }

    job.status = "running";
    job.startedAt = Date.now();
    this.runningCount++;
    this.emit("running", job);

    const timeoutPromise = new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Media job ${job.id} timed out after ${job.timeoutMs}ms`)), job.timeoutMs);
      t.unref?.();
    });

    try {
      const result = await Promise.race([handler(job.payload), timeoutPromise]);
      job.status = "succeeded";
      job.result = result;
      job.completedAt = Date.now();
      this.emit("succeeded", job);
    } catch (err) {
      if (job.retries < job.maxRetries && !String(err.message).includes("DELIVERY_REJECTED")) {
        job.retries++;
        job.status = "queued";
        this.emit("retry", job);
      } else {
        job.status = "failed";
        job.error = err.message || String(err);
        job.completedAt = Date.now();
        this.emit("failed", job);
      }
    } finally {
      this.runningCount = Math.max(0, this.runningCount - 1);
      this._processNext();
    }
  }

  stats() {
    const all = [...this.jobs.values()];
    return {
      total: all.length,
      queued: all.filter((j) => j.status === "queued").length,
      running: all.filter((j) => j.status === "running").length,
      succeeded: all.filter((j) => j.status === "succeeded").length,
      failed: all.filter((j) => j.status === "failed").length,
      cancelled: all.filter((j) => j.status === "cancelled").length,
      concurrencyCap: this.maxConcurrent,
    };
  }

  clearFinished() {
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        this.jobs.delete(id);
      }
    }
  }
}

export const globalMediaJobStore = new MediaJobStore({ maxConcurrent: 2 });
