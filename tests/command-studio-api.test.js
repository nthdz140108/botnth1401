import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { requestIdMiddleware } from "../src/dashboard/api-response.js";

function buildApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-api-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "json-data", "command.json"),
    JSON.stringify({ prefix: "!", commands: [{ name: "sendtask", permission: "adminBot", active: true }, { name: "help", permission: "all", active: true }] }));
  fs.writeFileSync(path.join(root, "mybot", "mybots.json"), JSON.stringify({}));
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  registerDashboardApi(app, { root });
  return { app, root };
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (res) => {
        const payload = { status: res.status, body: await res.json().catch(() => ({})) };
        resolve(payload);
        server.close();
      }).catch(reject);
    });
  });
}

test("catalog and coverage endpoints expose full studio coverage", async () => {
  const { app } = buildApp();
  const catalog = await request(app, "GET", "/api/command-studio/catalog");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.data.commands.length, 218);
  const sendtaskEntry = catalog.body.data.commands.find((c) => c.commandName === "sendtask");
  assert.equal(sendtaskEntry.adapter, "sendtask-scheduler");

  const coverage = await request(app, "GET", "/api/command-studio/coverage");
  assert.equal(coverage.body.data.summary.full, coverage.body.data.summary.totalRegistry);
});

test("config endpoint returns effective values with provenance and revisions", async () => {
  const { app } = buildApp();
  const res = await request(app, "GET", "/api/command-studio/commands/sendtask/config?botId=admin&threadId=42");
  assert.equal(res.status, 200);
  assert.equal(res.body.data.effective["operation.enabled"], true);
  assert.equal(res.body.data.provenance["operation.enabled"].source, "default");
  assert.equal(res.body.data.revisions.global, 0);
  assert.equal(res.body.data.effective["schedules.items"].length, 24);
});

test("draft save -> validate -> apply -> rollback cycle keeps active config consistent", async () => {
  const { app, root } = buildApp();
  const draftPut = await request(app, "PUT", "/api/command-studio/commands/help/draft", {
    scope: "global",
    patch: { "operation.cooldownSeconds": 99 },
  });
  assert.equal(draftPut.status, 200);

  const draftGet = await request(app, "GET", "/api/command-studio/commands/help/draft?scope=global");
  assert.equal(draftGet.body.data.draft.patch["operation.cooldownSeconds"], 99);

  const applied = await request(app, "POST", "/api/command-studio/commands/help/apply", { scope: "global", expectedRevision: 0, fromDraft: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.data.applied, true);
  assert.equal(applied.body.data.revision, 1);

  const configAfter = await request(app, "GET", "/api/command-studio/commands/help/config");
  assert.equal(configAfter.body.data.effective["operation.cooldownSeconds"], 99);
  assert.equal(configAfter.body.data.provenance["operation.cooldownSeconds"].source, "global");

  const history = await request(app, "GET", "/api/command-studio/commands/help/history");
  assert.ok(history.body.data.entries.some((entryItem) => entryItem.action === "studio.apply"));

  const rolledBack = await request(app, "POST", "/api/command-studio/commands/help/rollback", { scope: "global" });
  assert.equal(rolledBack.status, 200);
  const configRolledBack = await request(app, "GET", "/api/command-studio/commands/help/config");
  assert.notEqual(configRolledBack.body.data.effective["operation.cooldownSeconds"], 99);
  void root;
});

test("apply rejects stale revision with 409 REVISION_CONFLICT", async () => {
  const { app } = buildApp();
  const first = await request(app, "POST", "/api/command-studio/commands/help/apply", {
    scope: "global",
    values: { "responses.templates.onSuccess": "ok" },
  });
  assert.equal(first.status, 200);
  const stale = await request(app, "POST", "/api/command-studio/commands/help/apply", {
    scope: "global",
    values: { "responses.templates.onSuccess": "again" },
    expectedRevision: 0,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "REVISION_CONFLICT");
});

test("validation failures never touch active layer", async () => {
  const { app } = buildApp();
  const badValues = { "schedules.items": "not-an-array" };
  const applied = await request(app, "POST", "/api/command-studio/commands/sendtask/apply", {
    scope: "global",
    values: badValues,
  });
  assert.equal(applied.status, 400);
  const config = await request(app, "GET", "/api/command-studio/commands/sendtask/config");
  assert.equal(config.body.data.effective["schedules.items"].length, 24);
});

test("scope rules block group overrides for bot-only fields and unknown fields", async () => {
  const { app } = buildApp();
  const draft = await request(app, "PUT", "/api/command-studio/commands/sendtask/draft", {
    scope: "group",
    botId: "admin",
    threadId: "42",
    patch: { "schedules.timezone": "UTC" },
  });
  assert.equal(draft.status, 400);
  assert.equal(draft.body.error.code, "SCOPE_NOT_ALLOWED");

  const unknown = await request(app, "PUT", "/api/command-studio/commands/sendtask/draft", {
    scope: "global",
    patch: { "not.a.field": 1 },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");
});

test("group override applies only to requested bot/thread", async () => {
  const { app } = buildApp();
  const applyGroup = await request(app, "POST", "/api/command-studio/commands/help/apply", {
    scope: "group",
    botId: "admin",
    threadId: "42",
    values: { "operation.enabled": false },
  });
  assert.equal(applyGroup.status, 200, JSON.stringify(applyGroup.body));

  const targetThread = await request(app, "GET", "/api/command-studio/commands/help/config?botId=admin&threadId=42");
  assert.equal(targetThread.body.data.effective["operation.enabled"], false);
  const otherThread = await request(app, "GET", "/api/command-studio/commands/help/config?botId=admin&threadId=43");
  assert.equal(otherThread.body.data.effective["operation.enabled"], true);
});

test("reset-override removes the sparse override for a command on a layer", async () => {
  const { app } = buildApp();
  await request(app, "POST", "/api/command-studio/commands/help/apply", {
    scope: "global",
    values: { "operation.maxUsesPerHour": 5 },
  });
  const reset = await request(app, "POST", "/api/command-studio/commands/help/reset-override", { scope: "global" });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.removed, true);
  const config = await request(app, "GET", "/api/command-studio/commands/help/config");
  assert.equal(config.body.data.effective["operation.maxUsesPerHour"], null);
});
