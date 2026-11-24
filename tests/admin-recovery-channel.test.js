import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdminRecoveryChannel } from "../src/runtime/admin-recovery-channel.js";

const BASE_NOW = Date.parse("2026-08-31T00:00:00.000Z");
const EXPIRES_AT = "2026-08-31T00:01:30.000Z";
const PNG = Buffer.from("png-bytes");
const MANIFEST_FIELDS = [
  "createdAt",
  "expiresAt",
  "ownerPid",
  "qrFile",
  "schemaVersion",
  "sessionId",
  "state",
  "updatedAt",
].sort();

async function makeRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "admin-recovery-"));
}

function activePath(root) {
  return path.join(root, ".runtime", "admin-recovery", "active.json");
}

test("publishQr writes waiting_scan manifest and readQr returns copied bytes", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => "session-a",
  });
  const published = await channel.publishQr({
    imageBuffer: PNG,
    expiresAt: EXPIRES_AT,
    ownerPid: 1234,
  });
  assert.equal(published.sessionId, "session-a");
  assert.equal(published.state, "waiting_scan");
  assert.deepEqual(await channel.readQr("session-a"), Buffer.from("png-bytes"));
  assert.notEqual(await channel.readQr("session-a"), PNG);
});

test("readQr rejects path-like session ids outside the channel", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => "session-a",
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  assert.equal(await channel.readQr("../outside"), null);
  assert.equal(await channel.readQr("session-a/../../active.json"), null);
  assert.equal(await channel.readQr(""), null);
  assert.deepEqual(await channel.readQr("session-a"), Buffer.from("png-bytes"));
});

test("publishQr while active replaces session and removes prior image only after new manifest is durable", async () => {
  const root = await makeRoot();
  let call = 0;
  const ids = ["session-a", "session-b"];
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => ids[call++],
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  const second = await channel.publishQr({
    imageBuffer: Buffer.from("png-2"),
    expiresAt: EXPIRES_AT,
    ownerPid: 2,
  });
  assert.equal(second.sessionId, "session-b");
  const active = await channel.readActive();
  assert.equal(active.sessionId, "session-b");
  assert.equal(active.qrFile, "sessions/session-b/qr.png");
  assert.deepEqual(await channel.readQr("session-b"), Buffer.from("png-2"));
  assert.equal(await channel.readQr("session-a"), null);
  const sessionsDir = path.join(root, ".runtime", "admin-recovery", "sessions");
  assert.deepEqual(await fs.readdir(sessionsDir), ["session-b"]);
});

test("expired manifest is treated as inactive and its QR is not served", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => "session-a",
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  const later = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW + 120000,
    randomId: () => "session-x",
  });
  assert.equal(await later.readActive(), null);
  assert.equal(await later.readQr("session-a"), null);
});

test("transitions follow forward order, reject invalid ones, and terminal states clear artifacts", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => "session-a",
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });

  const next = await channel.transition("session-a", "waiting_confirm");
  assert.equal(next.state, "waiting_confirm");
  const persisted = JSON.parse(await fs.readFile(activePath(root), "utf8"));
  assert.equal(persisted.state, "waiting_confirm");
  assert.equal(persisted.updatedAt, next.updatedAt);
  assert.deepEqual(await channel.readQr("session-a"), Buffer.from("png-bytes"));

  assert.equal(await channel.transition("session-a", "waiting_scan"), null);
  const uncorrupted = JSON.parse(await fs.readFile(activePath(root), "utf8"));
  assert.equal(uncorrupted.state, "waiting_confirm");

  assert.equal(await channel.transition("session-a", "bogus-state"), null);

  const failed = await channel.transition("session-a", "failed");
  assert.equal(failed.state, "failed");
  assert.equal(await fs.access(activePath(root)).then(() => true, () => false), false);
  assert.equal(await channel.readQr("session-a"), null);

  assert.equal(await channel.transition("session-a", "success"), null);
});

test("terminal transition by a replaced session id cannot clear the newer active session", async () => {
  const root = await makeRoot();
  let call = 0;
  const ids = ["session-a", "session-b"];
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => ids[call++],
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  await channel.publishQr({
    imageBuffer: Buffer.from("png-2"),
    expiresAt: EXPIRES_AT,
    ownerPid: 2,
  });
  assert.equal(await channel.transition("session-a", "success"), null);
  const active = await channel.readActive();
  assert.equal(active.sessionId, "session-b");
  assert.deepEqual(await channel.readQr("session-b"), Buffer.from("png-2"));
});

test("cleanup is idempotent and an old sessionId cannot delete a newer active session", async () => {
  const root = await makeRoot();
  let call = 0;
  const ids = ["session-a", "session-b", "session-c"];
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => ids[call++],
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  await channel.cleanup("session-a", "cancelled");
  assert.equal(await channel.readActive(), null);
  await channel.cleanup("session-a", "cancelled");

  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1 });
  await channel.publishQr({
    imageBuffer: Buffer.from("png-2"),
    expiresAt: EXPIRES_AT,
    ownerPid: 2,
  });
  await channel.cleanup("session-a", "success");
  const active = await channel.readActive();
  assert.equal(active.sessionId, "session-c");
  assert.deepEqual(await channel.readQr("session-c"), Buffer.from("png-2"));
  assert.equal(await channel.cleanup("session-c", "waiting_scan"), null);
  assert.equal((await channel.readActive()).sessionId, "session-c");
});

test("serialized manifest contains only schema v1 fields and no sensitive strings", async () => {
  const root = await makeRoot();
  const channel = createAdminRecoveryChannel({
    projectRoot: root,
    now: () => BASE_NOW,
    randomId: () => "session-a",
  });
  await channel.publishQr({ imageBuffer: PNG, expiresAt: EXPIRES_AT, ownerPid: 1234 });
  const raw = await fs.readFile(activePath(root), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(Object.keys(parsed).sort(), MANIFEST_FIELDS);
  const lowered = raw.toLowerCase();
  for (const forbidden of ["cookie", "imei", "token", "credentials", "resultdata"]) {
    assert.ok(!lowered.includes(forbidden), `must not contain ${forbidden}`);
  }
});
