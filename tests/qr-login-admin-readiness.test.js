import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { probeBotReadiness } from '../src/runtime/runtime-readiness.js';

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

function liveReadiness(identityPatch = {}) {
  return {
    getProcess: async () => ({ name: 'admin', status: 'online', pid: 4242 }),
    probe: params => probeBotReadiness({ ...params,
      portProbe: async () => true,
      identityFetcher: async () => ({ kind: 'main', botKey: 'admin', pid: 4242, liveZaloUid: 'main-account', listenerConnected: true, ...identityPatch }),
    }),
  };
}

test('QR accepts a verified live Main when registry PID is null or obsolete', async () => {
  for (const pid of [null, '99999999']) {
    const result = await assertAdminReady({
      registry: { admin: { pid, uid: 'main-account', status: 'running', webPort: 2000 } },
      state: { cookieDead: false }, roleRegistry: { adminBotId: 'admin' },
      api: { isReady: () => true }, readiness: liveReadiness(),
      isProcessAlive: value => Number(value) === 4242,
    });
    assert.equal(result.ready, true);
    assert.equal(result.livePid, 4242);
  }
});

test('QR rejects wrong process, account or disconnected listener despite a live cached PID', async () => {
  for (const identity of [{ botKey: 'other' }, { pid: 9876 }, { liveZaloUid: 'other-account' }, { listenerConnected: false }]) {
    const result = await assertAdminReady({
      registry: { admin: { pid: String(process.pid), uid: 'main-account', status: 'running', webPort: 2000 } },
      state: {}, roleRegistry: { adminBotId: 'admin' }, api: { isReady: () => true },
      readiness: liveReadiness(identity), isProcessAlive: () => true,
    });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'api_not_ready');
  }
});

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
    readiness: liveReadiness(),
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
    readiness: liveReadiness(),
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
    readiness: liveReadiness(),
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
    readiness: liveReadiness(),
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
    readiness: liveReadiness(),
    sleep: async () => {},
    maxWaitMs: 1000,
    pollMs: 1,
  });

  assert.equal(result.ready, true);
});
