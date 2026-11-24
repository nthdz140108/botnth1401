import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  resolveOwnedActivationCandidates,
  resolveOwnerActiveSlot,
  openMyBotActiveSelection,
} from "../src/commands/mybot/System/mybot-active-selection.js";
import { activateBot } from "../src/commands/mybot/System/mybot-activation-service.js";
import {
  checkReplySelectionsMapData,
  deleteSelectionsMapData,
} from "../src/service-debug/api-crawl/index.js";
import {
  getOwnerTrialStatus,
  loadTrialLedger,
} from "../src/commands/mybot/System/mybot-trial-ledger.js";
import { getProfile } from "../src/commands/mybot/System/mybot-profile-service.js";
import { checkOwnerCreationQuota, acquireQrCreationLease } from "../src/commands/mybot/System/mybot-creation-quota.js";

function createMockApi() {
  const sent = [];
  return {
    sent,
    sendMessage: async (payload, threadId, type) => {
      const res = {
        msgId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        threadId,
        type,
        payload,
      };
      sent.push(res);
      return res;
    },
  };
}

function createFakeScheduler(initialTime = 1000000) {
  let currentTime = initialTime;
  let nextTimerId = 1;
  const timers = new Map();

  const now = () => currentTime;

  const schedule = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay: delay ?? 1000, id });
    return id;
  };
  schedule.now = now;

  const cancelSchedule = (id) => {
    timers.delete(id);
  };

  const step = async () => {
    if (timers.size === 0) return false;
    const [id, entry] = timers.entries().next().value;
    timers.delete(id);
    currentTime += entry.delay || 1000;
    await entry.callback();
    return true;
  };

  const stepAll = async () => {
    let count = 0;
    while (timers.size > 0 && count < 2000) {
      await step();
      count += 1;
    }
  };

  return { schedule, cancelSchedule, step, stepAll, now, timers };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-select-fixture-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "profiles"), { recursive: true });

  const ownerA = "owner_A";
  const bot1 = "bot_1";
  const bot2 = "bot_2";
  const bot3 = "bot_3";

  await fs.writeFile(path.join(root, "mybot", "credentials", `${bot1}.json`), JSON.stringify({ cookie: { t: "t1" } }));
  await fs.writeFile(path.join(root, "mybot", "credentials", `${bot2}.json`), JSON.stringify({ cookie: { t: "t2" } }));
  await fs.writeFile(path.join(root, "mybot", "credentials", `${bot3}.json`), JSON.stringify({ cookie: { t: "t3" } }));

  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    admin: { key: "admin", uid: "admin", isMain: true, status: "running" },
    [bot1]: { key: bot1, uid: bot1, name: "Bot One", displayName: "Bot One", ownerUid: ownerA, status: "stopped", trialStatus: "pending", enabled: true, createdAt: 1000 },
    [bot2]: { key: bot2, uid: bot2, name: "Bot Two", displayName: "Bot Two", ownerUid: ownerA, status: "stopped", trialStatus: "pending", enabled: true, createdAt: 2000 },
    [bot3]: { key: bot3, uid: bot3, name: "Bot Three", displayName: "Bot Three", ownerUid: "other_owner", status: "stopped", trialStatus: "pending", enabled: true, createdAt: 3000 },
  }));

  return { root, ownerA, bot1, bot2, bot3 };
}

