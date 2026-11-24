/**
 * Runtime Status Resolver — single source of truth for two-layer bot status.
 *
 * Layer 1: PM2 supervisor status (online/stopped/errored/unavailable).
 * Layer 2: bot readiness (port + /internal/runtime/identity + live Zalo UID).
 *
 * Consumers: dashboard/server.js (overview), src/dashboard/bot-registry.js
 * (/api/bots), src/dashboard/bot-action-service.js (lifecycle semantics) —
 * all share this resolver so overview, /api/bots and terminal snapshots agree.
 *
 * Status rules (approved design):
 * - disabled/expired keeps its configured state.
 * - PM2 has no process or process stopped → 'stopped'.
 * - PM2 daemon unreachable → 'unknown' (never fake 'running').
 * - PM2 errored → 'error'.
 * - PM2 online <60s but readiness not ready → 'starting'.
 * - PM2 online >60s but port/health still failing → 'error'.
 * - identity belongs to a different bot → 'identity-mismatch'.
 * - 'running' requires ALL of: PM2 online + identity kind/botKey match +
 *   live Zalo UID present.
 *
 * Registry/state PID fields are diagnostics only — they never upgrade a bot
 * to 'running' (stale or Windows-reused PIDs must not fake liveness).
 */

import { PM2Adapter, PM2ErrorCode } from "../runtime/pm2-adapter.js";
import { classifyBotExpiry } from "../commands/mybot/System/expiry-classifier.js";

export const STARTUP_GRACE_MS = 60_000;
const IDENTITY_TIMEOUT_MS = 400;

function normalizeLegacyResult(result) {
  if (result === false) return { success: false, reason: "pm2_command_failed" };
  if (result === true) return { success: true, reason: "ok" };
  return result;
}

export { normalizeLegacyResult };

/**
 * Create the shared resolver.
 * @param {object} options
 * @param {string} options.root project root
 * @param {object} [options.pm2] PM2-like adapter (must expose getProcessStatus
 *   or listProcesses); defaults to a real PM2Adapter.
 * @param {(port:number, host:string, timeoutMs?:number) => Promise<boolean>} [options.portProbe]
 * @param {(port:number, host:string, timeoutMs?:number) => Promise<object|null>} [options.identityFetcher]
 * @param {(key:string, store:object|null) => object|null} [options.readJson]
 */
