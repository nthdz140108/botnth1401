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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-profile-style-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "bots", "child1.json"), JSON.stringify({
    name: "child1",
    displayName: "Child Bot One",
    ownerUid: "owner_123",
    status: "stopped",
  }));
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    child1: {
      key: "child1",
      name: "child1",
      displayName: "Child Bot One",
      ownerUid: "owner_123",
      status: "stopped",
      trialStatus: "pending",
    },
  }));
  return root;
}

async function withServer(root, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.dashboardSession = { role: "admin", isAdmin: true, username: "admin" };
    next();
  });
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

test("Dashboard Profile & Style API handles CRUD, style updates, reset, and showinfo", async () => {
  const root = await makeRoot();
  await withServer(root, async (base) => {
    // 1. GET /api/bots/child1/profile
    const getRes = await fetch(`${base}/api/bots/child1/profile`).then((r) => r.json());
    assert.equal(getRes.success, true);
    assert.equal(getRes.data.botId, "child1");
    assert.equal(getRes.data.ownerUid, "owner_123");
    assert.ok(getRes.data.style);

    // 2. PUT /api/bots/child1/profile
    const putRes = await fetch(`${base}/api/bots/child1/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nameServer: "Server Pro 1",
        description: "Super Bot",
        expectedRevision: getRes.data.revision,
      }),
    }).then((r) => r.json());
    assert.equal(putRes.success, true);
    assert.equal(putRes.data.nameServer, "Server Pro 1");
    assert.equal(putRes.data.description, "Super Bot");
    assert.equal(putRes.data.revision, 2);

    // 3. PUT /api/bots/child1/style
    const styleRes = await fetch(`${base}/api/bots/child1/style`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        icon: "⚡",
        color: "15a85f",
        size: { nameServer: 20, text: 16 },
        type: { nameServer: ["bold", "underline"], text: ["italic"] },
        expectedRevision: 2,
      }),
    }).then((r) => r.json());
    assert.equal(styleRes.success, true);
    assert.equal(styleRes.data.style.icon, "⚡");
    assert.equal(styleRes.data.style.color, "15a85f");
    assert.equal(styleRes.data.style.size.nameServer, 20);

    // 4. POST /api/bots/child1/style/reset
    const resetRes = await fetch(`${base}/api/bots/child1/style/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 3 }),
    }).then((r) => r.json());
    assert.equal(resetRes.success, true);
    assert.equal(resetRes.data.style.icon, "🤖");
    assert.equal(resetRes.data.style.color, "db342e");

    // 5. GET /api/owners/owner_123/trial-status
    const trialRes = await fetch(`${base}/api/owners/owner_123/trial-status`).then((r) => r.json());
    assert.equal(trialRes.success, true);
    assert.equal(trialRes.data.eligible, true);
    assert.ok(trialRes.data.currentWeek);

    // 6. GET /api/bots/child1/showinfo
    const showRes = await fetch(`${base}/api/bots/child1/showinfo`).then((r) => r.json());
    assert.equal(showRes.success, true);
    assert.equal(showRes.data.botId, "child1");
    assert.equal(showRes.data.profile.nameServer, "Server Pro 1");
    assert.equal(showRes.data.trialStatus.eligible, true);

    // 7. GET /api/mybot/showinfo
    const showAllRes = await fetch(`${base}/api/mybot/showinfo`).then((r) => r.json());
    assert.equal(showAllRes.success, true);
    assert.ok(Array.isArray(showAllRes.data.bots));
  });
});
