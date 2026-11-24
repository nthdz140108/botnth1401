import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Reconcile auto-start policy:
 * - restoreChildBots starts every valid unexpired candidate (even stopped)
 * - per-bot failures do not block other bots; summary reports
 *   started/already-online/skipped/failed with reasons
 * - --monitor-only never starts bots
 */

async function loadModule() {
  return import("../src/runtime/reconcile-and-monitor.js");
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mybot-reconcile-"));
}

test("monitor-only flag never invokes child starts", async () => {
  const { shouldStartBots } = await loadModule();
  assert.equal(shouldStartBots(["--monitor-only"]), false);
  assert.equal(shouldStartBots([]), true);
  assert.equal(shouldStartBots(["--reconcile-only"]), true);
});

test("reconcile child restore loop is failure-isolated and returns a summary", async () => {
  const { restoreChildBotsForTest } = await loadModule();
  const summary = await restoreChildBotsForTest({
    registry: {
      "bot-a": { uid: "bot-a", botKey: "bot-a", status: "stopped", webPort: "5301", expiryAt: new Date(Date.now() + 3600_000).toISOString(), credentials: { cookie: "c", imei: "i" }, enabled: true },
      "bot-b": { uid: "bot-b", botKey: "bot-b", status: "running", webPort: "5302", expiryAt: "-1", credentials: { cookie: "c", imei: "i" }, enabled: true },
      "bot-c": { uid: "bot-c", botKey: "bot-c", status: "stopped", webPort: "5303", expiryAt: new Date(Date.now() + 3600_000).toISOString(), credentials: { cookie: "c", imei: "i" }, enabled: true },
      "bot-expired": { uid: "bot-expired", botKey: "bot-expired", status: "stopped", webPort: "5304", expiryAt: "2020-01-01T00:00:00Z", credentials: { cookie: "c", imei: "i" }, enabled: true },
    },
    adapter: {
      listManagedProcesses: async () => [{ name: "bot-b", status: "online" }],
      startBot: async (desc) => {
        if (desc.pm2Name === "bot-c") return { success: false, reason: "pm2-start-failed", detail: "spawn error" };
        return { success: true, adopted: false };
      },
    },
    isPortInUseFn: async () => false,
    ensureProcessAtCommitFn: async () => ({ reloaded: false, reloadFailed: false }),
  });

  assert.equal(summary.started, 1);
  assert.equal(summary.alreadyOnline, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].uid, "bot-c");
  assert.match(summary.failed[0].reason, /pm2-start-failed/);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.skipped[0].uid, "bot-expired");
  assert.match(summary.skipped[0].reason, /expired/i);
});