export function createRuntimeStatusResolver({
  root = process.cwd(),
  pm2 = null,
  portProbe = defaultPortProbe,
  identityFetcher = defaultIdentityFetcher,
  testMode = process.env.DASHBOARD_TEST_MODE === "1",
} = {}) {
  const adapter = pm2 || new PM2Adapter({ projectRoot: root });

  async function supervisorStatus(botKey) {
    if (adapter.getProcessStatus) return adapter.getProcessStatus(botKey);
    // Legacy injected adapters: fall back to status()/listProcesses().
    // `null`/undefined from a legacy adapter means "no such process"
    // (legacy checkPM2Status always returns an object), not daemon-down.
    if (adapter.status) {
      try {
        const legacy = await adapter.status(botKey);
        if (legacy && typeof legacy === "object") {
          const online = legacy.running === true || legacy.status === "online";
          return {
            available: true,
            status: online ? "online" : (legacy.status || "stopped"),
            pid: legacy.pid || null,
            pm2Id: legacy.pm2Id ?? null,
            uptime: legacy.uptime || 0,
            restartCount: legacy.restartCount || 0,
          };
        }
        return { available: true, status: "stopped", pid: null, pm2Id: null, uptime: 0, restartCount: 0 };
      } catch {
        return { available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: "pm2_unavailable", code: PM2ErrorCode.DAEMON_UNAVAILABLE };
      }
    }
    return { available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: "pm2_adapter_lacks_status", code: PM2ErrorCode.DAEMON_UNAVAILABLE };
  }

  /**
   * Resolve the two-layer runtime status for ONE bot.
   *
   * @param {object} bot minimal bot snapshot:
   *   { id, enabled, expiryAt, port, webHost, configuredStatus, configuredLiveUid }
   *   configuredLiveUid (optional): the Zalo UID recorded in config/state;
   *   when present, identity.liveZaloUid must equal it.
   * @returns {Promise<object>} full status snapshot (see module docs)
   */
  async function resolveBot(bot) {
    const id = String(bot?.id || "");
    const port = Number(bot?.port || bot?.webPort || 0);
    const host = bot?.webHost || "127.0.0.1";

    // Configured layer: disabled/expired wins before anything runtime-related.
    // Uses the SHARED expiry classifier (`-1` => permanent, future ISO =>
    // active, past ISO => expired, malformed/missing => malformed). This is the
    // single source of truth — do NOT call `Date.parse(expiryAt)` directly:
    // a literal `"-1"` would parse to `NaN` and the bot would falsely appear
    // expired.
    const configuredStatus = bot?.configuredStatus || "unknown";
    const enabled = bot?.enabled !== false;
    const expiryState = classifyBotExpiry({
      expiryAt: bot?.expiryAt,
      trialStatus: bot?.trialStatus,
    });
    const expired = expiryState === "expired";

    // Test mode: no real PM2 fleet or bot runtime exists; port answers = running.
    // Daemon-down handling and identity verification stay production-only paths.
    if (testMode) {
      const shouldProbe = enabled && !expired && Boolean(port);
      const portOpen = shouldProbe ? await portProbe(port, host) : false;
      const identityPayload = portOpen ? await identityFetcher(port, host) : null;
      const isStandby = identityPayload?.listenerState === "standby" || identityPayload?.listenerState === "hot_standby";
      const listenerOk = identityPayload ? (isStandby || identityPayload.listenerConnected !== false) : true;
      const baseStatus = !enabled ? "disabled" : expired ? "expired" : portOpen ? (isStandby ? "standby" : "running") : "stopped";
      const status = baseStatus === "running" && !listenerOk ? "listener-disconnected" : baseStatus;
      return {
        status,
        configuredStatus,
        connected: status === "running",
        enabled,
        expired,
        supervisor: { available: true, status: portOpen ? "online" : "stopped", pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: null, code: null },
        readiness: {
          status: status === "running" ? "ready" : status === "standby" ? "standby" : "not-ready",
          portOpen,
          identityVerified: Boolean(identityPayload),
          listenerConnected: listenerOk,
          listenerState: identityPayload?.listenerState ?? null,
          listenerLastError: identityPayload?.listenerLastError ?? null,
          memory: identityPayload?.memory ?? null,
          reason: status === "running" ? "test-mode" : status === "standby" ? "hot-standby" : status === "listener-disconnected" ? "listener-disconnected" : "port-closed",
          checkedAt: new Date().toISOString(),
        },
        reason: status === "running" ? "test-mode" : status === "standby" ? "hot-standby" : status === "listener-disconnected" ? "listener-disconnected" : "test-mode-stopped",
      };
    }

    const sup = await supervisorStatus(id);

    // Legacy adapters (status() only, no getProcessStatus) predate the
    // PM2-first fleet: keep port probing independent of supervisor state
    // for compatibility. Canonical adapters probe only when PM2 reports
    // online (avoids probing dead ports).
    const legacyMode = typeof adapter.getProcessStatus !== "function";
    // Readiness probes only run when the bot is not configured-disabled/expired
    // and PM2 is reachable (and online, for canonical adapters).
    const probeEligible = enabled && !expired && sup.available && (legacyMode || sup.status === "online");
    let portOpen = false;
    let identity = null;
    let identityVerified = false;
    let readinessStatus = "not-ready";
    let readinessReason = probeEligible ? "probing" : "skipped";
    // Listener layer: ability to RECEIVE messages. Absent fields (older bot
    // processes) are treated as connected for backward compatibility.
    let listenerConnected = true;
    let listenerStateValue = null;
    let listenerLastErrorValue = null;
    if (probeEligible) {
      portOpen = port ? await portProbe(port, host) : false;
      if (portOpen) {
        identity = await identityFetcher(port, host);
        identityVerified = matchesIdentity(bot, identity);
        readinessReason = identityVerified ? "identity-verified" : identity ? "identity-mismatch" : "identity-unreachable";
        listenerConnected = identity ? identity.listenerConnected !== false : true;
        listenerStateValue = identity?.listenerState ?? null;
        listenerLastErrorValue = identity?.listenerLastError ?? null;
      } else {
        readinessReason = "port-closed";
      }
    }

    // ---- Status decision ladder ----
    let status;
    let reason;
    if (!enabled) {
      status = "disabled";
      reason = "bot-disabled";
    } else if (expired) {
      status = "expired";
      reason = "bot-expired";
    } else if (!sup.available) {
      status = "unknown";
      reason = sup.reason || "pm2-unavailable";
    } else if (!sup.status || sup.status === "stopped") {
      status = "stopped";
      reason = "pm2-stopped";
    } else if (sup.status === "errored") {
      status = "error";
      reason = "pm2-errored";
    } else if (sup.status === "online") {
      if (!portOpen) {
        if (sup.uptime > STARTUP_GRACE_MS) {
          status = "error";
          reason = "port-closed-after-grace";
        } else {
          status = "starting";
          reason = "port-closed";
        }
      } else if (!identityVerified) {
        status = identity ? "identity-mismatch" : "starting";
        reason = identity ? "identity-mismatch" : "identity-unreachable";
      } else if (listenerStateValue === "standby" || listenerStateValue === "hot_standby") {
        status = "standby";
        reason = "hot-standby";
        readinessStatus = "standby";
      } else if (!listenerConnected) {
        // Port open + identity ok, but the Zalo WebSocket listener is down:
        // the bot cannot receive messages — never report Running/Ready.
        status = "listener-disconnected";
        reason = "listener-disconnected";
        readinessStatus = "listener-disconnected";
      } else {
        status = "running";
        reason = "ready";
      }
    } else if (legacyMode && portOpen) {
      // Legacy adapters: an open port with a verified identity still proves
      // readiness even when the legacy status cannot see the PM2 process.
      if (listenerStateValue === "standby" || listenerStateValue === "hot_standby") {
        status = "standby";
        reason = "hot-standby";
        readinessStatus = "standby";
      } else if (identityVerified && !listenerConnected) {
        status = "listener-disconnected";
        reason = "listener-disconnected";
        readinessStatus = "listener-disconnected";
      } else {
        status = identityVerified ? "running" : (identity ? "identity-mismatch" : "starting");
        reason = identityVerified ? "ready-legacy" : (identity ? "identity-mismatch" : "identity-unreachable");
      }
    } else {
      // launching/stopping/restarting and other transient PM2 states
      status = sup.status === "restarting" || sup.status === "launching" ? "starting" : "starting";
      reason = `pm2-${sup.status}`;
    }

    const connected = status === "running";
    return {
      status,
      configuredStatus,
      connected,
      enabled,
      expired,
      supervisor: {
        available: sup.available,
        status: sup.status,
        pid: sup.pid,
        pm2Id: sup.pm2Id,
        uptime: sup.uptime,
        restartCount: sup.restartCount,
        reason: sup.reason || null,
        code: sup.code || null,
      },
      readiness: {
        status: connected ? "ready" : readinessStatus,
        portOpen,
        identityVerified,
        listenerConnected,
        listenerState: listenerStateValue,
        listenerLastError: listenerLastErrorValue,
        memory: identity?.memory ?? null,
        reason: reason,
        checkedAt: new Date().toISOString(),
      },
      reason,
    };
  }

  return { resolveBot, supervisorStatus, adapter };
}

