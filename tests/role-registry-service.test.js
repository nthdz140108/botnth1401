import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RoleRegistryService } from "../src/dashboard/role-registry-service.js";

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "mybot-role-registry-"));
}

function makeRegistry(bots) {
  return {
    async describe(id) {
      return bots[id] || null;
    },
  };
}

function makeConfigStore({ failOnCall = null } = {}) {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async writeJson(file, value) {
      callCount += 1;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      if (failOnCall && callCount === failOnCall) {
        throw new Error(`write failed on call ${callCount}`);
      }
      return { value, backup: null, changedPaths: [file], restartRequired: true };
    },
  };
}

test("reads a default role registry when the file does not exist", async () => {
  const root = makeTempRoot();
  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({}),
    configStore: makeConfigStore(),
  });

  await assert.deepEqual(await service.read(), {
    schemaVersion: 1,
    adminBotId: "admin",
    primaryBotId: null,
    previousPrimaryBotId: null,
    promotedAt: null,
    updatedAt: null,
    transaction: null,
  });
});

test("swapAdminBot writes transaction metadata and persists the new admin", async () => {
  const root = makeTempRoot();
  const configStore = makeConfigStore();
  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({
      admin: { id: "admin", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
      bot1: { id: "bot1", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
    }),
    configStore,
    actions: {
      async restart() {
        return { ok: true };
      },
    },
  });

  const result = await service.swapAdminBot("bot1", { requestId: "req-1", actor: "dashboard", confirm: true });
  assert.equal(result.primaryBotId, "bot1");
  assert.equal(result.adminBotId, "bot1");
  assert.equal(result.previousAdminBotId, "admin");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.transaction.status, "committed");
  assert.equal(result.transaction.requestId, "req-1");
  assert.equal(result.transaction.actor, "dashboard");
  assert.equal(configStore.callCount, 2);

  const persisted = JSON.parse(await fs.readFile(path.join(root, "mybot", "role-registry.json"), "utf8"));
  assert.equal(persisted.primaryBotId, "bot1");
  assert.equal(persisted.adminBotId, "bot1");
  assert.equal(persisted.previousAdminBotId, "admin");
  assert.equal(persisted.transaction.status, "committed");
});

test("swapAdminBot rejects same bot, disabled, missing credential, and unhealthy bots", async () => {
  const root = makeTempRoot();
  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({
      admin: { id: "admin", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
      bot2: { id: "bot2", enabled: false, status: "disabled", connected: true, credential: { state: "configured" } },
      bot3: { id: "bot3", enabled: true, status: "running", connected: true, credential: { state: "missing" } },
      bot4: { id: "bot4", enabled: true, status: "error", connected: false, credential: { state: "configured" } },
    }),
    configStore: makeConfigStore(),
    actions: { async restart() { return true; } },
  });

  await assert.rejects(
    () => service.swapAdminBot("admin", { confirm: true }),
    (error) => error.code === "SAME_BOT" && error.status === 409
  );
  await assert.rejects(
    () => service.swapAdminBot("bot2", { confirm: true }),
    (error) => error.code === "BOT_DISABLED" && error.status === 409
  );
  await assert.rejects(
    () => service.swapAdminBot("bot3", { confirm: true }),
    (error) => error.code === "BOT_CREDENTIAL_MISSING" && error.status === 409
  );
  await assert.rejects(
    () => service.swapAdminBot("bot4", { confirm: true }),
    (error) => error.code === "BOT_UNHEALTHY" && error.status === 409
  );
});

test("swapAdminBot rolls back to the previous state when the commit write fails", async () => {
  const root = makeTempRoot();
  const roleFile = path.join(root, "mybot", "role-registry.json");
  await fs.mkdir(path.dirname(roleFile), { recursive: true });
  await fs.writeFile(roleFile, `${JSON.stringify({
    schemaVersion: 1,
    adminBotId: "admin",
    primaryBotId: "admin",
    previousPrimaryBotId: null,
    promotedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    transaction: null,
  }, null, 2)}\n`, "utf8");

  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({
      admin: { id: "admin", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
      bot2: { id: "bot2", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
    }),
    configStore: makeConfigStore({ failOnCall: 2 }),
    actions: { async restart() { return true; } },
  });

  await assert.rejects(() => service.swapAdminBot("bot2", { requestId: "req-2", confirm: true }), /write failed on call 2/);

  const restored = JSON.parse(await fs.readFile(roleFile, "utf8"));
  assert.equal(restored.primaryBotId, "admin");
  assert.equal(restored.adminBotId, "admin");
  assert.equal(restored.transaction, null);
});

test("promotePrimary rejects when another promotion already holds the lock", async () => {
  const root = makeTempRoot();
  const lockPath = path.join(root, "mybot", "role-registry.json.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "locked", "utf8");

  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({
      bot3: { id: "bot3", enabled: true, status: "running" },
    }),
    configStore: makeConfigStore(),
  });

  await assert.rejects(
    () => service.promotePrimary("bot3"),
    (error) => error.code === "ROLE_REGISTRY_LOCKED" && error.status === 409
  );
});

test("promotePrimary rejects unhealthy bots and missing credentials", async () => {
  const root = makeTempRoot();
  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({
      bot4: { id: "bot4", enabled: true, status: "running", connected: false, credential: { state: "configured" } },
      bot5: { id: "bot5", enabled: true, status: "running", connected: true, credential: { state: "missing" } },
    }),
    configStore: makeConfigStore(),
  });

  await assert.rejects(
    () => service.promotePrimary("bot4"),
    (error) => error.code === "BOT_UNHEALTHY" && error.status === 409
  );
  await assert.rejects(
    () => service.promotePrimary("bot5"),
    (error) => error.code === "BOT_CREDENTIAL_MISSING" && error.status === 409
  );
});

test("swapAdminBot rolls back and restarts the old admin when the new admin fails to restart", async () => {
  const root = makeTempRoot();
  const roleFile = path.join(root, "mybot", "role-registry.json");
  await fs.mkdir(path.dirname(roleFile), { recursive: true });
  await fs.writeFile(roleFile, `${JSON.stringify({
    schemaVersion: 1,
    adminBotId: "admin",
    primaryBotId: "admin",
    previousPrimaryBotId: null,
    promotedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    transaction: null,
  }, null, 2)}\n`, "utf8");

  const calls = [];
  const service = new RoleRegistryService({
    root,
    registry: makeRegistry({
      admin: { id: "admin", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
      bot6: { id: "bot6", enabled: true, status: "running", connected: true, credential: { state: "configured" } },
    }),
    configStore: makeConfigStore(),
    actions: {
      async stop(botId) {
        calls.push(["stop", botId]);
        return { botId, action: "stop" };
      },
      async restart(botId) {
        calls.push(["restart", botId]);
        if (botId === "bot6") throw new Error("boot failed");
        return { botId, action: "start" };
      },
    },
  });

  await assert.rejects(
    () => service.swapAdminBot("bot6", { requestId: "req-3", confirm: true }),
    /boot failed/
  );

  assert.deepEqual(calls, [["restart", "admin"], ["restart", "bot6"], ["restart", "admin"]]);
  const restored = JSON.parse(await fs.readFile(roleFile, "utf8"));
  assert.equal(restored.primaryBotId, "admin");
  assert.equal(restored.adminBotId, "admin");
  assert.equal(restored.transaction, null);
});
