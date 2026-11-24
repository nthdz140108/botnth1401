/**
 * Disk Cleanup Coordinator for mybot-guardian.
 *
 * Guardian is the single coordinator of automated SSD disk cleanup:
 * - Inter-process atomic lock with owner token in .runtime/disk-cleanup.lock to prevent overlap.
 * - Hourly temp cleanup under 2-observation stale policy.
 * - Periodic SSD threshold monitoring:
 *     - Warn cleanup at >= 80% (with cooldown; PM2/routine logs >= 10MB truncated).
 *     - Critical cleanup at >= 90% (with cooldown; all routine logs truncated, 7-day logs retained).
 * - End-of-day cleanup session at 23:55 (Asia/Ho_Chi_Minh), bounded by 290 seconds deadline (stops before 23:59:50).
 * - Startup catchup if the previous 23:55 session was missed (evaluates lastDailySuccessAt).
 * - Rescheduling of daily runs in finally block regardless of errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DiskCleanupService, getDiskUsage } from './disk-cleanup-service.js';
import { recordGuardianHeartbeat } from './disk-cleanup-heartbeat.js';

export const TIMEZONE = 'Asia/Ho_Chi_Minh';
export const DAILY_DEADLINE_MS = 290_000; // 290 seconds
export const STALE_LOCK_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Vietnam time is UTC+7 with no daylight saving time (always 7 hours offset).
 * 23:55:00 in Vietnam (UTC+7) corresponds exactly to 16:55:00 UTC.
 */
export function getNext2355Timestamp(fromMs = Date.now()) {
  const date = new Date(fromMs);
  // Construct today at 16:55:00 UTC
  const todayTarget = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    16, 55, 0, 0
  );

  if (fromMs < todayTarget) {
    return todayTarget;
  }
  // Otherwise tomorrow at 16:55:00 UTC
  return todayTarget + 24 * 60 * 60 * 1000;
}

export function getLast2355Timestamp(fromMs = Date.now()) {
  const date = new Date(fromMs);
  const todayTarget = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    16, 55, 0, 0
  );

  if (fromMs >= todayTarget) {
    return todayTarget;
  }
  return todayTarget - 24 * 60 * 60 * 1000;
}

export function isDailySessionMissed({ lastRunMs, nowMs = Date.now() }) {
  const last2355 = getLast2355Timestamp(nowMs);
  if (!lastRunMs) return true;
  return lastRunMs < last2355;
}

