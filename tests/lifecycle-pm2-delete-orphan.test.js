import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PM2 orphan cleanup + lifecycle delete regression tests.
 *
 * Production bug: the child-bot delete flow only called `pm2 stop`, then
 * removed the registry entry/files but never `pm2 delete`. PM2 kept tracking
 * the process, which surfaced as a persistent "Chưa có tên Zalo" row (a
 * BOT_MANAGED orphan with no registry record).
 *
 * 1. deleteChildBotLogic must call an explicit pm2-delete callback.
 * 2. reconcile orphan cleanup must pm2-delete stopped/errored BOT_MANAGED
 *    processes with no registry entry, warn-only for online ones, and never
 *    touch infra / foreign / registry-known processes.
 */

test("deleteChildBotLogic calls pm2 delete callback before removing registry", async () => {
  const { deleteChildBotLogic } = await import("../src/commands/mybot/System/mybot-lifecycle.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-del-pm2-"));
  const mybotDir = path.join(tmpDir, "mybot");
  fs.mkdirSync(path.join(mybotDir, "credentials"), { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  await fs.writeFileSync(path.join(mybotDir, "credentials", "22222.json"), "{}", "utf8");
  const registry = { "admin": { uid: "admin_uid", isMain: true, status: "running" }, "22222": { uid: "22222", status: "running" } };
  await fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");

  let deleteCalled = false;
  let stopCalled = false;
  let killCalled = false;
  let deleteOrder = 0;
  let stopOrder = 0;

  const result = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "22222",
    stopProcessFn: async () => { stopCalled = true; stopOrder = ++deleteOrder; },
    killProcessFn: async () => { killCalled = true; },
    deleteProcessFn: async () => {
      deleteCalled = true;
      deleteOrder = ++deleteOrder;
      return { success: true, verifiedAbsent: true, ownershipVerified: true };
    },
  });

  assert.equal(result.success, true);
  assert.equal(deleteCalled, true, "must call pm2 delete (not just stop)");
  assert.equal(stopCalled, false, "must call pm2 delete directly without stopping first");
  assert.equal(killCalled, true);

  const updated = JSON.parse(await fs.promises.readFile(registryPath, "utf8"));
  assert.equal(updated["22222"], undefined, "registry entry must be removed after delete");
});

test("cleanupPm2OrphansForTest deletes stopped/errored orphans, warns on online, skips infra+known", async () => {
  const { cleanupPm2OrphansForTest } = await import("../src/runtime/reconcile-and-monitor.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-orphan-"));
  const mybotDir = path.join(tmpDir, "mybot");
  fs.mkdirSync(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  // Registry knows bot-kept; admin/dashboard/guardian are infra; bot-orphan-stopped,
  // bot-orphan-errored, bot-orphan-online are NOT in the registry.
  await fs.writeFileSync(registryPath, JSON.stringify({
    "bot-kept": { uid: "bot-kept", status: "stopped" },
  }), "utf8");

  let deleteCalls = [];
  const adapter = {
    listProcesses: async () => [
      { name: "admin", status: "online", env: { BOT_MANAGED: "true", BOT_KEY: "admin" } },
      { name: "mybot-dashboard", status: "online", env: {} },
      { name: "mybot-guardian", status: "online", env: {} },
      { name: "bot-kept", status: "stopped", env: { BOT_MANAGED: "true", BOT_KEY: "bot-kept" } },
      { name: "bot-orphan-stopped", status: "stopped", env: { BOT_MANAGED: "true", BOT_KEY: "bot-orphan-stopped" } },
      { name: "bot-orphan-errored", status: "errored", env: { BOT_MANAGED: "true", BOT_KEY: "bot-orphan-errored" } },
      { name: "bot-orphan-online", status: "online", env: { BOT_MANAGED: "true", BOT_KEY: "bot-orphan-online" } },
      { name: "foreign-app", status: "online", env: {} },
    ],
    deleteBot: async (name) => { deleteCalls.push(name); return { success: true, name }; },
  };

  const result = await cleanupPm2OrphansForTest({ adapter, registryPath });

  assert.equal(result.registryOk, true);
  assert.deepEqual(result.deleted.sort(), ["bot-orphan-errored", "bot-orphan-stopped"]);
  assert.deepEqual(result.warned, ["bot-orphan-online"]);
  assert.deepEqual(deleteCalls.sort(), ["bot-orphan-errored", "bot-orphan-stopped"]);
  // infra + registry-known + foreign must never be deleted
  assert.ok(!deleteCalls.includes("admin"));
  assert.ok(!deleteCalls.includes("mybot-dashboard"));
  assert.ok(!deleteCalls.includes("mybot-guardian"));
  assert.ok(!deleteCalls.includes("bot-kept"));
  assert.ok(!deleteCalls.includes("foreign-app"));
});

