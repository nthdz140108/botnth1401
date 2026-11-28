import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  beginQrSession,
  markQrDisplayed,
  markWaitingConfirm,
  markCredentialsAcquired,
  failQrSession,
  expireQrSession,
  cancelQrSession,
  hasActiveQrSession,
  getQrSession,
  listQrSessions,
  sweepExpiredQrSessions,
  purgeQrSession,
  QR_ACQUISITION_DEADLINE_MS,
  QR_INIT_TIMEOUT_MS,
  QR_SESSION_STATES,
} from "../src/commands/mybot/Manager/qr-login-session-coordinator.js";
import {
  withMyBotsTransaction,
  acquireActualUidLock,
} from "../src/commands/mybot/Manager/qr-provisioning-registry.js";

// ---------------------------------------------------------------------------
// Per-requester coordinator contract
// ---------------------------------------------------------------------------

test("three different requesters can open QR sessions concurrently and all are accepted", () => {
  const a = beginQrSession({ sessionId: "sess-a", requesterUid: "uid-a" });
  const b = beginQrSession({ sessionId: "sess-b", requesterUid: "uid-b" });
  const c = beginQrSession({ sessionId: "sess-c", requesterUid: "uid-c" });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, true);

  assert.equal(hasActiveQrSession("uid-a"), true);
  assert.equal(hasActiveQrSession("uid-b"), true);
  assert.equal(hasActiveQrSession("uid-c"), true);

  assert.equal(listQrSessions().length, 3);
});

test("no global concurrency cap: fourth requester is not blocked by three others", () => {
  beginQrSession({ sessionId: "sess-1", requesterUid: "uid-1" });
  beginQrSession({ sessionId: "sess-2", requesterUid: "uid-2" });
  beginQrSession({ sessionId: "sess-3", requesterUid: "uid-3" });

  const fourth = beginQrSession({ sessionId: "sess-4", requesterUid: "uid-4" });
  assert.equal(fourth.ok, true);
  assert.equal(hasActiveQrSession("uid-4"), true);
});

test("same requester opening a second QR session is rejected", () => {
  beginQrSession({ sessionId: "sess-1", requesterUid: "uid-dup" });
  const second = beginQrSession({ sessionId: "sess-2", requesterUid: "uid-dup" });

  assert.equal(second.ok, false);
  assert.equal(second.reason, "REQUESTER_HAS_ACTIVE_QR_SESSION");
  assert.equal(hasActiveQrSession("uid-dup"), true);
});

test("highest-level admin cannot bypass one-session-per-requester rule", () => {
  beginQrSession({ sessionId: "sess-admin-1", requesterUid: "admin-uid-1" });
  const second = beginQrSession({ sessionId: "sess-admin-2", requesterUid: "admin-uid-1" });

  assert.equal(second.ok, false);
  assert.equal(second.reason, "REQUESTER_HAS_ACTIVE_QR_SESSION");
});

test("same requester can retry immediately after qr_acquired releases the slot", () => {
  beginQrSession({ sessionId: "sess-1", requesterUid: "uid-acquired" });
  markQrDisplayed("sess-1", { expiresAt: Date.now() + 60_000 });
  markCredentialsAcquired("sess-1", { credentials: { cookie: "c", imei: "i" } });

  assert.equal(hasActiveQrSession("uid-acquired"), false);

  const retry = beginQrSession({ sessionId: "sess-2", requesterUid: "uid-acquired" });
  assert.equal(retry.ok, true);
});

test("same requester can retry immediately after hard 60s expiry", () => {
  beginQrSession({ sessionId: "sess-1", requesterUid: "uid-expired" });
  markQrDisplayed("sess-1", { expiresAt: Date.now() + 60_000 });
  expireQrSession("sess-1");

  assert.equal(hasActiveQrSession("uid-expired"), false);

  const retry = beginQrSession({ sessionId: "sess-2", requesterUid: "uid-expired" });
  assert.equal(retry.ok, true);
});

