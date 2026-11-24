/**
 * Terminal Monitor: realtime status table for the PM2-managed bot fleet.
 *
 * Full layout (terminal >= 96 cols):
 *   BOT NAME | STATUS | PID | RAM | UPTIME | READINESS
 * Compact layout (< 96 cols):
 *   BOT | PM2 | PID | READINESS
 *
 * READINESS is resolved with the SAME shared readiness contract as reconcile
 * and the dashboard resolver (see runtime-readiness.js): PM2 supervisor status
 * + port probe + /internal/runtime/identity + listenerConnected. The old
 * per-row probe logic and the "missing listener fields = connected" backward
 * compatibility fallback are REMOVED — a bot is only `ready` when all layers
 * pass, and a payload missing pid/listener fields is never ready.
 * Concrete reasons surface: port-closed, identity-mismatch, pid-mismatch,
 * listener-disconnected, pm2-stopped, ...
 *
 * Connects to PM2 via listProcesses() every 2 seconds.
 * Only redraws when the resolved table changes.
 * Shows error state + backoff reconnect when PM2 daemon is unavailable.
 *
 * No stdout/stderr streaming, no message/command logs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PM2Adapter, isMyBotProcess } from './pm2-adapter.js';
import { probeBotReadiness, defaultPortProbe, defaultIdentityFetcher } from './runtime-readiness.js';
import { formatUptime, formatMemory, pad, truncate, stripAnsi, clearScreen, cursorHome, hideCursor, showCursor } from './terminal-render.js';

const REFRESH_MS = 2000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
/** Below this width the monitor renders the compact table (no RAM/uptime). */
const COMPACT_WIDTH_THRESHOLD = 96;

export class TerminalMonitor {
  constructor({
    projectRoot = process.cwd(),
    refreshMs = REFRESH_MS,
    portProbe = defaultPortProbe,
    identityFetcher = defaultIdentityFetcher,
  } = {}) {
    this.projectRoot = projectRoot;
    this.refreshMs = refreshMs;
    this.adapter = new PM2Adapter({ projectRoot });
    this.portProbe = portProbe;
    this.identityFetcher = identityFetcher;
    this.timer = null;
    this.lastState = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.isRunning = false;
    this.lineCount = 0;
    this.onOutput = null; // callback(line) for capture
  }

  /** Read registry bot keys for managed-process fallback identification. */
  async _registryBotKeys() {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = await fs.readFile(path.join(this.projectRoot, 'mybot', 'mybots.json'), 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return Object.keys(parsed || {}).filter((key) => typeof key === 'string' && key.trim());
    } catch {
      return [];
    }
  }

  /**
   * Enrich each process snapshot with the user-facing Zalo `displayName`.
   *
   * PM2 process name / botKey remain the INTERNAL ids (they are the control
   * key), but the terminal must show the real Zalo name:
   *   - Main  -> mybots.json['admin'].displayName, fallback assets/config.json.name
   *   - Child -> mybots.json[botKey].displayName
   * When the registry changes the Zalo name, the terminal redraws without
   * needing to rename / recreate the PM2 process.
   *
   * Missing name -> 'Chưa có tên Zalo' (never the raw `admin`/UID at the BOT
   * column).
   *
   * @param {Array} procs - process snapshots from listManagedProcesses/_fetchState
   * @returns {Promise<Array>} procs += displayName
   */
  async _enrichDisplayName(procs) {
    const registry = await this._readRegistry();
    const configName = await this._readConfigName();
    return (procs || []).map((proc) => {
      let displayName = null;
      if (proc.kind === 'dashboard' || proc.kind === 'guardian') {
        // Infra keeps its service label.
        displayName = proc.name;
      } else if (proc.kind === 'main' || proc.botKey === 'admin' || proc.name === 'admin') {
        const adminRecord = registry?.admin || {};
        displayName = adminRecord.displayName || proc.displayName || configName || proc.name;
      } else {
        const record = registry?.[proc.botKey || proc.name] || {};
        displayName = record.displayName || proc.displayName || record.name;
      }
      const resolved = String(displayName || '').trim();
      // Never surface a raw internal id when a display name is missing.
      return {
        ...proc,
        displayName: resolved || 'Chưa có tên Zalo',
      };
    });
  }

