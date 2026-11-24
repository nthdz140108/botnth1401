/**
 * PM2 Reconcile & Monitor Entry Point
 *
 * Called by run.bat when starting the full bot fleet. This script:
 * 1. Ensures the .runtime directory exists
 * 2. Starts dashboard, guardian via PM2 (if not already running)
 * 3. Starts main bot via PM2 (start-or-adopt)
 * 4. Restores child bots that were running before shutdown
 * 5. Starts the terminal monitor foreground
 *
 * Exits cleanly when monitor is closed (no process is killed).
 *
 * FIX: Now uses listMyBotProcesses() (not listProcesses) so reconcile only
 * manages MyBot fleet processes.
 * FIX: Reads normalized .state field (was .process.state which is always undefined
 * in PM2 jlist raw output; status lives in .pm2_env.status).
 * FIX: Stale-commit detection uses the MYBOT_CODE_COMMIT env marker stamped by
 * launch-descriptor.js (visible via `pm2 jlist` pm2_env.env) instead of the old
 * log-fingerprint guard whose log paths never matched real PM2 output files.
 * A marker mismatch forces reloadBotFromDescriptor(); reconcile fails clearly
 * if the reload cannot bring the process online at the current commit.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PM2Adapter, isMyBotProcess } from './pm2-adapter.js';
import { generateEcosystemConfig } from './ecosystem-config.js';
import { TerminalMonitor } from './terminal-monitor.js';
import { explainAutoRestoreCandidates } from '../commands/mybot/System/mybot-auto-restore.js';
import { createLaunchDescriptor } from './launch-descriptor.js';
import { ensureProcessAtCommit } from './reconcile-guard.js';
import { createBotReadinessService } from './runtime-readiness.js';
import { allocateBindablePort, canBindPort } from './port-allocator.js';
import { startInteractiveAdminRecoveryWatcher } from './admin-recovery-watcher.js';
import { installWindowsConsoleSafety } from './windows-console-guard.js';
import { ensureWin2012CanvasCompat } from './win2012-canvas-compat.js';

installWindowsConsoleSafety();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const RECONCILE_ECOSYSTEM_PATH = path.join(PROJECT_ROOT, '.runtime', 'ecosystem.config.cjs');

/** Main reconcile deadline: login 30s + QR recovery 120s + listener bind. */
const MAIN_READINESS_TIMEOUT_MS = 165_000;
/** Child / adopted-process deadline: 60s. */
const CHILD_READINESS_TIMEOUT_MS = 60_000;
/** A fresh process may be reloaded at most once per reconcile run. */
const MAX_RELOAD_PER_RUN = 1;

/**
 * Short SHA of the current checkout. null disables the commit-marker guard
 * (e.g. git unavailable): reconcile must never block startup on telemetry.
 */
