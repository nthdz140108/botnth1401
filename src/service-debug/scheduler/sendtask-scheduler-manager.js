import schedule from "node-schedule";

function defaultScheduleJob(cron, timezone, task) {
  return schedule.scheduleJob(cron, timezone ? { rule: cron, tz: timezone } : cron, task);
}

function defaultCancelJob(handle) {
  if (handle && typeof handle.cancel === "function") {
    handle.cancel();
    return true;
  }
  return false;
}

export class SendTaskSchedulerManager {
  constructor({ scheduleJob = defaultScheduleJob, cancelJob = defaultCancelJob, logger = console } = {}) {
    this.scheduleJob = scheduleJob;
    this.cancelJob = cancelJob;
    this.logger = logger;
    this.handles = new Map();
    this.desired = new Map();
    this.snapshot = null;
    this.revision = 0;
    this.lastSync = null;
    this.paused = false;
  }

  diff(desiredSchedules) {
    const desired = new Map(desiredSchedules.map((row) => [row.id, row]));
    const toSchedule = [];
    const toCancel = [];
    let unchanged = 0;
    for (const [id, row] of desired) {
      const current = this.desired.get(id);
      if (!current || !sameSchedule(current, row)) toSchedule.push(row);
      else unchanged += 1;
    }
    for (const id of this.desired.keys()) {
      if (!desired.has(id)) toCancel.push(id);
    }
    return { toSchedule, toCancel, unchanged };
  }

  async sync(desiredSchedules, { taskFactory } = {}) {
    const factory = taskFactory || this.defaultTaskFactory;
    const previousHandles = new Map(this.handles);
    const previousDesired = new Map(this.desired);
    const errors = [];
    let scheduled = 0;
    let cancelled = 0;
    try {
      for (const row of desiredSchedules) {
        const currentHandle = this.handles.get(row.id);
        const currentRow = this.desired.get(row.id);
        if (currentRow && currentHandle && sameSchedule(currentRow, row)) continue;
        if (currentHandle) {
          this.cancelJob(currentHandle);
          this.handles.delete(row.id);
          cancelled += 1;
        }
        const handle = this.scheduleJob(row.cron, row.timezone || null, () => {
          Promise.resolve()
            .then(() => factory(row))
            .catch((error) => this.logger.error?.(`[sendtask] job ${row.id} failed:`, error.message));
        });
        this.handles.set(row.id, handle);
        this.desired.set(row.id, cloneRow(row));
        scheduled += 1;
      }
      for (const [id, handle] of [...this.handles]) {
        if (!desiredSchedules.some((row) => row.id === id)) {
          this.cancelJob(handle);
          this.handles.delete(id);
          this.desired.delete(id);
          cancelled += 1;
        }
      }
      this.snapshot = { handles: previousHandles, desired: previousDesired };
      this.revision += 1;
      this.lastSync = { at: new Date().toISOString(), scheduled, cancelled, revision: this.revision };
      return { scheduled, cancelled, unchanged: desiredSchedules.length - scheduled, revision: this.revision };
    } catch (error) {
      await this.restoreSnapshot(previousHandles, previousDesired);
      errors.push(error.message);
      const syncError = new Error(`sendtask sync failed (${errors.join("; ")}); rolled back to previous schedules`);
      syncError.code = "SENDTASK_SYNC_FAILED";
      throw syncError;
    }
  }

  async rollback() {
    if (!this.snapshot) return { rolledBack: false, reason: "no-snapshot" };
    await this.restoreSnapshot(this.snapshot.handles, this.snapshot.desired);
    this.desired = new Map(this.snapshot.desired);
    this.revision += 1;
    const restored = this.snapshot;
    this.snapshot = null;
    return { rolledBack: true, jobs: restored.desired.size, revision: this.revision };
  }

  restoreSnapshot(handles, desired) {
    for (const handle of this.handles.values()) {
      try {
        this.cancelJob(handle);
      } catch {}
    }
    this.handles = new Map();
    for (const [id, row] of desired) {
      try {
        const handle = this.scheduleJob(row.cron, row.timezone || null, () => {
          Promise.resolve().then(() => (this.defaultTaskFactory ? this.defaultTaskFactory(row) : undefined)).catch(() => {});
        });
        this.handles.set(id, handle);
      } catch (error) {
        this.logger?.error?.(`[sendtask] rollback reschedule failed for ${id}:`, error.message);
      }
    }
    this.desired = new Map(desired);
  }

  pause() {
    for (const [id, handle] of this.handles) {
      try {
        this.cancelJob(handle);
      } catch {}
    }
    this.handles.clear();
    this.paused = true;
  }

  async resume(desiredSchedules = null) {
    this.paused = false;
    const target = desiredSchedules || [...this.desired.values()];
    return this.sync(target);
  }

  status() {
    return {
      revision: this.revision,
      jobs: [...this.handles.keys()].sort(),
      lastSync: this.lastSync,
      paused: this.paused,
    };
  }

  bindTaskFactory(factory) {
    this.defaultTaskFactory = factory;
  }
}

function sameSchedule(a, b) {
  return a.cron === b.cron
    && a.enabled === b.enabled
    && (a.timezone || null) === (b.timezone || null)
    && a.kind === b.kind
    && (a.category || "") === (b.category || "")
    && (a.queryTemplate || "") === (b.queryTemplate || "")
    && String(a.caption ?? "") === String(b.caption ?? "")
    && Number(a.ttlMinutes || 0) === Number(b.ttlMinutes || 0)
    // Thay đổi cấu hình fallback phải reschedule để job mới dùng đúng nguồn dự phòng
    && (a.fallbackKind ?? "") === (b.fallbackKind ?? "")
    && (a.fallbackCategory || "") === (b.fallbackCategory || "");
}

function cloneRow(row) {
  return JSON.parse(JSON.stringify(row));
}

export function createSendtaskSchedulerManager(options = {}) {
  globalThis.__sendtaskSchedulerManager = new SendTaskSchedulerManager(options);
  return globalThis.__sendtaskSchedulerManager;
}

/**
 * Get-or-create: startup tạo đúng một manager cho mỗi process;
 * các lần reload sau đó tái sử dụng manager hiện có để sync,
 * tránh sinh bộ job thứ hai gây gửi trùng.
 */
export function getOrCreateSendtaskSchedulerManager(options = {}) {
  const existing = globalThis.__sendtaskSchedulerManager;
  if (existing instanceof SendTaskSchedulerManager) {
    return existing;
  }
  return createSendtaskSchedulerManager(options);
}