  /** Read the bot registry map ({ key: record }). */
  async _readRegistry() {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = await fs.readFile(path.join(this.projectRoot, 'mybot', 'mybots.json'), 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Read assets/config.json name for the Main bot displayName fallback. */
  async _readConfigName() {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = await fs.readFile(path.join(this.projectRoot, 'assets', 'config.json'), 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return parsed?.name || parsed?.displayName || parsed?.userInfo?.name || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch current managed process list and diff against last state.
   * Returns null if PM2 unavailable (triggers reconnect).
   * Uses the canonical managed-fleet inventory: env markers (BOT_MANAGED,
   * BOT_KEY, MYBOT_INSTANCE_KIND), infra names, registry-key fallback —
   * never requires a `bot-` prefix, never adopts foreign PM2 apps.
   */
  async _fetchState() {
    try {
      let procs = [];
      if (typeof this.adapter.listManagedProcesses === 'function') {
        const botKeys = await this._registryBotKeys();
        procs = await this.adapter.listManagedProcesses({ botKeys });
        if (procs === null) return null;
      } else {
        // Legacy/test adapters without the managed inventory: keep the
        // canonical isMyBotProcess filter as fallback.
        const all = await this.adapter.listProcesses();
        if (all === null) return null;
        procs = (all || []).filter(isMyBotProcess);
      }
      procs = (procs || []).filter((p) => p && p.name !== 'mybot-gemini-web');
      return procs;
    } catch {
      return null;
    }
  }

  /**
   * Diff two process lists to detect changes.
   * FIX: Uses normalized fields (state, rss, pm2Id) not raw PM2 fields.
   */
  _hasChanged(prev, curr) {
    if (!prev && curr) return true;
    if (prev && !curr) return true;
    if (!prev || !curr) return false;
    if (prev.length !== curr.length) return true;
    for (let i = 0; i < curr.length; i++) {
      const a = prev[i];
      const b = curr[i];
      if (!a || !b) return true;
      if (a.name !== b.name) return true;
      if (a.pm2Id !== b.pm2Id) return true;
      if (a.pid !== b.pid) return true;
      if (a.status !== b.status) return true;
      if (a.rss !== b.rss) return true;
      if (a.readiness !== b.readiness) return true;
      if (a.displayName !== b.displayName) return true;
    }
    return false;
  }

  /**
   * Read the registry bot record for a bot key (used for port fallback when
   * the PM2 launch env lost its WEB_PORT marker).
   */
  async _registryRecord(botKey) {
    const registry = await this._readRegistry();
    return registry?.[botKey] || null;
  }

  /**
   * Resolve the web port for a bot process. When the PM2 launch env carries
   * WEB_PORT, that is authoritative (the process was launched with it). When
   * it is missing (e.g. adopted/legacy process, or PM2 dropped the env), fall
   * back to the registry record by the CORRECT botKey — never guess a default
   * port, never scan for a port belonging to another bot.
   */
  async _resolveWebPort(proc) {
    const envPort = Number(proc.env?.WEB_PORT);
    if (Number.isFinite(envPort) && envPort > 0) return envPort;
    const record = await this._registryRecord(proc.botKey || proc.name);
    const regPort = Number(record?.webPort);
    return Number.isFinite(regPort) && regPort > 0 ? regPort : 0;
  }

  /**
   * Readiness for a process row, resolved with the SAME shared readiness
   * contract as reconcile (runtime-readiness.js): PM2 supervisor + port +
   * /internal/runtime/identity + listenerConnected.
   *
   * - Infrastructure processes (dashboard/guardian) are labeled `infra`:
   *   they must never be port-probed or identity-probed.
   * - Bot processes (main/child) are only `ready` when ALL layers pass.
   *   A payload missing pid or listener fields is NEVER ready (old/foreign
   *   processes must not fake readiness).
   * - Concrete reasons are surfaced: port-closed, identity-mismatch,
   *   pid-mismatch, listener-disconnected, pm2-stopped, ...
   */
  async _readinessLabel(proc) {
    if (proc.kind === 'dashboard' || proc.kind === 'guardian') {
      return proc.status === 'online' ? 'infra' : `infra-${proc.status || 'unknown'}`;
    }
    if (proc.status !== 'online') {
      return proc.status === 'stopped' || !proc.status ? 'pm2-stopped' : `pm2-${proc.status}`;
    }
    const port = await this._resolveWebPort(proc);
    if (!port) return 'no-port';
    // Derive kind robustly: admin/main is always 'main'; anything else is a
    // child bot. proc.kind may be absent on legacy/partial process objects.
    const kind = proc.kind === 'main' || proc.name === 'admin' || proc.botKey === 'admin' ? 'main' : 'child';
    const descriptor = { kind, botKey: proc.botKey || proc.name, webPort: port };
    try {
      const result = await probeBotReadiness({
        descriptor,
        process: { ...proc, env: { ...(proc.env || {}), WEB_PORT: String(port) } },
        portProbe: this.portProbe,
        identityFetcher: this.identityFetcher,
      });
      return result.ready ? 'ready' : (result.reason || 'not-ready');
    } catch {
      return 'probe-error';
    }
  }

  /**
   * Resolve readiness labels for a whole process list in parallel.
   */
  async _withReadiness(procs) {
    const labels = await Promise.all(procs.map((proc) => this._readinessLabel(proc)));
    return procs.map((proc, index) => ({ ...proc, readiness: labels[index] }));
  }

  /**
   * Render one process row. Two layouts:
   * - full (terminal width >= 96): BOT | STATUS | PID | RAM | UPTIME | READINESS
   * - compact (< 96 cols): BOT | PM2 | PID | READINESS
   * `width` is the TOTAL line budget including the 2-space row indent, so
   * every rendered line stays inside the terminal width and never wraps.
   */
  _renderRow(proc, { compact, width }) {
    const reset = '\x1b[0m';
    const statusColor = proc.status === 'online'
      ? '\x1b[32m'  // green
      : proc.status === 'errored' || proc.status === 'stopped'
        ? '\x1b[31m' // red
        : proc.status === 'restarting'
          ? '\x1b[33m' // yellow
          : '\x1b[90m'; // dim
    const readinessColor = proc.readiness === 'ready'
      ? '\x1b[32m'
      : proc.readiness === 'infra' || proc.readiness?.startsWith('infra-')
        ? '\x1b[90m'
        : '\x1b[33m'; // yellow for not-ready reasons
    // The BOT column is user-facing: show the Zalo name, never the raw
    // PM2 name / admin / UID when the name is unknown.
    const name = truncate(proc.displayName || 'Chưa có tên Zalo', compact ? 24 : 20);
    const pid = String(proc.pid || '-');
    const status = proc.status || 'unknown';
    if (compact) {
      // BOT(24) + 3 separators(9) + PM2(10) + PID(7) = 50 before READINESS;
      // with the 2-space indent the budget is width - 52.
      const nameW = 24;
      const statusW = 10;
      const pidW = 7;
      const readinessW = Math.max(8, width - 52);
      return `${pad(name, nameW)} | ${statusColor}${pad(status, statusW)}${reset} | ${pad(pid, pidW)} | ${readinessColor}${pad(truncate(proc.readiness || '-', readinessW), readinessW)}${reset}`;
    }
    // Full layout: fixed columns 22/12/7/9/14 + 5 ' | ' separators (15) +
    // the 2-space indent = 81 chars before READINESS. READINESS absorbs the
    // remaining width so the total never exceeds the terminal width.
    const ram = formatMemory(proc.rss || 0);
    const uptime = formatUptime(proc.uptime || 0);
    const readinessW = Math.max(8, width - 81);
    return `${pad(name, 22)} | ${statusColor}${pad(status, 12)}${reset} | ${pad(pid, 7)} | ${pad(ram, 9)} | ${pad(uptime, 14)} | ${readinessColor}${pad(truncate(proc.readiness || '-', readinessW), readinessW)}${reset}`;
  }

  _getDiskCleanupInfo() {
    try {
      const p = path.join(this.projectRoot, '.runtime', 'disk-cleanup', 'status.json');
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const st = JSON.parse(raw);
        const lastRun = st.lastRun ? new Date(st.lastRun).toLocaleTimeString() : null;
        const freedMb = ((st.bytesFreedTotal || 0) / (1024 * 1024)).toFixed(1);
        const diskPercent = st.diskAfter?.usedPercent ?? st.diskBefore?.usedPercent ?? null;
        return { lastRun, freedMb, diskPercent };
      }
    } catch {}
    return null;
  }

  /**
   * Render the full table with header. Column layout adapts to the terminal
   * width; when the width cannot be detected, assume 96.
   */
  _renderTable(procs, { width = 96 } = {}) {
    const compact = width < COMPACT_WIDTH_THRESHOLD;
    const totalWidth = Math.max(40, Math.min(width, 200));
    const lines = [];
    const sep = pad('', totalWidth, '─');
    let header;
    if (compact) {
      // BOT(24) + 3 separators(9) + PM2(10) + PID(7) + indent(2) = 52
      header = `${pad('BOT', 24)} | ${pad('PM2', 10)} | ${pad('PID', 7)} | ${pad('READINESS', Math.max(8, totalWidth - 52))}`;
    } else {
      header = `${pad('BOT NAME', 22)} | ${pad('STATUS', 12)} | ${pad('PID', 7)} | ${pad('RAM', 9)} | ${pad('UPTIME', 14)} | ${pad('READINESS', Math.max(8, totalWidth - 81))}`;
    }
    const headerLine = '\x1b[1m\x1b[36m' + header + '\x1b[0m';
    lines.push(headerLine);
    lines.push(sep);

    if (!procs || procs.length === 0) {
      // Distinguish "daemon reachable but empty" from "daemon unavailable"
      // (the latter is handled separately in _renderError before reaching here).
      lines.push(pad('  (no MyBot processes under PM2 yet)', 60));
      lines.push('');
      lines.push('  PM2 daemon is reachable. Run `run.bat` again to start the fleet,');
      lines.push('  or `npx pm2 jlist` to inspect.');
    } else {
      // Sort: mybot-dashboard, mybot-guardian, admin, then children by name
      const sorted = [...procs].sort((a, b) => {
        const order = { 'mybot-dashboard': 0, 'mybot-guardian': 1, 'admin': 2 };
        const oa = order[a.name] ?? 99;
        const ob = order[b.name] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name).localeCompare(b.name);
      });
      for (const proc of sorted) {
        lines.push('  ' + this._renderRow(proc, { compact, width: totalWidth }));
      }
    }

    lines.push(sep);
    const diskInfo = this._getDiskCleanupInfo();
    const diskStr = diskInfo && diskInfo.diskPercent !== null
      ? `  |  SSD: ${diskInfo.diskPercent}%` + (diskInfo.lastRun ? ` (Clean: ${diskInfo.lastRun}, -${diskInfo.freedMb}MB)` : '')
      : '';
    if (!compact) {
      const totalRam = procs?.reduce((sum, p) => sum + (p.rss || 0), 0) || 0;
      lines.push(`  Total RAM: ${formatMemory(totalRam)}${diskStr}  |  Last refresh: ${new Date().toLocaleTimeString()}`);
    } else {
      lines.push(`  Last refresh: ${new Date().toLocaleTimeString()}${diskStr ? '  |' + diskStr : ''}`);
    }
    return lines;
  }

  /**
   * Render error state when PM2 is unavailable.
   */
  _renderError(attempt) {
    const backoffSec = Math.round(this.reconnectDelay / 1000);
    return [
      '\x1b[31m\x1b[1m[PM2 UNAVAILABLE]\x1b[0m',
      `  Cannot connect to PM2 daemon. Retrying in ${backoffSec}s...`,
      `  (Attempt ${attempt}; backoff max: ${RECONNECT_MAX_MS / 1000}s)`,
      '  Processes may still be running under different management.',
      '',
    ];
  }

  /**
   * Clear previously rendered lines.
   */
  _clear() {
    if (this.lineCount > 0) {
      process.stdout.write(cursorHome());
      for (let i = 0; i < this.lineCount; i++) {
        process.stdout.write('\x1b[2J'); // clear line
        if (i < this.lineCount - 1) process.stdout.write('\x1b[1B'); // move down
      }
      process.stdout.write(cursorHome());
    }
    this.lineCount = 0;
  }

  /**
   * Write lines to stdout. Every line is hard-clipped to the terminal width
   * so nothing ever wraps in CMD, regardless of content source.
   */
  _writeLines(lines) {
    const width = this._terminalWidth();
    const clipped = lines.map((line) => {
      const visible = stripAnsi(line);
      if (visible.length <= width) return line;
      // Keep the ANSI prefix (colors) and clip visible content.
      const ansiMatch = line.match(/^(\x1b\[[0-9;]*[a-zA-Z])+/);
      const prefix = ansiMatch ? ansiMatch[0] : '';
      return prefix + truncate(visible, width);
    });
    const output = clipped.join('\n') + '\n';
    if (this.onOutput) {
      for (const line of clipped) this.onOutput(line);
    }
    process.stdout.write(output);
    this.lineCount = clipped.length;
  }

  /**
   * Schedule reconnect with exponential backoff.
   */
  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = RECONNECT_BASE_MS;
      if (this.isRunning) this._tick();
    }, delay);
  }

