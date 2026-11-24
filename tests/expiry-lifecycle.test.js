import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---- Shared expiry classifier contract -----------------------------------

test("classifyBotExpiry maps pending/no-expiry correctly", async () => {
  const { classifyBotExpiry } = await import("../src/commands/mybot/System/expiry-classifier.js");
  assert.equal(classifyBotExpiry({ expiryAt: null, trialStatus: "pending" }), "pending");
  assert.equal(classifyBotExpiry({ expiryAt: null, trialStatus: "pending", now: Date.now() }), "pending");
  // trailing undefined expiry also treated as pending for a pending trial
  assert.equal(classifyBotExpiry({ expiryAt: undefined, trialStatus: "pending" }), "pending");
});

test("classifyBotExpiry maps active/permanent/expired/malformed", async () => {
  const { classifyBotExpiry } = await import("../src/commands/mybot/System/expiry-classifier.js");
  const now = 1700000000000;
  assert.equal(classifyBotExpiry({ expiryAt: new Date(now + 3600000).toISOString(), trialStatus: "active", now }), "active");
  assert.equal(classifyBotExpiry({ expiryAt: "-1", trialStatus: "active", now }), "permanent");
  assert.equal(classifyBotExpiry({ expiryAt: "-1", trialStatus: "pending", now }), "permanent");
  assert.equal(classifyBotExpiry({ expiryAt: new Date(now - 1000).toISOString(), trialStatus: "active", now }), "expired");
  assert.equal(classifyBotExpiry({ expiryAt: "not-a-date", trialStatus: "active", now }), "malformed");
  // active status but no expiry is inconsistent -> malformed, never expired
  assert.equal(classifyBotExpiry({ expiryAt: null, trialStatus: "active", now }), "malformed");
});

test("resolvePeriodicAction never turns pending into expired", async () => {
  const { resolvePeriodicAction } = await import("../src/commands/mybot/System/expiry-classifier.js");
  const now = 1700000000000;
  const action = resolvePeriodicAction({
    botInfo: { expiryAt: null, trialStatus: "pending", status: "stopped" },
    now,
  });
  assert.equal(action.action, "skip");
  assert.equal(action.shouldStopPM2, false);
});

test("resolvePeriodicAction flags expired only from a real past date", async () => {
  const { resolvePeriodicAction } = await import("../src/commands/mybot/System/expiry-classifier.js");
  const now = 1700000000000;
  const expired = resolvePeriodicAction({
    botInfo: { expiryAt: new Date(now - 1000).toISOString(), trialStatus: "active", status: "running" },
    now,
  });
  assert.equal(expired.action, "expire");
  assert.equal(expired.shouldStopPM2, true);

  // A malformed expiry must never auto-expire.
  const malformed = resolvePeriodicAction({
    botInfo: { expiryAt: "nonsense", trialStatus: "pending", status: "stopped" },
    now,
  });
  assert.notEqual(malformed.action, "expire");
});

test("shouldRecoverCorruptedExpiredRecord repairs only pending, expiry-less, ledger-unused records", async () => {
  const { shouldRecoverCorruptedExpiredRecord } = await import("../src/commands/mybot/System/expiry-classifier.js");

  // Corrupted: expired + pending + no expiry + no trialStartedAt + ledger unused -> recover
  assert.equal(
    shouldRecoverCorruptedExpiredRecord(
      { status: "expired", trialStatus: "pending", expiryAt: null, trialStartedAt: null },
      { ledgerUsed: false },
    ),
    true,
  );

  // Never recover when ledger used
  assert.equal(
    shouldRecoverCorruptedExpiredRecord(
      { status: "expired", trialStatus: "pending", expiryAt: null, trialStartedAt: null },
      { ledgerUsed: true },
    ),
    false,
  );

  // Never recover when trial was started
  assert.equal(
    shouldRecoverCorruptedExpiredRecord(
      { status: "expired", trialStatus: "active", expiryAt: null, trialStartedAt: "2026-01-01T00:00:00.000Z" },
      { ledgerUsed: false },
    ),
    false,
  );

  // Never recover when there IS an expiry (real expiry must be honored)
  assert.equal(
    shouldRecoverCorruptedExpiredRecord(
      { status: "expired", trialStatus: "active", expiryAt: "2020-01-01T00:00:00.000Z", trialStartedAt: "2019-01-01T00:00:00.000Z" },
      { ledgerUsed: false },
    ),
    false,
  );
});

// ---- Periodic sweep integration: pending bot must not be stopped/expired ----

test("initCheckTime leaves pending trial records untouched (no PM2 stop, no status flip)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-periodic-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      "bot-pending-1": {
        name: "bot-pending-1",
        status: "stopped",
        trialStatus: "pending",
        trialStartedAt: null,
        trialDurationMs: 3600000,
        expiryAt: null,
        webPort: "4444",
      },
    }),
  );

  let stopCalls = [];
  let killCalls = [];
  let statusWrites = [];

  // Import and re-run with injected side effects via a helper that the
  // implementation exposes: scanPendingTrialRecords()
  const { scanPendingTrialRecords } = await import("../src/commands/mybot/System/expiry-classifier.js");
  const actions = await scanPendingTrialRecords({
    root,
    now: 1700000000000,
    onStop: async (uid) => { stopCalls.push(uid); },
    onKill: async (uid) => { killCalls.push(uid); },
    onStatus: async (uid, status) => { statusWrites.push({ uid, status }); },
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "skip");
  assert.equal(stopCalls.length, 0, "must never stop PM2 for a pending trial");
  assert.equal(killCalls.length, 0, "must never kill a spawned process for a pending trial");
  assert.equal(statusWrites.length, 0, "must never flip pending status to expired");
});

// ---- Corrupted record recovery --------------------------------------------

test("recoverCorruptedPendingRecord repairs expired->stopped only when eligible", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-recover-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      "bot-corrupt-1": {
        name: "bot-corrupt-1",
        status: "expired",
        trialStatus: "pending",
        trialStartedAt: null,
        trialDurationMs: 3600000,
        expiryAt: null,
        webPort: "4444",
      },
    }),
  );

  const { recoverPendingTrialRecords } = await import("../src/commands/mybot/System/expiry-classifier.js");
  const recovered = await recoverPendingTrialRecords({ root, now: 1700000000000 });

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].uid, "bot-corrupt-1");
  assert.equal(recovered[0].recovered, true);

  const onDisk = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
  assert.equal(onDisk["bot-corrupt-1"].status, "stopped", "corrupted expired record must become stopped");
  assert.equal(onDisk["bot-corrupt-1"].trialStatus, "pending", "trial stays pending");
  assert.equal(onDisk["bot-corrupt-1"].expiryAt, null);
});

test("recoverPendingTrialRecords does not touch a record that already has trialStartedAt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-recover2-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      "bot-started-1": {
        name: "bot-started-1",
        status: "expired",
        trialStatus: "active",
        trialStartedAt: "2026-01-01T00:00:00.000Z",
        trialDurationMs: 3600000,
        expiryAt: "2026-01-01T01:00:00.000Z",
        webPort: "4444",
      },
    }),
  );

  const { recoverPendingTrialRecords } = await import("../src/commands/mybot/System/expiry-classifier.js");
  const recovered = await recoverPendingTrialRecords({ root, now: 1700000000000 });

  assert.equal(recovered.length, 0, "trial-started records must never be auto-recovered/re-granted");
  const onDisk = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
  assert.equal(onDisk["bot-started-1"].status, "expired");
});
