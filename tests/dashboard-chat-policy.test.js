import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { AuditStore } from "../src/dashboard/audit-store.js";
import { BotRegistry } from "../src/dashboard/bot-registry.js";
import { ConfigStore } from "../src/dashboard/config-store.js";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-chat-policy-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.writeFile(path.join(root, 'mybot', 'mybots.json'), JSON.stringify({ child: { name: 'child' } }));
  await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({
    name: "child",
    WEB_CONFIG_PATH: "mybot/web-config-child.json",
  }));
  await fs.writeFile(path.join(root, "mybot", "web-config-child.json"), JSON.stringify({ prefix: "!" }));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ commands: [] }));
  return root;
}

async function withServer(root, fn) {
  const app = express();
  app.use(express.json());
  registerDashboardApi(app, {
    root,
    registry: new BotRegistry({ root }),
    configStore: new ConfigStore({ backupDir: path.join(root, "logs", "backups") }),
    auditStore: new AuditStore({ root }),
  });
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("chat policy API reads, writes, validates, and audits", async () => {
  const root = await makeRoot();
  await withServer(root, async (base) => {
    const initial = await fetch(`${base}/api/bots/child/chat-policy`).then((response) => response.json());
    assert.equal(initial.success, true);
    assert.deepEqual(initial.data.policy, { botId: "child", groupEnabled: true, privateEnabled: true });

    const saved = await fetch(`${base}/api/bots/child/chat-policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-request-id": "req-chat-policy" },
      body: JSON.stringify({ groupEnabled: false }),
    }).then((response) => response.json());
    assert.equal(saved.success, true);
    assert.equal(saved.restartRequired, true);
    assert.equal(saved.data.policy.groupEnabled, false);
    assert.equal(saved.data.policy.privateEnabled, true);
    assert.ok(saved.backup?.file);

    const invalid = await fetch(`${base}/api/bots/child/chat-policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ privateEnabled: "false" }),
    }).then((response) => response.json());
    assert.equal(invalid.success, false);
    assert.equal(invalid.error.code, "CHAT_POLICY_VALIDATION_FAILED");

    const audited = await fs.readFile(path.join(root, "logs", "dashboard-audit.jsonl"), "utf8");
    assert.match(audited, /chat-policy.update/);
    assert.match(audited, /req-chat-policy/);
  });
});

test("chat policy API rejects unknown bots", async () => {
  const root = await makeRoot();
  await withServer(root, async (base) => {
    const response = await fetch(`${base}/api/bots/missing/chat-policy`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "BOT_NOT_FOUND");
  });
});