  /**
   * One tick: fetch state and render.
   * FIX: Only clear before render; if state hasn't changed, do nothing (no
   * blank terminal). The old code cleared unconditionally, which could leave
   * a blank screen if no changes were detected.
   */
  async _tick() {
    if (!this.isRunning) return;

    const fetched = await this._fetchState();

    if (fetched === null) {
      // PM2 unavailable: clear and render error
      this._clear();
      this._writeLines(this._renderError(this.reconnectDelay / RECONNECT_BASE_MS));
      this._scheduleReconnect();
      return;
    }

    // Reset backoff on successful connect
    this.reconnectDelay = RECONNECT_BASE_MS;

    // Resolve real readiness (parallel probes) — infra rows are labeled
    // without any probe; bot rows go through port + identity checks.
    const withReadiness = await this._withReadiness(fetched);

    // Enrich each row with the user-facing Zalo name (PM2 name/botKey stay
    // internal; only the displayed BOT column changes).
    const procs = await this._enrichDisplayName(withReadiness);

    if (!this._hasChanged(this.lastState, procs)) {
      // No change — keep current display, do nothing
      return;
    }

    // State changed — clear old, render new
    this._clear();
    this.lastState = procs;
    this._writeLines(this._renderTable(procs, { width: this._terminalWidth() }));
  }