function currentCommitShort() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function ensureRuntimeDir() {
  for (const sub of [
    ['pressure'],
    ['temp', '.leases'],
    ['backups'],
  ]) {
    const dir = path.join(PROJECT_ROOT, '.runtime', ...sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

async function readRegistry() {
  const regPath = path.join(PROJECT_ROOT, 'mybot', 'mybots.json');
  if (!fs.existsSync(regPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(regPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

async function isPortInUse(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => { resolve(true); });
    s.once('listening', () => { s.close(); resolve(false); });
    s.listen(port, '127.0.0.1');
  });
}

/**
 * Allocate a NEW genuinely-bindable port for a child bot whose current port is
 * unusable (occupied by a foreign process, or the bridge failed to bind). This
 * never falls back to a hard-coded default: if nothing is free it throws.
 *
 * @param {object} params
 * @param {object} params.registry current mybots.json
 * @param {object} params.botKey the child bot key
 * @returns {Promise<number>} a bindable port not claimed by other bots
 */
async function allocateFreshChildPort({ registry, botKey }) {
  // Temporarily drop the child's own (broken) port from the "used" set so the
  // allocator can re-allocate from the full range; other bots stay reserved.
  const registryWithoutSelf = { ...registry };
  delete registryWithoutSelf[botKey];
  const port = await allocateBindablePort({ registry: registryWithoutSelf });
  return port;
}

/**
 * Apply a newly allocated webPort to a child bot consistently across:
 * mybots.json registry, the bot's own config, and the running PM2 env, then
 * reload exactly that one child and verify its new PID + readiness.
 *
 * Returns { success, port, pm2Name, reason, identity } — never throws on an
 * individual child (failure-isolated, no restart loop).
 */
export async function autoFixChildPort({
  registry,
  bot,
  adapter,
  readiness,
  commit,
  projectRoot = PROJECT_ROOT,
  isPortInUseFn = isPortInUse,
  canBindFn = canBindPort,
  reloadFn = null,
  readinessTimeoutMs = CHILD_READINESS_TIMEOUT_MS,
} = {}) {
  const pm2Name = bot.botKey || bot.uid;
  const oldPort = Number(bot.webPort) || 0;

  try {
    // Pick a new bindable port (skips anything another bot holds and anything
    // a foreign process already occupies). Throws NO_BINDABLE_PORT if none.
    const registryWithoutSelf = { ...registry };
    delete registryWithoutSelf[pm2Name];
    const newPort = await allocateBindablePort({ registry: registryWithoutSelf });

    // Update the registry record synchronously.
    const registryPath = path.join(projectRoot, 'mybot', 'mybots.json');
    const updatedRegistry = { ...registry, [pm2Name]: { ...bot, webPort: String(newPort) } };
    try { fs.writeFileSync(registryPath, JSON.stringify(updatedRegistry, null, 2), 'utf8'); } catch {}

    // Update the bot's own config webPort (mybot/bots/<key>.json) if present.
    const childConfigPath = path.join(projectRoot, 'mybot', 'bots', `${pm2Name}.json`);
    if (fs.existsSync(childConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(childConfigPath, 'utf8').replace(/^\uFEFF/, ''));
        cfg.webPort = String(newPort);
        fs.writeFileSync(childConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
      } catch {}
    }

    // Reload the child from the current descriptor carrying the NEW port env.
    const desc = createLaunchDescriptor({
      kind: 'child',
      botKey: pm2Name,
      uid: bot.uid,
      projectRoot,
      webPort: newPort,
      commit,
    });
    const reload = typeof reloadFn === 'function'
      ? await reloadFn(desc)
      : await adapter.reloadBotFromDescriptor(desc);
    if (!reload?.success) {
      return { success: false, port: newPort, pm2Name, reason: `reload-failed:${reload?.reason || 'unknown'}` };
    }

    // Verify the reloaded process is online, on the new port, with matching
    // PID (Web port changed => a fresh PID is expected), then readiness.
    const procs = await adapter.listMyBotProcesses().catch(() => []);
    const proc = procs.find((p) => p.name === pm2Name) || null;
    const newPid = reload.pid || proc?.pid || null;
    const ready = await readiness.waitFor({
      descriptor: desc,
      process: proc,
      expectedPid: newPid,
      supervisor: (name) => readiness.getProcess(name),
      timeoutMs: readinessTimeoutMs,
      intervalMs: 1000,
    });
    if (!ready.ready) {
      return { success: false, port: newPort, pm2Name, reason: `not-ready:${ready.reason}`, identity: ready.identity };
    }
    // Confirm the bridge actually answers on the new port with the right identity.
    const portOpen = newPort > 0 ? await isPortInUseFn(newPort) : false;
    console.log(`[reconcile] ${pm2Name} port auto-fixed ${oldPort || '?'} -> ${newPort} (pid ${newPid}, reason=${ready.reason}, portOpen=${portOpen})`);
    return { success: true, port: newPort, pm2Name, reason: ready.reason, identity: ready.identity };
  } catch (error) {
    // NO_BINDABLE_PORT or a reload failure: leave the child at its own error
    // state; do NOT create a restart loop.
    return { success: false, port: oldPort, pm2Name, reason: `auto-fix-error:${error.message}` };
  }
}

async function isPM2DaemonUp(adapter) {
  try {
    await adapter.listProcesses();
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for one bot process to be actually ready (port + identity + listener),
 * NOT merely PM2-online. This is the fix for "PM2 online but port-closed":
 * PM2 only proves the supervisor thinks the process is alive.
 *
 * @param {object} params
 * @param {object} params.adapter PM2 adapter
 * @param {object} params.descriptor launch descriptor for the bot
 * @param {object} params.readiness createBotReadinessService() result
 * @param {number} [params.timeoutMs] MAIN_READINESS_TIMEOUT_MS for main,
 *   CHILD_READINESS_TIMEOUT_MS for children.
 * @param {boolean} [params.expectFreshPid] when true, the identity pid must
 *   equal the freshly observed PM2 pid (newly started / reloaded).
 * @returns {Promise<object>} readiness result
 */
async function ensureBotReady({ adapter, descriptor, readiness, timeoutMs = CHILD_READINESS_TIMEOUT_MS, expectFreshPid = false }) {
  const pm2Name = descriptor.pm2Name;
  let processSnapshot = null;
  try {
    const procs = await adapter.listMyBotProcesses();
    processSnapshot = procs.find((p) => p.name === pm2Name) || null;
  } catch {
    // Daemon was preflighted; fall through and let the probe report.
  }
  const expectedPid = expectFreshPid ? (processSnapshot?.pid || null) : null;
  const result = await readiness.waitFor({
    descriptor,
    process: processSnapshot,
    expectedPid,
    supervisor: (name) => readiness.getProcess(name),
    timeoutMs,
    intervalMs: 1000,
  });
  if (result.ready) {
    console.log(`[reconcile] ${pm2Name} READY (pid ${processSnapshot?.pid || result.identity?.pid || '?'}, reason=${result.reason})`);
  } else {
    console.warn(`[reconcile] ${pm2Name} NOT ready: ${result.reason}${result.identity ? ` (identity: ${result.identity.kind}/${result.identity.botKey} pid=${result.identity.pid})` : ''}`);
    for (const [label, logPath] of [['stderr', processSnapshot?.errorLogPath], ['stdout', processSnapshot?.outLogPath]]) {
      if (!logPath || !fs.existsSync(logPath)) continue;
      try {
        const tail = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).slice(-12);
        if (tail.length > 0 && tail.some(Boolean)) {
          console.warn(`[reconcile] Last ${label} lines of ${pm2Name} (${logPath}):`);
          for (const line of tail) console.warn(`  | ${line}`);
        }
      } catch {}
    }
  }
  return result;
}

async function startDashboard(adapter, commit) {
  if (process.env.MYBOT_NODE_HYBRID === 'true' || process.env.DISABLE_NODE_DASHBOARD === 'true') {
    console.log('[reconcile] Hybrid mode active: Node dashboard auto-start disabled (port 4173 reserved for Rust V4)');
    return;
  }
  const port = parseInt(process.env.DASHBOARD_PORT || '4173', 10);
  const inUse = await isPortInUse(port);
  if (inUse) {
    const guard = await ensureProcessAtCommit({
      adapter,
      pm2Name: 'mybot-dashboard',
      commit,
      buildDescriptor: () => createLaunchDescriptor({ kind: 'dashboard', projectRoot: PROJECT_ROOT, commit }),
    });
    if (!guard.reloaded) console.log(`[reconcile] Dashboard already on port ${port}, skipping`);
    if (guard.reloadFailed) throw new Error(`mybot-dashboard reload failed — refusing to continue with stale dashboard`);
    return;
  }
  const desc = createLaunchDescriptor({ kind: 'dashboard', projectRoot: PROJECT_ROOT, commit });
  const result = await adapter.startBot(desc);
  if (result.success) {
    console.log(`[reconcile] Dashboard started (${desc.pm2Name})${result.adopted ? ' [adopted]' : ''}`);
  } else {
    console.warn(`[reconcile] Dashboard start failed: ${result.reason} — ${result.detail || ''}`);
  }
}

async function startGuardian(adapter, commit) {
  const desc = createLaunchDescriptor({ kind: 'guardian', projectRoot: PROJECT_ROOT, commit });
  // FIX: use listMyBotProcesses() and check normalized .state
  const procs = await adapter.listMyBotProcesses();
  const guardian = procs.find((p) => p.name === 'mybot-guardian');
  if (guardian && guardian.status === 'online') {
    const guard = await ensureProcessAtCommit({
      adapter,
      pm2Name: 'mybot-guardian',
      commit,
      buildDescriptor: () => desc,
    });
    if (!guard.reloaded) console.log('[reconcile] Guardian already online, skipping');
    if (guard.reloadFailed) throw new Error(`mybot-guardian reload failed — refusing to continue with stale guardian`);
    return;
  }
  const result = await adapter.startBot(desc);
  if (result.success) {
    console.log(`[reconcile] Guardian started (${desc.pm2Name})${result.adopted ? ' [adopted]' : ''}`);
  } else {
    console.warn(`[reconcile] Guardian start failed: ${result.reason} — ${result.detail || ''}`);
  }
}

async function cleanupLegacyGeminiWeb(adapter) {
  try {
    const procs = await adapter.listProcesses();
    const existing = procs.find((p) => p.name === 'mybot-gemini-web');
    if (existing) {
      console.log('[reconcile] Removing legacy mybot-gemini-web from PM2...');
      await adapter.deleteBot('mybot-gemini-web');
    }
  } catch {
    // Best effort cleanup
  }
}

async function startMain(adapter, commit, readiness) {
  const desc = createLaunchDescriptor({ kind: 'main', projectRoot: PROJECT_ROOT, commit });
  // FIX: use listMyBotProcesses() and check normalized .state
  const procs = await adapter.listMyBotProcesses();
  const main = procs.find((p) => p.name === 'admin');
  let startedFresh = false;
  if (main && main.status === 'online') {
    const guard = await ensureProcessAtCommit({
      adapter,
      pm2Name: 'admin',
      commit,
      buildDescriptor: () => desc,
    });
    if (guard.reloadFailed) throw new Error(`admin reload failed — refusing to continue with stale main bot`);
    if (guard.reloaded) {
      startedFresh = true;
      console.log('[reconcile] Main bot reloaded onto current commit, awaiting readiness...');
    } else {
      console.log('[reconcile] Main bot already online, verifying readiness...');
    }
  } else {
    const result = await adapter.startBot(desc);
    if (!result.success) {
      console.warn(`[reconcile] Main bot start failed: ${result.reason} — ${result.detail || ''}`);
      return { success: false, reason: result.reason };
    }
    startedFresh = true;
    console.log(`[reconcile] Main bot started (${desc.pm2Name})${result.adopted ? ' [adopted]' : ''}`);
  }

  // Readiness is the real "is the bot running" check — PM2 online alone is
  // NOT enough (the PM2 7 ESM import bug leaves processes online with the
  // port closed). Wait for identity + port + listener.
  const ready = await ensureBotReady({
    adapter,
    descriptor: desc,
    readiness,
    timeoutMs: MAIN_READINESS_TIMEOUT_MS,
    expectFreshPid: startedFresh,
  });
  return { success: ready.ready, ...ready };
}

/**
 * Restore ALL valid, unexpired child bots at startup (policy: "mọi bot hợp
 * lệ còn hạn" — previous `status: stopped` no longer excludes a bot).
 *
 * Failure-isolated: one bot's start error never blocks the remaining bots.
 * Returns a summary { started, alreadyOnline, skipped, failed } where each
 * entry carries the bot uid and the concrete reason.
 */
export async function restoreChildBotsForTest({
  registry = {},
  adapter,
  isPortInUseFn,
  ensureProcessAtCommitFn = ensureProcessAtCommit,
  commit = 'test',
  readiness = null,
  readinessTimeoutMs = CHILD_READINESS_TIMEOUT_MS,
  autoFixChildPortFn = null,
  projectRoot = PROJECT_ROOT,
} = {}) {
  const { candidates, skipped } = explainAutoRestoreCandidates(registry, { projectRoot });
  const summary = {
    total: candidates.length,
    started: 0,
    alreadyOnline: 0,
    skipped: Object.entries(skipped).map(([uid, reason]) => ({ uid, reason })),
    failed: [],
    startedList: [],
    alreadyOnlineList: [],
  };

  if (candidates.length === 0) {
    console.log('[reconcile] No child bots to restore');
    return summary;
  }

  // Canonical managed inventory: env markers + registry-key fallback, so
  // child bots with keys not starting with `bot-` are still recognized.
  const botKeys = Object.keys(registry || {});
  const procs = adapter.listManagedProcesses
    ? await adapter.listManagedProcesses({ botKeys })
    : await adapter.listProcesses();

  for (const bot of candidates) {
    const pm2Name = bot.botKey || bot.uid;
    try {
      const alreadyOnline = procs.some((p) => p.name === pm2Name && p.status === 'online');
      if (alreadyOnline) {
        const buildChildDesc = () => createLaunchDescriptor({
          kind: 'child',
          botKey: bot.botKey || bot.uid,
          uid: bot.uid,
          projectRoot: PROJECT_ROOT,
          webPort: bot.webPort,
          commit,
        });
        const guard = await ensureProcessAtCommitFn({
          adapter,
          pm2Name,
          commit,
          buildDescriptor: buildChildDesc,
        });
        if (guard.reloadFailed) {
          summary.failed.push({ uid: pm2Name, reason: 'stale-commit-reload-failed' });
          continue;
        }
        // When a real readiness probe service is wired in, verify an already-online
        // child is not wedged in `listener-disconnected` or `port-closed`. If it
        // stays unready past a short settle window, reload it once.
        if (readiness && typeof readiness.probe === 'function' && bot.webPort) {
          const onlineDesc = buildChildDesc();
          const onlineProc = procs.find((p) => p.name === pm2Name) || null;
          const initialProbe = await readiness.probe({ descriptor: onlineDesc, process: onlineProc }).catch(() => null);
          if (initialProbe && !initialProbe.ready) {
            const waited = await ensureBotReady({
              adapter,
              descriptor: onlineDesc,
              readiness,
              timeoutMs: Math.min(readinessTimeoutMs, 15_000),
              expectFreshPid: Boolean(guard.reloaded),
            });
            if (!waited.ready && !guard.reloaded && typeof adapter.reloadBotFromDescriptor === 'function') {
              console.warn(`[reconcile] ${pm2Name} online but not ready (${waited.reason}); reloading once...`);
              const reloadRes = await adapter.reloadBotFromDescriptor(onlineDesc).catch(() => ({ success: false }));
              if (reloadRes?.success) {
                const afterReload = await ensureBotReady({
                  adapter,
                  descriptor: onlineDesc,
                  readiness,
                  timeoutMs: readinessTimeoutMs,
                  expectFreshPid: true,
                });
                if (!afterReload.ready) {
                  summary.failed.push({ uid: pm2Name, reason: `not-ready:${afterReload.reason}` });
                  continue;
                }
              } else {
                summary.failed.push({ uid: pm2Name, reason: `not-ready:${waited.reason}` });
                continue;
              }
            }
          }
        }
        summary.alreadyOnline += 1;
        summary.alreadyOnlineList.push(pm2Name);
        console.log(`[reconcile] ${pm2Name} already online, skipping`);
        continue;
      }

      const webPort = bot.webPort;
      if (webPort && (await isPortInUseFn(webPort))) {
        console.log(`[reconcile] ${pm2Name} port ${webPort} already in use, skipping`);
        summary.alreadyOnline += 1;
        summary.alreadyOnlineList.push(pm2Name);
        continue;
      }

      const desc = createLaunchDescriptor({
        kind: 'child',
        botKey: bot.botKey || bot.uid,
        uid: bot.uid,
        projectRoot: PROJECT_ROOT,
        webPort,
        commit,
      });
      const result = await adapter.startBot(desc);
      if (result.success) {
        console.log(`[reconcile] Started ${pm2Name}${result.adopted ? ' [adopted]' : ''}`);
        // Readiness check for the freshly started/adopted process. A PM2
        // `online` result is NOT readiness — the process must answer on its
        // port with the correct identity and an active listener. Child
        // failures are aggregated (not fatal) but never block other children.
        if (readiness) {
          const ready = await ensureBotReady({
            adapter,
            descriptor: desc,
            readiness,
            timeoutMs: readinessTimeoutMs,
            expectFreshPid: !result.adopted,
          });
          if (!ready.ready) {
            // Port auto-fix: a child that is PM2-online but reports a closed
            // bridge or a bound-but-different identity is usually a stale/foreign
            // port. Re-provision a genuinely bindable port, reload exactly this
            // child once, and verify the new PID + identity. Never loop.
            const portReason = ready.reason === 'port-closed'
              || ready.reason === 'identity-mismatch'
              || ready.reason === 'pid-mismatch'
              || (ready.identity?.portError && ready.identity.portError === true);
            if (portReason && typeof autoFixChildPortFn === 'function') {
              const fixed = await autoFixChildPortFn({
                registry,
                bot,
                adapter,
                readiness,
                commit,
                isPortInUseFn,
              });
              if (fixed.success) {
                summary.started += 1;
                summary.startedList.push(pm2Name);
                continue;
              }
              console.warn(`[reconcile] ${pm2Name} port auto-fix failed (${fixed.reason}); keeping at error`);
              summary.failed.push({ uid: pm2Name, reason: `not-ready:${ready.reason}` });
              continue;
            }
            summary.failed.push({ uid: pm2Name, reason: `not-ready:${ready.reason}` });
            continue;
          }
        }
        summary.started += 1;
        summary.startedList.push(pm2Name);
      } else {
        console.warn(`[reconcile] Failed to start ${pm2Name}: ${result.reason} — ${result.detail || ''}`);
        summary.failed.push({ uid: pm2Name, reason: `${result.reason}${result.detail ? ` — ${result.detail}` : ''}` });
      }
    } catch (error) {
      console.warn(`[reconcile] Failed to start ${pm2Name}: ${error.message}`);
      summary.failed.push({ uid: pm2Name, reason: error.message });
    }
  }

  console.log(
    `[reconcile] Child bots: ${summary.started} started, ${summary.alreadyOnline} already-online, ` +
    `${summary.skipped.length} skipped, ${summary.failed.length} failed`
  );
  for (const item of summary.skipped) console.log(`[reconcile]   skipped ${item.uid}: ${item.reason}`);
  for (const item of summary.failed) console.log(`[reconcile]   failed  ${item.uid}: ${item.reason}`);
  return summary;
}

async function restoreChildBots(adapter, commit, readiness) {
  const registry = await readRegistry();
  return restoreChildBotsForTest({
    registry,
    adapter,
    commit,
    readiness,
    isPortInUseFn: isPortInUse,
    ensureProcessAtCommitFn: ensureProcessAtCommit,
    autoFixChildPortFn: autoFixChildPort,
  });
}

/**
 * Reconcile PM2 orphan MyBot fleet processes against the current registry.
 *
 * "Orphan" = a PM2 process that PM2 is still tracking but the bot registry
 * (mybots.json) has no record of. These appear because the delete flow used
 * to call `pm2 stop` without `pm2 delete`, leaving the registry entry gone
 * but the process still listed under PM2 (the "Chưa có tên Zalo" row).
 *
 * Safe-delete policy (matches the locked plan):
 *  - Only run when the registry file reads and parses cleanly. Malformed
 *    registry => leave every PM2 process alone (no guessing).
 *  - Only consider processes that look like the MyBot fleet (env marker
 *    BOT_MANAGED=true, or fixed infra names 'admin', 'mybot-dashboard',
 *    'mybot-guardian'). Foreign PM2 apps that happen to share a name are
 *    excluded by `isMyBotProcess` (registry-key fallback only when the
 *    BOT_MANAGED env is unset and not 'false').
 *  - Exclude infra rows: admin, mybot-dashboard, mybot-guardian.
 *  - Children with no registry entry whose PM2 status is `stopped` or
 *    `errored` => call `pm2 delete` so they disappear from the fleet list.
 *  - Children with no registry entry whose PM2 status is `online` =>
 *    WARN only, never auto-delete (live online bots may belong to a
 *    different workspace; we don't kill them unattended).
 *  - Registry-known processes are left alone — they're handled by the
 *    restore + readiness paths.
 *
 * Idempotent: re-running after the orphans are gone is a no-op.
 *
 * @param {object} params
 * @param {object} params.adapter PM2Adapter (real or mock)
 * @param {string} [params.registryPath] path to mybots.json
 * @returns {Promise<{scanned:number,deleted:string[],warned:string[],skipped:number,registryOk:boolean,errors:Array}>}
 */
export async function cleanupPm2OrphansForTest({
  adapter,
  registryPath = path.join(PROJECT_ROOT, 'mybot', 'mybots.json'),
} = {}) {
  const result = { scanned: 0, deleted: [], warned: [], skipped: 0, registryOk: false, errors: [] };

  if (!adapter || typeof adapter.listProcesses !== 'function' || typeof adapter.deleteBot !== 'function') {
    return result;
  }

  // 1. Read registry, fail-closed if malformed or missing.
  let registry = {};
  try {
    if (!fs.existsSync(registryPath)) {
      // No registry on disk means we cannot know which processes are
      // orphans — leave every PM2 process alone.
      return result;
    }
    const raw = fs.readFileSync(registryPath, 'utf8').replace(/^\uFEFF/, '');
    registry = JSON.parse(raw);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      return result;
    }
    result.registryOk = true;
  } catch {
    return result;
  }

  // 2. Snapshot the PM2 fleet.
  let procs = [];
  try {
    procs = await adapter.listProcesses();
  } catch (err) {
    result.errors.push({ phase: 'listProcesses', message: err?.message || String(err) });
    return result;
  }

  result.scanned = procs.length;

  // Only processes explicitly stamped BOT_MANAGED=true (or fixed infra names,
  // which are skipped below) are candidates for orphan cleanup. The legacy
  // `bot-` name prefix is NOT trusted here: a foreign PM2 app that happens to
  // start with `bot-` but was never launched by the MyBot fleet must not be
  // deleted just because it shares a name (the plan's "đừng đụng process chỉ
  // tình cờ trùng tên" rule).
  const isBOTManaged = (proc) => {
    const env = proc.env || proc.pm2Env?.env || {};
    return env.BOT_MANAGED === 'true' || env.BOT_MANAGED === true;
  };

  for (const proc of procs) {
    if (!proc || !proc.name) continue;
    // Only manage MyBot fleet processes (env markers + infra names).
    if (!isMyBotProcess(proc)) continue;
    // Infra rows are never orphans.
    if (proc.name === 'admin' || proc.name === 'mybot-dashboard' || proc.name === 'mybot-guardian') {
      continue;
    }
    // A child orphan must be explicitly fleet-managed. Processes admitted only
    // via the legacy `bot-` prefix without BOT_MANAGED are left untouched.
    if (!isBOTManaged(proc)) continue;
    // Registry-known processes are owned, leave them for restore + readiness.
    if (Object.prototype.hasOwnProperty.call(registry, proc.name)) continue;

    const status = String(proc.status || '').toLowerCase();
    if (status === 'stopped' || status === 'errored') {
      try {
        const del = await adapter.deleteBot(proc.name);
        if (del?.success) {
          result.deleted.push(proc.name);
          console.log(`[reconcile] Cleaned orphan PM2 process: ${proc.name} (was ${status})`);
        } else {
          result.errors.push({ phase: 'delete', name: proc.name, reason: del?.reason || 'unknown' });
        }
      } catch (err) {
        result.errors.push({ phase: 'delete', name: proc.name, message: err?.message || String(err) });
      }
    } else if (status === 'online') {
      result.warned.push(proc.name);
      console.warn(`[reconcile] Orphan MyBot process ${proc.name} is online; leaving untouched (operator review required)`);
    } else {
      // launching / restarting / unknown — leave alone, reconcile will retry next run.
      result.skipped += 1;
    }
  }

  return result;
}

async function cleanupPm2Orphans(adapter) {
  return cleanupPm2OrphansForTest({
    adapter,
    registryPath: path.join(PROJECT_ROOT, 'mybot', 'mybots.json'),
  });
}

async function reconcile() {
  console.log('[reconcile] Starting PM2 fleet reconciliation...');
  await ensureRuntimeDir();

  const adapter = new PM2Adapter({ projectRoot: PROJECT_ROOT });
  // Preflight: check PM2 daemon health BEFORE attempting to start anything.
  // Fail fast with a clear error so the user knows what's wrong.
  const health = await adapter.isAvailable();
  if (!health.available) {
    console.error('[reconcile] ERROR: PM2 daemon is not reachable.');
    console.error(`[reconcile] Reason: ${health.reason}`);
    console.error('[reconcile] To start the PM2 daemon, run one of:');
    console.error('  [reconcile]   npx pm2 ping   # start daemon and verify');
    console.error('  [reconcile]   pm2 resurrect  # reload saved processes');
    console.error('[reconcile] Aborting reconcile. Run `run.bat` again after PM2 is up.');
    // Fail-fast: exit with non-zero so run.bat/operator knows reconcile failed
    process.exit(2);
  }
  console.log('[reconcile] PM2 daemon OK');

  // Ensure node-canvas DLLs are compatible with Windows Server 2012 R2 (NT 6.x)
  try {
    await ensureWin2012CanvasCompat({ projectRoot: PROJECT_ROOT });
  } catch (compatErr) {
    console.warn(`[reconcile] Win2012 canvas compatibility check warning: ${compatErr.message}`);
  }

  const isHybrid = process.env.MYBOT_NODE_HYBRID === 'true' || process.env.DISABLE_NODE_DASHBOARD === 'true';

  // Write ecosystem config for reference
  const ecosystem = generateEcosystemConfig({
    projectRoot: PROJECT_ROOT,
    includeDashboard: !isHybrid,
    includeGuardian: true,
    includeMain: true,
    childBots: [],
  });
  const ecosystemDir = path.dirname(RECONCILE_ECOSYSTEM_PATH);
  if (!fs.existsSync(ecosystemDir)) {
    fs.mkdirSync(ecosystemDir, { recursive: true });
  }
  fs.writeFileSync(RECONCILE_ECOSYSTEM_PATH, `module.exports = ${JSON.stringify(ecosystem, null, 2)};\n`, 'utf8');

  const commit = currentCommitShort();

  if (isHybrid) {
    console.log('[reconcile] Hybrid mode active: port 4173 is exclusively reserved for Rust V4. Ensuring Node dashboard PM2 process is removed.');
    try {
      await adapter.stopBot('mybot-dashboard');
      await adapter.deleteBot('mybot-dashboard');
    } catch {}
  } else {
    await startDashboard(adapter, commit);
  }
  await startGuardian(adapter, commit);
  await cleanupLegacyGeminiWeb(adapter);

  // Sweep orphaned PM2 processes whose registry entry was removed (the old
  // delete flow called `pm2 stop` but never `pm2 delete`). Failed-closed:
  // skipped when the registry is missing or malformed; live online processes
  // are warned, never auto-killed.
  await cleanupPm2Orphans(adapter);

  // Readiness service: the single shared contract for "is the bot actually
  // ready?" used by reconcile, the terminal monitor and the MyBot commands.
  const readiness = createBotReadinessService({ adapter, root: PROJECT_ROOT });

  const mainResult = await startMain(adapter, commit, readiness);
  if (!mainResult.success) {
    console.error(`[reconcile] ERROR: Main bot not ready after reconcile: ${mainResult.reason}`);
    console.error('[reconcile] Aborting. PM2 daemon is up but the Main bot is not serving.');
    process.exit(3);
  }

  await restoreChildBots(adapter, commit, readiness);

  // Verify the critical processes are actually online before signaling OK.
  // Uses the canonical managed inventory (env markers + registry fallback)
  // so child bots with non `bot-` keys are also seen.
  const registry = await readRegistry();
  const botKeys = Object.keys(registry || {});
  const finalList = await adapter.listManagedProcesses({ botKeys });
  const required = isHybrid ? ['mybot-guardian', 'admin'] : ['mybot-dashboard', 'mybot-guardian', 'admin'];
  const missing = required.filter((name) => {
    const p = finalList.find((x) => x.name === name);
    return !p || p.status !== 'online';
  });
  if (missing.length > 0) {
    console.error(`[reconcile] ERROR: required processes not online after reconcile: ${missing.join(', ')}`);
    console.error('[reconcile] Aborting. PM2 daemon is up but the fleet is incomplete.');
    process.exit(3);
  }

  console.log('[reconcile] Fleet reconciliation complete (all required processes online; Main READY)');
}

/**
 * Auto-start happens ONLY at startup reconcile (run.bat). `--monitor-only`
 * must never start bots: it renders status and exits without side effects.
 */
export function shouldStartBots(args = process.argv.slice(2)) {
  return !args.includes('--monitor-only');
}

async function main() {
  // Test-mode guard: importing this module from node:test (or validation
  // runs) must never trigger a real PM2 reconcile. Production entry is
  // `run.bat` → node reconcile-and-monitor.js.
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' || process.env.SKIP_ENV_VALIDATION) {
    console.log('[reconcile] Test/validation mode detected — reconcile skipped.');
    return;
  }

  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node reconcile-and-monitor.js [--monitor-only] [--reconcile-only]');
    console.log('  --reconcile-only  Run reconcile and exit (no monitor)');
    console.log('  --monitor-only    Run monitor only (no reconcile, no bot starts)');
    return;
  }

  const reconcileOnly = args.includes('--reconcile-only');
  const monitorOnly = args.includes('--monitor-only');

  const isInteractiveConsole = Boolean(
    !reconcileOnly &&
    String(process.env.BOT_MANAGED || '').toLowerCase() !== 'true' &&
    (process.stdout?.isTTY || process.env.MYBOT_INTERACTIVE_CONSOLE === '1')
  );
  const qrRecoveryWatcher = isInteractiveConsole
    ? startInteractiveAdminRecoveryWatcher({ projectRoot: PROJECT_ROOT })
    : null;
  if (qrRecoveryWatcher) {
    process.once('exit', () => {
      qrRecoveryWatcher.stop();
    });
  }

  if (shouldStartBots(args)) {
    await reconcile();
  }

  if (!reconcileOnly) {
    console.log('[monitor] Starting terminal monitor (PM2 fleet status)...');
    console.log('[monitor] Press Ctrl+C to stop monitor only. PM2 processes will continue.');
    console.log('');

    const monitor = new TerminalMonitor({ projectRoot: PROJECT_ROOT });

    const cleanup = () => {
      qrRecoveryWatcher?.stop();
      monitor.stop();
      console.log('[monitor] Monitor stopped. PM2 processes are still running.');
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    monitor.start();

    // Keep alive until monitor stops
    await new Promise(() => {});
  }
}

main().catch((err) => {
  console.error('[reconcile] Fatal error:', err.message);
  process.exit(1);
});
