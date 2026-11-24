import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  readJsonFile,
  writeJsonAtomic,
  updateJsonAtomic,
} from "../src/commands/mybot/System/json-state.js";
import {
  readIdentityHandshake,
  writeIdentityHandshake,
} from "../src/commands/mybot/System/identity-handshake.js";
import {
  readReloadRequest,
  writeReloadRequest,
} from "../src/commands/mybot/System/reload-request.js";
import {
  requestCredentialReload,
  waitForIdentityHandshake,
} from "../src/commands/mybot/System/pm2-manager.js";
import {
  loadMyBotsRegistry,
  saveMyBotsRegistry,
} from "../src/commands/mybot/System/mybots-registry.js";
import { selectLoginIdentity } from "../src/commands/mybot/System/login-identity.js";

test("writeJsonAtomic writes formatted JSON and removes temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qr-state-"));
  const file = path.join(dir, "state.json");

  writeJsonAtomic(file, { status: "ready", uid: "123" });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    status: "ready",
    uid: "123",
  });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});

test("updateJsonAtomic updates existing JSON with fallback for missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qr-state-"));
  const file = path.join(dir, "state.json");

  const result = updateJsonAtomic(file, (current) => ({ count: current.count + 1 }), { count: 1 });

  assert.deepEqual(result, { count: 2 });
  assert.deepEqual(readJsonFile(file), { count: 2 });
});

test("identity handshake defaults status and timestamps", () => {
  const sessionId = `test-${Date.now()}`;

  const data = writeIdentityHandshake(sessionId, { status: "ready", uid: "777" });

  assert.equal(data.sessionId, sessionId);
  assert.equal(data.status, "ready");
  assert.equal(data.uid, "777");
  assert.match(data.updatedAt, /^\d{4}-/);
  assert.equal(readIdentityHandshake(sessionId).uid, "777");
});

test("reload request stores request metadata by uid", () => {
  const uid = `uid-${Date.now()}`;

  const data = writeReloadRequest(uid, {
    requestId: "r1",
    credentialPath: "assets/config.json",
  });

  assert.equal(data.uid, uid);
  assert.equal(data.status, "requested");
  assert.equal(readReloadRequest(uid).requestId, "r1");
});

test("waitForIdentityHandshake resolves when handshake becomes ready", async () => {
  const sessionId = `wait-${Date.now()}`;
  setTimeout(() => writeIdentityHandshake(sessionId, { status: "ready", uid: "abc" }), 20);

  const result = await waitForIdentityHandshake(sessionId, 500);

  assert.equal(result.status, "ready");
  assert.equal(result.uid, "abc");
});

test("requestCredentialReload writes requested state", async () => {
  const uid = `reload-${Date.now()}`;

  const result = await requestCredentialReload(uid, {
    credentialPath: "mybot/credentials/x.json",
  });

  assert.equal(result.status, "requested");
  assert.equal(result.uid, uid);
  assert.ok(result.requestId);
});

test("saveMyBotsRegistry writes to a provided registry path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  const file = path.join(dir, "mybots.json");

  saveMyBotsRegistry({ admin: { status: "running" } }, file);

  assert.deepEqual(loadMyBotsRegistry(file), { admin: { status: "running" } });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});

test("selectLoginIdentity never treats IMEI as UID", () => {
  const identity = selectLoginIdentity({
    sdkUid: "",
    userInfo: {
      data: {
        logged: true,
        info: {
          name: "Thanh Hung",
          avatar: "avatar.jpg",
        },
      },
    },
    resultData: {
      imei: "f8a3537b-756e-42dc-95f3-4421fcb6d66a-b78b4e2d6c0a362c418b145fe44ed73f",
    },
  });

  assert.equal(identity.uid, "");
  assert.equal(identity.displayName, "Thanh Hung");
});

test("selectLoginIdentity prefers SDK UID over QR session data", () => {
  const identity = selectLoginIdentity({
    sdkUid: "36636267278442919",
    resultData: {
      uid: "",
      imei: "f8a3537b-756e-42dc-95f3-4421fcb6d66a-b78b4e2d6c0a362c418b145fe44ed73f",
      name: "Thanh Hung",
    },
  });

  assert.equal(identity.uid, "36636267278442919");
  assert.equal(identity.displayName, "Thanh Hung");
});
