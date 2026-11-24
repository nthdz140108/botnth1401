import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { registerDashboardApi } from "../../src/dashboard/api-routes.js";
import { saveProfile } from "../../src/commands/mybot/System/mybot-profile-service.js";

async function startTestServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "showinfo-ownership-"));
  await fs.mkdir(path.join(root, "mybot", "instances"), { recursive: true });

  const registryData = {
    admin: { name: "admin", status: "running" },
    "bot-alice": { name: "Alice Bot", ownerUid: "alice-1", status: "running" },
    "bot-bob": { name: "Bob Bot", ownerUid: "bob-2", status: "running" },
  };
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(registryData));

  saveProfile("admin", { botId: "admin", ownerUid: "admin", nameServer: "Admin Server" }, { root });
  saveProfile("bot-alice", { botId: "bot-alice", ownerUid: "alice-1", nameServer: "Alice Server" }, { root });
  saveProfile("bot-bob", { botId: "bot-bob", ownerUid: "bob-2", nameServer: "Bob Server" }, { root });

  const app = express();
  app.use(express.json());

  // Test session mock middleware
  app.use((req, res, next) => {
    const testRole = req.headers["x-test-role"];
    const testOwner = req.headers["x-test-owner"];
    if (testRole === "admin") {
      req.dashboardSession = { username: "admin", role: "admin", isAdmin: true, ownerUid: "admin" };
    } else if (testRole === "user") {
      req.dashboardSession = { username: testOwner || "alice-1", role: "user", isAdmin: false, ownerUid: testOwner || "alice-1", uid: testOwner || "alice-1" };
    }
    next();
  });

  registerDashboardApi(app, { root });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  return {
    root,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("GET /api/mybot/showinfo rejects unauthenticated requests with 401 AUTH_REQUIRED", async () => {
  const fixture = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${fixture.port}/api/mybot/showinfo`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error?.code, "AUTH_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("GET /api/mybot/showinfo returns all bots for system admin session", async () => {
  const fixture = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${fixture.port}/api/mybot/showinfo`, {
      headers: { "x-test-role": "admin" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.bots.length, 3);
  } finally {
    await fixture.close();
  }
});

test("GET /api/mybot/showinfo filters bots by ownerUid for user session and prevents spoofing", async () => {
  const fixture = await startTestServer();
  try {
    // 1. Normal user alice sees only alice bot
    const res = await fetch(`http://127.0.0.1:${fixture.port}/api/mybot/showinfo`, {
      headers: { "x-test-role": "user", "x-test-owner": "alice-1" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.bots.length, 1);
    assert.equal(json.data.bots[0].botId, "bot-alice");
    assert.equal(json.data.bots[0].profile.nameServer, "Alice Server");

    // 2. User alice attempts to spoof query ?ownerUid=bob-2 -> ignored, still returns alice bot
    const spoofQueryRes = await fetch(`http://127.0.0.1:${fixture.port}/api/mybot/showinfo?ownerUid=bob-2`, {
      headers: { "x-test-role": "user", "x-test-owner": "alice-1" },
    });
    assert.equal(spoofQueryRes.status, 200);
    const spoofJson = await spoofQueryRes.json();
    assert.equal(spoofJson.data.bots.length, 1);
    assert.equal(spoofJson.data.bots[0].botId, "bot-alice");

    // 3. User alice attempts to spoof header x-owner-uid: bob-2 -> ignored, still returns alice bot
    const spoofHeaderRes = await fetch(`http://127.0.0.1:${fixture.port}/api/mybot/showinfo`, {
      headers: {
        "x-test-role": "user",
        "x-test-owner": "alice-1",
        "x-owner-uid": "bob-2",
      },
    });
    assert.equal(spoofHeaderRes.status, 200);
    const spoofHeaderJson = await spoofHeaderRes.json();
    assert.equal(spoofHeaderJson.data.bots.length, 1);
    assert.equal(spoofHeaderJson.data.bots[0].botId, "bot-alice");
  } finally {
    await fixture.close();
  }
});