test("cleanupPm2OrphansForTest is fail-closed when registry is malformed", async () => {
  const { cleanupPm2OrphansForTest } = await import("../src/runtime/reconcile-and-monitor.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-orphan-bad-"));
  const mybotDir = path.join(tmpDir, "mybot");
  fs.mkdirSync(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");
  await fs.writeFileSync(registryPath, "{not-valid-json", "utf8");

  let deleteCalls = [];
  const adapter = {
    listProcesses: async () => [
      { name: "bot-orphan-stopped", status: "stopped", env: { BOT_MANAGED: "true", BOT_KEY: "bot-orphan-stopped" } },
    ],
    deleteBot: async (name) => { deleteCalls.push(name); return { success: true, name }; },
  };

  const result = await cleanupPm2OrphansForTest({ adapter, registryPath });
  assert.equal(result.registryOk, false);
  assert.equal(result.deleted.length, 0, "must not delete anything when registry is malformed");
  assert.equal(deleteCalls.length, 0);
});

test("cleanupPm2OrphansForTest is fail-closed when registry file is missing", async () => {
  const { cleanupPm2OrphansForTest } = await import("../src/runtime/reconcile-and-monitor.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-orphan-missing-"));
  const registryPath = path.join(tmpDir, "mybot", "mybots.json");

  let deleteCalls = [];
  const adapter = {
    listProcesses: async () => [
      { name: "bot-orphan-stopped", status: "stopped", env: { BOT_MANAGED: "true", BOT_KEY: "bot-orphan-stopped" } },
    ],
    deleteBot: async (name) => { deleteCalls.push(name); return { success: true, name }; },
  };

  const result = await cleanupPm2OrphansForTest({ adapter, registryPath });
  assert.equal(result.registryOk, false);
  assert.equal(result.deleted.length, 0);
  assert.equal(deleteCalls.length, 0);
});

test("cleanupPm2OrphansForTest never touches foreign processes without BOT_MANAGED or bot- prefix", async () => {
  const { cleanupPm2OrphansForTest } = await import("../src/runtime/reconcile-and-monitor.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-orphan-foreign-"));
  const mybotDir = path.join(tmpDir, "mybot");
  fs.mkdirSync(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");
  await fs.writeFileSync(registryPath, JSON.stringify({}), "utf8");

  let deleteCalls = [];
  const adapter = {
    listProcesses: async () => [
      // Foreign app: no BOT_MANAGED, no `bot-` prefix, not infra. Never a
      // MyBot fleet process — must NEVER be deleted.
      { name: "some-other-pm2-app", status: "stopped", env: {} },
      // A process whose name happens to match a registry key but the env
      // explicitly says BOT_MANAGED=false. The registry-key fallback in
      // listManagedProcesses excludes it; orphan cleanup must also skip.
      { name: "user-123", status: "errored", env: { BOT_MANAGED: "false" } },
    ],
    deleteBot: async (name) => { deleteCalls.push(name); return { success: true, name }; },
  };

  const result = await cleanupPm2OrphansForTest({ adapter, registryPath });
  assert.equal(result.deleted.length, 0);
  assert.equal(deleteCalls.length, 0);
});

test("cleanupPm2OrphansForTest skips bot- prefixed process that lacks BOT_MANAGED marker", async () => {
  const { cleanupPm2OrphansForTest } = await import("../src/runtime/reconcile-and-monitor.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-orphan-prefix-"));
  const mybotDir = path.join(tmpDir, "mybot");
  fs.mkdirSync(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");
  await fs.writeFileSync(registryPath, JSON.stringify({}), "utf8");

  let deleteCalls = [];
  const adapter = {
    listProcesses: async () => [
      // A foreign app named `bot-xyz` but NEVER launched by the MyBot fleet:
      // no BOT_MANAGED marker. The legacy `bot-` name prefix must not be
      // enough to treat it as an orphan (the "trùng tên" rule).
      { name: "bot-xyz", status: "stopped", env: {} },
    ],
    deleteBot: async (name) => { deleteCalls.push(name); return { success: true, name }; },
  };

  const result = await cleanupPm2OrphansForTest({ adapter, registryPath });
  assert.equal(result.deleted.length, 0, "must not delete a bot- prefixed process without BOT_MANAGED");
  assert.equal(deleteCalls.length, 0);
});
