import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Commit-marker guard tests (MYBOT_CODE_COMMIT).
 *
 * Four process categories must behave exactly as specified:
 * 1. marker == HEAD           -> adopt, never reload.
 * 2. marker != HEAD (stale)   -> reload via reloadBotFromDescriptor; reconcile
 *                                fails clearly when the reload cannot bring
 *                                the process online at the current commit.
 * 3. marker missing (legacy)  -> fail-open adopt, never block startup.
 * 4. foreign PM2 app          -> never reloaded (guard only sees MyBot fleet
 *                                names through listMyBotProcesses).
 */

const HEAD = "abc1234ffff00011122233344455566677788899";
const OLD = "0000000aaaa00011122233344455566677788899";

function makeAdapter({ processes, reloadCalls = [] }) {
  return {
    async listMyBotProcesses() {
      return processes.filter((p) => p.fleet !== false);
    },
    async reloadBotFromDescriptor(descriptor) {
      reloadCalls.push(descriptor);
      return { success: true, pm2Name: descriptor.pm2Name, pid: 4321, previousPid: 1234, pidChanged: true, reason: "reloaded" };
    },
  };
}

test("launch descriptor stamps MYBOT_CODE_COMMIT from git HEAD", async () => {
  const { createLaunchDescriptor } = await import("../../src/runtime/launch-descriptor.js");
  for (const kind of ["main", "child", "dashboard", "guardian"]) {
    const desc = createLaunchDescriptor({
      kind,
      botKey: kind === "child" ? "bot-x" : undefined,
      projectRoot: "/proj",
      commit: HEAD,
    });
    assert.equal(desc.env.MYBOT_CODE_COMMIT, HEAD, `${kind} descriptor must carry the commit marker`);
  }
});

test("launch descriptor omits the marker when commit is unavailable", async () => {
  const { createLaunchDescriptor } = await import("../../src/runtime/launch-descriptor.js");
  const desc = createLaunchDescriptor({ kind: "main", projectRoot: "/proj", commit: null });
  assert.equal(desc.env.MYBOT_CODE_COMMIT, undefined);
});

test("normalizePM2Process exposes the commit marker and web port", async () => {
  const { normalizePM2Process } = await import("../../src/runtime/pm2-adapter.js");
  const norm = normalizePM2Process({
    name: "admin",
    pm_id: 0,
    pid: 42,
    pm2_env: {
      status: "online",
      env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", MYBOT_CODE_COMMIT: HEAD, WEB_PORT: "2000" },
    },
  });
  assert.equal(norm.env.MYBOT_CODE_COMMIT, HEAD);
  assert.equal(norm.env.WEB_PORT, "2000");
});

test("marker guard: matching marker is adopted without reload", async () => {
  const reloadCalls = [];
  const adapter = makeAdapter({
    processes: [
      { name: "admin", kind: "main", status: "online", pid: 1, env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", MYBOT_CODE_COMMIT: HEAD, WEB_PORT: "2000" } },
    ],
    reloadCalls,
  });
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "admin",
    commit: HEAD,
    buildDescriptor: () => ({ pm2Name: "admin" }),
  });
  assert.equal(result.adopted, true);
  assert.equal(result.reloaded, false);
  assert.equal(reloadCalls.length, 0);
});

test("marker guard: mismatched marker forces a reload from the current descriptor", async () => {
  const reloadCalls = [];
  let fleet = [
    { name: "admin", kind: "main", status: "online", pid: 1, env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", MYBOT_CODE_COMMIT: OLD, WEB_PORT: "2000" } },
  ];
  const adapter = {
    async listMyBotProcesses() { return fleet; },
    async reloadBotFromDescriptor(descriptor) {
      reloadCalls.push(descriptor);
      // Simulate PM2 replacing the process with new code + env.
      fleet = [
        { name: "admin", kind: "main", status: "online", pid: 4321, env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", MYBOT_CODE_COMMIT: HEAD, WEB_PORT: "2000" } },
      ];
      return { success: true, pm2Name: descriptor.pm2Name, pid: 4321, previousPid: 1, pidChanged: true, reason: "reloaded" };
    },
  };
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "admin",
    commit: HEAD,
    buildDescriptor: () => ({ pm2Name: "admin", script: "/proj/src/bootstrap.js" }),
  });
  assert.equal(result.reloaded, true);
  assert.equal(result.reloadFailed, undefined);
  assert.equal(reloadCalls.length, 1);
  assert.equal(reloadCalls[0].pm2Name, "admin");
  assert.equal(reloadCalls[0].script, "/proj/src/bootstrap.js");
});