/**
 * Identity match: /internal/runtime/identity must report the right
 * kind/botKey for this bot. A live Zalo UID on the identity payload makes the
 * match strongest; child bots matched only via liveZaloUid/configuredUid are
 * still accepted but flagged through reason in the resolver ladder.
 */
export function matchesIdentity(bot, identity) {
  if (!identity || typeof identity !== "object") return false;
  const id = String(bot?.id || "");
  if (id === "admin") {
    return identity.kind === "main";
  }
  const kindOk = identity.kind === "child" || identity.kind === "main" && Boolean(identity.liveZaloUid);
  const keyOk = identity.botKey === id
    || identity.configuredUid === id
    || identity.liveZaloUid === id;
  return Boolean(kindOk && keyOk);
}

/**
 * Exported so the terminal monitor can run the SAME readiness probes
 * (port + identity) instead of a hard-coded `pm2-only` label.
 */
export async function defaultPortProbe(port, host = "127.0.0.1", timeout = 400) {
  const net = await import("node:net");
  const numericPort = Number(port);
  if (!Number.isFinite(numericPort) || numericPort <= 0) return false;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("error", () => done(false));
    socket.connect(numericPort, host, () => done(true));
  });
}

/**
 * Exported so the terminal monitor can verify bot identity with the same
 * contract as the dashboard resolver.
 */
export async function defaultIdentityFetcher(port, host = "127.0.0.1", timeoutMs = IDENTITY_TIMEOUT_MS) {
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