export class DiskCleanupCoordinator {
  constructor({
    projectRoot = process.cwd(),
    service = null,
    getDiskUsage: customGetDiskUsage = null,
    lockPath = null,
    warnPercent = 80,
    criticalPercent = 90,
    cooldownMs = 30 * 60 * 1000,
    hourlyIntervalMs = 60 * 60 * 1000,
    checkIntervalMs = 60_000,
    heartbeatIntervalMs = 60_000,
    logger = console,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.service = service || new DiskCleanupService({ projectRoot: this.projectRoot, now, logger });
    this.getDiskUsage = customGetDiskUsage || (() => getDiskUsage(this.projectRoot));
    this.lockPath = lockPath || path.join(this.projectRoot, '.runtime', 'disk-cleanup.lock');
    this.warnPercent = warnPercent;
    this.criticalPercent = criticalPercent;
    this.cooldownMs = cooldownMs;
    this.hourlyIntervalMs = hourlyIntervalMs;
    this.checkIntervalMs = checkIntervalMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;

    this.lastWarnTrigger = 0;
    this.lastCriticalTrigger = 0;
    this.isRunning = false;

    this._dailyTimer = null;
    this._hourlyTimer = null;
    this._thresholdTimer = null;
    this._heartbeatTimer = null;
  }

  /**
   * Record guardian heartbeat to decouple process liveness from cleanup result.
   */
  recordHeartbeat(opts = {}) {
    try {
      const { syncStatus = false, ...hbOpts } = opts;
      const hb = recordGuardianHeartbeat({
        projectRoot: this.projectRoot,
        pid: process.pid,
        nowMs: this.now(),
        ...hbOpts,
      });

      if (syncStatus && this.service?.statusPath && fs.existsSync(this.service.statusPath)) {
        try {
          const raw = fs.readFileSync(this.service.statusPath, 'utf8');
          const st = JSON.parse(raw);
          st.guardianHeartbeatAt = hb.guardianHeartbeatAt;
          if (!st.nextDailyRunAt) {
            st.nextDailyRunAt = new Date(getNext2355Timestamp(this.now())).toISOString();
          }
          fs.writeFileSync(this.service.statusPath, JSON.stringify(st, null, 2), 'utf8');
        } catch {}
      }
      return hb;
    } catch (err) {
      this.logger.warn?.(`[DISK-CLEANUP] Failed to record heartbeat: ${err.message}`);
      return null;
    }
  }

  _ensureBaselineStatus() {
    const statusPath = this.service?.statusPath || path.join(this.projectRoot, '.runtime', 'disk-cleanup', 'status.json');
    if (!fs.existsSync(statusPath)) {
      const nowIso = new Date(this.now()).toISOString();
      const baseline = {
        schemaVersion: 1,
        status: 'idle',
        inventoryComplete: true,
        guardianHeartbeatAt: nowIso,
        lastRun: null,
        lastAttemptAt: null,
        lastSuccessfulRunAt: null,
        lastDailySuccessAt: null,
        lastHourlySuccessAt: null,
        lastThresholdRunAt: null,
        trigger: 'startup_baseline',
        nextDailyRunAt: new Date(getNext2355Timestamp(this.now())).toISOString(),
        nextScheduledRun: new Date(getNext2355Timestamp(this.now())).toISOString(),
        bytesFreedTotal: 0,
        filesFreedTotal: 0,
      };
      try {
        const dir = path.dirname(statusPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(statusPath, JSON.stringify(baseline, null, 2), 'utf8');
      } catch {}
    }
  }

  /**
   * Acquire cross-process lock atomically with an owner token.
   */
  _acquireLock() {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const nowMs = this.now();
    const token = `${process.pid}-${nowMs}-${Math.random().toString(36).slice(2, 9)}`;
    const lockPayload = JSON.stringify({ pid: process.pid, timestamp: nowMs, token });

    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      fs.writeFileSync(fd, lockPayload, 'utf8');
      fs.closeSync(fd);
      return { acquired: true, token, pid: process.pid };
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Lock already exists. Check if stale.
        try {
          const content = fs.readFileSync(this.lockPath, 'utf8');
          const data = JSON.parse(content);
          const age = nowMs - (data.timestamp || 0);

          if (age > STALE_LOCK_MS) {
            this.logger.warn(`[DISK-CLEANUP] Breaking stale lock from PID ${data.pid} (age: ${Math.round(age / 1000)}s)`);
            fs.unlinkSync(this.lockPath);
            const fd = fs.openSync(this.lockPath, 'wx');
            fs.writeFileSync(fd, lockPayload, 'utf8');
            fs.closeSync(fd);
            return { acquired: true, token, pid: process.pid };
          }
          return { acquired: false, pid: data.pid, token: data.token };
        } catch {
          // If reading failed, attempt re-create
          try {
            fs.unlinkSync(this.lockPath);
            const fd = fs.openSync(this.lockPath, 'wx');
            fs.writeFileSync(fd, lockPayload, 'utf8');
            fs.closeSync(fd);
            return { acquired: true, token, pid: process.pid };
          } catch {
            return { acquired: false, reason: 'contended' };
          }
        }
      }
      return { acquired: false, error: err.message };
    }
  }

  _releaseLock(token) {
    if (!token) return;
    try {
      if (fs.existsSync(this.lockPath)) {
        const raw = fs.readFileSync(this.lockPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.token === token) {
          fs.unlinkSync(this.lockPath);
        } else {
          this.logger.warn(`[DISK-CLEANUP] Refusing to release lock: token mismatch (lock held by ${data.token}, caller has ${token})`);
        }
      }
    } catch (err) {
      this.logger.error('[DISK-CLEANUP] Failed to release lock:', err.message);
    }
  }