test("marker guard: reload that fails to come back online fails reconcile clearly", async () => {
  const reloadCalls = [];
  let fleet = [
    { name: "admin", kind: "main", status: "online", pid: 1, env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", MYBOT_CODE_COMMIT: OLD, WEB_PORT: "2000" } },
  ];
  const adapter = {
    async listMyBotProcesses() { return fleet; },
    async reloadBotFromDescriptor(descriptor) {
      reloadCalls.push(descriptor);
      // Simulate: reload ran but the app crashes — PM2 reports errored and
      // the marker never reaches HEAD.
      fleet = [
        { name: "admin", kind: "main", status: "errored", pid: null, env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", MYBOT_CODE_COMMIT: OLD, WEB_PORT: "2000" } },
      ];
      return { success: true, pm2Name: descriptor.pm2Name, pid: 4321, reason: "reloaded" };
    },
  };
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "admin",
    commit: HEAD,
    buildDescriptor: () => ({ pm2Name: "admin" }),
  });
  assert.equal(result.reloadFailed, true);
  assert.equal(result.adopted, false);
});

test("marker guard: missing commit marker but full contract markers is fail-open adopt", async () => {
  const reloadCalls = [];
  const adapter = makeAdapter({
    processes: [
      { name: "admin", kind: "main", status: "online", pid: 1, env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main", WEB_PORT: "2000" } },
    ],
    reloadCalls,
  });
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "admin",
    commit: HEAD,
    buildDescriptor: () => ({ pm2Name: "admin" }),
  });
  // Commit marker is telemetry only (fail-open), but the required contract
  // markers (BOT_KEY/MYBOT_INSTANCE_KIND/WEB_PORT) are present, so adopt.
  assert.equal(result.adopted, true);
  assert.equal(result.reloaded, false);
  assert.equal(reloadCalls.length, 0);
});

test("marker guard: online but missing required contract markers forces a reload", async () => {
  const reloadCalls = [];
  let fleet = [
    { name: "bot-a", kind: "child", status: "online", pid: 1, env: { BOT_MANAGED: "true" } },
  ];
  const adapter = {
    async listMyBotProcesses() { return fleet; },
    async reloadBotFromDescriptor(descriptor) {
      reloadCalls.push(descriptor);
      fleet = [
        { name: "bot-a", kind: "child", status: "online", pid: 99, env: { BOT_MANAGED: "true", BOT_KEY: "bot-a", MYBOT_INSTANCE_KIND: "child", WEB_PORT: "5301", MYBOT_CODE_COMMIT: HEAD } },
      ];
      return { success: true, pm2Name: descriptor.pm2Name, pid: 99, previousPid: 1, pidChanged: true, reason: "reloaded" };
    },
  };
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "bot-a",
    commit: HEAD,
    buildDescriptor: () => ({ pm2Name: "bot-a", script: "/proj/src/bootstrap.js" }),
  });
  assert.equal(result.reloaded, true);
  assert.equal(result.reloadFailed, undefined);
  assert.equal(reloadCalls.length, 1);
  assert.equal(reloadCalls[0].pm2Name, "bot-a");
});

test("marker guard: foreign PM2 apps are invisible to the guard", async () => {
  const reloadCalls = [];
  const adapter = makeAdapter({
    processes: [
      { name: "intruder", kind: "child", status: "online", pid: 9, fleet: false, env: { MYBOT_CODE_COMMIT: OLD } },
    ],
    reloadCalls,
  });
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "intruder",
    commit: HEAD,
    buildDescriptor: () => ({ pm2Name: "intruder" }),
  });
  // The foreign app is not in listMyBotProcesses -> guard sees no online
  // process -> returns adopted:false without reloading anything.
  assert.equal(result.adopted, false);
  assert.equal(result.reloaded, false);
  assert.equal(reloadCalls.length, 0);
});

test("marker guard: git unavailable disables the guard", async () => {
  const reloadCalls = [];
  const adapter = makeAdapter({ processes: [], reloadCalls });
  const { ensureProcessAtCommit } = await import("../../src/runtime/reconcile-guard.js");
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "admin",
    commit: null,
    buildDescriptor: () => ({ pm2Name: "admin" }),
  });
  assert.equal(result.adopted, true);
  assert.equal(reloadCalls.length, 0);
});

test("reconcile module references the shared guard", async () => {
  // reconcile-and-monitor.js executes main() at import time, so instead of
  // importing it we statically verify it wires the shared guard in.
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "runtime", "reconcile-and-monitor.js"),
    "utf8",
  );
  assert.match(source, /from ['"]\.\/reconcile-guard\.js['"]/);
  assert.match(source, /ensureProcessAtCommit/);
  const guard = await import("../../src/runtime/reconcile-guard.js");
  assert.equal(typeof guard.ensureProcessAtCommit, "function");
});

