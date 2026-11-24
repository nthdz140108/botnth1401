import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { createDashboardGateway } from "../../src/dashboard/dashboard-gateway.js";

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("gateway proxies JSON method, body, status, and request id", async () => {
  const upstream = await listen(express().use(express.json()).post("/api/messages/send", (req, res) => {
    res.status(202).set("X-Request-ID", req.get("X-Request-ID")).json({ success: true, data: { body: req.body } });
  }));
  const app = express();
  app.use(createDashboardGateway({ upstreamUrl: upstream.url }).middleware);
  const dashboard = await listen(app);
  try {
    const response = await fetch(`${dashboard.url}/api/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-gateway" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("X-Request-ID"), "req-gateway");
    assert.deepEqual(await response.json(), { success: true, data: { body: { message: "hello" } } });
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test("gateway resolves BOT_WEB_URL from the primary bot registry when env vars are absent", async () => {
  const upstream = await listen(express().get("/api/messages/send", (_req, res) => {
    res.json({ success: true, data: { source: "registry-fallback" } });
  }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-gateway-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "role-registry.json"), JSON.stringify({ primaryBotId: "admin" }));
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    admin: { webHost: "127.0.0.1", webPort: Number(new URL(upstream.url).port) },
  }));
  const app = express();
  const gateway = createDashboardGateway({ root });
  app.use(gateway.middleware);
  const dashboard = await listen(app);
  try {
    assert.equal(gateway.getOfflineState().upstreamUrl, upstream.url);
    const response = await fetch(`${dashboard.url}/api/messages/send`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: { source: "registry-fallback" } });
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
    await new Promise((resolve) => upstream.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("gateway exposes backend unavailable for mutation and offline overview fallback", async () => {
  const app = express();
  app.get("/api/dashboard/overview", (_req, res) => res.json({ success: true, data: { bots: [{ id: "local" }] } }));
  app.use(createDashboardGateway({ upstreamUrl: "http://127.0.0.1:1", upstreamDisabled: true }).middleware);
  const dashboard = await listen(app);
  try {
    const overview = await fetch(`${dashboard.url}/api/dashboard/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).data.bots[0].id, "local");
    const mutation = await fetch(`${dashboard.url}/api/messages/send`, { method: "POST", headers: { "X-Request-ID": "req-offline" }, body: "{}" });
    assert.equal(mutation.status, 503);
    const body = await mutation.json();
    assert.equal(body.error.code, "BACKEND_UNAVAILABLE");
    assert.equal(body.requestId, "req-offline");
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
  }
});

test("socket relay forwards upstream telemetry to the browser only", () => {
  const dashboardIo = new EventEmitter();
  const browser = new FakeSocket();
  const upstream = new FakeSocket();
  createDashboardGateway({ upstreamUrl: "http://upstream", ioClientFactory: () => upstream }).attachSocketRelay(dashboardIo);
  dashboardIo.emit("connection", browser);
  upstream.receive("sendMessageAllResponse", { success: true });
  upstream.receive("dashboard:telemetry", { online: true });
  assert.deepEqual(upstream.sent, []);
  assert.deepEqual(browser.sent, [
    ["sendMessageAllResponse", { success: true }],
    ["dashboard:telemetry", { online: true }],
  ]);
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  emit(event, ...args) {
    if (event === "connection" || event === "connect") return super.emit(event, ...args);
    this.sent.push([event, ...args]);
    return true;
  }
  receive(event, ...args) { super.emit("__any__", event, ...args); return super.emit(event, ...args); }
  onAny(handler) { this.on("__any__", handler); }
}
