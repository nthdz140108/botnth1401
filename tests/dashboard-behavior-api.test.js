import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { requestIdMiddleware } from "../src/dashboard/api-response.js";

function buildApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-api-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot", "bots"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot", "command-overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "json-data", "command.json"),
    JSON.stringify({ prefix: "!", commands: [{ name: "help", permission: "all", active: true }] }));
  fs.writeFileSync(path.join(root, "mybot", "mybots.json"), JSON.stringify({}));
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  registerDashboardApi(app, { root });
  return { app, root };
}

function put(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${url}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => {
        resolve({ status: res.status, body: await res.json() });
        server.close();
      }).catch(reject);
    });
  });
}

function get(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${url}`).then(async (res) => {
        resolve({ status: res.status, body: await res.json() });
        server.close();
      }).catch(reject);
    });
  });
}

function del(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${url}`, { method: "DELETE" }).then(async (res) => {
        resolve({ status: res.status, body: await res.json() });
        server.close();
      }).catch(reject);
    });
  });
}

test("serves behavior schema with variables", async () => {
  const { app } = buildApp();
  const res = await get(app, "/api/commands/behavior-schema");
  assert.equal(res.status, 200);
  assert.ok(res.body.data.schema.groups.length >= 4);
  assert.ok(res.body.data.variables.includes("{prefix}"));
});

test("put+get global behavior roundtrip and validation failure", async () => {
  const { app, root } = buildApp();
  const good = await put(app, "/api/commands/help/behavior", {
    responses: { useCustomTemplates: true, templates: { onCooldown: "{user} đợi {remaining}s" } },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.value.behavior.responses.useCustomTemplates, true);

  const fetched = await get(app, "/api/commands/help/behavior");
  assert.equal(fetched.body.data.global.responses.templates.onCooldown, "{user} đợi {remaining}s");

  const bad = await put(app, "/api/commands/help/behavior", { operation: { cooldownMode: "sai" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "COMMAND_VALIDATION_FAILED");

  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "assets/json-data/command.json"), "utf8"))
    .commands[0].behavior);
});

test("bot override roundtrip returns effective merged profile", async () => {
  const { app } = buildApp();
  await put(app, "/api/commands/help/behavior", { operation: { maxUsesPerHour: 5 } });
  const saved = await put(app, "/api/bots/bot01/commands/help/behavior", { operation: { killSwitch: true } });
  assert.equal(saved.status, 200);

  const view = await get(app, "/api/bots/bot01/commands/help/behavior");
  assert.equal(view.body.data.effective.operation.killSwitch, true);
  assert.equal(view.body.data.effective.operation.maxUsesPerHour, 5);
  assert.equal(view.body.data.hasOverride, true);
});

test("bot-scope behavior delete on unknown command returns 404", async () => {
  const { app, root } = buildApp();
  const res = await del(app, "/api/bots/bot01/commands/ghost/behavior");
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "COMMAND_NOT_FOUND");
  assert.ok(!fs.existsSync(path.join(root, "mybot", "command-overrides", "bot01.json")));
});

test("render-preview renders template or 400 on invalid input", async () => {
  const { app } = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const post = async (body) => await fetch(`http://127.0.0.1:${port}/api/commands/render-preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const okRes = await post({ template: "{prefix}{command} cho {user}", vars: { prefix: "!", command: "kick", user: "An" } });
    assert.equal(okRes.body.data.rendered, "!kick cho An");

    const fallback = await post({ template: "", vars: {} });
    assert.equal(fallback.body.data.rendered, null);

    const invalid = await post({ template: 42 });
    assert.equal(invalid.status, 400);
  } finally {
    server.close();
  }
});

test("command-config reload writes request file", async () => {
  const { app } = buildApp();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const botId = `bot01-hotreload-${Date.now()}`;
  const writtenPath = path.join(repoRoot, "mybot", "state", "reload", `${botId}.json`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/command-config/reload`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(res.status, 202);
    assert.equal(res.body.data.requested, true);
    assert.equal(res.body.data.botId, botId);
    const written = JSON.parse(fs.readFileSync(writtenPath, "utf8"));
    assert.equal(written.reloadType, "command-config");
    assert.equal(written.status, "requested");

    const invalid = await fetch(`http://127.0.0.1:${port}/api/system/command-config/reload`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId: "../evil" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_BOT_ID");
  } finally {
    server.close();
    fs.rmSync(writtenPath, { force: true });
  }
});
