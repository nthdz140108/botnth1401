import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createAuthGuardMiddleware, validateAuthToken, socketAuthMiddleware } from "../src/web-service/auth-guard.js";

async function makeServer() {
  const app = express();
  app.use(express.json());

  // Public route
  app.get("/api/system/health", (_req, res) => {
    res.json({ status: "healthy", ok: true });
  });

  // Protected mutation routes
  const auth = createAuthGuardMiddleware({ allowLoopbackWithoutToken: false });

  app.post("/upload", auth, (_req, res) => {
    res.json({ success: true, uploaded: true });
  });

  app.post("/shutdown", auth, (_req, res) => {
    res.json({ success: true, shutdown: true });
  });

  app.post("/api/config", auth, (_req, res) => {
    res.json({ success: true, saved: true });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(port, path, options = {}) {
  const { method = "GET", headers = {}, body = null } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode, raw: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("health endpoint is public and does not require token", async () => {
  const server = await makeServer();
  try {
    const res = await request(server.port, "/api/system/health");
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.status, "healthy");
  } finally {
    await server.close();
  }
});

test("mutation endpoints reject unauthenticated requests with 401", async () => {
  const server = await makeServer();
  try {
    const resUpload = await request(server.port, "/upload", { method: "POST" });
    assert.equal(resUpload.statusCode, 401);

    const resShutdown = await request(server.port, "/shutdown", { method: "POST" });
    assert.equal(resShutdown.statusCode, 401);

    const resConfig = await request(server.port, "/api/config", { method: "POST" });
    assert.equal(resConfig.statusCode, 401);
  } finally {
    await server.close();
  }
});

test("mutation endpoints reject invalid tokens with 403", async () => {
  const server = await makeServer();
  try {
    const res = await request(server.port, "/upload", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token-xyz" },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await server.close();
  }
});

test("mutation endpoints accept valid bearer token", async () => {
  const server = await makeServer();
  const validToken = process.env.BOT_WEB_AUTH_TOKEN || "bot-web-default-local-token";
  try {
    const res = await request(server.port, "/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.data.uploaded, true);
  } finally {
    await server.close();
  }
});

test("socketAuthMiddleware grants read-only on loopback without token and admin with valid token", () => {
  const validToken = process.env.BOT_WEB_AUTH_TOKEN || "bot-web-default-local-token";

  // Case 1: Loopback without token -> authenticated: true, isAdmin: false
  const socketLoopbackNoToken = {
    handshake: { address: "127.0.0.1", auth: {} },
    data: {},
  };
  let called1 = false;
  socketAuthMiddleware(socketLoopbackNoToken, (err) => {
    assert.equal(err, undefined);
    called1 = true;
  });
  assert.equal(called1, true);
  assert.equal(socketLoopbackNoToken.data.authenticated, true);
  assert.equal(socketLoopbackNoToken.data.isAdmin, false);

  // Case 2: Loopback with valid token -> authenticated: true, isAdmin: true
  const socketWithToken = {
    handshake: { address: "127.0.0.1", auth: { token: validToken } },
    data: {},
  };
  let called2 = false;
  socketAuthMiddleware(socketWithToken, (err) => {
    assert.equal(err, undefined);
    called2 = true;
  });
  assert.equal(called2, true);
  assert.equal(socketWithToken.data.isAdmin, true);

  // Case 3: External address without token -> rejected
  const socketExternalNoToken = {
    handshake: { address: "192.168.1.50", auth: {} },
    data: {},
  };
  socketAuthMiddleware(socketExternalNoToken, (err) => {
    assert.ok(err);
    assert.match(err.message, /Authentication failed/);
  });
});