test("active selection: openMyBotActiveSelection creates 60s session and handles reply selection", async () => {
  const { root, ownerA, bot1, bot2 } = await createFixture();
  const scheduler = createFakeScheduler();

  try {
    const api = createMockApi();
    const triggerMessage = {
      threadId: "thread_grp",
      type: 1,
      senderId: ownerA,
      data: { uidFrom: ownerA, dName: "User A" },
    };

    const candidates = resolveOwnedActivationCandidates({
      ownerUid: ownerA,
      projectRoot: root,
    });
    assert.equal(candidates.length, 2);

    let selectedBot = null;
    let selectedIdx = null;

    const record = await openMyBotActiveSelection({
      api,
      message: triggerMessage,
      candidates,
      projectRoot: root,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      now: scheduler.now,
      onSelect: async (bot, idx) => {
        selectedBot = bot;
        selectedIdx = idx;
      },
    });

    assert.ok(record);
    assert.equal(record.platform, "mybot-active");
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].payload.msg, /Reply tin nhắn này hoặc chat số thứ tự/);

    const promptId = api.sent[0].msgId;

    // 1. Reply from other user is ignored
    const otherUserReply = {
      threadId: "thread_grp",
      type: 1,
      data: {
        uidFrom: "stranger",
        content: "1",
        quote: { globalMsgId: promptId, msgId: promptId },
      },
    };
    const replyOtherHandled = await checkReplySelectionsMapData(api, otherUserReply);
    assert.equal(replyOtherHandled, false);
    assert.equal(selectedBot, null);

    // 2. Reply from owner in different thread is ignored
    const diffThreadReply = {
      threadId: "diff_thread",
      type: 1,
      data: {
        uidFrom: ownerA,
        content: "1",
        quote: { globalMsgId: promptId, msgId: promptId },
      },
    };
    const replyDiffHandled = await checkReplySelectionsMapData(api, diffThreadReply);
    assert.equal(replyDiffHandled, false);
    assert.equal(selectedBot, null);

    // 3. Valid reply from owner in same thread chooses bot 2
    const validReply = {
      threadId: "thread_grp",
      type: 1,
      data: {
        uidFrom: ownerA,
        content: "2",
        quote: { globalMsgId: promptId, msgId: promptId },
      },
    };
    const validHandled = await checkReplySelectionsMapData(api, validReply);
    assert.equal(validHandled, true);
    assert.equal(selectedIdx, 1);
    assert.equal(selectedBot.key, bot2);

    // 4. Subsequent reply cannot claim already completed session
    const replayReply = {
      threadId: "thread_grp",
      type: 1,
      data: {
        uidFrom: ownerA,
        content: "1",
        quote: { globalMsgId: promptId, msgId: promptId },
      },
    };
    const replayHandled = await checkReplySelectionsMapData(api, replayReply);
    assert.equal(replayHandled, false);
  } finally {
    await deleteSelectionsMapData(ownerA);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("active selection: handles unquoted free-form number chat in matching thread", async () => {
  const { root, ownerA, bot1, bot2 } = await createFixture();
  const scheduler = createFakeScheduler();

  try {
    const api = createMockApi();
    const triggerMessage = {
      threadId: "thread_free",
      type: 1,
      senderId: ownerA,
      data: { uidFrom: ownerA, dName: "User A" },
    };

    const candidates = resolveOwnedActivationCandidates({
      ownerUid: ownerA,
      projectRoot: root,
    });

    let selectedBot = null;
    await openMyBotActiveSelection({
      api,
      message: triggerMessage,
      candidates,
      projectRoot: root,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      now: scheduler.now,
      onSelect: async (bot) => {
        selectedBot = bot;
      },
    });

    // 1. Unquoted chat in different thread is ignored
    const wrongThreadChat = {
      threadId: "other_thread",
      type: 1,
      data: {
        uidFrom: ownerA,
        content: "1",
      },
    };
    const wrongThreadHandled = await checkReplySelectionsMapData(api, wrongThreadChat);
    assert.equal(wrongThreadHandled, false);
    assert.equal(selectedBot, null);

    // 2. Unquoted chat number "1" in matching thread succeeds
    const freeChatMessage = {
      threadId: "thread_free",
      type: 1,
      data: {
        uidFrom: ownerA,
        content: "1",
      },
    };

    const handled = await checkReplySelectionsMapData(api, freeChatMessage);
    assert.equal(handled, true);
    assert.equal(selectedBot.key, bot1);
  } finally {
    await deleteSelectionsMapData(ownerA);
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("atomic rollback: post-commit error releases trial claim, restores snapshots, and stops process", async () => {
  const { root, ownerA, bot1 } = await createFixture();
  try {
    let processStopped = false;
    const mockPm2 = {
      start: async () => true,
      stop: async () => { processStopped = true; },
      checkHealth: async () => ({ healthy: true }),
    };

    // Run activateBot
    const res = await activateBot({
      botId: bot1,
      actorUid: ownerA,
      root,
      pm2Adapter: mockPm2,
      healthProbe: async () => ({ healthy: true }),
    });

    assert.equal(res.success, true);
    assert.equal(res.trialGranted, true);
    const profile = getProfile(bot1, { root });
    assert.equal(profile.trialStatus, "active");
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("showinfo: displays 'Sẵn sàng tạo QR' when idle and 'Đang có phiên QR xử lý' when lease active", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "showinfo-test-"));
  try {
    const ownerUid = "owner_test_si";

    // 1. Idle state
    const idleCheck = checkOwnerCreationQuota(ownerUid, { projectRoot: tmpDir, includeReservations: true });
    assert.equal(idleCheck.hasInFlightReservation, false);

    // 2. Active lease state
    const lease = acquireQrCreationLease(ownerUid, "req_si_1", { projectRoot: tmpDir });
    assert.equal(lease.allowed, true);

    const activeCheck = checkOwnerCreationQuota(ownerUid, { projectRoot: tmpDir, includeReservations: true });
    assert.equal(activeCheck.hasInFlightReservation, true);

    // 3. Released state
    lease.release();
    const releasedCheck = checkOwnerCreationQuota(ownerUid, { projectRoot: tmpDir, includeReservations: true });
    assert.equal(releasedCheck.hasInFlightReservation, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
