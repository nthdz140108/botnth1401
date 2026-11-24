/**
 * PM2 Adapter: unified interface for PM2 process management.
 *
 * Uses the locally-installed PM2 (from node_modules/pm2) exclusively.
 * Provides start/stop/restart/list/memory-pressure with normalized output.
 *
 * KEY DESIGN DECISIONS:
 * - PM2 jlist raw output stores status at `pm2_env.status`, NOT `process.state`.
 *   We normalize to `process.state` so all consumers can use `p.state` consistently.
 * - All PM2 processes are scoped to the "mybot" namespace (PM2 namespace feature).
 *   We only manage processes whose name starts with "mybot-" or matches registry bots.
 * - startBot uses start-or-adopt: never deletes an existing process before starting.
 * - Empty list from `pm2 jlist` means daemon is running but no managed processes yet.
 *   null (throw) means daemon is unreachable.
 *
 * SAFETY: All PM2 operations are best-effort and time-bounded. Failures do not
 * crash the caller; they return structured results with typed reasons.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLaunchDescriptor } from './launch-descriptor.js';
import { resolveLogPaths } from './ecosystem-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

/** Path to the locally-installed PM2 CLI script. */
function getLocalPM2Entry(projectRoot) {
  const root = path.resolve(projectRoot || path.resolve(__dirname, '../..'));
  return path.resolve(root, 'node_modules', 'pm2', 'bin', 'pm2');
}

const PM2_TIMEOUT_MS = 30_000;

/**
 * Typed error codes for PM2 operations. These map to structured `{ success, reason }`
 * results so callers can branch on specific failure modes.
 */
export const PM2ErrorCode = {
  DAEMON_UNAVAILABLE: 'daemon_unavailable',
  MISSING_PM2_NAME: 'missing_pm2_name',
  MISSING_SCRIPT: 'missing_script',
  PM2_START_FAILED: 'pm2_start_failed',
  PM2_STOP_FAILED: 'pm2_stop_failed',
  PM2_RESTART_FAILED: 'pm2_restart_failed',
  PM2_DELETE_FAILED: 'pm2_delete_failed',
  PM2_LIST_FAILED: 'pm2_list_failed',
  TIMEOUT: 'timeout',
  SPAWN_ERROR: 'spawn_error',
  UNKNOWN: 'unknown',
};

/**
 * Normalize a raw PM2 jlist item to a canonical shape.
 *
 * Raw PM2 stores process metadata at the top level (name, pid, pm_id, etc.)
 * but the STATUS is stored inside `pm2_env.status`, not `process.state`.
 * We also extract memory, uptime, and restart count.
 *
 * @param {object} raw - raw PM2 process object from `pm2 jlist`
 * @returns {object} normalized process object
 */
