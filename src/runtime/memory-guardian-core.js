/**
 * Memory Guardian — pure class for memory monitoring.
 *
 * FIX: Reads normalized `state` field (was `process.state` which is empty in
 * PM2 jlist). The PM2 adapter normalizes pm2_env.status to process.state.
 *
 * FIX: Sends IPC via real flag file that the bot runtime watches (not the
 * old mechanism that was never implemented on the receiver side).
 *
 * FIX: Critical flow now does cleanup → wait 60s → remeasure → then restart
 * (not immediate restart).
 *
 * The standalone main() entry point is in memory-guardian.js.
 */

import os from 'node:os';
import { PM2Adapter, PM2ErrorCode, isMyBotProcess } from './pm2-adapter.js';
import { DiskCleanupCoordinator } from './disk-cleanup-guardian.js';
import { DiskCleanupService } from './disk-cleanup-service.js';

const DEFAULTS = {
  CHECK_INTERVAL_MS: 15_000,
  WARN_PERCENT: 80,
  CRITICAL_PERCENT: 90,
  WARN_FREE_MB: 800,
  CRITICAL_FREE_MB: 400,
  GC_COOLDOWN_MS: 5 * 60 * 1000,
  CLEANUP_WAIT_MS: 60_000,
  RESTART_WAIT_STABLE_MS: 30_000,
  CRITICAL_ACK_TIMEOUT_MS: 30_000,
};

