/**
 * Fleet-wide PM2 stop for the MyBot updater.
 *
 * Scope: only fixed infra names (mybot-dashboard, mybot-guardian, admin) and
 * MyBot child bots identified by env markers or registry keys via
 * PM2Adapter.listManagedProcesses(). NEVER touches foreign PM2 apps and never
 * calls `pm2 kill`.
 *
 * Quiescence contract: returns success only when every target has left the
 * `online/launching/stopping/restarting` transient states (or the daemon
 * itself is down, which equally guarantees nothing can resurrect old code).
 */

import fs from "node:fs";
import path from "node:path";
import { PM2Adapter } from "./pm2-adapter.js";

export const INFRA_NAMES = ["mybot-dashboard", "mybot-guardian", "admin"];

const ACTIVE_STATES = new Set(["online", "launching", "stopping", "restarting"]);

/**
 * Poll PM2 until every named process has left an active state.
 * Daemon death during the window counts as quiesced: nothing supervised
 * can autorestart old code without a daemon.
 */
export async function verifyFleetStopped(adapter, names, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stillRunning = [];
  while (Date.now() <= deadline) {
    let procs = [];
    try {
      procs = await adapter.listProcesses();
    } catch {
      // Daemon down mid-stop: nothing alive to resurrect.
      return { allStopped: true, stillRunning: [] };
    }
    stillRunning = names.filter((name) => {
      const proc = procs.find((p) => p.name === name);
      return proc && ACTIVE_STATES.has(proc.status);
    });
    if (stillRunning.length === 0) return { allStopped: true, stillRunning: [] };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { allStopped: false, stillRunning };
}

function readRegistryBotKeys(projectRoot) {
  const registryPath = path.join(projectRoot, "mybot", "mybots.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
    return Object.keys(parsed || {}).filter((key) => key && key !== "admin");
  } catch {
    return [];
  }
}

/**
 * Stop the entire MyBot PM2 fleet and verify quiescence.
 *
 * @param {object} params
 * @param {string} params.projectRoot project root (registry + local PM2 resolution)
 * @param {object} [params.adapter] injectable PM2 adapter (tests)
 * @param {number} [params.timeoutMs] quiescence verification window
 * @param {number} [params.pollMs] poll interval
 * @returns {Promise<{success:boolean, daemonAvailable:boolean, stopped:string[],
 *   alreadyStopped:string[], missing:string[], failed:Array<{name,reason}>,
 *   stillRunning:string[]}>}
 */
export async function stopMyBotFleetViaPM2({
  projectRoot,
  adapter = null,
  timeoutMs = 60_000,
  pollMs = 500,
} = {}) {
  const pm2 = adapter || new PM2Adapter({ projectRoot });
  const result = {
    success: false,
    daemonAvailable: true,
    stopped: [],
    alreadyStopped: [],
    missing: [],
    failed: [],
    stillRunning: [],
  };

  const health = await pm2.isAvailable().catch(() => ({ available: false }));
  if (!health.available) {
    // Daemon down = nothing under PM2 supervision; nothing can autorestart.
    result.success = true;
    result.daemonAvailable = false;
    return result;
  }

  let targets;
  try {
    const botKeys = readRegistryBotKeys(projectRoot);
    const procs = await pm2.listManagedProcesses({ botKeys });
    // listManagedProcesses already applies the fleet scope (infra names, env
    // markers, legacy bot- prefix, registry-key fallback) and never adopts
    // foreign PM2 apps. Trust that single source of truth.
    const seen = new Set();
    targets = procs
      .filter((proc) => proc?.name && !seen.has(proc.name) && seen.add(proc.name))
      .map((proc) => ({ name: proc.name, status: proc.status }));
  } catch (err) {
    result.failed.push({ name: "*", reason: `inventory_failed: ${err.message}` });
    return result;
  }

  for (const target of targets) {
    if (!ACTIVE_STATES.has(target.status)) {
      result.alreadyStopped.push(target.name);
      continue;
    }
    const stopResult = await pm2.stopBot(target.name);
    if (stopResult?.success) result.stopped.push(target.name);
    else result.failed.push({ name: target.name, reason: stopResult?.reason || "stop_failed" });
  }

  const verify = await verifyFleetStopped(pm2, targets.map((t) => t.name), { timeoutMs, pollMs });
  result.stillRunning = verify.stillRunning;
  result.success = verify.allStopped && result.failed.length === 0;
  return result;
}