export function normalizePM2Process(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name || '');
  const pid = raw.pm_id !== undefined ? raw.pid : raw.pid;
  const pm2Id = raw.pm_id;

  // PM2 status lives in pm2_env.status, NOT process.state
  const status = raw.pm2_env?.status || raw.pm2_env?.STATUS || raw.process?.state || 'unknown';

  // Memory in bytes (monit is PM2's 5-second rolling average; internal is RSS)
  const rss = raw.monit?.memory || raw.process?.memory?.rss || 0;

  // Uptime: ms since process started
  const uptime = raw.pm2_env?.pm_uptime
    ? Date.now() - new Date(raw.pm2_env.pm_uptime).getTime()
    : 0;

  const restartCount = raw.pm2_env?.restart_time ?? raw.pm2_env?.restartTime ?? 0;

  // Namespace from PM2 namespace feature (if enabled)
  const namespace = raw.pm2_env?.namespace || raw.namespace || 'default';

  // Snapshot of the launch env for fleet identification (BOT_MANAGED, BOT_KEY,
  // MYBOT_INSTANCE_KIND) and readiness probing (WEB_PORT). Kept small: only
  // the marker/probe fields are copied.
  const rawEnv = raw.pm2_env?.env || {};
  const env = {};
  for (const key of ['BOT_MANAGED', 'BOT_KEY', 'MYBOT_INSTANCE_KIND', 'BOT_UID', 'MYBOT_CODE_COMMIT', 'WEB_PORT']) {
    if (rawEnv[key] !== undefined) env[key] = rawEnv[key];
  }

  // Derive kind from process name conventions used in launch-descriptor.js:
  // mybot-dashboard, mybot-guardian, admin, bot-<uid>
  let kind = 'child';
  if (name === 'mybot-dashboard') kind = 'dashboard';
  else if (name === 'mybot-guardian') kind = 'guardian';
  else if (name === 'admin') kind = 'main';
  else if (name.startsWith('bot-')) kind = 'child';

  // botKey is the canonical identifier (without mybot- prefix for dashboard/guardian)
  const botKey = kind === 'dashboard' || kind === 'guardian'
    ? name.replace(/^mybot-/, '')
    : name;

  // Extract outLogPath and errorLogPath from PM2 raw env or properties
  const rawOut = raw.outLogPath ||
    raw.pm2_env?.pm_out_log_path ||
    raw.pm2_env?.out_file ||
    raw.pm2_env?.out_log_path ||
    raw.pm_out_log_path ||
    null;

  const rawErr = raw.errorLogPath ||
    raw.pm2_env?.pm_err_log_path ||
    raw.pm2_env?.error_file ||
    raw.pm2_env?.err_log_path ||
    raw.pm_err_log_path ||
    null;

  const outLogPath = rawOut && typeof rawOut === 'string' && rawOut !== '/dev/null' && rawOut !== 'NULL'
    ? path.resolve(rawOut)
    : null;

  const errorLogPath = rawErr && typeof rawErr === 'string' && rawErr !== '/dev/null' && rawErr !== 'NULL'
    ? path.resolve(rawErr)
    : null;

  return {
    name,           // PM2 process name
    namespace,      // PM2 namespace
    kind,           // 'main' | 'child' | 'dashboard' | 'guardian'
    botKey,         // canonical bot identifier
    status,         // PM2 status string (online, stopped, errored, etc.)
    pid: pid || null,
    pm2Id: pm2Id !== undefined ? pm2Id : null,
    rss,            // bytes
    uptime,          // ms
    restartCount,    // number
    env,            // launch-env markers snapshot (BOT_MANAGED, BOT_KEY, ...)
    outLogPath,     // canonical stdout log path
    errorLogPath,   // canonical stderr log path
  };
}

/**
 * Check if a normalized process belongs to the MyBot fleet.
 * Scopes PM2 management to MyBot processes only — we never touch other PM2 apps.
 *
 * Identification strategy (in priority order):
 * 1. Fixed infrastructure names: 'admin', 'mybot-dashboard', 'mybot-guardian'.
 * 2. Env markers stamped by launch-descriptor.js: BOT_MANAGED=true plus
 *    BOT_KEY / MYBOT_INSTANCE_KIND present in pm2_env.env.
 * 3. Legacy 'bot-' name prefix (kept for backwards compatibility only).
 *
 * A `bot-` prefix is NOT required: registry keys like `user-123` or Zalo UIDs
 * are valid child-bot names. A `raw` jlist item can also be passed (env
 * markers are read from pm2_env.env) so callers may check either shape.
 */
export function isMyBotProcess(proc) {
  if (!proc) return false;
  const name = proc.name || '';
  // Fixed infrastructure names
  if (name === 'mybot-dashboard' || name === 'mybot-guardian') return true;
  if (name === 'admin') return true;
  // Env markers from launch descriptor (normalized proc carries .env snapshot)
  const env = proc.env || proc.pm2_env?.env || proc.pm2Env?.env || {};
  if (env.BOT_MANAGED === 'true' || env.BOT_MANAGED === true) {
    return typeof env.BOT_KEY === 'string' && env.BOT_KEY.length > 0
      || typeof env.MYBOT_INSTANCE_KIND === 'string' && env.MYBOT_INSTANCE_KIND.length > 0;
  }
  // Legacy prefix fallback
  if (name.startsWith('bot-')) return true;
  return false;
}

/**
 * Build the bot-key registry fallback set used by listManagedProcesses.
 * Includes 'admin' plus every registry bot key. Non-MyBot PM2 apps that
 * happen to share a name with a registry key are still excluded by the
 * env-marker check (a foreign app named `user-123` without BOT_MANAGED=true
 * is NOT adopted).
 */
export function resolveFleetBotKeys({ registryBotKeys = [] } = {}) {
  const keys = new Set(['admin']);
  for (const key of registryBotKeys) {
    if (typeof key === 'string' && key.trim()) keys.add(key.trim());
  }
  return keys;
}

