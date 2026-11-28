/**
 * Runtime Readiness Service — shared contract for "is this bot actually ready?".
 *
 * A bot is `running` ONLY when ALL of the following hold:
 *   1. PM2 supervisor reports the process `online`.
 *   2. The bot's web port answers on 127.0.0.1.
 *   3. GET /internal/runtime/identity returns the CORRECT bot identity
 *      (kind + botKey match the launch descriptor) AND the correct PID.
 *   4. The identity payload reports `listenerConnected === true` — the bot can
 *      actually RECEIVE Zalo messages.
 *
 * A payload missing the `pid` field, or missing the listener fields, is NEVER
 * treated as ready (older/foreign processes must not fake readiness).
 *
 * Consumers share this ONE contract so reconcile, the terminal monitor and the
 * MyBot commands all agree:
 *   - reconcile   → waitForBotReadiness() before "fleet complete"
 *   - monitor     → probeBotReadiness() for each row label
 *   - MyBot start/restart → waitForBotReadiness() before reporting `running`
 *
 * This is the fix for "PM2 online but port-closed": PM2 only guarantees the
 * supervisor thinks the process is alive. It says NOTHING about whether
 * src/index.js was actually imported (the PM2 7 ESM import bug) or whether the
 * web server bound its port. Only the readiness probes can tell.
 */

import { PM2Adapter } from './pm2-adapter.js';

/** Default port probe: TCP connect with a short timeout. */
export async function defaultPortProbe(port, host = '127.0.0.1', timeoutMs = 1000) {
  const numericPort = Number(port);
  if (!Number.isFinite(numericPort) || numericPort <= 0) return false;
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(numericPort, host, () => done(true));
  });
}

