import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopMyBotFleetViaPM2, verifyFleetStopped, INFRA_NAMES } from "../../src/runtime/fleet-stop.js";

const INFRA = new Set(["mybot-dashboard", "mybot-guardian", "admin"]);

/**
 * Mock adapter modeling PM2Adapter contract:
 * - listManagedProcesses({botKeys}) filters to MyBot fleet only
 *   (infra names + env markers + bot- prefix + registry keys fallback)
 * - stopBot succeeds except for failStop names; failed targets stay online
 */
function makeAdapter({ procs, failStop = [], daemonUp = true, registryKeys = [] }) {
  const calls = [];
  const keys = new Set([...registryKeys, "admin"]);
  const isFleet = (p) => INFRA.has(p.name)
    || p.env?.BOT_MANAGED === "true"
    || p.name.startsWith("bot-")
    || keys.has(p.name);
  return {
    calls,
    async isAvailable() { return { available: daemonUp }; },
    async listManagedProcesses({ botKeys = [] } = {}) {
      const merged = new Set([...keys, ...botKeys]);
      return procs.filter((p) => INFRA.has(p.name)
        || p.env?.BOT_MANAGED === "true"
        || p.name.startsWith("bot-")
        || merged.has(p.name));
    },
    async listProcesses() {
      return procs.map((p) => {
        const stoppedOk = calls.some((c) => c.op === "stop" && c.name === p.name) && !failStop.includes(p.name);
        return stoppedOk ? { ...p, status: "stopped" } : p;
      });
    },
    async stopBot(name) {
      calls.push({ op: "stop", name });
      if (failStop.includes(name)) return { success: false, pm2Name: name, reason: "pm2_stop_failed" };
      return { success: true, pm2Name: name, reason: "stopped" };
    },
  };
}

function tempProjectRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-stop-"));
  mkdirSync(path.join(root, "mybot"), { recursive: true });
  writeFileSync(path.join(root, "mybot", "mybots.json"), JSON.stringify({ "user-123": { status: "running" } }), "utf8");
  return root;
}

test("fleet-stop stops infra names plus registry child bots", async () => {
  const projectRoot = tempProjectRoot();
  const adapter = makeAdapter({ procs: [
    { name: "mybot-dashboard", status: "online" },
    { name: "mybot-guardian", status: "online" },
    { name: "admin", status: "online" },
    { name: "user-123", status: "online" },
    { name: "foreign-app", status: "online" },
  ] });
  const result = await stopMyBotFleetViaPM2({ projectRoot, adapter });
  assert.equal(result.success, true);
  assert.deepEqual([...result.stopped].sort(), ["admin", "mybot-dashboard", "mybot-guardian", "user-123"]);
  assert.ok(!result.stopped.includes("foreign-app"), "must not touch non-MyBot PM2 apps");
  assert.ok(INFRA_NAMES.includes("admin"));
});

test("fleet-stop verifies quiescence and reports still-running targets", async () => {
  const adapter = makeAdapter({ procs: [{ name: "admin", status: "online" }], failStop: ["admin"] });
  const result = await stopMyBotFleetViaPM2({ projectRoot: tempProjectRoot(), adapter, timeoutMs: 200, pollMs: 20 });
  assert.equal(result.success, false);
  assert.deepEqual(result.failed, [{ name: "admin", reason: "pm2_stop_failed" }]);
  assert.deepEqual(result.stillRunning, ["admin"]);
});

test("fleet-stop is a no-op success when daemon is down (nothing to resurrect)", async () => {
  const adapter = makeAdapter({ procs: [], daemonUp: false });
  const result = await stopMyBotFleetViaPM2({ projectRoot: "x", adapter });
  assert.equal(result.success, true);
  assert.equal(result.daemonAvailable, false);
  assert.deepEqual(result.stopped, []);
});

test("fleet-stop tolerates inventory failure without throwing", async () => {
  const adapter = {
    async isAvailable() { return { available: true }; },
    async listManagedProcesses() { throw new Error("jlist parse error"); },
  };
  const result = await stopMyBotFleetViaPM2({ projectRoot: "x", adapter, timeoutMs: 100, pollMs: 10 });
  assert.equal(result.success, false);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /inventory_failed/);
});

test("verifyFleetStopped polls until processes leave online state", async () => {
  let attempts = 0;
  const adapter = {
    async listProcesses() {
      attempts += 1;
      return attempts < 3 ? [{ name: "admin", status: "online" }] : [{ name: "admin", status: "stopped" }];
    },
  };
  const result = await verifyFleetStopped(adapter, ["admin"], { timeoutMs: 2000, pollMs: 10 });
  assert.equal(result.allStopped, true);
});

test("verifyFleetStopped treats daemon death during stop as quiesced", async () => {
  const adapter = {
    async listProcesses() { throw new Error("daemon died"); },
  };
  const result = await verifyFleetStopped(adapter, ["admin"], { timeoutMs: 500, pollMs: 10 });
  assert.equal(result.allStopped, true);
  assert.deepEqual(result.stillRunning, []);
});
