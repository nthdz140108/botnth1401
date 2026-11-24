/**
 * Memory Pressure Listener — runtime receiver for memory-pressure IPC.
 *
 * The PM2-adapter.sendMemoryPressure() writes a flag file under
 * `.runtime/pressure/<pm2Name>.flag` containing:
 *   { reason, at, requestId, ackPath }
 *
 * This module:
 * 1. Watches the .runtime/pressure/ directory for new flag files matching this
 *    bot's pm2Name.
 * 2. On a new flag, runs `runContinuousPrune()` (best-effort: clears caches,
 *    runs user-supplied prune hook, calls `global.gc()` if available).
 * 3. Captures before/after heap + RSS metrics.
 * 4. Writes the ACK file at `ackPath` with the metrics.
 * 5. Removes the flag file.
 *
 * The whole operation is time-bounded; if the bot takes too long, we still
 * write a partial ACK so the guardian can advance.
 *
 * This is purely a runtime helper. It is automatically started by
 * src/bootstrap.js when the bot is running under PM2 (BOT_MANAGED=true).
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const POLL_INTERVAL_MS = 1500;
const ACK_TIMEOUT_MS = 30_000;

function safeReadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

async function getHeapAndRss() {
  let heap = null;
  let currentRss = 0;
  let peakRss = 0;
  try {
    if (typeof process.memoryUsage === 'function') {
      heap = process.memoryUsage();
      currentRss = heap.rss || 0;
      peakRss = currentRss;
    }
  } catch {}
  try {
    if (typeof process.resourceUsage === 'function') {
      const maxRss = process.resourceUsage().maxRSS;
      if (maxRss) peakRss = Math.max(peakRss, maxRss * 1024);
    }
  } catch {}

  let treeRss = currentRss;
  try {
    const { getProcessTreeRss } = await import('./process-tree.js');
    treeRss = await getProcessTreeRss(process.pid, currentRss);
  } catch {}

  return {
    heap,
    rss: currentRss,
    currentRss,
    peakRss,
    treeRss,
  };
}

export async function runContinuousPrune({ timeoutMs = ACK_TIMEOUT_MS, hooks = [] } = {}) {
  const start = Date.now();
  let ranGc = false;
  const hookErrors = [];

  const runWithTimeout = async () => {
    // Single prune source: only run injected hooks
    for (const hook of hooks) {
      if (typeof hook !== 'function') continue;
      try {
        await hook();
      } catch (err) {
        hookErrors.push(err?.message || String(err));
      }
      if (Date.now() - start > timeoutMs) return;
    }

    // Attempt GC if available
    if (typeof global.gc === 'function') {
      try {
        global.gc();
        ranGc = true;
      } catch (err) {
        hookErrors.push(`gc_error: ${err?.message || String(err)}`);
      }
    }
  };

  let timeoutId = null;
  try {
    await Promise.race([
      runWithTimeout(),
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, timeoutMs);
        if (timeoutId?.unref) timeoutId.unref();
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  return { ranGc, durationMs: Date.now() - start, hookErrors };
}

export class MemoryPressureListener extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.pm2Name  - PM2 process name for this bot
   * @param {string} options.projectRoot - project root
   * @param {string} [options.pressureDir] - override pressure dir
   * @param {Array<Function>} [options.pruneHooks] - optional cleanup hooks
   * @param {object} [options.logger] - RuntimeLogger for metrics
   */
  constructor({ pm2Name, projectRoot, pressureDir = null, pruneHooks = [], logger = null } = {}) {
    super();
    if (!pm2Name) throw new Error('MemoryPressureListener: pm2Name is required');
    if (!projectRoot) throw new Error('MemoryPressureListener: projectRoot is required');

    this.pm2Name = pm2Name;
    this.projectRoot = projectRoot;
    this.pressureDir = pressureDir || path.join(projectRoot, '.runtime', 'pressure');
    this.pruneHooks = Array.isArray(pruneHooks) ? pruneHooks : [];
    this.logger = logger;
    this.timer = null;
    this.isRunning = false;
    this._polling = false;
    this.metrics = { received: 0, acked: 0, timeouts: 0, errors: 0 };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    if (!fs.existsSync(this.pressureDir)) {
      try { fs.mkdirSync(this.pressureDir, { recursive: true }); } catch {}
    }
    this.timer = setInterval(() => {
      this._poll().catch((err) => {
        this.metrics.errors++;
        this.emit('error', err);
      });
    }, POLL_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    // Also poll once on start so a flag already present gets handled
    this._poll().catch(() => {});
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _poll() {
    if (!this.isRunning || this._polling) return;
    const flagPath = path.join(this.pressureDir, `${this.pm2Name}.flag`);
    if (!fs.existsSync(flagPath)) return;

    this._polling = true;
    try {
      const request = safeReadJSON(flagPath);
      if (!request) {
        // Invalid flag — remove it
        safeUnlink(flagPath);
        return;
      }

      this.metrics.received++;
      const ackPath = request.ackPath || path.join(this.pressureDir, `${this.pm2Name}.ack`);

      const before = await getHeapAndRss();
      let pruneResult;
      try {
        pruneResult = await runContinuousPrune({ timeoutMs: ACK_TIMEOUT_MS, hooks: this.pruneHooks });
      } catch (err) {
        this.metrics.errors++;
        pruneResult = { ranGc: false, durationMs: 0, error: err.message };
      }
      const after = await getHeapAndRss();

      const ack = {
        requestId: request.requestId || null,
        reason: request.reason || 'gc',
        receivedAt: request.at || null,
        ackedAt: new Date().toISOString(),
        before,
        after,
        currentRssBefore: before.currentRss,
        currentRssAfter: after.currentRss,
        peakRssBefore: before.peakRss,
        peakRssAfter: after.peakRss,
        treeRssBefore: before.treeRss,
        treeRssAfter: after.treeRss,
        hookErrors: pruneResult?.hookErrors || [],
        ranGc: pruneResult?.ranGc || false,
        durationMs: pruneResult?.durationMs || 0,
      };

      try {
        fs.writeFileSync(ackPath, JSON.stringify(ack, null, 2), 'utf8');
        this.metrics.acked++;
        if (this.logger?.system) {
          this.logger.system({
            scope: 'memory-pressure',
            level: 'info',
            message: `GC run: heap ${before.heap?.heapUsed || 0}→${after.heap?.heapUsed || 0} rss=${after.rss} ranGc=${ack.ranGc}`,
          });
        }
      } catch (err) {
        this.metrics.errors++;
      } finally {
        safeUnlink(flagPath);
      }
    } finally {
      this._polling = false;
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

/**
 * Helper to start the listener without manually instantiating the class.
 * Returns the listener instance.
 */
export function startMemoryPressureWatcher({ pm2Name, projectRoot, pruneHooks, logger }) {
  const listener = new MemoryPressureListener({ pm2Name, projectRoot, pruneHooks, logger });
  listener.start();
  return listener;
}