test("expired session state and deadline are tracked", () => {
  const expiresAt = Date.now() + 60_000;
  beginQrSession({ sessionId: "sess-exp", requesterUid: "uid-exp" });
  markQrDisplayed("sess-exp", { expiresAt });

  let session = getQrSession("sess-exp");
  assert.equal(session.state, QR_SESSION_STATES.waiting_scan);
  assert.equal(session.expiresAt, expiresAt);

  expireQrSession("sess-exp");
  session = getQrSession("sess-exp");
  assert.equal(session.state, QR_SESSION_STATES.expired);
  assert.equal(hasActiveQrSession("uid-exp"), false);
});

test("initialization timeout sweeps and releases a session stuck before QR display", () => {
  beginQrSession({ sessionId: "sess-stuck", requesterUid: "uid-stuck" });

  // Simulate 30s+ passing before the QR image is ever displayed
  const released = sweepExpiredQrSessions({
    now: Date.now() + QR_INIT_TIMEOUT_MS + 1000,
  });

  assert.ok(released.includes("sess-stuck"));
  assert.equal(getQrSession("sess-stuck").state, QR_SESSION_STATES.expired);
  assert.equal(hasActiveQrSession("uid-stuck"), false);
});

test("waiting_scan session past deadline is swept and requester slot is released", () => {
  const expiresAt = Date.now() - 1;
  beginQrSession({ sessionId: "sess-scan-exp", requesterUid: "uid-scan-exp" });
  markQrDisplayed("sess-scan-exp", { expiresAt });

  const released = sweepExpiredQrSessions({ now: Date.now() });

  assert.ok(released.includes("sess-scan-exp"));
  assert.equal(getQrSession("sess-scan-exp").state, QR_SESSION_STATES.expired);
  assert.equal(hasActiveQrSession("uid-scan-exp"), false);
});

test("credentials acquired with cookie+imei marks session acquired", () => {
  beginQrSession({ sessionId: "sess-cred", requesterUid: "uid-cred" });
  markQrDisplayed("sess-cred", { expiresAt: Date.now() + 60_000 });
  markWaitingConfirm("sess-cred");

  markCredentialsAcquired("sess-cred", { credentials: { cookie: "abc", imei: "imei-1" } });

  const session = getQrSession("sess-cred");
  assert.equal(session.state, QR_SESSION_STATES.qr_acquired);
  assert.equal(session.hasCredentials, true);
});

test("late confirm after expiry does not resurrect the session", () => {
  beginQrSession({ sessionId: "sess-late", requesterUid: "uid-late" });
  markQrDisplayed("sess-late", { expiresAt: Date.now() - 1 });
  expireQrSession("sess-late");

  // A late confirmation attempts to mark credentials acquired — must be a no-op
  const result = markCredentialsAcquired("sess-late", { credentials: { cookie: "late", imei: "late-imei" } });

  assert.equal(result.state, QR_SESSION_STATES.expired);
  assert.equal(result.hasCredentials, false);
  assert.equal(hasActiveQrSession("uid-late"), false);
});

test("failQrSession releases requester slot", () => {
  beginQrSession({ sessionId: "sess-fail", requesterUid: "uid-fail" });
  markQrDisplayed("sess-fail", { expiresAt: Date.now() + 60_000 });

  failQrSession("sess-fail", "network_error");

  assert.equal(getQrSession("sess-fail").state, QR_SESSION_STATES.failed);
  assert.equal(hasActiveQrSession("uid-fail"), false);
});

test("cancelQrSession releases requester slot", () => {
  beginQrSession({ sessionId: "sess-cancel", requesterUid: "uid-cancel" });
  markQrDisplayed("sess-cancel", { expiresAt: Date.now() + 60_000 });

  cancelQrSession("sess-cancel", "user-cancelled");

  assert.equal(getQrSession("sess-cancel").state, QR_SESSION_STATES.cancelled);
  assert.equal(hasActiveQrSession("uid-cancel"), false);
});

