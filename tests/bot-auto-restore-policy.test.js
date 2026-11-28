import test from "node:test";
import assert from "node:assert/strict";

/**
 * New restore policy: every valid, non-expired child bot is an auto-start
 * candidate regardless of its previous `status` (including `stopped`).
 * Invalid bots are fail-closed: disabled, rejected, deleted, expired,
 * cookieDead, trial pending/activating, missing credentials (cookie+imei) or
 * invalid webPort are excluded, with reasons.
 *
 * `identityPending` is NOT a reason to exclude a bot: a pending child must be
 * allowed to start so it can resolve its own admin identities in its own
 * session (the child-identity deadlock fix). It runs in restricted mode while
 * pending (self UID is the only Supreme Admin, fail-closed).
 */

async function loadPolicy() {
  return import("../src/commands/mybot/System/mybot-auto-restore.js");
}

const FUTURE = new Date(Date.now() + 86400_000).toISOString();
const PAST = new Date(Date.now() - 86400_000).toISOString();

function validBot(overrides = {}) {
  return {
    status: "stopped",
    desiredStatus: "running",
    webPort: "5001",
    expiryAt: FUTURE,
    enabled: true,
    credentials: { cookie: "c=1", imei: "imei-1" },
    ...overrides,
  };
}

test("manually stopped valid bot is excluded from reboot restoration", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = { "bot-stopped-valid": validBot({ desiredStatus: "stopped" }) };
  const candidates = getAutoRestoreCandidates(registry);
  assert.deepEqual(candidates.map((c) => c.uid), []);
});

test("permanently valid bot (expiryAt '-1') is a candidate", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-lifetime": validBot({ expiryAt: "-1" }),
    "bot-future": validBot({ webPort: "5002" }),
  };
  const candidates = getAutoRestoreCandidates(registry);
  assert.deepEqual(candidates.map((c) => c.uid).sort(), ["bot-future", "bot-lifetime"]);
});

test("admin is never a restore candidate", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const candidates = getAutoRestoreCandidates({
    admin: validBot({ status: "running", webPort: "2000" }),
  });
  assert.equal(candidates.length, 0);
});

test("disabled, rejected and deleted bots are excluded", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-disabled": validBot({ enabled: false }),
    "bot-status-disabled": validBot({ status: "disabled" }),
    "bot-rejected": validBot({ status: "rejected" }),
    "bot-deleted": validBot({ deleted: true }),
  };
  assert.equal(getAutoRestoreCandidates(registry).length, 0);
});

test("expired bots are excluded; malformed expiry is fail-closed", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-expired": validBot({ expiryAt: PAST }),
    "bot-malformed-expiry": validBot({ expiryAt: "not-a-date" }),
  };
  const candidates = getAutoRestoreCandidates(registry);
  assert.equal(candidates.length, 0);
});

test("cookieDead bots are excluded; identityPending bots ARE candidates", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-cookie-dead": validBot({ cookieDead: true }),
    "bot-identity-pending": validBot({ identityPending: true }),
    "bot-identity-pending-other": validBot({ identityPending: true, webPort: "5006" }),
  };
  // Pending children must be allowed to start so they can self-resolve identity.
  assert.deepEqual(
    getAutoRestoreCandidates(registry).map((c) => c.uid).sort(),
    ["bot-identity-pending", "bot-identity-pending-other"]
  );
});

test("trial pending/activating bots are excluded", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-trial-pending": validBot({ trialStatus: "pending" }),
    "bot-trial-activating": validBot({ trialStatus: "activating" }),
  };
  assert.equal(getAutoRestoreCandidates(registry).length, 0);
});

test("bots missing credentials or webPort are excluded", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-no-credentials": validBot({ credentials: null }),
    "bot-cookie-only": validBot({ credentials: { cookie: "c=1" } }),
    "bot-legacy-cookie-imei": validBot({ credentials: undefined, cookie: "c=1", imei: "imei-1" }),
    "bot-no-port": validBot({ webPort: "" }),
    "bot-bad-port": validBot({ webPort: "not-a-port" }),
    "bot-port-zero": validBot({ webPort: "0" }),
  };
  const candidates = getAutoRestoreCandidates(registry);
  assert.deepEqual(candidates.map((c) => c.uid), ["bot-legacy-cookie-imei"]);
});

test("skip reasons are collected per bot for diagnostics", async () => {
  const { explainAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-expired": validBot({ expiryAt: PAST }),
    "bot-ok": validBot({ webPort: "5002" }),
  };
  const report = explainAutoRestoreCandidates(registry);
  assert.equal(report.candidates.map((c) => c.uid).join(","), "bot-ok");
  assert.match(report.skipped["bot-expired"], /expired/i);
});

test("executeAutoRestore delegates occupied ports to launcher readiness verification", async () => {
  const { executeAutoRestore } = await loadPolicy();
  const launched = [];
  const report = await executeAutoRestore({
    registry: {
      "bot-online": validBot({ webPort: "5101" }),
      "bot-offline": validBot({ webPort: "5102" }),
    },
    launcherFn: async (uid) => { launched.push(uid); return { success: true }; },
    isPortInUseFn: async (port) => port === 5101,
  });
  assert.deepEqual(launched.sort(), ["bot-offline", "bot-online"]);
  assert.equal(report.attempted.length, 2);
  assert.equal(report.succeeded.length, 2);
  assert.equal(report.failed.length, 0);
});

test("one failing bot does not block the others", async () => {
  const { executeAutoRestore } = await loadPolicy();
  const launched = [];
  const report = await executeAutoRestore({
    registry: {
      "bot-a": validBot({ webPort: "5201" }),
      "bot-b": validBot({ webPort: "5202" }),
      "bot-c": validBot({ webPort: "5203" }),
    },
    launcherFn: async (uid) => {
      launched.push(uid);
      if (uid === "bot-b") return { success: false, reason: "pm2-start-failed" };
      return { success: true };
    },
    isPortInUseFn: async () => false,
  });
  assert.deepEqual(launched, ["bot-a", "bot-b", "bot-c"]);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].uid, "bot-b");
  assert.equal(report.succeeded.length, 2);
});
