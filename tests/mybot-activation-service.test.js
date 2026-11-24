import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activateBot } from "../src/commands/mybot/System/mybot-activation-service.js";
import { updateProfile, getProfile } from "../src/commands/mybot/System/mybot-profile-service.js";
import { loadTrialLedger } from "../src/commands/mybot/System/mybot-trial-ledger.js";

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-act-test-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "profiles"), { recursive: true });

  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    bot1: { name: "bot1", displayName: "Bot 1", ownerUid: "owner-1", status: "stopped", enabled: true },
    botDisabled: { name: "botDisabled", ownerUid: "owner-1", status: "disabled", enabled: false },
    botRejected: { name: "botRejected", ownerUid: "owner-1", status: "rejected", enabled: true },
  }, null, 2));

  await fs.writeFile(path.join(root, "mybot", "credentials", "bot1.json"), JSON.stringify({
    cookie: { token: "token_123" },
    imei: "imei_123",
  }, null, 2));

  return root;
}

test("activateBot validates presence, status, and credentials", async () => {
  const root = await createFixture();

  // 1. Not found
  const notFound = await activateBot({ botId: "nonexistent", actorUid: "owner-1", root });
  assert.equal(notFound.success, false);
  assert.equal(notFound.code, "BOT_NOT_FOUND");

  // 2. Disabled
  const disabled = await activateBot({ botId: "botDisabled", actorUid: "owner-1", root });
  assert.equal(disabled.success, false);
  assert.equal(disabled.code, "BOT_DISABLED");

  // 3. Rejected
  const rejected = await activateBot({ botId: "botRejected", actorUid: "owner-1", root });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, "BOT_REJECTED");

  // 4. Forbidden
  const forbidden = await activateBot({ botId: "bot1", actorUid: "stranger", isSystemAdmin: false, root });
  assert.equal(forbidden.success, false);
  assert.equal(forbidden.code, "FORBIDDEN");
});

test("activateBot successfully claims trial and updates profile", async () => {
  const root = await createFixture();
  let pm2Started = false;
  const pm2Mock = {
    start: async () => { pm2Started = true; return true; },
    checkHealth: async () => ({ healthy: true }),
  };

  const res = await activateBot({
    botId: "bot1",
    actorUid: "owner-1",
    root,
    pm2Adapter: pm2Mock,
  });

  assert.equal(res.success, true);
  assert.equal(res.trialGranted, true);
  assert.equal(pm2Started, true);
  assert.ok(res.expiryAt);

  const profile = getProfile("bot1", { root });
  assert.equal(profile.trialStatus, "active");
  assert.equal(profile.expiryAt, res.expiryAt);

  // Second pending trial activation in same week -> TRIAL_QUOTA_EXHAUSTED (no active-bot count cap!)
  // Create another bot for same owner
  await fs.writeFile(path.join(root, "mybot", "credentials", "bot2.json"), JSON.stringify({ cookie: { t: 1 } }));
  const inv = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
  inv.bot2 = { name: "bot2", ownerUid: "owner-1", status: "stopped", enabled: true };
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(inv));

  const res2 = await activateBot({
    botId: "bot2",
    actorUid: "owner-1",
    root,
    pm2Adapter: pm2Mock,
  });

  assert.equal(res2.success, false);
  assert.equal(res2.code, "TRIAL_QUOTA_EXHAUSTED");

  // Once extended (permanent / unexpired), unlimited bots for the same owner can run concurrently
  for (let i = 2; i <= 8; i++) {
    const id = `bot${i}`;
    await fs.writeFile(path.join(root, "mybot", "credentials", `${id}.json`), JSON.stringify({ cookie: { t: i } }));
    inv[id] = { name: id, ownerUid: "owner-1", status: "stopped", enabled: true };
    updateProfile(id, { ownerUid: "owner-1", expiryAt: "-1", trialStatus: "active", enabled: true }, { root });
  }
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(inv));

  const concurrentResults = await Promise.all(
    Array.from({ length: 7 }, (_, idx) =>
      activateBot({
        botId: `bot${idx + 2}`,
        actorUid: "owner-1",
        root,
        pm2Adapter: pm2Mock,
      })
    )
  );
  for (const r of concurrentResults) {
    assert.equal(r.success, true);
    assert.equal(r.status, "running");
  }
});

test("activateBot rolls back trial when process start fails", async () => {
  const root = await createFixture();
  const pm2Mock = {
    start: async () => { throw new Error("Spawn error"); },
    stop: async () => true,
  };

  const res = await activateBot({
    botId: "bot1",
    actorUid: "owner-1",
    root,
    pm2Adapter: pm2Mock,
  });

  assert.equal(res.success, false);
  assert.equal(res.code, "ACTIVATION_FAILED");

  // Verify trial ledger was released
  const ledger = loadTrialLedger({ root });
  assert.equal(ledger.ledger["owner-1"], undefined);

  // Verify profile was reverted to pending
  const profile = getProfile("bot1", { root });
  assert.equal(profile.trialStatus, "pending");
});

test("activateBot supports launcherAdapter dependency injection and healthProbe failure rollback", async () => {
  const root = await createFixture();
  let launcherCalled = false;
  let processStopped = false;

  const launcherMock = {
    startBotWithLauncher: async (botId) => {
      launcherCalled = true;
      return { success: true, pid: 12345 };
    },
  };

  const pm2Mock = {
    stop: async () => { processStopped = true; },
  };

  // Health probe fails
  const res = await activateBot({
    botId: "bot1",
    actorUid: "owner-1",
    root,
    pm2Adapter: pm2Mock,
    launcherAdapter: launcherMock,
    checkHealth: true,
    healthProbe: async () => ({ healthy: false, error: "Connection timeout on port 4444" }),
  });

  assert.equal(res.success, false);
  assert.equal(res.code, "ACTIVATION_FAILED");
  assert.match(res.error, /Connection timeout/);
  assert.equal(launcherCalled, true);
  assert.equal(processStopped, true);

  // Verify trial ledger released
  const ledger = loadTrialLedger({ root });
  assert.equal(ledger.ledger["owner-1"], undefined);

  // Verify profile reverted
  const profile = getProfile("bot1", { root });
  assert.equal(profile.trialStatus, "pending");
});
