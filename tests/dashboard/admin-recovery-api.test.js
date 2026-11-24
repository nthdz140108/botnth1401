import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { createAdminRecoveryChannel } from "../../src/runtime/admin-recovery-channel.js";
import { createAdminRecoveryService } from "../../src/dashboard/admin-recovery-service.js";
import { registerDashboardApi } from "../../src/dashboard/api-routes.js";

const BASE_NOW = Date.parse("2026-08-31T00:00:00.000Z");
const EXPIRES_AT = "2026-08-31T00:01:30.000Z";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "admin-recovery-api-"));
}

function buildApp(service) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers["x-test-role"] === "admin") {
      req.dashboardSession = { username: "admin", role: "admin", isAdmin: true };
    }
    next();
  });
  registerDashboardApi(app, { adminRecoveryService: service });
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function activeManifestPath(root) {
  return path.join(root, ".runtime", "admin-recovery", "active.json");
}

test("GET /api/system/admin-recovery rejects unauthenticated requests with 401", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: root, now: () => BASE_NOW, randomId: () => "session-a" });
  const service = createAdminRecoveryService({ projectRoot: root, channel, now: () => BASE_NOW });
  const server = await listen(buildApp(service));
  try {
    const res = await fetch(`${server.url}/api/system/admin-recovery`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error?.code, "AUTH_REQUIRED");
  } finally {
    await server.close();
  }
});

test("authenticated idle response returns state idle without qrImage", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: root, now: () => BASE_NOW, randomId: () => "session-a" });
  const service = createAdminRecoveryService({ projectRoot: root, channel, now: () => BASE_NOW });
  const server = await listen(buildApp(service));
  try {
    const res = await fetch(`${server.url}/api/system/admin-recovery`, { headers: { "x-test-role": "admin" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.state, "idle");
    assert.equal("qrImage" in body.data, false);
  } finally {
    await server.close();
  }
});

test("authenticated active response exposes sessionId, timestamps and base64 QR data URL", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: root, now: () => BASE_NOW, randomId: () => "session-a" });
  const service = createAdminRecoveryService({ projectRoot: root, channel, now: () => BASE_NOW });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 4321 });
  const server = await listen(buildApp(service));
  try {
    const res = await fetch(`${server.url}/api/system/admin-recovery`, { headers: { "x-test-role": "admin" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.state, "waiting_scan");
    assert.equal(body.data.sessionId, "session-a");
    assert.equal(body.data.createdAt, "2026-08-31T00:00:00.000Z");
    assert.equal(body.data.expiresAt, EXPIRES_AT);
    assert.ok(body.data.qrImage.startsWith("data:image/png;base64,"));
    const decoded = Buffer.from(body.data.qrImage.slice("data:image/png;base64,".length), "base64");
    assert.ok(decoded.equals(PNG));
  } finally {
    await server.close();
  }
});

test("admin recovery responses always send no-store and no-referrer headers", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: root, now: () => BASE_NOW, randomId: () => "session-a" });
  const service = createAdminRecoveryService({ projectRoot: root, channel, now: () => BASE_NOW });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  const server = await listen(buildApp(service));
  try {
    const res = await fetch(`${server.url}/api/system/admin-recovery`, { headers: { "x-test-role": "admin" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await server.close();
  }
});

test("expired manifest reports state expired without image", async () => {
  const root = await makeRoot();
  const laterNow = () => BASE_NOW + 120000;
  const channel = createAdminRecoveryChannel({ projectRoot: root, now: laterNow, randomId: () => "session-a" });
  const service = createAdminRecoveryService({ projectRoot: root, channel, now: laterNow });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  const server = await listen(buildApp(service));
  try {
    const res = await fetch(`${server.url}/api/system/admin-recovery`, { headers: { "x-test-role": "admin" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.state, "expired");
    assert.equal("qrImage" in body.data, false);
    assert.equal("sessionId" in body.data, false);
  } finally {
    await server.close();
  }
});

test("manifest whose qrFile escapes the recovery root is sanitized and the outside canary is never read", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: root, now: () => BASE_NOW, randomId: () => "session-a" });
  const service = createAdminRecoveryService({ projectRoot: root, channel, now: () => BASE_NOW });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });

  const canaryPath = path.join(root, "canary-secret.png");
  const canaryBytes = Buffer.from("CANARY-MUST-NOT-BE-READ");
  await fs.writeFile(canaryPath, canaryBytes);

  const escaped = {
    schemaVersion: 1,
    sessionId: "session-a",
    state: "waiting_scan",
    createdAt: "2026-08-31T00:00:00.000Z",
    expiresAt: EXPIRES_AT,
    qrFile: "../../canary-secret.png",
    ownerPid: 1,
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
  await fs.writeFile(activeManifestPath(root), `${JSON.stringify(escaped, null, 2)}\n`, "utf8");

  const server = await listen(buildApp(service));
  try {
    const res = await fetch(`${server.url}/api/system/admin-recovery`, { headers: { "x-test-role": "admin" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal("qrImage" in body.data, false);
    assert.equal(["starting", "waiting_scan", "waiting_confirm"].includes(body.data.state), false);
    assert.equal(JSON.stringify(body).includes("CANARY"), false);
    const untouched = await fs.readFile(canaryPath);
    assert.ok(untouched.equals(canaryBytes));
  } finally {
    await server.close();
  }
});
