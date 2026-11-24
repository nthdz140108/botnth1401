import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activateBot } from "../src/commands/mybot/System/mybot-activation-service.js";
import { getProfile } from "../src/commands/mybot/System/mybot-profile-service.js";
import { loadTrialLedger } from "../src/commands/mybot/System/mybot-trial-ledger.js";

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-actready-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "profiles"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    botChild: { name: "botChild", displayName: "Hẹn", ownerUid: "owner-1", status: "stopped", enabled: true, webPort: "4444" },
  }, null, 2));
  await fs.writeFile(path.join(root, "mybot", "credentials", "botChild.json"), JSON.stringify({
    cookie: { token: "x" }, imei: "imei", uid: "owner-1",
  }, null, 2));
  return root;
}

test("activateBot commits trial ONLY after health readiness succeeds (ready time = trial start)", async () => {
  const root = await createRoot();
  let startCalled = false;
  const readyAtMs = 1700000100000;
  const pm2Mock = {
    start: async () => { startCalled = true; return true; },
    stop: async () => true,
    checkHealth: async () => ({ healthy: true }),
  };

  const res = await activateBot({
    botId: "botChild",
    actorUid: "owner-1",
    root,
    pm2Adapter: pm2Mock,
    healthProbe: async () => {
      // Readiness observed at readyAtMs. The recorded trial must start here.
      return { healthy: true, checkedAt: new Date(readyAtMs).toISOString() };
    },
  });

  assert.equal(res.success, true);
  assert.equal(res.trialGranted, true);
  assert.equal(res.trialStartedAt, new Date(readyAtMs).toISOString());
  assert.equal(new Date(res.expiryAt).getTime() - readyAtMs, 3600000, "expiry - startedAt must equal exactly 3600000 ms");
  assert.equal(res.status, "running");
  assert.equal(startCalled, true);

  // Trial fields live in the authoritative registry (mybots.json), not the
  // profile, so assert against the registry for exact start/expiry.
  const registry = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
  assert.equal(registry.botChild.trialStatus, "active");
  assert.equal(registry.botChild.status, "running");
  assert.equal(new Date(registry.botChild.expiryAt).getTime() - new Date(registry.botChild.trialStartedAt).getTime(), 3600000);

  const profile = getProfile("botChild", { root });
  assert.equal(profile.trialStatus, "active");
  assert.equal(new Date(profile.expiryAt).getTime() - new Date(res.trialStartedAt).getTime(), 3600000);
});

test("activateBot on failed health keeps expiryAt null and does not consume the trial", async () => {
  const root = await createRoot();
  let stopped = false;
  const pm2Mock = {
    start: async () => true,
    stop: async () => { stopped = true; return true; },
  };

  const res = await activateBot({
    botId: "botChild",
    actorUid: "owner-1",
    root,
    pm2Adapter: pm2Mock,
    checkHealth: true,
    healthProbe: async () => ({ healthy: false, error: "port never opened" }),
  });

  assert.equal(res.success, false);
  assert.equal(res.code, "ACTIVATION_FAILED");
  assert.equal(stopped, true, "failed process must be stopped");

  const ledger = loadTrialLedger({ root });
  assert.equal(ledger.ledger["owner-1"], undefined, "trial must not be consumed on failure");

  // Trial fields are authoritative in the registry.
  const registry = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
  assert.equal(registry.botChild.trialStatus, "pending");
  assert.equal(registry.botChild.trialStartedAt, null);
  assert.equal(registry.botChild.expiryAt, null, "expiryAt must stay null on failure");
});
