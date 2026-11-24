import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempProjectRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-autofix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Reconcile child port auto-fix regression:
 * - a PM2-online child whose bridge port is closed gets a genuinely bindable
 *   port, exactly ONE reload, and must be verified before counting as started
 * - a failed auto-fix must NOT loop: the child stays failed with the reason
 * - no silent fallback to a fixed port when nothing is bindable
 */

async function loadModule() {
  return import("../src/runtime/reconcile-and-monitor.js");
}

function registryFor(uid, port) {
  return {
    [uid]: {
      uid,
      botKey: uid,
      status: "running",
      webPort: String(port),
      expiryAt: new Date(Date.now() + 3600_000).toISOString(),
      credentials: { cookie: "c", imei: "i" },
      enabled: true,
    },
  };
}

function makeReadiness({ failPorts = [] } = {}) {
  return {
    getProcess: async (pm2Name) => ({ name: pm2Name, status: "online", pid: 4242 }),
    waitFor: async ({ descriptor, expectedPid }) => {
      if (failPorts.includes(Number(descriptor.webPort))) {
        return { ready: false, status: "starting", reason: "port-closed", identity: null };
      }
      return {
        ready: true,
        status: "running",
        reason: "ready",
        identity: { kind: "child", botKey: descriptor.botKey, pid: expectedPid },
      };
    },
  };
}

test("port-closed child is auto-fixed: new bindable port, one reload, counted as started", async (t) => {
  const { restoreChildBotsForTest, autoFixChildPort } = await loadModule();
  const uid = "bot-a";
  const brokenPort = 5301;

  let reloads = 0;
  const reloadedPorts = [];
  const tempRoot = makeTempProjectRoot(t);
  const summary = await restoreChildBotsForTest({
    registry: registryFor(uid, brokenPort),
    adapter: {
      listManagedProcesses: async () => [],
      listMyBotProcesses: async () => [{ name: uid, status: "online", pid: 5555 }],
      startBot: async () => ({ success: true, adopted: false }),
      reloadBotFromDescriptor: async (descriptor) => {
        reloads += 1;
        reloadedPorts.push(Number(descriptor.env.WEB_PORT));
        return { success: true, pid: 5555 };
      },
    },
    commit: "test",
    readiness: makeReadiness({ failPorts: [brokenPort] }),
    isPortInUseFn: async () => false,
    ensureProcessAtCommitFn: async () => ({ reloaded: false, reloadFailed: false }),
    autoFixChildPortFn: (params) => autoFixChildPort({ ...params, projectRoot: tempRoot, readinessTimeoutMs: 500 }),
  });

  assert.equal(summary.failed.length, 0);
  assert.equal(summary.started, 1, "auto-fixed child counts as started");
  assert.equal(reloads, 1, "exactly ONE reload — no restart loop");
  assert.equal(reloadedPorts.length, 1);
  assert.notEqual(reloadedPorts[0], brokenPort, "the child moved off the broken port");
});

test("failed auto-fix keeps the child failed without looping", async (t) => {
  const { restoreChildBotsForTest, autoFixChildPort } = await loadModule();
  const uid = "bot-b";
  const brokenPort = 5302;

  let reloads = 0;
  const tempRoot = makeTempProjectRoot(t);
  const summary = await restoreChildBotsForTest({
    registry: registryFor(uid, brokenPort),
    adapter: {
      listManagedProcesses: async () => [],
      listMyBotProcesses: async () => [{ name: uid, status: "online", pid: 5555 }],
      startBot: async () => ({ success: true, adopted: false }),
      reloadBotFromDescriptor: async () => {
        reloads += 1;
        return { success: false, reason: "pm2_start_failed" };
      },
    },
    commit: "test",
    readiness: makeReadiness({ failPorts: [brokenPort] }),
    isPortInUseFn: async () => false,
    ensureProcessAtCommitFn: async () => ({ reloaded: false, reloadFailed: false }),
    autoFixChildPortFn: (params) => autoFixChildPort({ ...params, projectRoot: tempRoot, readinessTimeoutMs: 300 }),
  });

  assert.equal(summary.started, 0);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].uid, uid);
  assert.match(summary.failed[0].reason, /not-ready:port-closed/);
  assert.equal(reloads, 1, "reload failure surfaces once; no restart loop");
});

test("autoFixChildPort writes the new port into registry and child config", async (t) => {
  const { autoFixChildPort } = await loadModule();
  const fsModule = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fsModule.mkdtempSync(path.join(os.tmpdir(), "mybot-portfix-"));
  t.after(() => fsModule.rmSync(root, { recursive: true, force: true }));

  fsModule.mkdirSync(path.join(root, "mybot", "bots"), { recursive: true });
  fsModule.writeFileSync(
    path.join(root, "mybot", "bots", "bot-c.json"),
    JSON.stringify({ name: "bot-c", webPort: "5303" }),
  );

  const readiness = makeReadiness({ failPorts: [5303] });
  const result = await autoFixChildPort({
    registry: registryFor("bot-c", 5303),
    bot: { uid: "bot-c", botKey: "bot-c", webPort: "5303" },
    adapter: {
      reloadBotFromDescriptor: async () => ({ success: true, pid: 777 }),
      listMyBotProcesses: async () => [{ name: "bot-c", status: "online", pid: 777 }],
    },
    readiness,
    commit: "test",
    projectRoot: root,
    isPortInUseFn: async () => false,
    readinessTimeoutMs: 500,
  });

  assert.equal(result.success, true);
  assert.notEqual(result.port, 5303);

  const updatedRegistry = JSON.parse(fsModule.readFileSync(path.join(root, "mybot", "mybots.json"), "utf8"));
  assert.equal(updatedRegistry["bot-c"].webPort, String(result.port), "registry is updated");
  const updatedConfig = JSON.parse(fsModule.readFileSync(path.join(root, "mybot", "bots", "bot-c.json"), "utf8"));
  assert.equal(updatedConfig.webPort, String(result.port), "child config is updated");
});
