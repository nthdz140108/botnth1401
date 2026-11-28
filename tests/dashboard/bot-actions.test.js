import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotRegistry } from "../../src/dashboard/bot-registry.js";
import { ConfigStore } from "../../src/dashboard/config-store.js";
import { createBotActionService } from "../../src/dashboard/bot-action-service.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-actions-"));
  for (const dir of ["mybot/bots", "mybot/state", "mybot/credentials", "mybot/overrides", "mybot/config", "mybot/data", "logs"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "mybot/mybots.json"), JSON.stringify({
    child: { name: "child", displayName: "Child Bot", ownerUid: "test-owner", expiryAt: "-1", status: "running", webPort: 3333 },
    stopped: { name: "stopped", status: "stopped" },
    disabled: { name: "disabled", status: "stopped", enabled: false, disabledReason: "maintenance" },
  }));
  await fs.writeFile(path.join(root, "mybot/bots/child.json"), JSON.stringify({
    name: "child",
    webPort: 3333,
    configFilePath: "mybot/credentials/child.json",
    overridePath: "mybot/overrides/child",
    dataPath: "mybot/data/child",
  }));
  await fs.writeFile(path.join(root, "mybot/state/child.json"), JSON.stringify({ status: "running", pid: "99999" }));
  await fs.writeFile(path.join(root, "mybot/credentials/child.json"), "{\"cookie\":{\"token\":\"secret\"},\"imei\":\"test-imei\",\"userAgent\":\"test-ua\"}\n");
  await fs.mkdir(path.join(root, "mybot/overrides/child"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot/overrides/child/commands.json"), "{}\n");
  await fs.mkdir(path.join(root, "mybot/data/child"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot/data/child/cache.json"), "{}\n");
  return root;
}

function serviceFor(root, overrides = {}) {
  const calls = [];
  const registry = new BotRegistry({ root, portProbe: async () => false, pm2: { status: async () => null } });
  const configStore = new ConfigStore({ backupDir: path.join(root, "logs/backups") });
  const pm2Adapter = {
    status: async () => ({ running: true, status: "online" }),
    start: async (id) => { calls.push(["start", id]); return true; },
    stop: async (id) => { calls.push(["stop", id]); return true; },
    restart: async (id) => { calls.push(["restart", id]); return true; },
    delete: async (id) => { calls.push(["delete", id]); return { success: true, verifiedAbsent: true, ownershipVerified: true, pm2Name: `mybot-${id}` }; },
    ...overrides.pm2Adapter,
  };
  const processAdapter = {
    status: async () => ({ running: false, status: "stopped" }),
    kill: async (id) => { calls.push(["kill", id]); return true; },
    ...overrides.processAdapter,
  };
  return {
    calls,
    registry,
    service: createBotActionService({
      readinessProbe: async () => ({ healthy: true, checkedAt: new Date().toISOString() }),
      root,
      registry,
      configStore,
      pm2Adapter,
      processAdapter,
      restartLauncher: overrides.restartLauncher,
      auditStore: overrides.auditStore,
    }),
  };
}

test("restarts admin through the launcher without starting a second bot", async () => {
  const root = await fixture();
  const { calls, service } = serviceFor(root, {
    restartLauncher: async ({ botId }) => {
      calls.push(["launcher", botId]);
      return true;
    },
  });

  const result = await service.restart("admin");
  assert.equal(result.botId, "admin");
  assert.equal(result.action, "restart");
  assert.equal(result.status, "running");
  assert.ok(result.operationId);
  assert.equal(result.phase, "ws_ready");
  assert.deepEqual(calls, [["launcher", "admin"]]);
});

test("restarts a directly spawned bot by killing then starting it", async () => {
  const root = await fixture();
  const { calls, service } = serviceFor(root, {
    pm2Adapter: { status: async () => ({ running: false, status: "not_found" }) },
    processAdapter: { status: async () => ({ running: true }) },
  });

  const result = await service.restart("child");
  assert.equal(result.botId, "child");
  assert.equal(result.action, "restart");
  assert.equal(result.status, "running");
  assert.ok(result.operationId);
  assert.equal(result.phase, "ws_ready");
  assert.deepEqual(calls, [["kill", "child"], ["start", "child"]]);
});

test("shares a concurrent PM2 restart for the same bot", async () => {
  const root = await fixture();
  let release;
  let started;
  const restartStarted = new Promise((resolve) => { started = resolve; });
  let restartCalls = 0;
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: true, status: "online" }),
      restart: async () => {
        restartCalls += 1;
        started();
        await new Promise((resolve) => { release = resolve; });
        return true;
      },
    },
  });

  const first = service.restart("child");
  const second = service.restart("child");
  assert.strictEqual(first, second);
  await restartStarted;
  release();
  await Promise.all([first, second]);
  assert.equal(restartCalls, 1);
});