function runPM2Command(args, { timeoutMs = PM2_TIMEOUT_MS, projectRoot = process.cwd() } = {}) {
  return new Promise((resolve) => {
    let proc;
    let output = '';
    let errorOutput = '';
    let timer = null;

    const pm2Entry = getLocalPM2Entry(projectRoot);
    if (!fs.existsSync(pm2Entry)) {
      resolve({ ok: false, code: -1, stdout: '', stderr: `PM2 CLI not found at ${pm2Entry}`, reason: PM2ErrorCode.DAEMON_UNAVAILABLE });
      return;
    }

    try {
      proc = spawn(process.execPath, [pm2Entry, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: isWindows,
        shell: false,
        cwd: projectRoot,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err?.message || err), reason: PM2ErrorCode.SPAWN_ERROR });
      return;
    }

    proc.stdout?.on('data', (d) => { output += d.toString(); });
    proc.stderr?.on('data', (d) => { errorOutput += d.toString(); });

    proc.on('close', (code) => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ ok: code === 0, code, stdout: output, stderr: errorOutput });
    });

    proc.on('error', (err) => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ ok: false, code: -1, stdout: output, stderr: String(err?.message || err), reason: PM2ErrorCode.DAEMON_UNAVAILABLE });
    });

    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ ok: false, code: -1, stdout: output, stderr: 'timeout', reason: PM2ErrorCode.TIMEOUT });
    }, timeoutMs);
  });
}

/**
 * Parse PM2 jlist raw stdout.
 *
 * Handles:
 * 1. Pure JSON array stdout.
 * 2. Mixed banner output where PM2 daemon prints startup banners, e.g.:
 *    [PM2] Spawning PM2 daemon with pm2_home=...
 *    [PM2] PM2 Successfully daemonized
 *    [{"name": "...", ...}]
 *    By scanning lines backwards or extracting the trailing JSON array.
 * 3. Returns null if no valid JSON array can be parsed.
 */