  /**
   * Current terminal width in columns. Falls back to 96 (the widest layout
   * that fits a default CMD window) when stdout is not a TTY or the width
   * cannot be read.
   */
  _terminalWidth() {
    const columns = process.stdout?.columns;
    return Number.isInteger(columns) && columns >= 40 ? columns : 96;
  }

  /**
   * Start the monitor loop.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastState = null;
    this.reconnectDelay = RECONNECT_BASE_MS;

    process.stdout.write(clearScreen());
    process.stdout.write(hideCursor());

    const loop = async () => {
      await this._tick();
      if (this.isRunning) {
        this.timer = setTimeout(loop, this.refreshMs);
      }
    };
    loop();
  }

  /**
   * Stop the monitor without killing managed processes.
   * Returns a Promise that resolves when the monitor has fully stopped.
   */
  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._clear();
    process.stdout.write(showCursor());
    // If run as standalone script (indicated by the _runMonitor flag), exit.
    if (this._standalone) {
      process.exit(0);
    }
  }
}

/**
 * Run the terminal monitor as a standalone script.
 */
export async function runMonitor() {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const monitor = new TerminalMonitor({ projectRoot });
  monitor._standalone = true;

  const shutdown = () => {
    monitor.stop(); // calls process.exit internally when _standalone=true
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  monitor.start();

  // Keep alive
  await new Promise(() => {});
}