test("reports direct restart start failures", async () => {
  const root = await fixture();
  const { calls, service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: false, status: "not_found" }),
      start: async () => false,
    },
    processAdapter: { status: async () => ({ running: true }) },
  });

  await assert.rejects(() => service.restart("child"), { code: "ACTION_FAILED" });
  assert.deepEqual(calls, [["kill", "child"]]);
});

test("normalizes direct restart adapter exceptions", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: { status: async () => ({ running: false, status: "not_found" }) },
    processAdapter: {
      status: async () => ({ running: true }),
      kill: async () => { throw new Error("kill exploded"); },
    },
  });

  await assert.rejects(() => service.restart("child"), { code: "ACTION_FAILED" });
});

test("disabled registry entries report disabled and reject start/restart", async () => {
  const root = await fixture();
  const { registry, service } = serviceFor(root);
  const bot = await registry.describe("disabled");
  assert.equal(bot.enabled, false);
  assert.equal(bot.status, "disabled");
  await assert.rejects(() => service.start("disabled"), { code: "BOT_DISABLED" });
  await assert.rejects(() => service.restart("disabled"), { code: "BOT_DISABLED" });
});

test("disable stops first and enable clears fields without starting", async () => {
  const root = await fixture();
  const { calls, registry, service } = serviceFor(root, { processAdapter: { status: async () => ({ running: true }) } });
  const result = await service.disable("child", { reason: "maintenance" });
  assert.equal(result.enabled, false);
  assert.deepEqual(calls.slice(0, 2), [["stop", "child"], ["kill", "child"]]);
  assert.equal((await registry.describe("child")).status, "disabled");
  await service.enable("child");
  assert.equal((await registry.describe("child")).enabled, true);
  assert.equal(calls.some(([action]) => action === "start"), false);
});

test("disable does not persist when stopping fails", async () => {
  const root = await fixture();
  const { registry, service } = serviceFor(root, { pm2Adapter: { stop: async () => false }, processAdapter: { status: async () => ({ running: true }) } });
  await assert.rejects(() => service.disable("child", { reason: "maintenance" }), { code: "STOP_FAILED" });
  assert.equal((await registry.describe("child")).enabled, true);
});

test("delete protects admin and requires matching confirmation", async () => {
  const root = await fixture();
  const { service } = serviceFor(root);
  await assert.rejects(() => service.delete("admin", { confirmId: "admin", confirmName: "admin" }), { code: "ADMIN_PROTECTED" });
  await assert.rejects(() => service.delete("child", { confirmId: "child", confirmName: "wrong" }), { code: "DELETE_CONFIRMATION_REQUIRED" });
  await assert.rejects(() => service.disable("admin", { reason: "maintenance" }), { code: "ADMIN_PROTECTED" });
});

test("bulk delete requires the exact confirmation token", async () => {
  const root = await fixture();
  const { service } = serviceFor(root);
  const rejected = await service.bulk("delete", ["child"], { confirm: "DELETE" });
  assert.equal(rejected.results[0].error.code, "DELETE_CONFIRMATION_REQUIRED");
});

test("bulk delete uses the exact token as confirmation for every selected bot", async () => {
  const root = await fixture();
  const { registry, service } = serviceFor(root);
  const result = await service.bulk("delete", ["child"], { confirm: "DELETE_SELECTED_BOTS" });
  assert.equal(result.results[0].success, true);
  assert.equal(await registry.describe("child"), null);
});

test("delete backs up and removes child files, state, registry, and audit", async () => {
  const root = await fixture();
  const audit = { entries: [], append: async (entry) => { audit.entries.push(entry); return entry; } };
  const { calls, registry, service } = serviceFor(root, { auditStore: audit });
  const result = await service.delete("child", { confirmId: "child", confirmName: "Child Bot" });
  assert.equal(result.partial, false);
  assert.ok(result.backup?.file);
  assert.ok(result.deletedPaths.some((item) => item.endsWith("child.json")));
  assert.equal((await registry.describe("child")), null);
  assert.equal(await fs.stat(path.join(root, "mybot/overrides/child")).catch(() => null), null);
  assert.equal(calls.some(([action]) => action === "delete"), true);
  assert.equal(audit.entries[0].action, "bots.delete");
});

test("bulk action deduplicates ids and keeps per-bot failures", async () => {
  const root = await fixture();
  const stoppedIds = new Set();
  const { service } = serviceFor(root, {
    pm2Adapter: {
      stop: async (id) => { if (id !== "stopped") stoppedIds.add(id); return id !== "stopped"; },
      status: async (id) => stoppedIds.has(id) ? { running: false, status: "stopped" } : { running: true, status: "online" },
    },
  });
  const result = await service.bulk("stop", ["child", "child", "stopped", "missing"]);
  assert.deepEqual(result.results.map((item) => item.botId), ["child", "stopped", "missing"]);
  assert.equal(result.results.find((item) => item.botId === "child").success, true);
  assert.equal(result.results.find((item) => item.botId === "stopped").success, false);
  assert.equal(result.partial, true);
});