export function parsePM2JlistOutput(rawOutput) {
  if (typeof rawOutput !== 'string') return null;
  const trimmed = rawOutput.trim();
  if (!trimmed) return [];

  // 1. Try pure JSON parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // 2. Try last JSON-array line (scanning upwards)
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('[') && line.endsWith(']')) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }

  // 3. Try finding substring from last newline bracket or first bracket to last bracket
  const lastLineBracket = trimmed.lastIndexOf('\n[');
  const startIdx = lastLineBracket !== -1 ? lastLineBracket + 1 : trimmed.indexOf('[');
  const lastClose = trimmed.lastIndexOf(']');
  if (startIdx !== -1 && lastClose > startIdx) {
    try {
      const slice = trimmed.slice(startIdx, lastClose + 1).trim();
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}

/**
 * PM2Adapter — unified PM2 process manager.
 *
 * @param {object} options
 * @param {string} [options.projectRoot] - project root for resolving local PM2
 * @param {object} [options.mock]        - test mock with optional { listProcesses, startBot, stopBot, restartBot, deleteBot, reloadBotFromDescriptor, sendMemoryPressure }
 */
export class PM2Adapter {
  constructor({ projectRoot = process.cwd(), mock = null } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this._mock = mock;
    this._listCache = null;
    this._listCacheTime = 0;
    this._listInFlight = null;
  }

  /** Invalidate short-term process cache */
  invalidateCache() {
    this._listCache = null;
    this._listCacheTime = 0;
    this._listInFlight = null;
  }

  /** List all PM2 processes, normalized. Returns [] if daemon is reachable but empty. */
  async listProcesses({ bypassCache = false } = {}) {
    if (this._mock?.listProcesses) return this._mock.listProcesses();

    const now = Date.now();
    if (!bypassCache && this._listCache && (now - this._listCacheTime < 1500)) {
      return this._listCache;
    }

    if (!bypassCache && this._listInFlight) {
      return this._listInFlight;
    }

    this._listInFlight = (async () => {
      try {
        const res = await runPM2Command(['jlist'], { projectRoot: this.projectRoot });

        if (!res.ok) {
          // Distinguish: daemon dead vs other failure
          if (/connect|ECONNREFUSED|refused|ENOTFOUND|espawn/i.test(res.stderr) || res.reason === PM2ErrorCode.DAEMON_UNAVAILABLE) {
            const err = new Error(`PM2 daemon unavailable: ${res.stderr}`);
            err.code = PM2ErrorCode.DAEMON_UNAVAILABLE;
            throw err;
          }
          // Daemon reachable but command failed
          const err = new Error(`pm2 jlist failed: ${res.stderr}`);
          err.code = PM2ErrorCode.PM2_LIST_FAILED;
          throw err;
        }

        const procs = parsePM2JlistOutput(res.stdout);
        if (procs === null) {
          const err = new Error(`pm2 jlist JSON parse error: unable to parse JSON array from output: ${res.stdout.slice(0, 200)}`);
          err.code = PM2ErrorCode.PM2_LIST_FAILED;
          throw err;
        }

        const normalized = procs.map(normalizePM2Process).filter(Boolean);
        this._listCache = normalized;
        this._listCacheTime = Date.now();
        return normalized;
      } finally {
        this._listInFlight = null;
      }
    })();

    return this._listInFlight;
  }

  /**
   * List only MyBot fleet processes.
   * Use this for reconcile, monitor, and guardian — never show all PM2 processes.
   */
  async listMyBotProcesses() {
    const procs = await this.listProcesses();
    return procs.filter(isMyBotProcess);
  }

  /**
   * Canonical managed-fleet inventory used by dashboard, terminal monitor,
   * reconcile and guardian.
   *
   * Identification (isMyBotProcess):
   * - env markers BOT_MANAGED=true + BOT_KEY / MYBOT_INSTANCE_KIND,
   * - fixed infra names ('admin', 'mybot-dashboard', 'mybot-guardian'),
   * - legacy 'bot-' prefix fallback,
   * - registry bot keys as fallback for old processes without markers.
   * A `bot-` prefix is never required; foreign PM2 apps are never adopted.
   *
   * @param {object} [options]
   * @param {string[]} [options.botKeys] registry bot keys used as fallback
   *   identification for processes launched before env markers existed.
   * @returns {Promise<object[]>} normalized MyBot processes
   */
  async listManagedProcesses({ botKeys = [] } = {}) {
    const procs = await this.listProcesses();
    const registryKeys = botKeys.length ? resolveFleetBotKeys({ registryBotKeys: botKeys }) : null;
    return procs.filter((proc) => {
      if (isMyBotProcess(proc)) return true;
      // Registry fallback for legacy processes without env markers.
      // Adopt only when the env snapshot carries no contradicting marker:
      // a foreign app without BOT_MANAGED stays out even on name collision.
      if (registryKeys?.has(proc.name)) {
        if (proc.env?.BOT_MANAGED !== 'false') return true;
      }
      return false;
    });
  }

  /**
   * Structured supervisor status for one bot key.
   * Never throws for daemon-down: returns { available:false, reason, code }
   * so the resolver can report 'unknown' instead of fake 'running'.
   *
   * @param {string} botKey canonical bot key (pm2 name)
   * @returns {Promise<{available:boolean, status:string|null, pid:number|null,
   *   pm2Id:number|null, uptime:number, restartCount:number, reason?:string, code?:string}>}
   */
  async getProcessStatus(botKey) {
    if (!botKey) {
      return { available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: PM2ErrorCode.MISSING_PM2_NAME, code: PM2ErrorCode.MISSING_PM2_NAME };
    }
    try {
      const procs = await this.listProcesses();
      const proc = procs.find((p) => p.name === botKey) || null;
      return {
        available: true,
        status: proc?.status || null,
        pid: proc?.pid || null,
        pm2Id: proc?.pm2Id ?? null,
        uptime: proc?.uptime || 0,
        restartCount: proc?.restartCount || 0,
      };
    } catch (err) {
      return {
        available: false,
        status: null,
        pid: null,
        pm2Id: null,
        uptime: 0,
        restartCount: 0,
        reason: err?.message || 'pm2_unavailable',
        code: err?.code || PM2ErrorCode.DAEMON_UNAVAILABLE,
      };
    }
  }

  /**
   * Check if the PM2 daemon is reachable.
   * Returns { available: true } when daemon responds (even with empty list).
   * Returns { available: false, reason: '...' } when daemon is dead.
   * Use this for fail-fast preflight checks before starting processes.
   */
  async isAvailable() {
    try {
      await this.listProcesses();
      return { available: true };
    } catch (err) {
      return { available: false, reason: err.message, code: err.code || PM2ErrorCode.DAEMON_UNAVAILABLE };
    }
  }

  /**
   * Start a bot under PM2 using start-or-adopt semantics.
   *
   * - If a process with this name already exists and is healthy → adopt it (return success).
   * - If it exists but is stopped/errored → restart it.
   * - If it doesn't exist → start it fresh.
   *
   * NEVER deletes a process before starting.
   *
   * IMPLEMENTATION: We write a single-app ecosystem config (JSON) to disk as
   * `pm2-start-<name>.config.cjs` and invoke `pm2 startOrReload <config>`
   * (preferred) or `pm2 start <config>`. The `.config.cjs` suffix is required:
   * PM2 only treats those names as config files (Common.isConfigFile).
   * This avoids the shell-escape bug of `--node-args` (with shell: true on
   * Windows) that broke PM2's CLI parsing of `--max-old-space-size` etc.
   * The JSON file preserves `node_args` and `env` as proper data structures
   * so PM2 receives them correctly on every platform.
   */
  async startBot(descriptor) {
    if (!descriptor?.pm2Name) {
      return { success: false, reason: PM2ErrorCode.MISSING_PM2_NAME };
    }
    if (!descriptor?.script) {
      return { success: false, reason: PM2ErrorCode.MISSING_SCRIPT };
    }
    if (this._mock?.startBot) return this._mock.startBot(descriptor);

    const pm2Name = descriptor.pm2Name;

    // Start-or-adopt: check if already running
    try {
      const procs = await this.listMyBotProcesses();
      const existing = procs.find((p) => p.name === pm2Name);
      if (existing) {
        if (existing.status === 'online') {
          return { success: true, pm2Name, pid: existing.pid, adopted: true, reason: 'adopted' };
        }
        if (existing.status === 'errored' || existing.status === 'stopped') {
          // Restart existing instead of re-creating
          const res = await runPM2Command(['restart', pm2Name], { projectRoot: this.projectRoot });
          if (res.ok) {
            return { success: true, pm2Name, reason: 'restarted' };
          }
          return {
            success: false,
            pm2Name,
            reason: PM2ErrorCode.PM2_RESTART_FAILED,
            detail: res.stderr || res.reason,
          };
        }
      }
    } catch {
      // Daemon may be down; proceed to attempt start anyway.
      // runEcosystemStart() will fail-fast with a typed error.
    }

    // Write a single-app ecosystem config file. The name MUST end with
    // `.config.cjs`: PM2's Common.isConfigFile() only recognizes
    // .json/.yml/.yaml/.config.js/.config.cjs/.config.mjs. A bare `.cjs`
    // name makes Common.parseConfig() return undefined and PM2 crashes
    // at `if (config.deploy)` in _startJson() (PM2 7.x).
    const logFiles = resolveLogPaths(this.projectRoot, pm2Name, descriptor.kind);
    const ecosystem = {
      apps: [
        {
          name: pm2Name,
          script: descriptor.script,
          cwd: descriptor.cwd || this.projectRoot,
          args: Array.isArray(descriptor.args) && descriptor.args.length > 1
            ? descriptor.args.slice(1)
            : [],
          node_args: Array.isArray(descriptor.nodeArgs) ? [...descriptor.nodeArgs] : [],
          instances: 1,
          exec_mode: 'fork',
          autorestart: true,
          watch: false,
          merge_logs: false,
          out_file: logFiles.out,
          error_file: logFiles.err,
          time: true,
          env: descriptor.env && typeof descriptor.env === 'object' ? { ...descriptor.env } : {},
          ...(descriptor.pm2MaxMemoryRestart
            ? { max_memory_restart: descriptor.pm2MaxMemoryRestart }
            : {}),
        },
      ],
    };

    const fs = await import('node:fs');
    const path = await import('node:path');
    const runtimeDir = path.join(this.projectRoot, '.runtime');
    if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
    const configPath = path.join(runtimeDir, `pm2-start-${pm2Name}.config.cjs`);
    const configBody = `module.exports = ${JSON.stringify(ecosystem, null, 2)};\n`;
    try {
      fs.writeFileSync(configPath, configBody, 'utf8');
    } catch (err) {
      return {
        success: false,
        pm2Name,
        reason: PM2ErrorCode.PM2_START_FAILED,
        detail: `write_ecosystem_failed: ${err.message}`,
      };
    }

    // Use startOrReload — it adopts existing app with same name (no duplicate
    // "process already exists" error) and is idempotent across runs.
    const res = await runPM2Command(['startOrReload', configPath], {
      projectRoot: this.projectRoot,
      timeoutMs: 60_000,
    });

    if (!res.ok) {
      return {
        success: false,
        pm2Name,
        reason: PM2ErrorCode.PM2_START_FAILED,
        detail: res.stderr || res.reason || res.stdout,
      };
    }

    this.invalidateCache();
    return { success: true, pm2Name, reason: 'started' };
  }

  async stopBot(target) {
    const pm2Name = typeof target === 'string' ? target : target?.pm2Name;
    if (!pm2Name) return { success: false, reason: PM2ErrorCode.MISSING_PM2_NAME };
    if (this._mock?.stopBot) return this._mock.stopBot(pm2Name);

    const res = await runPM2Command(['stop', pm2Name], { projectRoot: this.projectRoot });
    this.invalidateCache();
    if (!res.ok && /daemon/i.test(res.stderr || '')) {
      return { success: false, pm2Name, reason: PM2ErrorCode.DAEMON_UNAVAILABLE, detail: res.stderr };
    }
    return {
      success: res.ok,
      pm2Name,
      reason: res.ok ? 'stopped' : (res.stderr || PM2ErrorCode.PM2_STOP_FAILED),
    };
  }

  async restartBot(target) {
    const pm2Name = typeof target === 'string' ? target : target?.pm2Name;
    if (!pm2Name) return { success: false, reason: PM2ErrorCode.MISSING_PM2_NAME };
    if (this._mock?.restartBot) return this._mock.restartBot(pm2Name);

    const res = await runPM2Command(['restart', pm2Name], { projectRoot: this.projectRoot });
    this.invalidateCache();
    if (!res.ok && /daemon/i.test(res.stderr || '')) {
      return { success: false, pm2Name, reason: PM2ErrorCode.DAEMON_UNAVAILABLE, detail: res.stderr };
    }
    return {
      success: res.ok,
      pm2Name,
      reason: res.ok ? 'restarted' : (res.stderr || PM2ErrorCode.PM2_RESTART_FAILED),
    };
  }

  /**
   * Reload (startOrReload) a PM2 app from a full launch descriptor.
   *
   * Unlike `restartBot` (which merely restarts the SAME in-memory process
   * definition, keeping the old env), this re-applies the descriptor's
   * script/args/env via `pm2 startOrReload <config>` so PM2 picks up the NEW
   * env block — including MYBOT_CODE_COMMIT. Used by reconcile to force an
   * online app running stale-commit code onto current source.
   *
   * Never touches apps outside the MyBot fleet: the caller must pass a
   * descriptor whose pm2Name resolves to a MyBot-managed process.
   *
   * Returns { success, pm2Name, pid, reason } where pid is the post-reload
   * PID when it can be observed (callers verify marker + PID separately).
   */
  async reloadBotFromDescriptor(descriptor) {
    const pm2Name = descriptor?.pm2Name;
    if (!pm2Name) {
      return { success: false, reason: PM2ErrorCode.MISSING_PM2_NAME };
    }
    if (!descriptor?.script) {
      return { success: false, pm2Name, reason: PM2ErrorCode.MISSING_SCRIPT };
    }
    if (this._mock?.reloadBotFromDescriptor) return this._mock.reloadBotFromDescriptor(descriptor);

    // Capture the pre-reload PID so callers can confirm the reload actually
    // replaced the process (a graceful reload may keep the same PID only when
    // the app was restarted in place; startOrReload re-spawns in fork mode).
    let previousPid = null;
    try {
      const procs = await this.listProcesses();
      const existing = procs.find((p) => p.name === pm2Name);
      previousPid = existing?.pid || null;
    } catch {
      // Daemon state unknown — proceed; startOrReload will fail fast if down.
    }

    const logFiles = resolveLogPaths(this.projectRoot, pm2Name, descriptor.kind);
    const ecosystem = {
      apps: [
        {
          name: pm2Name,
          script: descriptor.script,
          cwd: descriptor.cwd || this.projectRoot,
          args: Array.isArray(descriptor.args) && descriptor.args.length > 1
            ? descriptor.args.slice(1)
            : [],
          node_args: Array.isArray(descriptor.nodeArgs) ? [...descriptor.nodeArgs] : [],
          instances: 1,
          exec_mode: 'fork',
          autorestart: true,
          watch: false,
          merge_logs: false,
          out_file: logFiles.out,
          error_file: logFiles.err,
          time: true,
          env: descriptor.env && typeof descriptor.env === 'object' ? { ...descriptor.env } : {},
          ...(descriptor.pm2MaxMemoryRestart
            ? { max_memory_restart: descriptor.pm2MaxMemoryRestart }
            : {}),
        },
      ],
    };

    const fs = await import('node:fs');
    const path = await import('node:path');
    const runtimeDir = path.join(this.projectRoot, '.runtime');
    if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
    const configPath = path.join(runtimeDir, `pm2-reload-${pm2Name}.config.cjs`);
    const configBody = `module.exports = ${JSON.stringify(ecosystem, null, 2)};\n`;
    try {
      fs.writeFileSync(configPath, configBody, 'utf8');
    } catch (err) {
      return {
        success: false,
        pm2Name,
        reason: PM2ErrorCode.PM2_START_FAILED,
        detail: `write_ecosystem_failed: ${err.message}`,
      };
    }

    const res = await runPM2Command(['startOrReload', configPath], {
      projectRoot: this.projectRoot,
      timeoutMs: 60_000,
    });
    if (!res.ok) {
      return {
        success: false,
        pm2Name,
        reason: PM2ErrorCode.PM2_RESTART_FAILED,
        detail: res.stderr || res.reason || res.stdout,
      };
    }

    let pid = null;
    try {
      const procs = await this.listProcesses();
      const proc = procs.find((p) => p.name === pm2Name);
      pid = proc?.pid || null;
    } catch {
      // Leave pid null; caller decides whether that is fatal.
    }

    return {
      success: true,
      pm2Name,
      pid,
      previousPid,
      pidChanged: pid !== null && previousPid !== null && pid !== previousPid,
      reason: 'reloaded',
    };
  }

  async deleteBot(target, { timeoutMs = 15000, pollIntervalMs = 500, botKey: optBotKey, registryPath } = {}) {
    const pm2Name = typeof target === 'string' ? target : (target?.pm2Name || target?.name || target?.botKey);
    const botKey = optBotKey || (typeof target === 'object' ? (target?.botKey || target?.name) : pm2Name);
    if (!pm2Name) {
      return {
        success: false,
        reason: PM2ErrorCode.MISSING_PM2_NAME,
        pm2Name: null,
        verifiedAbsent: false,
        ownershipVerified: false,
        detail: 'Target PM2 process name is required',
      };
    }
    if (this._mock?.deleteBot) {
      const mockRes = await this._mock.deleteBot(pm2Name);
      const isSuccess = typeof mockRes === 'boolean' ? mockRes : Boolean(mockRes?.success);
      const isAbsent = mockRes?.verifiedAbsent !== undefined ? Boolean(mockRes.verifiedAbsent) : isSuccess;
      const isOwner = mockRes?.ownershipVerified !== undefined ? Boolean(mockRes.ownershipVerified) : isSuccess;
      return {
        success: isSuccess && isAbsent && isOwner,
        reason: mockRes?.reason || (isSuccess ? 'deleted' : PM2ErrorCode.PM2_DELETE_FAILED),
        pm2Name,
        verifiedAbsent: isAbsent,
        ownershipVerified: isOwner,
        detail: mockRes?.detail || '',
      };
    }

    // 1. Verify existence and fleet ownership before deletion
    let existingProc = null;
    try {
      const procs = await this.listProcesses();
      existingProc = procs.find((p) => p.name === pm2Name || p.pm2Name === pm2Name);
    } catch (err) {
      return {
        success: false,
        reason: PM2ErrorCode.DAEMON_UNAVAILABLE,
        pm2Name,
        verifiedAbsent: false,
        ownershipVerified: false,
        detail: err?.message || String(err),
      };
    }

    if (!existingProc) {
      // Process is already absent from PM2
      return {
        success: true,
        reason: 'not_found',
        pm2Name,
        verifiedAbsent: true,
        ownershipVerified: true,
        detail: `Process '${pm2Name}' not present in PM2`,
      };
    }

    // Process exists: VERIFY FLEET OWNERSHIP
    const env = existingProc.env || existingProc.pm2_env?.env || existingProc.pm2Env?.env || {};
    const isBotManaged = env.BOT_MANAGED === 'true' || env.BOT_MANAGED === true;
    const envBotKey = env.BOT_KEY || env.BOT_UID;

    let registryBotKeys = new Set();
    try {
      const regFile = registryPath || path.join(this.projectRoot, 'mybot', 'mybots.json');
      if (fs.existsSync(regFile)) {
        const regData = JSON.parse(fs.readFileSync(regFile, 'utf8').replace(/^\uFEFF/, ''));
        registryBotKeys = new Set(Object.keys(regData || {}));
      }
    } catch {}

    const keyMatches = (envBotKey && (envBotKey === botKey || registryBotKeys.has(envBotKey))) ||
                       registryBotKeys.has(pm2Name);

    const execPath = existingProc.script || existingProc.pm2_env?.pm_exec_path || existingProc.pm2_env?.script;
    const isProjectScript = execPath && typeof execPath === 'string' && (
      execPath.includes(this.projectRoot) ||
      execPath.endsWith('index.js') ||
      execPath.endsWith('bot.js') ||
      execPath.endsWith('bootstrap.js')
    );

    const ownershipVerified = (isBotManaged && keyMatches) || (isBotManaged && isProjectScript) || (isProjectScript && keyMatches);

    if (!ownershipVerified) {
      return {
        success: false,
        reason: 'foreign_process_collision',
        pm2Name,
        verifiedAbsent: false,
        ownershipVerified: false,
        detail: `Process '${pm2Name}' exists in PM2 but failed fleet ownership verification`,
      };
    }

    // 2. Execute deletion
    const res = await runPM2Command(['delete', pm2Name], { projectRoot: this.projectRoot, timeoutMs });

    // 3. Poll up to timeoutMs (default 15s) until process disappears from pm2 jlist
    const deadline = Date.now() + Math.min(timeoutMs, 15_000);
    let verifiedAbsent = false;
    let checkError = null;

    while (Date.now() <= deadline) {
      try {
        const procs = await this.listProcesses();
        const exists = procs.some((p) => p.name === pm2Name || p.pm2Name === pm2Name);
        if (!exists) {
          verifiedAbsent = true;
          break;
        }
      } catch (err) {
        checkError = err;
        break;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    if (checkError) {
      return {
        success: false,
        reason: PM2ErrorCode.DAEMON_UNAVAILABLE,
        pm2Name,
        verifiedAbsent: false,
        ownershipVerified: true,
        detail: checkError.message || String(checkError),
      };
    }

    if (!verifiedAbsent) {
      return {
        success: false,
        reason: res.reason || PM2ErrorCode.PM2_DELETE_FAILED,
        pm2Name,
        verifiedAbsent: false,
        ownershipVerified: true,
        detail: res.stderr || 'Process still present in PM2 fleet after delete attempt',
      };
    }

    return {
      success: true,
      reason: res.ok ? 'deleted' : 'not_found',
      pm2Name,
      verifiedAbsent: true,
      ownershipVerified: true,
      detail: res.stdout || res.stderr || '',
    };
  }

  /**
   * Send memory-pressure signal to a bot process.
   *
   * Uses a flag file that the bot runtime watches. The bot reads the file,
   * runs GC, acknowledges via another flag, and removes the request flag.
   *
   * The flag file format:
   *   { "reason": "gc" | "restart", "at": ISO8601, "requestId": uuid }
   */
  async sendMemoryPressure(target, reason = 'gc') {
    const pm2Name = typeof target === 'string' ? target : target?.pm2Name;
    if (!pm2Name) return { success: false, reason: PM2ErrorCode.MISSING_PM2_NAME };
    if (this._mock?.sendMemoryPressure) return this._mock.sendMemoryPressure(pm2Name, reason);

    const { mkdirSync, writeFileSync } = await import('node:fs');
    const flagDir = path.join(this.projectRoot, '.runtime', 'pressure');
    const flagPath = path.join(flagDir, `${pm2Name}.flag`);
    const ackPath = path.join(flagDir, `${pm2Name}.ack`);

    try {
      mkdirSync(flagDir, { recursive: true });
      writeFileSync(flagPath, JSON.stringify({
        reason,
        at: new Date().toISOString(),
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ackPath,
      }), 'utf8');

      return { success: true, pm2Name, flagPath, reason };
    } catch (err) {
      return { success: false, pm2Name, reason: String(err?.message || err) };
    }
  }

  /**
   * Check if a specific process is online by PM2 name.
   * Throws if PM2 daemon is unreachable.
   */
  async isOnline(pm2Name) {
    const procs = await this.listProcesses();
    const proc = procs.find(p => p.name === pm2Name);
    return proc?.status === 'online' ? proc : null;
  }
}

export function createPM2Adapter(options = {}) {
  return new PM2Adapter(options);
}
