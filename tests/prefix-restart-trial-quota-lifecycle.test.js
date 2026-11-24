import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { handlePrefixCommand } from "../src/commands/bot-manager/prefix.js";
import { getGlobalPrefix, setGlobalPrefix } from "../src/service-debug/service.js";
import {
  writeRestartRequest,
  readRestartRequest,
  consumeRestartRequest,
  markRestartRequestNotified,
} from "../src/utils/restart-request.js";
import {
  reserveCreationQuota,
  commitCreationQuota,
  releaseCreationQuota,
  acquireQrCreationLease,
  acquireCreationQuotaLease,
  checkOwnerCreationQuota,
} from "../src/commands/mybot/System/mybot-creation-quota.js";
import {
  reserveTrialActivation,
  claimOwnerTrial,
  releaseOwnerTrial,
  getOwnerTrialStatus,
  getBangkokCalendarWeek,
} from "../src/commands/mybot/System/mybot-trial-ledger.js";
import {
  activateBot,
  resolveOwnedActivationCandidates,
  resolveOwnerActiveSlot,
} from "../src/commands/mybot/System/mybot-activation-service.js";
import { openMyBotActiveSelection } from "../src/commands/mybot/System/mybot-active-selection.js";
import { checkReplySelectionsMapData } from "../src/service-debug/api-crawl/index.js";

async function setupIsolatedPrefixRoot() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pfx-test-"));
  const dataDir = path.join(tmpDir, "mybot", "instances", "admin", "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "command.json"), JSON.stringify({ prefix: "!", commands: [] }));
  return tmpDir;
}