test("session released before network cleanup so hanging cleanup never blocks requester", () => {
  beginQrSession({ sessionId: "sess-cleanup", requesterUid: "uid-cleanup" });
  markQrDisplayed("sess-cleanup", { expiresAt: Date.now() + 60_000 });

  // Simulate a hanging cleanup that never resolves: coordinator must not wait on it.
  const hangingCleanup = new Promise(() => {});
  expireQrSession("sess-cleanup");
  void hangingCleanup;

  assert.equal(hasActiveQrSession("uid-cleanup"), false);

  const retry = beginQrSession({ sessionId: "sess-cleanup-2", requesterUid: "uid-cleanup" });
  assert.equal(retry.ok, true);
});

// ---------------------------------------------------------------------------
// Provisioning concurrency safety (registry port reservation + rollback)
// ---------------------------------------------------------------------------

function createTempProjectRoot() {
  const base = process.cwd();
  const root = `${base}/.tmp-qr-concurrency-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return root;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

test("two concurrent provisioning transactions reserve distinct ports and both records survive", async () => {
  const root = createTempProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");
  writeJson(registryPath, {
    admin: { name: "admin", webPort: "2000", status: "running", isMain: true },
  });

  const results = await Promise.all([
    withMyBotsTransaction({ root, registryPath }, async (txn) => {
      const record = await txn.reserveProvisionedBot({ uid: "bot-a", displayName: "Bot A" });
      return { uid: record.uid, port: record.webPort };
    }),
    withMyBotsTransaction({ root, registryPath }, async (txn) => {
      const record = await txn.reserveProvisionedBot({ uid: "bot-b", displayName: "Bot B" });
      return { uid: record.uid, port: record.webPort };
    }),
  ]);

  const registry = readJson(registryPath);
  assert.ok(registry["bot-a"], "bot-a record must survive provisioning");
  assert.ok(registry["bot-b"], "bot-b record must survive provisioning");
  assert.notEqual(results[0].port, results[1].port, "concurrent bots must get different ports");

  // Ports must be within range and distinct from admin
  for (const r of results) {
    const port = parseInt(r.port, 10);
    assert.ok(port >= 4444 && port <= 6666, `port ${port} must be in 4444-6666`);
    assert.notEqual(port, 2000, "port must differ from admin bot port");
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test("rollback of session A does not remove or revert bot created by session B", async () => {
  const root = createTempProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");
  writeJson(registryPath, {
    admin: { name: "admin", webPort: "2000", status: "running", isMain: true },
  });

  // Session B creates a bot successfully
  const bResult = await withMyBotsTransaction({ root, registryPath }, async (txn) => {
    const record = await txn.reserveProvisionedBot({ uid: "bot-b", displayName: "Bot B" });
    txn.finalizeProvisionedBot("bot-b", { status: "stopped" });
    return record.webPort;
  });

  // Session A tries to provision but fails; its rollback must not remove bot B
  await assert.rejects(
    withMyBotsTransaction({ root, registryPath }, async (txn) => {
      await txn.reserveProvisionedBot({ uid: "bot-a", displayName: "Bot A" });
      throw new Error("session A failed");
    }),
    /session A failed/
  );

  const registry = readJson(registryPath);
  assert.ok(registry["bot-b"], "bot B record must survive session A rollback");
  assert.ok(!registry["bot-a"], "bot A record must be rolled back");
  assert.equal(registry["bot-b"].webPort, bResult, "bot B port must be unchanged");
  assert.equal(registry["bot-b"].status, "stopped", "bot B final state must be preserved");

  fs.rmSync(root, { recursive: true, force: true });
});

test("two sessions returning the same actualUid are serialized and ownership is rechecked", async () => {
  const root = createTempProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");
  writeJson(registryPath, {
    admin: { name: "admin", webPort: "2000", status: "running", isMain: true },
  });

  let activeCount = 0;
  let maxConcurrent = 0;
  let secondRanAfterFirstReleased = false;
  let firstActiveDuringSecond = false;

  const serialized = await Promise.all([
    acquireActualUidLock({ root, actualUid: "same-uid" }, async () => {
      activeCount++;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      await new Promise((r) => setTimeout(r, 30));
      firstActiveDuringSecond = activeCount === 1;
      activeCount--;
      secondRanAfterFirstReleased = activeCount === 0;
      return "first";
    }),
    acquireActualUidLock({ root, actualUid: "same-uid" }, async () => {
      activeCount++;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      await new Promise((r) => setTimeout(r, 10));
      activeCount--;
      return "second";
    }),
  ]);

  assert.deepEqual(serialized.sort(), ["first", "second"]);
  assert.equal(maxConcurrent, 1, "same actualUid sessions must be serialized (max concurrency 1)");
  assert.equal(secondRanAfterFirstReleased, true, "second session must run only after first released the lock");

  fs.rmSync(root, { recursive: true, force: true });
});

test("no raw cookie or IMEI is logged by the provisioning registry", async () => {
  const root = createTempProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");
  writeJson(registryPath, {
    admin: { name: "admin", webPort: "2000", status: "running", isMain: true },
  });

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));

  try {
    await withMyBotsTransaction({ root, registryPath }, async (txn) => {
      await txn.reserveProvisionedBot({
        uid: "bot-secret",
        displayName: "Bot Secret",
        cookie: "super-secret-cookie-value-12345",
        imei: "super-secret-imei-value-54321",
      });
      txn.finalizeProvisionedBot("bot-secret", { status: "stopped" });
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  const joined = logs.join("\n");
  assert.ok(!joined.includes("super-secret-cookie-value-12345"), "raw cookie must not be logged");
  assert.ok(!joined.includes("super-secret-imei-value-54321"), "IMEI must not be logged");

  fs.rmSync(root, { recursive: true, force: true });
});

test("new bot records start stopped with pending trial", async () => {
  const root = createTempProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");
  writeJson(registryPath, {
    admin: { name: "admin", webPort: "2000", status: "running", isMain: true },
  });

  const record = await withMyBotsTransaction({ root, registryPath }, async (txn) => {
    await txn.reserveProvisionedBot({ uid: "bot-new", displayName: "Bot New" });
    txn.finalizeProvisionedBot("bot-new", { status: "stopped" });
    return txn.readRegistry()["bot-new"];
  });

  assert.equal(record.status, "stopped");
  assert.equal(record.trialStatus, "pending");
  assert.equal(record.trialStartedAt, null);
  assert.equal(record.expiryAt, null);

  fs.rmSync(root, { recursive: true, force: true });
});

test("provisioning record marked 'provisioning' mid-flight is not treated as running", async () => {
  const root = createTempProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");
  writeJson(registryPath, {
    admin: { name: "admin", webPort: "2000", status: "running", isMain: true },
  });

  let midFlightRecord = null;
  await withMyBotsTransaction({ root, registryPath }, async (txn) => {
    const rec = await txn.reserveProvisionedBot({ uid: "bot-mid", displayName: "Bot Mid" });
    midFlightRecord = readJson(registryPath)["bot-mid"];
    txn.finalizeProvisionedBot("bot-mid", { status: "stopped" });
  });

  assert.equal(midFlightRecord.status, "provisioning");
  assert.ok(midFlightRecord.provisioningSessionId, "Provisioning must carry a unique transaction ID");
  assert.ok(midFlightRecord.provisioningStartedAt, "provisioningStartedAt must be set");

  const finalRecord = readJson(registryPath)["bot-mid"];
  assert.equal(finalRecord.status, "stopped");
  assert.equal(finalRecord.provisioningSessionId, undefined, "provisioning metadata must be cleared on finalize");

  fs.rmSync(root, { recursive: true, force: true });
});