  /**
   * Execute cleanup under the cross-process lock.
   */
  async executeWithLock({
    trigger = 'manual_run',
    deadlineMs = DAILY_DEADLINE_MS,
    scope = 'all',
  } = {}) {
    const lock = this._acquireLock();
    if (!lock.acquired) {
      this.logger.warn(`[DISK-CLEANUP] Lock held by PID ${lock.pid || 'unknown'}; skipping ${trigger}`);
      return { success: false, reason: 'lock_held', pid: lock.pid, status: 'partial' };
    }

    try {
      this.logger.log(`[DISK-CLEANUP] Starting cleanup session: trigger=${trigger}, deadline=${deadlineMs / 1000}s`);
      const result = await this.service.run({ trigger, deadlineMs, scope });
      this.logger.log(`[DISK-CLEANUP] Completed ${trigger}: status=${result.status}, freed ${(result.bytesFreed / (1024 * 1024)).toFixed(1)}MB across ${result.filesFreed} files in ${result.durationMs}ms`);
      return result;
    } finally {
      this.recordHeartbeat({ syncStatus: true });
      this._releaseLock(lock.token);
    }
  }

  /**
   * Execute media-temp cleanup pass specifically for .mp3/.mp4 files under cross-process lock.
   */
  async executeMediaTempWithLock({
    dryRun = false,
    deadlineMs = 60_000,
  } = {}) {
    const lock = this._acquireLock();
    if (!lock.acquired) {
      this.logger.warn(`[DISK-CLEANUP] Lock held by PID ${lock.pid || 'unknown'}; skipping media-temp cleanup`);
      return {
        status: 'partial',
        inventoryComplete: false,
        reason: 'lock_held',
        pid: lock.pid,
        candidateFiles: 0,
        candidateBytes: 0,
        deletedFiles: 0,
        deletedBytes: 0,
        deferred: [],
        protectedSkipped: 0,
        errors: [{ error: `Lock held by PID ${lock.pid}` }],
      };
    }

    try {
      this.logger.log(`[DISK-CLEANUP] Starting media-temp cleanup: dryRun=${dryRun}, deadline=${deadlineMs / 1000}s`);
      const result = await this.service.cleanMediaTemp({ dryRun, deadlineMs });
      this.logger.log(`[DISK-CLEANUP] Completed media-temp cleanup: status=${result.status}, deleted=${result.deletedFiles} files (${(result.deletedBytes / (1024 * 1024)).toFixed(2)}MB), deferred=${result.deferred.length}`);
      return result;
    } finally {
      this.recordHeartbeat({ syncStatus: true });
      this._releaseLock(lock.token);
    }
  }

  /**
   * Check SSD thresholds (80% warn, 90% critical) with cooldowns.
   */
  async checkDiskThresholds() {
    this.recordHeartbeat();
    try {
      const disk = await this.getDiskUsage();
      const usedPercent = disk.usedPercent || 0;
      const nowMs = this.now();

      if (usedPercent >= this.criticalPercent) {
        if (nowMs - this.lastCriticalTrigger >= this.cooldownMs) {
          this.lastCriticalTrigger = nowMs;
          this.lastWarnTrigger = nowMs; // Critical resets warn cooldown
          return await this.executeWithLock({
            trigger: 'disk_threshold_critical_90',
            deadlineMs: DAILY_DEADLINE_MS,
          });
        }
      } else if (usedPercent >= this.warnPercent) {
        if (nowMs - this.lastWarnTrigger >= this.cooldownMs) {
          this.lastWarnTrigger = nowMs;
          return await this.executeWithLock({
            trigger: 'disk_threshold_warn_80',
            deadlineMs: DAILY_DEADLINE_MS,
          });
        }
      }
    } catch (err) {
      this.logger.error('[DISK-CLEANUP] Threshold check failed:', err.message);
    }
    return null;
  }

