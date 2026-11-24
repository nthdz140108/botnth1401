import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

import {
  assertAdminReady,
  waitForAdminReady,
} from "../src/commands/mybot/Manager/qr-login-admin-readiness.js";

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "qr-admin-ready-"));
  mkdirSync(path.join(root, "mybot", "state"), { recursive: true });
  return root;
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

test("assertAdminReady rejects cookie-dead admin before QR session is created", async () => {
  const root = makeRoot();
  writeJson(path.join(root, "mybot", "mybots.json"), {
    admin: { status: "running", pid: String(process.pid), webPort: "2000" },
  });
  writeJson(path.join(root, "mybot", "state", "admin.json"), {
    cookieDead: true,
    cookieDeadReason: "cookie expired",
  });

  const result = await assertAdminReady({
    projectRoot: root,
    api: { isReady: () => true },
    isProcessAlive: () => true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "cookie_dead");
});

test("assertAdminReady rejects running registry when admin PID is gone", async () => {
  const root = makeRoot();
  writeJson(path.join(root, "mybot", "mybots.json"), {
    admin: { status: "running", pid: "99999999", webPort: "2000" },
  });
  writeJson(path.join(root, "mybot", "state", "admin.json"), {
    cookieDead: false,
  });

  const result = await assertAdminReady({
    projectRoot: root,
    api: { isReady: () => true },
    isProcessAlive: () => false,
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "process_stopped");
});

test("assertAdminReady accepts running admin with live process and ready API", async () => {
  const root = makeRoot();
  writeJson(path.join(root, "mybot", "mybots.json"), {
    admin: { status: "running", pid: String(process.pid), webPort: "2000" },
  });
  writeJson(path.join(root, "mybot", "state", "admin.json"), {
    cookieDead: false,
  });

  const result = await assertAdminReady({
    projectRoot: root,
    api: { isReady: () => true },
    isProcessAlive: () => true,
  });

  assert.equal(result.ready, true);
});

test("assertAdminReady accepts a stale stopped registry when admin is still live", async () => {
  const result = await assertAdminReady({
    registry: {
      admin: { status: "stopped", pid: String(process.pid), webPort: "2000" },
    },
    state: { cookieDead: false },
    api: { isReady: () => true },
    isProcessAlive: () => true,
  });

  assert.equal(result.ready, true);
  assert.equal(result.reason, "ready");
});

test("waitForAdminReady tolerates a transient restart state", async () => {
  const registryStates = [
    { admin: { status: "stopped", pid: String(process.pid) } },
    { admin: { status: "running", pid: String(process.pid) } },
  ];

  const result = await waitForAdminReady({
    api: { isReady: () => true },
    state: { cookieDead: false },
    loadRegistry: () => registryStates.shift() || { admin: { status: "running", pid: String(process.pid) } },
    isProcessAlive: () => true,
    sleep: async () => {},
    maxWaitMs: 1000,
    pollMs: 1,
  });

  assert.equal(result.ready, true);
});