/** Default identity fetcher: GET /internal/runtime/identity on the bot port. */
export async function defaultIdentityFetcher(port, host = '127.0.0.1', timeoutMs = 2000) {
  const numericPort = Number(port);
  if (!Number.isFinite(numericPort) || numericPort <= 0) return null;
  try {
    const res = await fetch(`http://${host}:${numericPort}/internal/runtime/identity`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

/** Default sleep for the poll loop. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Match the identity payload against the expected bot.
 *
 * @param {object} params
 * @param {object} params.descriptor launch descriptor (kind, botKey)
 * @param {object|null} params.identity parsed /internal/runtime/identity payload
 * @param {number|null} [params.expectedPid] the PID we expect; when provided the
 *   identity pid must equal it (newly started / reloaded process).
 * @param {number|null} [params.supervisorPid] the PID PM2 reports; used when
 *   expectedPid is not available (adopted processes).
 * @returns {boolean}
 */
export function matchesBotIdentity({ descriptor, identity, expectedPid = null, supervisorPid = null }) {
  if (!identity || typeof identity !== 'object') return false;
  const kind = descriptor?.kind === 'main' ? 'main' : 'child';
  const botKey = descriptor?.botKey;

  // Identity must carry the listener + pid fields; a payload missing them is
  // an old/foreign process, never ready.
  if (typeof identity.pid !== 'number' && typeof identity.pid !== 'string') return false;
  if (typeof identity.listenerConnected !== 'boolean') return false;
  if (typeof identity.botKey !== 'string' || identity.botKey.length === 0) return false;

  const kindOk = identity.kind === kind;
  const keyOk = identity.botKey === botKey;
  const expectedAccount = descriptor?.accountUid || descriptor?.verifiedAccountUid || descriptor?.expectedAccountUid;
  const accountOk = !expectedAccount || String(identity.liveZaloUid || '') === String(expectedAccount);

  // PID check: expected PID wins; fall back to supervisor PID; otherwise any
  // numeric pid present is accepted (adopt path without a known PID).
  let pidOk = true;
  if (expectedPid != null) {
    pidOk = String(identity.pid) === String(expectedPid);
  } else if (supervisorPid != null) {
    pidOk = String(identity.pid) === String(supervisorPid);
  }

  return Boolean(kindOk && keyOk && pidOk && accountOk);
}

/**
 * One-shot readiness probe for a single bot process.
 *
 * @param {object} params
 * @param {object} params.descriptor launch descriptor (kind, botKey, webPort)
 * @param {object|null} [params.process] normalized PM2 process (status, pid)
 * @param {number|null} [params.expectedPid] PID to expect (overrides process.pid)
 * @param {Function} [params.portProbe] (port, host, timeoutMs) => Promise<boolean>
 * @param {Function} [params.identityFetcher] (port, host, timeoutMs) => Promise<object|null>
 * @returns {Promise<object>} readiness result (see module docs)
 */
export async function probeBotReadiness({
  descriptor,
  process: proc = null,
  expectedPid = null,
  portProbe = defaultPortProbe,
  identityFetcher = defaultIdentityFetcher,
  now = () => Date.now(),
} = {}) {
  const checkedAt = new Date(now()).toISOString();
  const port = Number(descriptor?.webPort || proc?.env?.WEB_PORT || 0);
  const supervisor = proc
    ? { available: true, status: proc.status || 'unknown', pid: proc.pid || null, uptime: proc.uptime || 0, restartCount: proc.restartCount || 0 }
    : { available: false, status: null, pid: null, uptime: 0, restartCount: 0 };

  // Layer 1: PM2 supervisor must be online.
  if (!proc || proc.status !== 'online') {
    return {
      ready: false,
      status: 'stopped',
      reason: 'pm2-stopped',
      supervisor,
      identity: null,
      checkedAt,
    };
  }

  // Layer 2a: port must be open.
  const portOpen = port > 0 ? await portProbe(port, '127.0.0.1') : false;
  if (!portOpen) {
    return {
      ready: false,
      status: 'starting',
      reason: 'port-closed',
      supervisor,
      identity: null,
      checkedAt,
    };
  }

  // Layer 2b: identity must answer and match.
  const identity = await identityFetcher(port, '127.0.0.1');
  if (!identity) {
    return {
      ready: false,
      status: 'starting',
      reason: 'identity-unavailable',
      supervisor,
      identity: null,
      checkedAt,
    };
  }

  const expectedPidResolved = expectedPid != null ? expectedPid : (proc.pid || null);
  if (!matchesBotIdentity({ descriptor, identity, expectedPid: expectedPidResolved, supervisorPid: proc.pid })) {
    // Distinguish identity vs pid mismatch for diagnostics.
    const pidMismatch = expectedPidResolved != null
      && typeof identity.pid !== 'undefined'
      && String(identity.pid) !== String(expectedPidResolved);
    return {
      ready: false,
      status: 'error',
      reason: pidMismatch ? 'pid-mismatch' : 'identity-mismatch',
      supervisor,
      identity,
      checkedAt,
    };
  }

  // Layer 2c: listener must be connected (ability to RECEIVE messages).
  if (identity.listenerConnected !== true) {
    return {
      ready: false,
      status: 'error',
      reason: 'listener-disconnected',
      supervisor,
      identity,
      checkedAt,
    };
  }

  return {
    ready: true,
    status: 'running',
    reason: 'ready',
    supervisor,
    identity,
    checkedAt,
  };
}

/**
 * Poll a bot until it is ready or the deadline expires.
 *
 * @param {object} params
 * @param {object} params.descriptor launch descriptor (kind, botKey, webPort)
 * @param {number|null} [params.expectedPid] PID to expect (post-start/reload)
 * @param {object|null} [params.process] normalized PM2 process snapshot
 * @param {Function} [params.supervisor] async () => normalized PM2 process|null;
 *   when provided, each poll refreshes the supervisor snapshot so pm2-stopped
 *   and pid changes are detected live.
 * @param {number} [params.timeoutMs] 165_000 for main reconcile (login 30s +
 *   QR recovery 120s + bind), 60_000 for child/restart.
 * @param {number} [params.intervalMs] default 1000ms
 * @param {Function} [params.portProbe] test override
 * @param {Function} [params.identityFetcher] test override
 * @param {Function} [params.sleep] test override
 * @returns {Promise<object>} final readiness result; on timeout reason is
 *   `readiness-timeout` and `ready` is false.
 */
export async function waitForBotReadiness({
  descriptor,
  expectedPid = null,
  process: initialProcess = null,
  supervisor = null,
  timeoutMs = 60_000,
  intervalMs = 1000,
  portProbe = defaultPortProbe,
  identityFetcher = defaultIdentityFetcher,
  sleep = defaultSleep,
  now = () => Date.now(),
  log = null,
} = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const initialRestarts = Number(initialProcess?.restartCount || 0);
  let currentProcess = initialProcess;
  let lastResult = null;

  while (true) {
    // Refresh the supervisor snapshot when a fetcher is provided so a process
    // that crashes during startup is detected instead of probing forever.
    if (typeof supervisor === 'function') {
      try {
        const latest = await supervisor(descriptor?.pm2Name);
        if (latest) currentProcess = latest;
      } catch {
        // Keep the previous snapshot on supervisor error.
      }
    }

    lastResult = await probeBotReadiness({
      descriptor,
      process: currentProcess,
      expectedPid,
      portProbe,
      identityFetcher,
      now,
    });

    if (lastResult.ready) return lastResult;

    const currentRestarts = Number(currentProcess?.restartCount || 0);
    const isTerminalSupervisorState = Boolean(
      currentProcess && (currentProcess.status === 'errored' || currentProcess.status === 'stopped')
    );
    if ((isTerminalSupervisorState && now() - startedAt >= 2000) || currentRestarts - initialRestarts >= 3) {
      const result = {
        ...lastResult,
        ready: false,
        status: 'stopped',
        reason: isTerminalSupervisorState ? lastResult.reason : 'crash-loop',
        checkedAt: new Date(now()).toISOString(),
      };
      if (log?.warn) log.warn(`[readiness] ${descriptor?.pm2Name || descriptor?.botKey} aborted early (${result.reason}, restarts=${currentRestarts - initialRestarts})`);
      return result;
    }

    if (now() >= deadline) {
      const result = {
        ...lastResult,
        ready: false,
        status: lastResult.status === 'stopped' ? 'stopped' : 'error',
        reason: lastResult.status === 'stopped' ? lastResult.reason : 'readiness-timeout',
        checkedAt: new Date(now()).toISOString(),
      };
      if (log?.warn) log.warn(`[readiness] ${descriptor?.pm2Name || descriptor?.botKey} not ready within ${timeoutMs}ms (last: ${lastResult.reason})`);
      return result;
    }
    await sleep(intervalMs);
  }
}

/**
 * Create a shared readiness service bound to one PM2 adapter.
 * Provides probeBotReadiness (single-shot) and waitForBotReadiness (polling).
 *
 * @param {object} options
 * @param {object} options.adapter PM2-like adapter (listMyBotProcesses / getProcessStatus)
 * @param {string} [options.root] project root
 */
export function createBotReadinessService({
  adapter = null,
  root = process.cwd(),
  portProbe = defaultPortProbe,
  identityFetcher = defaultIdentityFetcher,
} = {}) {
  let _adapter = adapter;
  if (!_adapter) {
    _adapter = new PM2Adapter({ projectRoot: root });
  }

  /** Fetch the live normalized process snapshot for one pm2 name. */
  async function getProcess(pm2Name) {
    if (typeof _adapter.listMyBotProcesses === 'function') {
      const procs = await _adapter.listMyBotProcesses();
      return procs.find((p) => p.name === pm2Name) || null;
    }
    if (typeof _adapter.getProcessStatus === 'function') {
      const sup = await _adapter.getProcessStatus(pm2Name);
      return sup?.available && sup.status === 'online'
        ? { name: pm2Name, status: 'online', pid: sup.pid, uptime: sup.uptime, restartCount: sup.restartCount }
        : null;
    }
    return null;
  }

  return {
    getProcess,
    probe: (params) => probeBotReadiness({ ...params, portProbe, identityFetcher }),
    waitFor: (params) => waitForBotReadiness({
      ...params,
      portProbe,
      identityFetcher,
      supervisor: params.supervisor || ((pm2Name) => getProcess(pm2Name)),
    }),
  };
}
