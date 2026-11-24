import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { startWebServer, closeWebServer } from "../src/web-service/web-server.js";
import { setRuntimeInstanceDescriptor, resolveLaunchDescriptor } from "../src/core/runtime-instance.js";

test("runtime bridge exposes allowlist of internal endpoints and returns 404 for non-internal routes", async () => {
  const descriptor = resolveLaunchDescriptor({
    kind: "child",
    botKey: "test_bridge_bot",
    configuredUid: "998877",
    webPort: 34567,
  });
  setRuntimeInstanceDescriptor(descriptor);

  await startWebServer({});

  try {
    const baseUrl = `http://127.0.0.1:34567`;

    // 1. GET /internal/runtime/identity -> 200 OK with descriptor identity
    const idRes = await fetch(`${baseUrl}/internal/runtime/identity`);
    assert.equal(idRes.status, 200);
    const idData = await idRes.json();
    assert.equal(idData.success, true);
    assert.equal(idData.kind, "child");
    assert.equal(idData.botKey, "test_bridge_bot");
    assert.equal(idData.configuredUid, "998877");

    // 2. GET /internal/runtime/health -> 200 OK
    const healthRes = await fetch(`${baseUrl}/internal/runtime/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.status, "healthy");
    assert.equal(healthData.botKey, "test_bridge_bot");

    // 3. GET / (Dashboard SPA / static) -> 404 NOT_FOUND
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 404);
    const rootData = await rootRes.json();
    assert.equal(rootData.success, false);
    assert.equal(rootData.error, "NOT_FOUND");

    // 4. GET /api/dashboard/overview -> 404 NOT_FOUND
    const apiRes = await fetch(`${baseUrl}/api/dashboard/overview`);
    assert.equal(apiRes.status, 404);

    // 5. POST /upload -> 404 NOT_FOUND
    const uploadRes = await fetch(`${baseUrl}/upload`, { method: "POST" });
    assert.equal(uploadRes.status, 404);
  } finally {
    await closeWebServer();
  }
});