test("prefix: bare 'prefix' (case-insensitive) outputs current prefix without admin permission", async () => {
  const origRoot = process.env.PROJECT_ROOT;
  const tmpDir = await setupIsolatedPrefixRoot();
  process.env.PROJECT_ROOT = tmpDir;
  setGlobalPrefix("!");

  try {
    const messagesSent = [];
    const fakeApi = {
      sendMessage: async (payload, threadId, type) => {
        messagesSent.push({ payload, threadId, type });
        return { msgId: "123" };
      },
    };

    const message = {
      threadId: "thread_123",
      type: 1,
      data: { content: "PrEfIx", uidFrom: "user_normal" },
    };

    const handled = await handlePrefixCommand(fakeApi, message, false);
    assert.equal(handled, true);
    assert.equal(messagesSent.length, 1);
    assert.match(messagesSent[0].payload.msg, /Prefix bây giờ của bot là: !/);
  } finally {
    setGlobalPrefix("!");
    if (origRoot) process.env.PROJECT_ROOT = origRoot;
    else delete process.env.PROJECT_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("prefix: changing prefix requires current prefix and adminLevelHighest", async () => {
  const origRoot = process.env.PROJECT_ROOT;
  const tmpDir = await setupIsolatedPrefixRoot();
  process.env.PROJECT_ROOT = tmpDir;
  setGlobalPrefix("!");

  try {
    const messagesSent = [];
    const fakeApi = {
      sendMessage: async (payload, threadId, type) => {
        messagesSent.push({ payload, threadId, type });
        return { msgId: "123" };
      },
    };

    // 1. Bare "prefix ?" without current prefix is rejected (returns false)
    const bareChangeMsg = {
      threadId: "thread_123",
      type: 1,
      data: { content: "prefix ?", uidFrom: "admin_uid" },
    };
    const handledBare = await handlePrefixCommand(fakeApi, bareChangeMsg, true);
    assert.equal(handledBare, false);

    // 2. "!prefix ?" without admin permission is denied with warning
    const nonAdminMsg = {
      threadId: "thread_123",
      type: 1,
      data: { content: "!prefix ?", uidFrom: "user_normal" },
    };
    const handledNonAdmin = await handlePrefixCommand(fakeApi, nonAdminMsg, false);
    assert.equal(handledNonAdmin, true);
    assert.match(messagesSent[messagesSent.length - 1].payload.msg, /Không có quyền thay đổi prefix/);

    // 3. "!prefix ?" with admin permission succeeds
    const adminMsg = {
      threadId: "thread_123",
      type: 1,
      data: { content: "!prefix ?", uidFrom: "admin_uid" },
    };
    const handledAdmin = await handlePrefixCommand(fakeApi, adminMsg, true);
    assert.equal(handledAdmin, true);
    assert.equal(getGlobalPrefix(), "?");
    assert.match(messagesSent[messagesSent.length - 1].payload.msg, /Prefix mới là: \?/);
  } finally {
    setGlobalPrefix("!");
    if (origRoot) process.env.PROJECT_ROOT = origRoot;
    else delete process.env.PROJECT_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("prefix: message send error does not throw or break update", async () => {
  const origRoot = process.env.PROJECT_ROOT;
  const tmpDir = await setupIsolatedPrefixRoot();
  process.env.PROJECT_ROOT = tmpDir;
  setGlobalPrefix("!");

  try {
    const fakeApiThrowing = {
      sendMessage: async () => {
        throw new Error("Network timeout sending message");
      },
    };

    const adminMsg = {
      threadId: "thread_123",
      type: 1,
      data: { content: "!prefix #", uidFrom: "admin_uid" },
    };

    // Should not throw, should update prefix successfully
    const handled = await handlePrefixCommand(fakeApiThrowing, adminMsg, true);
    assert.equal(handled, true);
    assert.equal(getGlobalPrefix(), "#");
  } finally {
    setGlobalPrefix("!");
    if (origRoot) process.env.PROJECT_ROOT = origRoot;
    else delete process.env.PROJECT_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("prefix: quote send failure falls back to unquoted delivery", async () => {
  const origRoot = process.env.PROJECT_ROOT;
  const tmpDir = await setupIsolatedPrefixRoot();
  process.env.PROJECT_ROOT = tmpDir;
  setGlobalPrefix("!");

  try {
    let quoteAttempted = false;
    let fallbackDelivered = false;

    const fakeApi = {
      sendMessage: async (payload, threadId, type) => {
        if (payload.quote) {
          quoteAttempted = true;
          throw new Error("Quote message expired or unavailable");
        }
        fallbackDelivered = true;
        return { msgId: "fallback_ok" };
      },
    };

    const msg = {
      threadId: "thread_123",
      type: 1,
      data: { content: "prefix", uidFrom: "user_1" },
    };

    const handled = await handlePrefixCommand(fakeApi, msg, false);
    assert.equal(handled, true);
    assert.equal(quoteAttempted, true);
    assert.equal(fallbackDelivered, true);
  } finally {
    setGlobalPrefix("!");
    if (origRoot) process.env.PROJECT_ROOT = origRoot;
    else delete process.env.PROJECT_ROOT;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("restart: child bot restart request lifecycle and single-flight consumption", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-rs-test-"));
  try {
    const childUid = "9988776655";
    const req = writeRestartRequest(childUid, { threadId: "g1", type: 1 }, tmpDir);
    assert.equal(req.status, "requested");

    const readReq = readRestartRequest(childUid, tmpDir);
    assert.equal(readReq.status, "requested");

    // First consume succeeds
    const consumed = consumeRestartRequest(childUid, tmpDir);
    assert.ok(consumed);
    assert.equal(consumed.status, "consumed");

    // Second consume returns null (idempotent, no double-relaunch)
    const consumedAgain = consumeRestartRequest(childUid, tmpDir);
    assert.equal(consumedAgain, null);

    // mark notified
    const notified = markRestartRequestNotified(childUid, tmpDir);
    assert.ok(notified.notifiedAt);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("creation quota: lease allows unlimited bots per owner sequentially, only blocks concurrent sessions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-quota-test-"));
  try {
    const ownerUid = "owner_12345";

    // 1. First lease
    const lease1 = acquireQrCreationLease(ownerUid, "req_1", { projectRoot: tmpDir });
    assert.equal(lease1.allowed, true);
    assert.equal(lease1.status, "reserved");

    // Concurrent second lease for same owner is blocked
    const lease2 = acquireQrCreationLease(ownerUid, "req_2", { projectRoot: tmpDir });
    assert.equal(lease2.allowed, false);

    // Release lease1
    const releaseRes = lease1.release();
    assert.equal(releaseRes.success, true);
    assert.equal(lease1.status, "released");

    // Immediate retry after release succeeds
    const lease3 = acquireQrCreationLease(ownerUid, "req_3", { projectRoot: tmpDir });
    assert.equal(lease3.allowed, true);

    // Commit lease3 (bot 1 created)
    const commitRes = lease3.commit("bot_1");
    assert.equal(commitRes.success, true);
    assert.equal(lease3.status, "committed");

    // Now owner creates bot 2 (unlimited bot creation!)
    const leaseBot2 = acquireQrCreationLease(ownerUid, "req_bot2", { projectRoot: tmpDir });
    assert.equal(leaseBot2.allowed, true, "Owner can create multiple bots without quota limits");
    leaseBot2.commit("bot_2");

    // Now owner creates bot 3
    const leaseBot3 = acquireQrCreationLease(ownerUid, "req_bot3", { projectRoot: tmpDir });
    assert.equal(leaseBot3.allowed, true, "Owner can create bot 3");
    leaseBot3.commit("bot_3");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("trial activation: only commits trial ledger after health-check passes, preserves quota on failure", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-trial-act-test-"));
  try {
    const botId = "child_bot_01";
    const ownerUid = "owner_777";

    // Setup bot file & credential & inventory
    const botsDir = path.join(tmpDir, "mybot", "bots");
    const credDir = path.join(tmpDir, "mybot", "credentials");
    const stateDir = path.join(tmpDir, "mybot", "state");
    await fs.mkdir(botsDir, { recursive: true });
    await fs.mkdir(credDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    await fs.writeFile(path.join(botsDir, `${botId}.json`), JSON.stringify({ name: botId, webPort: "5555" }), "utf8");
    await fs.writeFile(path.join(credDir, `${botId}.json`), JSON.stringify({ cookie: { zpw_sek: "abc" }, imei: "123" }), "utf8");
    await fs.writeFile(path.join(tmpDir, "mybot", "mybots.json"), JSON.stringify({
      [botId]: {
        key: botId,
        uid: botId,
        ownerUid,
        status: "stopped",
        trialStatus: "pending",
        webPort: "5555",
      },
    }), "utf8");

    // Mock PM2 adapter to prevent calling real pm2
    const mockPm2 = {
      start: async () => true,
      stop: async () => true,
      checkHealth: async () => ({ healthy: false, error: "Health check connection refused" }),
    };

    // 1. Activation fails health check -> trial quota must NOT be consumed
    const failedRes = await activateBot({
      botId,
      actorUid: ownerUid,
      root: tmpDir,
      pm2Adapter: mockPm2,
      checkHealth: true,
      healthProbe: async () => ({ healthy: false, error: "Health check connection refused" }),
    });

    assert.equal(failedRes.success, false);
    assert.equal(failedRes.code, "ACTIVATION_FAILED");

    // Verify trial status is still eligible
    const statusAfterFail = getOwnerTrialStatus(ownerUid, { root: tmpDir });
    assert.equal(statusAfterFail.eligible, true, "Owner must still have 1 trial remaining after failed activation");

    // 2. Activation succeeds -> trial ledger is committed and trialStartedAt is recorded
    const successPm2 = {
      start: async () => true,
      stop: async () => true,
      checkHealth: async () => ({ healthy: true }),
    };

    const successRes = await activateBot({
      botId,
      actorUid: ownerUid,
      root: tmpDir,
      pm2Adapter: successPm2,
      checkHealth: true,
      healthProbe: async () => ({ healthy: true }),
    });

    assert.equal(successRes.success, true);
    assert.equal(successRes.trialGranted, true);
    assert.ok(successRes.trialStartedAt);
    assert.ok(successRes.expiryAt);

    // Verify trial status is now exhausted for this week
    const statusAfterSuccess = getOwnerTrialStatus(ownerUid, { root: tmpDir });
    assert.equal(statusAfterSuccess.eligible, false, "Owner trial should be consumed after successful activation");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("multi-bot 1-active rule: rejects second bot activation while first bot is active", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-multi-active-"));
  try {
    const ownerUid = "owner_multi";
    const bot1 = "bot_active_1";
    const bot2 = "bot_active_2";

    const botsDir = path.join(tmpDir, "mybot", "bots");
    const credDir = path.join(tmpDir, "mybot", "credentials");
    const profilesDir = path.join(tmpDir, "mybot", "profiles");
    await fs.mkdir(botsDir, { recursive: true });
    await fs.mkdir(credDir, { recursive: true });
    await fs.mkdir(profilesDir, { recursive: true });

    await fs.writeFile(path.join(credDir, `${bot1}.json`), JSON.stringify({ cookie: { t: 1 } }));
    await fs.writeFile(path.join(credDir, `${bot2}.json`), JSON.stringify({ cookie: { t: 2 } }));

    await fs.writeFile(path.join(tmpDir, "mybot", "mybots.json"), JSON.stringify({
      [bot1]: { key: bot1, uid: bot1, ownerUid, status: "stopped", trialStatus: "pending", enabled: true },
      [bot2]: { key: bot2, uid: bot2, ownerUid, status: "stopped", trialStatus: "pending", enabled: true },
    }));

    const mockPm2 = {
      start: async () => true,
      stop: async () => true,
      checkHealth: async () => ({ healthy: true }),
    };

    // 1. Activate bot 1
    const res1 = await activateBot({
      botId: bot1,
      actorUid: ownerUid,
      root: tmpDir,
      pm2Adapter: mockPm2,
      healthProbe: async () => ({ healthy: true }),
    });
    assert.equal(res1.success, true);
    assert.equal(res1.trialGranted, true);

    // 2. By default (unlimited active bots), pending bot 2 in the same week only hits weekly free trial ledger,
    // while an explicit maxActiveBotsPerOwner: 1 enforces OWNER_ACTIVE_BOT_EXISTS
    const res2Default = await activateBot({
      botId: bot2,
      actorUid: ownerUid,
      root: tmpDir,
      pm2Adapter: mockPm2,
      healthProbe: async () => ({ healthy: true }),
    });
    assert.equal(res2Default.success, false);
    assert.equal(res2Default.code, "TRIAL_QUOTA_EXHAUSTED");

    const res2Capped = await activateBot({
      botId: bot2,
      actorUid: ownerUid,
      root: tmpDir,
      pm2Adapter: mockPm2,
      healthProbe: async () => ({ healthy: true }),
      maxActiveBotsPerOwner: 1,
    });
    assert.equal(res2Capped.success, false);
    assert.equal(res2Capped.code, "OWNER_ACTIVE_BOT_EXISTS");

    // 3. Activating bot 1 again (when stopped but unexpired) restarts it without consuming extra trial
    const inv = JSON.parse(await fs.readFile(path.join(tmpDir, "mybot", "mybots.json"), "utf8"));
    inv[bot1].status = "stopped";
    await fs.writeFile(path.join(tmpDir, "mybot", "mybots.json"), JSON.stringify(inv));

    const restartRes = await activateBot({
      botId: bot1,
      actorUid: ownerUid,
      root: tmpDir,
      pm2Adapter: mockPm2,
      healthProbe: async () => ({ healthy: true }),
    });
    assert.equal(restartRes.success, true);
    assert.equal(restartRes.trialGranted, false, "Restarting same unexpired bot should not consume new trial");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("candidates and active slot resolution isolate owner and ignore main/other bots", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-iso-test-"));
  try {
    const ownerA = "owner_A";
    const ownerB = "owner_B";

    const myBots = {
      admin: { key: "admin", uid: "admin", isMain: true, status: "running" },
      bot_A1: { key: "bot_A1", uid: "bot_A1", ownerUid: ownerA, name: "Bot A1", status: "stopped" },
      bot_A2: { key: "bot_A2", uid: "bot_A2", ownerUid: ownerA, name: "Bot A2", status: "running" },
      bot_B1: { key: "bot_B1", uid: "bot_B1", ownerUid: ownerB, name: "Bot B1", status: "stopped" },
    };

    const candidatesA = resolveOwnedActivationCandidates({
      ownerUid: ownerA,
      registry: myBots,
      projectRoot: tmpDir,
    });

    assert.equal(candidatesA.length, 2);
    assert.deepEqual(candidatesA.map((c) => c.key).sort(), ["bot_A1", "bot_A2"]);

    const slotA = resolveOwnerActiveSlot({
      ownerUid: ownerA,
      candidates: candidatesA,
      projectRoot: tmpDir,
    });
    assert.equal(slotA.occupied, true);
    assert.equal(slotA.activeBot.key, "bot_A2");

    const candidatesB = resolveOwnedActivationCandidates({
      ownerUid: ownerB,
      registry: myBots,
      projectRoot: tmpDir,
    });
    assert.equal(candidatesB.length, 1);
    assert.equal(candidatesB[0].key, "bot_B1");

    const slotB = resolveOwnerActiveSlot({
      ownerUid: ownerB,
      candidates: candidatesB,
      projectRoot: tmpDir,
    });
    assert.equal(slotB.occupied, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