  /**
   * Check if the most recent daily 23:55 session was missed and run catchup.
   * Only evaluates lastDailySuccessAt so hourly runs never mask catchup!
   */
  async checkStartupCatchup() {
    try {
      const status = this.service.status ? this.service.status() : null;
      const lastDailySuccessAt = status?.lastDailySuccessAt;
      const lastRunMs = lastDailySuccessAt ? new Date(lastDailySuccessAt).getTime() : null;
      const nowMs = this.now();

      if (isDailySessionMissed({ lastRunMs, nowMs })) {
        this.logger.log('[DISK-CLEANUP] Last 23:55 session was missed; running startup catchup...');
        return await this.executeWithLock({
          trigger: 'startup_catchup',
          deadlineMs: DAILY_DEADLINE_MS,
        });
      }
    } catch (err) {
      this.logger.error('[DISK-CLEANUP] Startup catchup check failed:', err.message);
    }
    return null;
  }

  /**
   * Schedule next daily 23:55 run. Rescheduling always occurs in finally.
   */
  _scheduleNextDaily() {
    if (!this.isRunning) return;
    const nowMs = this.now();
    const next2355 = getNext2355Timestamp(nowMs);
    const delay = Math.max(1000, next2355 - nowMs);

    this.logger.log(`[DISK-CLEANUP] Next 23:55 session scheduled in ${Math.round(delay / 60000)} minutes`);

    this._dailyTimer = this.setTimeoutFn(async () => {
      try {
        await this.executeWithLock({
          trigger: 'schedule_daily_2355',
          deadlineMs: DAILY_DEADLINE_MS,
        });
      } catch (err) {
        this.logger.error('[DISK-CLEANUP] Scheduled daily session error:', err.message);
      } finally {
        this._scheduleNextDaily();
      }
    }, delay);

    if (this._dailyTimer?.unref) this._dailyTimer.unref();
  }

  /**
   * Start guardian disk cleanup coordinator.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Initialize baseline status and record initial heartbeat
    this._ensureBaselineStatus();
    this.recordHeartbeat();

    // 2. Periodic guardian heartbeat timer
    this._heartbeatTimer = this.setIntervalFn(() => {
      if (!this.isRunning) return;
      this.recordHeartbeat();
    }, this.heartbeatIntervalMs);
    if (this._heartbeatTimer?.unref) this._heartbeatTimer.unref();

    // 3. Startup catchup check (evaluates lastDailySuccessAt)
    this.checkStartupCatchup().catch(() => {});

    // 4. Schedule daily 23:55 session
    this._scheduleNextDaily();

    // 5. Hourly temp cleanup
    this._hourlyTimer = this.setIntervalFn(async () => {
      if (!this.isRunning) return;
      this.recordHeartbeat();
      await this.executeWithLock({
        trigger: 'hourly_temp',
        scope: 'temp_only',
        deadlineMs: 60_000,
      });
    }, this.hourlyIntervalMs);
    if (this._hourlyTimer?.unref) this._hourlyTimer.unref();

    // 6. Periodic threshold check
    this._thresholdTimer = this.setIntervalFn(async () => {
      if (!this.isRunning) return;
      await this.checkDiskThresholds();
    }, this.checkIntervalMs);
    if (this._thresholdTimer?.unref) this._thresholdTimer.unref();
  }

  /**
   * Stop coordinator and all timers.
   */
  stop() {
    this.isRunning = false;
    if (this._heartbeatTimer) {
      this.clearIntervalFn(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._dailyTimer) {
      this.clearTimeoutFn(this._dailyTimer);
      this._dailyTimer = null;
    }
    if (this._hourlyTimer) {
      this.clearIntervalFn(this._hourlyTimer);
      this._hourlyTimer = null;
    }
    if (this._thresholdTimer) {
      this.clearIntervalFn(this._thresholdTimer);
      this._thresholdTimer = null;
    }
  }
}
