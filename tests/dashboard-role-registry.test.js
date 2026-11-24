import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { BotRegistry } from "../src/dashboard/bot-registry.js";

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    use() {},
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

function createFakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("dashboard api exposes primary-bot and promote-primary through the role registry service", async () => {
  const app = createFakeApp();
  const reads = [];
  const promotions = [];
  const roleRegistryService = {
    async read() {
      reads.push(true);
      return {
        schemaVersion: 1,
        primaryBotId: "admin",
        previousPrimaryBotId: null,
        promotedAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        transaction: null,
      };
    },
    async promotePrimary(botId, meta) {
      promotions.push({ botId, meta });
      return {
        schemaVersion: 1,
        primaryBotId: botId,
        previousPrimaryBotId: "admin",
        promotedAt: "2026-08-11T00:01:00.000Z",
        updatedAt: "2026-08-11T00:01:00.000Z",
        transaction: { id: "tx-1", status: "committed" },
      };
    },
  };

  registerDashboardApi(app, {
    root: process.cwd(),
    registry: {
      async describe(id) {
        return id === "bot-1" ? { id: "bot-1", enabled: true, status: "running" } : null;
      },
      async list() { return []; },
      async runtime() { return {}; },
    },
    configStore: {
      async writeJson() { return { value: {}, backup: null, changedPaths: [], restartRequired: true }; },
      async readJson() { return {}; },
      async updateJson() { return { value: {}, backup: null, changedPaths: [], restartRequired: true }; },
      async rollback() { return { value: {}, backup: null, changedPaths: [], restartRequired: true }; },
    },
    roleRegistryService,
    auditStore: { async append() {} },
    commandService: {
      async scan() { return []; },
      async list() { return []; },
      async updateGlobal() { return { value: {}, changedPaths: [] }; },
      async createGlobal() { return { value: {}, changedPaths: [] }; },
      async deleteGlobal() { return { value: {}, changedPaths: [] }; },
      async listForBot() { return []; },
      async updateOverride() { return { value: {}, changedPaths: [] }; },
      async deleteOverride() { return { value: {}, changedPaths: [] }; },
      async copyFromAdmin() { return { value: {}, changedPaths: [] }; },
      async applyAll() { return { botIds: [] }; },
    },
    credentialService: {
      async read() { return {}; },
      async reveal() { return {}; },
      async update() { return { value: {}, changedPaths: [] }; },
    },
    prefixService: {
      async read() { return {}; },
      async update() { return { value: {}, changedPaths: [] }; },
    },
    chatPolicyService: {
      async read() { return {}; },
      async update() { return { policy: {}, changedPaths: [] }; },
    },
    providerConfigService: {
      async read() { return {}; },
      async update() { return { keys: [], changedKeys: [], backup: null }; },
    },
    actions: {
      async start() {},
      async stop() {},
      async restart() {},
      async enable() {},
      async disable() {},
      async delete() {},
      async bulk() { return { action: "bulk", results: [], partial: false }; },
    },
  });

  const getPrimary = app.routes.get("GET /api/system/primary-bot");
  const promote = app.routes.get("POST /api/bots/:id/actions/promote-primary");
  assert.equal(typeof getPrimary, "function");
  assert.equal(typeof promote, "function");

  const getRes = createFakeRes();
  await getPrimary({ requestId: "req-1", headers: {} }, getRes);
  assert.equal(getRes.body.data.primaryBotId, "admin");
  assert.equal(reads.length, 1);

  const postRes = createFakeRes();
  await promote({ requestId: "req-2", params: { id: "bot-1" }, body: { actor: "dashboard" }, headers: {} }, postRes);
  assert.equal(postRes.body.data.primaryBotId, "bot-1");
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].meta.requestId, "req-2");
  assert.equal(promotions[0].meta.actor, "dashboard");
});

test("bot registry surfaces the primary role in bot listings", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mybot-bot-registry-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), `${JSON.stringify({
    bot1: { name: "bot1", status: "running", enabled: true, webPort: "4444" },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(root, "mybot", "role-registry.json"), `${JSON.stringify({
    schemaVersion: 1,
    primaryBotId: "bot1",
    previousPrimaryBotId: "admin",
    promotedAt: "2026-08-11T00:10:00.000Z",
    updatedAt: "2026-08-11T00:10:00.000Z",
    transaction: null,
  }, null, 2)}\n`, "utf8");

  const registry = new BotRegistry({ root, portProbe: async () => false });
  const bots = await registry.list();
  const bot1 = bots.find((bot) => bot.id === "bot1");
  const admin = bots.find((bot) => bot.id === "admin");

  assert.equal(bot1.isPrimary, true);
  assert.equal(bot1.primaryRole, "primary");
  assert.equal(bot1.primaryBotId, "bot1");
  assert.equal(admin.primaryRole, "child");
  assert.equal(admin.primaryBotId, "bot1");
});
