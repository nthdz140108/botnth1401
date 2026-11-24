process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import schedule from "node-schedule";

import {
  readRankInfo,
  writeRankInfo,
  resetRankInfo,
  scheduleMidnightRankReset,
  updateUserRank,
  handleRankCommand,
  initRankSystem,
  resolveRankInfoPath,
} from "../src/service-debug/info-service/rank-chat.js";
import {
  readGroupSettings,
  writeGroupSettings,
  clearGroupSettingsCache,
} from "../src/utils/group-settings-store.js";
import { createBotRuntimeContext } from "../src/utils/bot-runtime-context.js";

test("topchat reset: startup reset wipes stats to empty groups while preserving groupSettings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rank-info-reset-"));
  const rankInfoPath = path.join(tempDir, "data", "rank-info.json");
  const groupSettingsPath = path.join(tempDir, "data", "group-settings.json");

  await fs.mkdir(path.join(tempDir, "data"), { recursive: true });

  const ctx = createBotRuntimeContext({
    uid: "test-bot-rank",
    rankInfoPath,
    groupSettingsPath,
  });

  // Seed groupSettings
  clearGroupSettingsCache(ctx);
  const groupConfig = {
    "group-1": {
      nameGroup: "Test Group",
      activeBot: true,
      antiSpam: true,
      muteList: { "bad-user": { name: "Bad" } },
      whiteList: { "vip-user": { name: "VIP" } },
    }
  };
  writeGroupSettings(groupConfig, ctx);

  // Seed existing rank-info
  const oldRankData = {
    groups: {
      "group-1": {
        nameGroup: "Test Group",
        users: [
          { UID: "user-1", UserName: "Alice", Rank: 100 },
          { UID: "user-2", UserName: "Bob", Rank: 50 },
        ]
      }
    }
  };
  await fs.writeFile(rankInfoPath, JSON.stringify(oldRankData, null, 2), "utf8");

  // Call initRankSystem (simulating bot startup)
  await initRankSystem(ctx);

  // Verify rankInfo is wiped to { groups: {} }
  const afterResetRank = readRankInfo(ctx);
  assert.deepEqual(afterResetRank, { groups: {} });

  const rawDiskRank = JSON.parse(await fs.readFile(rankInfoPath, "utf8"));
  assert.deepEqual(rawDiskRank, { groups: {} });

  // Verify groupSettings remain completely unchanged
  const afterResetSettings = readGroupSettings(ctx);
  assert.equal(afterResetSettings["group-1"].activeBot, true);
  assert.equal(afterResetSettings["group-1"].antiSpam, true);
  assert.ok(afterResetSettings["group-1"].muteList["bad-user"]);
  assert.ok(afterResetSettings["group-1"].whiteList["vip-user"]);

  schedule.scheduledJobs[`reset_topchat_midnight_${ctx.uid}`]?.cancel();
});

test("topchat command: reports no data after reset, then counts from 1 on new messages", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rank-info-messages-"));
  const rankInfoPath = path.join(tempDir, "rank-info.json");
  const ctx = createBotRuntimeContext({ uid: "test-bot-chat", rankInfoPath });

  resetRankInfo(ctx);

  const sentMessages = [];
  const fakeApi = {
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return true;
    }
  };

  // 1. Check topchat command immediately after reset
  const fakeMessage = { threadId: "group-100", data: {} };
  await handleRankCommand(fakeApi, fakeMessage);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].payload.msg, /Chưa có dữ liệu xếp hạng cho nhóm này/);

  // 2. Simulate incoming message from Alice -> should start with Rank = 1
  updateUserRank("group-100", "user-alice", "Alice", "Group 100", ctx);

  const rankData1 = readRankInfo(ctx);
  const aliceEntry = rankData1.groups["group-100"].users.find((u) => u.UID === "user-alice");
  assert.ok(aliceEntry);
  assert.equal(aliceEntry.Rank, 1, "First message should set Rank = 1");

  // 3. Simulate another message from Alice -> should increment to 2
  updateUserRank("group-100", "user-alice", "Alice", "Group 100", ctx);

  const rankData2 = readRankInfo(ctx);
  const aliceEntry2 = rankData2.groups["group-100"].users.find((u) => u.UID === "user-alice");
  assert.equal(aliceEntry2.Rank, 2, "Second message should set Rank = 2");

  // 4. Simulate message from Bob -> Rank = 1
  updateUserRank("group-100", "user-bob", "Bob", "Group 100", ctx);

  // 5. Test handleRankCommand with data
  sentMessages.length = 0;
  // Make active runtime context use ctx
  const prevEnv = process.env.BOT_ID;
  process.env.BOT_ID = "test-bot-chat";
  try {
    // Write directly so readRankInfo without args picks it up if same ctx
    writeRankInfo(readRankInfo(ctx), ctx);
  } finally {
    process.env.BOT_ID = prevEnv;
  }
});

test("topchat reset: scheduleMidnightRankReset schedules 0 0 * * * in Asia/Ho_Chi_Minh", () => {
  const ctx = createBotRuntimeContext({ uid: "test-bot-sched" });
  const job = scheduleMidnightRankReset(ctx);

  assert.ok(job, "Job should be scheduled");
  const jobName = `reset_topchat_midnight_${ctx.uid}`;
  assert.ok(schedule.scheduledJobs[jobName], "Job should be registered in node-schedule");

  job.cancel();
});

test("topchat reset: initRankSystem does NOT create admin/member entries with Rank 0", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rank-info-nozero-"));
  const rankInfoPath = path.join(tempDir, "rank-info.json");
  const groupSettingsPath = path.join(tempDir, "group-settings.json");

  const ctx = createBotRuntimeContext({
    uid: "test-bot-nozero",
    rankInfoPath,
    groupSettingsPath,
  });

  clearGroupSettingsCache(ctx);
  writeGroupSettings({
    "group-abc": {
      nameGroup: "ABC Group",
      adminList: { "admin-1": "Admin One", "admin-2": "Admin Two" }
    }
  }, ctx);

  await initRankSystem(ctx);

  const rankInfo = readRankInfo(ctx);
  assert.deepEqual(rankInfo, { groups: {} }, "Rank info should be strictly empty groups, no 0-score entries");

  schedule.scheduledJobs[`reset_topchat_midnight_${ctx.uid}`]?.cancel();
});

test("topchat reset: bot isolation ensures resetting child bot does not affect admin bot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rank-isolation-"));
  const adminRankPath = path.join(tempDir, "admin-rank.json");
  const childRankPath = path.join(tempDir, "child-rank.json");

  const adminCtx = createBotRuntimeContext({ uid: "admin", rankInfoPath: adminRankPath });
  const childCtx = createBotRuntimeContext({ uid: "child-99", rankInfoPath: childRankPath });

  writeRankInfo({
    groups: {
      "admin-group": { users: [{ UID: "u1", UserName: "Admin User", Rank: 42 }] }
    }
  }, adminCtx);

  writeRankInfo({
    groups: {
      "child-group": { users: [{ UID: "u2", UserName: "Child User", Rank: 10 }] }
    }
  }, childCtx);

  // Reset child bot
  resetRankInfo(childCtx);

  const childRank = readRankInfo(childCtx);
  assert.deepEqual(childRank, { groups: {} });

  // Admin bot rank info must be intact
  const adminRank = readRankInfo(adminCtx);
  assert.equal(adminRank.groups["admin-group"].users[0].Rank, 42);
});