function getEnv(key, fallback) {
  const v = process.env[key];
  if (v !== undefined) {
    const n = parseFloat(v);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

function getEnvMB(key, fallback) {
  const v = process.env[key];
  if (v !== undefined) {
    const m = String(v).match(/^([\d.]+)\s*[Mm]$/);
    if (m) return parseFloat(m[1]) * 1024 * 1024;
    const n = parseFloat(v);
    if (!isNaN(n)) return n * 1024 * 1024;
  }
  return fallback;
}

export function getSystemMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usedPercent = (used / total) * 100;
  return { total, free, used, usedPercent };
}

export function formatBytes(b) {
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

export class MemoryGuardian {
  constructor({
    projectRoot = process.cwd(),
    checkIntervalMs = null,
    adapter = null,
    enableDiskCleanup = true,
    processTreeRssFn = null,
    now = () => Date.now(),
    diskCoordinator = null,
    coordinatorOptions = {},
  } = {}) {
    this.projectRoot = projectRoot;
    this.now = now;
    this.adapter = adapter || new PM2Adapter({ projectRoot });
    this.processTreeRssFn = processTreeRssFn;
    this.diskCoordinator = diskCoordinator !== null && diskCoordinator !== undefined
      ? diskCoordinator
      : (enableDiskCleanup !== false
        ? new DiskCleanupCoordinator({
            projectRoot: this.projectRoot,
            now: this.now,
            service: new DiskCleanupService({
              projectRoot: this.projectRoot,
              adapter: this.adapter,
              now: this.now,
            }),
            ...coordinatorOptions,
          })
        : null);
    this.checkIntervalMs = checkIntervalMs ?? getEnv('MEMORY_CHECK_INTERVAL_MS', DEFAULTS.CHECK_INTERVAL_MS);
    this.warnPercent = getEnv('MEMORY_WARN_PERCENT', DEFAULTS.WARN_PERCENT);
    this.criticalPercent = getEnv('MEMORY_CRITICAL_PERCENT', DEFAULTS.CRITICAL_PERCENT);
    this.warnFreeMB = getEnvMB('MEMORY_WARN_FREE_MB', DEFAULTS.WARN_FREE_MB);
    this.criticalFreeMB = getEnvMB('MEMORY_CRITICAL_FREE_MB', DEFAULTS.CRITICAL_FREE_MB);
    this.gcCooldownMs = getEnv('MEMORY_GC_COOLDOWN_MS', DEFAULTS.GC_COOLDOWN_MS);
    this.cleanupWaitMs = getEnv('MEMORY_CLEANUP_WAIT_MS', DEFAULTS.CLEANUP_WAIT_MS);
    this.restartWaitMs = getEnv('MEMORY_RESTART_WAIT_MS', DEFAULTS.RESTART_WAIT_STABLE_MS);
    this.criticalAckTimeoutMs = getEnv('MEMORY_CRITICAL_ACK_TIMEOUT_MS', DEFAULTS.CRITICAL_ACK_TIMEOUT_MS);

    this.gcCooldowns = new Map();
    this.cleanupAttempts = new Map();
    this.lastCriticalTime = null;
    this.lastAction = null;
    this.timer = null;
    this.isRunning = false;
    this.metrics = {
      checks: 0,
      cleanups: 0,
      restarts: 0,
      skipped: 0,
      acks: 0,
      timeouts: 0,
      failures: 0,
    };
  }

  _isCooldownActive(pm2Name) {
    const last = this.gcCooldowns.get(pm2Name);
    if (!last) return false;
    return Date.now() - last < this.gcCooldownMs;
  }

  /**
   * Get MyBot fleet processes only (PM2 status normalized by adapter).
   * Uses the canonical managed inventory so processes identified only by
   * env markers (BOT_MANAGED/BOT_KEY/MYBOT_INSTANCE_KIND) or legacy registry
   * keys are all included — identification is widened, restart/cleanup
   * policy is unchanged.
   */
  async _getProcessList() {
    try {
      let botKeys = [];
      try {
        const fsMod = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const raw = await fsMod.readFile(pathMod.join(this.projectRoot, 'mybot', 'mybots.json'), 'utf8');
        botKeys = Object.keys(JSON.parse(raw.replace(/^\uFEFF/, '')) || {}).filter((key) => typeof key === 'string' && key.trim());
      } catch {}
      const procs = this.adapter.listManagedProcesses
        ? await this.adapter.listManagedProcesses({ botKeys })
        : (await this.adapter.listProcesses()).filter(isMyBotProcess);

      // Measure full process-tree RSS for each bot (PM2 root + child workers)
      try {
        if (typeof this.processTreeRssFn === "function") {
          for (const proc of procs) {
            const rawRss = proc.rss ?? proc.monit?.memory ?? 0;
            proc.treeRss = await this.processTreeRssFn(proc.pid, rawRss);
          }
        } else {
          const { getFleetProcessTreeRss } = await import('./process-tree.js');
          const pids = procs.map((p) => p.pid).filter(Boolean);
          const treeMap = await getFleetProcessTreeRss(pids);
          for (const proc of procs) {
            if (proc.pid && treeMap.has(proc.pid)) {
              proc.treeRss = treeMap.get(proc.pid);
            } else {
              proc.treeRss = proc.rss ?? proc.monit?.memory ?? 0;
            }
          }
        }
      } catch {
        for (const proc of procs) {
          proc.treeRss = proc.rss ?? proc.monit?.memory ?? 0;
        }
      }

      // Only manage MyBot processes — never touch foreign PM2 apps
      return procs;
    } catch (err) {
      if (err.code === PM2ErrorCode.DAEMON_UNAVAILABLE) {
        // Daemon is dead — record but don't crash
        this.metrics.failures++;
        return [];
      }
      throw err;
    }
  }

  /**
   * Select the highest-RSS bot eligible for cleanup (warning level).
   * Children (non-admin) are preferred; admin only as fallback.
   * Ranks by full process-tree RSS.
   */
  _selectBotForCleanup(procs) {
    const candidates = procs.filter((p) => {
      if (p.status !== 'online') return false;
      if (p.kind === 'dashboard' || p.kind === 'guardian') return false;
      if (!p.treeRss && !p.rss) return false;
      return !this._isCooldownActive(p.name);
    });
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      // Children first (kind === 'child'), then admin
      const aIsChild = a.kind === 'child' ? 0 : 1;
      const bIsChild = b.kind === 'child' ? 0 : 1;
      if (aIsChild !== bIsChild) return aIsChild - bIsChild;
      const rssA = a.treeRss || a.rss || 0;
      const rssB = b.treeRss || b.rss || 0;
      return rssB - rssA;
    });
    return candidates[0];
  }

  /**
   * Select the bot to restart at critical level.
   * Priority: child (1) > main/admin (2) > dashboard (3) > guardian (NEVER).
   * Ranks by full process-tree RSS.
   */
  _selectBotForRestart(procs) {
    if (procs.length === 0) return null;

    // Guardian must never be restarted by guardian itself
    const candidates = procs.filter((p) => p.status === 'online' && p.kind !== 'guardian');
    if (candidates.length === 0) return null;

    const priority = (p) => {
      if (p.kind === 'child') return 1;
      if (p.kind === 'main') return 2;
      if (p.kind === 'dashboard') return 3;
      return 9;
    };

    candidates.sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      const rssA = a.treeRss || a.rss || 0;
      const rssB = b.treeRss || b.rss || 0;
      return rssB - rssA;
    });
    return candidates[0];
  }

  _heapStats() {
    if (typeof process.memoryUsage === 'function') {
      try { return process.memoryUsage(); } catch {}
    }
    return null;
  }

  /**
   * Send GC request and wait for ACK.
   * Returns { success, durationMs, ack }.
   */
  async _triggerGC(pm2Name) {
    this.gcCooldowns.set(pm2Name, Date.now());

    const sendResult = await this.adapter.sendMemoryPressure(pm2Name, 'gc');
    if (!sendResult?.success) {
      this.metrics.failures++;
      return { success: false, reason: sendResult?.reason || 'send_failed' };
    }

    // Wait for ACK file
    const ackResult = await this._waitForAck(pm2Name, this.criticalAckTimeoutMs);
    if (!ackResult.success) {
      if (ackResult.reason === 'timeout') this.metrics.timeouts++;
      else this.metrics.failures++;
      return ackResult;
    }

    this.metrics.acks++;
    return { success: true, ...ackResult };
  }

  /**
   * Wait for the bot to write the ACK file and remove the flag file.
   */
  async _waitForAck(pm2Name, timeoutMs) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const flagPath = path.join(this.projectRoot, '.runtime', 'pressure', `${pm2Name}.flag`);
    const ackPath = path.join(this.projectRoot, '.runtime', 'pressure', `${pm2Name}.ack`);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (fs.existsSync(ackPath)) {
          const content = fs.readFileSync(ackPath, 'utf8');
          try { fs.unlinkSync(ackPath); } catch {}
          try { fs.unlinkSync(flagPath); } catch {}
          try {
            const parsed = JSON.parse(content);
            return { success: true, durationMs: Date.now() - start, ack: parsed };
          } catch {
            return { success: true, durationMs: Date.now() - start };
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return { success: false, reason: 'timeout' };
  }

  async _triggerRestart(pm2Name) {
    try {
      const result = await this.adapter.restartBot(pm2Name);
      if (!result.success) {
        this.metrics.failures++;
        return result;
      }
      // After a supervisor restart, verify the bot is actually ready by
      // probing its port + identity + listener. A PM2 online status alone
      // is NOT readiness (the PM2 7 ESM import bug). If readiness fails,
      // log the failure but keep the cooldown to avoid a restart loop.
      try {
        const { createBotReadinessService } = await import('./runtime-readiness.js');
        const readiness = createBotReadinessService({ adapter: this.adapter, root: this.projectRoot });
        const proc = await readiness.getProcess(pm2Name);
        if (proc && proc.status === 'online') {
          const descriptor = this._buildDescriptor(pm2Name, proc);
          if (descriptor) {
            const ready = await readiness.probe({ descriptor, process: proc });
            if (!ready?.ready) {
              this.metrics.failures++;
              console.warn(`[GUARDIAN] Restarted ${pm2Name} but readiness check failed: ${ready?.reason || 'unknown'}`);
            }
          }
        }
      } catch (readinessErr) {
        // Readiness check is best-effort: never let it crash the guardian.
        this.metrics.failures++;
        console.warn(`[GUARDIAN] Readiness check after restart failed: ${readinessErr.message}`);
      }
      return result;
    } catch (err) {
      this.metrics.failures++;
      return { success: false, reason: err.message };
    }
  }

  /**
   * Build a descriptor from the process snapshot for readiness probing.
   * Used after restart to verify the bot is actually ready.
   */
  _buildDescriptor(pm2Name, proc) {
    if (!proc) return null;
    const kind = proc.kind === 'main' ? 'main' : 'child';
    const webPort = Number(proc.env?.WEB_PORT || 0);
    if (!webPort) return null;
    return { kind, botKey: proc.botKey || pm2Name, webPort, pm2Name };
  }

  _isCritical(mem) {
    const freeMb = mem.free / (1024 * 1024);
    return mem.usedPercent >= this.criticalPercent || freeMb < this.criticalFreeMB;
  }

  _isWarning(mem) {
    const freeMb = mem.free / (1024 * 1024);
    return mem.usedPercent >= this.warnPercent || freeMb < this.warnFreeMB;
  }

  /**
   * One tick of the guardian. Returns { action, mem, ... }.
   */
  async tick() {
    this.metrics.checks++;
    const mem = getSystemMemory();
    const procs = await this._getProcessList();

    // Reset critical tracking when memory returns to normal
    if (!this._isWarning(mem)) {
      this.lastCriticalTime = null;
      this.cleanupAttempts.clear();
      this.lastAction = { action: 'none', mem, procs: procs.length };
      return this.lastAction;
    }

    // Critical path: cleanup → wait → remeasure → only restart if still critical
    if (this._isCritical(mem)) {
      // If we already kicked off a critical flow, wait for it
      if (this.lastCriticalTime) {
        const elapsed = Date.now() - this.lastCriticalTime;
        if (elapsed < this.cleanupWaitMs) {
          return { action: 'wait_critical', mem, procs: procs.length, elapsedMs: elapsed };
        }
        // Reached wait window — remeasure
        const remeasured = getSystemMemory();
        if (!this._isCritical(remeasured)) {
          this.lastCriticalTime = null;
          this.cleanupAttempts.clear();
          this.lastAction = { action: 'critical_recovered', mem: remeasured, procs: procs.length };
          return this.lastAction;
        }
        // Still critical after wait — restart one child
        const bot = this._selectBotForRestart(procs);
        if (bot) {
          this.metrics.restarts++;
          const result = await this._triggerRestart(bot.name);
          this.lastCriticalTime = null;
          this.cleanupAttempts.clear();
          this.lastAction = {
            action: 'restart',
            bot: bot.name,
            mem: remeasured,
            procs: procs.length,
            success: result.success,
          };
          return this.lastAction;
        }
        // No eligible bot — fall through to warning logic
      } else {
        // First critical detection: try cleanup first
        const bot = this._selectBotForCleanup(procs);
        if (bot) {
          this.metrics.cleanups++;
          const ack = await this._triggerGC(bot.name);
          this.lastCriticalTime = Date.now();
          this.lastAction = {
            action: 'critical_cleanup',
            bot: bot.name,
            mem,
            procs: procs.length,
            acked: ack.success,
          };
          return this.lastAction;
        }
        // No cleanup candidate (e.g., everything on cooldown); wait one cycle
        this.lastCriticalTime = Date.now();
        return { action: 'critical_wait', mem, procs: procs.length };
      }
    }

    // Warning path: cleanup only, no restart
    const bot = this._selectBotForCleanup(procs);
    if (!bot) {
      this.metrics.skipped++;
      this.lastAction = { action: 'skip', reason: 'no eligible bot', mem, procs: procs.length };
      return this.lastAction;
    }

    this.metrics.cleanups++;
    const ack = await this._triggerGC(bot.name);
    this.lastAction = {
      action: 'cleanup',
      bot: bot.name,
      mem,
      procs: procs.length,
      acked: ack.success,
    };
    return this.lastAction;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    if (this.diskCoordinator) {
      this.diskCoordinator.start();
    }
    const loop = async () => {
      if (!this.isRunning) return;
      await this.tick().catch(() => {});
      if (this.isRunning) {
        this.timer = setTimeout(loop, this.checkIntervalMs);
        if (this.timer.unref) this.timer.unref();
      }
    };
    loop();
  }

  stop() {
    this.isRunning = false;
    if (this.diskCoordinator) {
      this.diskCoordinator.stop();
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }
}
