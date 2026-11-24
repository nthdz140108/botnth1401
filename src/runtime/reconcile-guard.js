/**
 * Commit-marker guard for PM2 reconcile.
 *
 * Decides, for one MyBot PM2 app that is `online`, whether it may be adopted
 * or must be reloaded from the current source:
 *
 * - MYBOT_CODE_COMMIT env marker (stamped by launch-descriptor.js at start
 *   time) is compared against the current git HEAD.
 * - marker == HEAD      -> adopt.
 * - marker != HEAD      -> reload from the current descriptor
 *                          (reloadBotFromDescriptor re-applies script/args/env
 *                          via `pm2 startOrReload`, so the new code + env win).
 *                          Failure to come back online is a hard failure:
 *                          callers must abort instead of running stale code.
 * - marker missing      -> fail-open adopt (legacy processes launched before
 *                          the marker existed must not block startup).
 * - git unavailable     -> guard disabled entirely (fail-open).
 * - foreign PM2 apps    -> invisible: the guard only inspects
 *                          listMyBotProcesses(), never the full PM2 list.
 *
 * This replaces the previous log-fingerprint guard whose candidate log paths
 * never matched the files PM2 actually writes.
 */

let markerGuardDisabledLogged = false;

/** Normalize a commit value to comparable lowercase short form. */
export function commitKey(value) {
  return String(value || "").trim().toLowerCase().slice(0, 7);
}

/**
 * Ensure the PM2 app `pm2Name` runs code at `commit`.
 *
 * @param {object} params
 * @param {object} params.adapter PM2 adapter (listMyBotProcesses + reloadBotFromDescriptor)
 * @param {string} params.pm2Name MyBot PM2 app name
 * @param {string|null} params.commit git HEAD (null disables the guard)
 * @param {() => object} params.buildDescriptor builds the CURRENT launch descriptor
 * @param {Function} [params.log] console-compatible logger
 * @returns {Promise<{adopted:boolean, reloaded:boolean, reloadFailed?:boolean}>}
 */
export async function ensureProcessAtCommit({ adapter, pm2Name, commit, buildDescriptor, log = console }) {
  if (!commit) {
    if (!markerGuardDisabledLogged) {
      log.log?.("[reconcile] git unavailable; commit-marker guard disabled");
      markerGuardDisabledLogged = true;
    }
    return { adopted: true, reloaded: false };
  }

  let procs;
  try {
    procs = await adapter.listMyBotProcesses();
  } catch {
    // Daemon down is handled by the reconcile preflight; treat as adopt so
    // the start path surfaces the real error.
    return { adopted: true, reloaded: false };
  }
  const proc = procs.find((p) => p.name === pm2Name && p.status === "online");
  if (!proc) return { adopted: false, reloaded: false };

  // Contract markers: a MyBot bot process launched by this codebase MUST carry
  // BOT_KEY, MYBOT_INSTANCE_KIND and WEB_PORT in its launch env. A process that
  // is PM2-online but lacks any of them is a legacy/foreign/adopted artifact that
  // cannot be trusted for readiness (port probing would target a wrong/guessed
  // port). Reload it from the current descriptor rather than adopting — never
  // guess a default port or scan for a port that belongs to another bot.
  const env = proc.env || {};
  const requiredMarkers = pm2Name === "mybot-guardian"
    ? ["MYBOT_INSTANCE_KIND"]
    : pm2Name === "mybot-dashboard"
      ? ["MYBOT_INSTANCE_KIND", "WEB_PORT"]
      : ["BOT_KEY", "MYBOT_INSTANCE_KIND", "WEB_PORT"];
  const missingRequiredMarker = requiredMarkers.some(
    (key) => env[key] === undefined || env[key] === null || String(env[key]).trim() === "",
  );
  if (missingRequiredMarker) {
    log.warn?.(`[reconcile] ${pm2Name} online but missing required marker(s) [${requiredMarkers.join("/")}] -- reloading from current descriptor`);
    const descriptor = buildDescriptor();
    const reload = await adapter.reloadBotFromDescriptor(descriptor);
    if (!reload.success) {
      log.error?.(`[reconcile] Reload failed for ${pm2Name}: ${reload.reason} -- ${reload.detail || ""}`);
      return { adopted: false, reloaded: false, reloadFailed: true };
    }
    const after = await adapter.listMyBotProcesses().catch(() => []);
    const verified = after.find((p) => p.name === pm2Name) || null;
    if (!verified || verified.status !== "online") {
      log.error?.(`[reconcile] ${pm2Name} not online after marker reload (status: ${verified?.status || "missing"})`);
      return { adopted: false, reloaded: true, reloadFailed: true };
    }
    log.log?.(`[reconcile] ${pm2Name} reloaded onto contract markers (pid ${verified.pid ?? "?"})`);
    return { adopted: false, reloaded: true, reloadedOk: true };
  }

  const observed = commitKey(env.MYBOT_CODE_COMMIT);
  if (!observed) {
    // Missing marker: legacy process launched before MYBOT_CODE_COMMIT existed.
    // Fail-open — adopt, never block startup on missing telemetry.
    return { adopted: true, reloaded: false };
  }
  if (observed === commitKey(commit)) {
    return { adopted: true, reloaded: false };
  }

  log.warn?.(`[reconcile] ${pm2Name} runs OLD code (commit ${observed} != ${commitKey(commit)}) -- reloading from current source`);
  const descriptor = buildDescriptor();
  const reload = await adapter.reloadBotFromDescriptor(descriptor);
  if (!reload.success) {
    log.error?.(`[reconcile] Reload failed for ${pm2Name}: ${reload.reason} -- ${reload.detail || ""}`);
    return { adopted: false, reloaded: false, reloadFailed: true };
  }

  // Verify post-reload state: the process must be online again. PM2 applies
  // the new env synchronously on startOrReload; jlist reflects it immediately.
  let verified = null;
  try {
    const after = await adapter.listMyBotProcesses();
    verified = after.find((p) => p.name === pm2Name) || null;
  } catch {
    verified = null;
  }
  if (!verified || verified.status !== "online") {
    log.error?.(`[reconcile] ${pm2Name} not online after reload (status: ${verified?.status || "missing"})`);
    return { adopted: false, reloaded: true, reloadFailed: true };
  }
  const verifiedMarker = commitKey(verified.env?.MYBOT_CODE_COMMIT);
  if (verifiedMarker && verifiedMarker !== commitKey(commit)) {
    log.error?.(`[reconcile] ${pm2Name} still reports old marker (${verifiedMarker}) after reload`);
    return { adopted: false, reloaded: true, reloadFailed: true };
  }
  log.log?.(`[reconcile] ${pm2Name} reloaded onto commit ${commitKey(commit)} (pid ${verified.pid ?? "?"})`);
  return { adopted: false, reloaded: true, reloadedOk: true };
}

/**
 * Test seam: same implementation, fresh module-level "guard disabled" flag so
 * tests stay deterministic.
 */
export function resetMarkerGuardLogging() {
  markerGuardDisabledLogged = false;
}

export const __internals = { ensureProcessAtCommit };
export default ensureProcessAtCommit;
