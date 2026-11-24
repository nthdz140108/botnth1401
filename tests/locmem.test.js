import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  LocmemStore,
  createLocmemStore,
  resolveLocmemDbPath,
  closeAllLocmemStores,
  PendingConfirmationManager,
  trackLocmemMessage,
  trackLocmemReaction,
  trackLocmemGroupAction,
  handleLocmemCommand,
  handleLocmemReaction as rawHandleLocmemReaction,
  runMonthlyCleanup,
  runDailyLocmemRetentionPrune,
  checkAndRunStartupCatchUp,
  getVietnamDateKey,
  getVietnamMonthKey,
  getRegisteredBotUids,
  shutdownLocmem,
  COVERAGE_STATUS,
  normalizeCoverageStatusCode,
  getConsecutiveCalendarDays,
} from "../src/service-debug/locmem/index.js";
import { MessageType } from "../src/api-zalo/models/Message.js";
import { commandRegistry } from "../src/commands/command-registry.js";
import { COMMAND_PERMISSION_POLICY } from "../src/commands/command-permission-policy.js";
import { HIGH_RISK_COMMANDS } from "../src/commands/high-risk-policy.js";
import { ADMIN_ONLY_MASS_COMMANDS } from "../src/commands/command-policy-loader.js";

// Reaction fixtures must have thirty real stored days rather than a one-day pending stub.
async function handleLocmemReaction(api, reaction, context = {}) {
  const manager = context.pendingManager;
  const group = reaction.threadId || reaction.data?.idTo;
  const pending = manager?.getPending(group);
  let temp;
  let store = context.storeOverride || context.store;
  if (pending) {
    if (!store) {
      temp = createTempDir();
      store = new LocmemStore({ dbPath: path.join(temp, 'reaction') });
    }
    const today = context.todayKey || getVietnamDateKey();
    const days = getConsecutiveCalendarDays(today, 30);
    for (const day of days) {
      store.recordSnapshot(group, pending.candidates, day);
      store.recordDailyCoverageSnapshot(group, day, true);
    }
    store.finalizeTrackedDays(today);
    pending.dateRange.days = days;
    context = { ...context, storeOverride: store };
  }
  try { return await rawHandleLocmemReaction(api, reaction, context); }
  finally { if (temp) { store.close(); fs.rmSync(temp, { recursive: true, force: true }); } }
}

// Helper to make a clean temporary directory
function createTempDir(prefix = "locmem-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("LocmemStore: pure-JS daily JSON partitions contain only counters and metadata, zero message content or PII", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "test-locmem");
  const store = new LocmemStore({ dbPath, botUid: "bot_audit" });

  t.after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  store.markCoverage("group_audit", "2026-10-01", { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
  store.saveMemberSnapshot("group_audit", ["uid_1", "uid_2"], "2026-10-01");
  store.recordActivity({
    groupId: "group_audit",
    memberId: "uid_1",
    dateKey: "2026-10-01",
    messageCount: 3,
    reactionCount: 1,
    groupActionCount: 0,
  });
  store.flushPendingActivities();

  assert.equal(fs.existsSync(store.metaPath), true);
  const partitionPath = path.join(store.storeDir, "2026-10-01.json");
  assert.equal(fs.existsSync(partitionPath), true);

  const partition = JSON.parse(fs.readFileSync(partitionPath, "utf8"));
  assert.deepEqual(Object.keys(partition).sort(), ["activities", "coverage", "dateKey", "snapshots"]);
  assert.deepEqual(partition.activities.group_audit.uid_1, [3, 1, 0]);

  const serialized = JSON.stringify(partition);
  const forbiddenKeywords = ["content", "text", "body", "avatar", "payload", "media", "attachment", "image"];
  for (const forbidden of forbiddenKeywords) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `Partition JSON contains forbidden PII/content term: ${forbidden}`);
  }
});

test("LocmemStore: multiple bot instances are completely isolated by SQLite file", async (t) => {
  const tmpDir = createTempDir();
  const dbPath1 = path.join(tmpDir, "bot1.sqlite");
  const dbPath2 = path.join(tmpDir, "bot2.sqlite");

  const store1 = new LocmemStore({ dbPath: dbPath1, botUid: "bot_1" });
  const store2 = new LocmemStore({ dbPath: dbPath2, botUid: "bot_2" });

  t.after(() => {
    store1.close();
    store2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  store1.recordActivity({
    groupId: "group_1",
    memberId: "user_a",
    dateKey: "2026-10-01",
    messageCount: 5,
  });

  const countInStore1 = store1.getMemberActivity("group_1", "user_a", "2026-10-01");
  const countInStore2 = store2.getMemberActivity("group_1", "user_a", "2026-10-01");

  assert.equal(countInStore1.messageCount, 5);
  assert.equal(countInStore2, null, "Bot 2 must not see Bot 1 data");
});

test("LocmemStore: concurrent writes increment counters atomically without data loss", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "concurrent.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_concurrent" });

  t.after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const iterations = 50;
  for (let i = 0; i < iterations; i++) {
    store.recordActivity({
      groupId: "group_conc",
      memberId: "user_conc",
      dateKey: "2026-10-01",
      messageCount: 1,
      reactionCount: 2,
      groupActionCount: 3,
    });
  }

  const result = store.getMemberActivity("group_conc", "user_conc", "2026-10-01");
  assert.equal(result.messageCount, iterations);
  assert.equal(result.reactionCount, iterations * 2);
  assert.equal(result.groupActionCount, iterations * 3);
});

test("LocmemStore: persistence across reopen", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "persist.sqlite");
  
  let store = new LocmemStore({ dbPath, botUid: "bot_persist" });
  store.recordActivity({
    groupId: "group_p",
    memberId: "user_p",
    dateKey: "2026-10-01",
    messageCount: 10,
  });
  store.close();

  // Reopen
  store = new LocmemStore({ dbPath, botUid: "bot_persist" });
  const act = store.getMemberActivity("group_p", "user_p", "2026-10-01");
  assert.equal(act.messageCount, 10);
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("LocmemStore: 7-day criteria fail-closed evaluation", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "failclosed.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_eval" });

  t.after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const groupId = "g_eval";
  const members = ["user_inactive", "user_active_today", "user_new", "user_active_past"];
  const dates = [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
  ];
  const todayKey = "2026-10-08";

  // Scenario A: Only 6 complete days exist -> FAIL-CLOSED (0 candidates)
  for (let i = 0; i < 6; i++) {
    const d = dates[i];
    store.markCoverage(groupId, d, { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
    store.saveMemberSnapshot(groupId, ["user_inactive", "user_active_today"], d);
  }

  const completeDays6 = store.getCompleteDays(groupId, todayKey, 7);
  assert.equal(completeDays6.length, 6);
  let candidates6 = store.getInactiveCandidates({
    groupId,
    completeDays: completeDays6,
    todayDateKey: todayKey,
  });
  assert.equal(candidates6.length, 0, "Must return 0 candidates when < 7 complete days");

  // Add the 7th day, but with downtime (isComplete = false) -> STILL FAIL-CLOSED
  store.markCoverage(groupId, dates[6], { isComplete: false, coverageStatus: "downtime", downtimeReason: "ws_error" });
  const completeDaysWithDowntime = store.getCompleteDays(groupId, todayKey, 7);
  assert.equal(completeDaysWithDowntime.length, 6, "Incomplete day must not be in completeDays");
  const candidatesDowntime = store.getInactiveCandidates({
    groupId,
    completeDays: completeDaysWithDowntime,
    todayDateKey: todayKey,
  });
  assert.equal(candidatesDowntime.length, 0);

  // Now fix 7th day to complete
  store.markCoverage(groupId, dates[6], { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
  // Add snapshots for all 7 days for user_inactive, user_active_today, user_active_past
  for (const d of dates) {
    store.saveMemberSnapshot(groupId, ["user_inactive", "user_active_today", "user_active_past"], d);
  }
  // user_new is only in the last 3 days snapshots
  for (let i = 4; i < 7; i++) {
    store.saveMemberSnapshot(groupId, ["user_new"], dates[i]);
  }

  // user_active_past sent a message on day 3
  store.recordActivity({
    groupId,
    memberId: "user_active_past",
    dateKey: dates[2],
    messageCount: 1,
  });

  // user_active_today sent a message today
  store.recordActivity({
    groupId,
    memberId: "user_active_today",
    dateKey: todayKey,
    reactionCount: 1,
  });

  // Re-evaluate with 7 complete days
  const completeDays7 = store.getCompleteDays(groupId, todayKey, 7);
  assert.equal(completeDays7.length, 7);
  const candidates7 = store.getInactiveCandidates({
    groupId,
    completeDays: completeDays7,
    todayDateKey: todayKey,
  });

  // user_inactive: 7 snapshots, 0 past activity, 0 today activity -> CANDIDATE
  // user_active_today: 0 past activity, but 1 reaction today -> PROTECTED (NOT candidate)
  // user_new: missing from first 4 snapshots -> PROTECTED (NOT candidate)
  // user_active_past: 1 message on day 3 -> PROTECTED (NOT candidate)
  assert.deepEqual(candidates7, ["user_inactive"]);
});

test("LocmemTracker: event filtering (messages, reactions, group actions)", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "tracker.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_track" });

  t.after(() => {
    closeAllLocmemStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const runtimeCtx = {
    locmemDbPath: dbPath,
    botKey: "bot_track",
    liveZaloUid: "bot_track_uid",
  };
  const todayKey = getVietnamDateKey();

  // 1. Direct message ignored
  trackLocmemMessage({}, {
    type: MessageType.DirectMessage,
    threadId: "user_dm",
    data: { uidFrom: "user_dm" },
  }, runtimeCtx);
  assert.equal(store.getMemberActivity("user_dm", "user_dm", todayKey), null);

  // 2. Self group message ignored
  trackLocmemMessage({}, {
    type: MessageType.GroupMessage,
    threadId: "group_100",
    isSelf: true,
    data: { uidFrom: "bot_track_uid" },
  }, runtimeCtx);
  assert.equal(store.getMemberActivity("group_100", "bot_track_uid", todayKey), null);

  // 3. Valid group message counted directly into database by production tracker hook
  trackLocmemMessage({}, {
    type: MessageType.GroupMessage,
    threadId: "group_100",
    data: { uidFrom: "member_1" },
  }, runtimeCtx);

  const actMsg = store.getMemberActivity("group_100", "member_1", todayKey);
  assert.ok(actMsg, "Member activity record must exist after message");
  assert.equal(actMsg.messageCount, 1, "Must record exactly 1 message");
  assert.equal(actMsg.reactionCount, 0);
  assert.equal(actMsg.groupActionCount, 0);

  // 4. Reaction: ignore rType <= 0 (un-reaction)
  trackLocmemReaction({}, {
    isGroup: true,
    threadId: "group_100",
    data: { uidFrom: "member_2", content: { rType: -1 } },
  }, runtimeCtx);
  assert.equal(store.getMemberActivity("group_100", "member_2", todayKey), null);

  // Valid reaction counted directly into database
  trackLocmemReaction({}, {
    isGroup: true,
    threadId: "group_100",
    data: { uidFrom: "member_1", content: { rType: 5 } },
  }, runtimeCtx);
  const actReact = store.getMemberActivity("group_100", "member_1", todayKey);
  assert.equal(actReact.reactionCount, 1, "Must record exactly 1 reaction");

  // 5. Group action: valid vote/poll via UPDATE_BOARD.sourceId
  trackLocmemGroupAction({}, {
    threadId: "group_100",
    data: { sourceId: "member_1" },
  }, runtimeCtx);
  const actAction = store.getMemberActivity("group_100", "member_1", todayKey);
  assert.equal(actAction.groupActionCount, 1, "Must record exactly 1 group action");
});

test("LocmemService: pending manager handles 120s expiry and single request per group", async () => {
  const manager = new PendingConfirmationManager(500); // 500ms for test
  const req = manager.createRequest({
    groupId: "g_pending",
    requestedBy: "admin_1",
    candidateUids: ["cand_1", "cand_2"],
    candidateNames: new Map([["cand_1", "Alice"], ["cand_2", "Bob"]]),
    qualifiedDays: ["2026-10-01", "2026-10-02"],
    previewMsgIds: ["prev_1"],
    serverMsgId: "msg_confirm_1",
  });

  assert.ok(req);
  assert.equal(manager.hasPending("g_pending"), true);

  // Creating a second request while first is active fails
  const dup = manager.createRequest({
    groupId: "g_pending",
    requestedBy: "admin_2",
  });
  assert.equal(dup, null, "Must reject second concurrent request");

  // Atomic take
  const taken = manager.takeRequest("g_pending", "msg_confirm_1");
  assert.equal(taken?.groupId, "g_pending");
  assert.equal(manager.hasPending("g_pending"), false);

  // Second take returns null (double-heart prevention)
  const doubleTake = manager.takeRequest("g_pending", "msg_confirm_1");
  assert.equal(doubleTake, null, "Double take must return null");
});

test("LocmemService: handleLocmemReaction only accepts HEART (rType=5) from adminLevelHigh on confirmation msg", async () => {
  const manager = new PendingConfirmationManager(60000);
  manager.createRequest({
    groupId: "g_react",
    requestedBy: "admin_high",
    candidateUids: ["cand_1"],
    candidateNames: new Map([["cand_1", "Alice"]]),
    qualifiedDays: ["2026-10-01"],
    previewMsgIds: ["prev_1"],
    serverMsgId: "msg_valid_confirm",
  });

  const kickedMembers = [];
  const sentMessages = [];
  const mockApi = {
    removeUserFromGroup: async (groupId, uids) => {
      kickedMembers.push(...uids);
      return { status: 0, errorMembers: [] };
    },
    sendMessage: async (msg, threadId) => {
      sentMessages.push({ msg, threadId });
      return { msgId: "result_msg" };
    },
    getGroupInfo: async (threadId = "g_react") => ({
      gridInfoMap: {
        [threadId]: {
          name: "Group React",
          creatorId: "creator_id",
          adminIds: ["admin_box"],
          memVerList: ["cand_1_0"],
        },
      },
    }),
  };

  // 1. Non-heart reaction (e.g. LIKE rType = 1) -> ignored
  const handledLike = await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_react",
      data: {
        uidFrom: "admin_high",
        msgId: "msg_valid_confirm",
        content: { rType: 1 },
      },
    },
    { pendingManager: manager }
  );
  assert.equal(handledLike, false);
  assert.equal(manager.hasPending("g_react"), true);

  // 2. Heart reaction on WRONG message -> ignored
  const handledWrongMsg = await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_react",
      data: {
        uidFrom: "admin_high",
        msgId: "msg_other",
        content: { rType: 5 },
      },
    },
    { pendingManager: manager }
  );
  assert.equal(handledWrongMsg, false);
  assert.equal(manager.hasPending("g_react"), true);

  // 3. Heart reaction from non-admin -> ignored
  const handledNonAdmin = await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_react",
      data: {
        uidFrom: "regular_user",
        msgId: "msg_valid_confirm",
        content: { rType: 5 },
      },
    },
    { pendingManager: manager, isHighAdminFn: () => false }
  );
  assert.equal(handledNonAdmin, false);
  assert.equal(manager.hasPending("g_react"), true);

  // 4. Heart reaction from adminLevelHigh on valid msg -> HANDLED & EXECUTED
  const handledValid = await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_react",
      data: {
        uidFrom: "admin_high",
        msgId: "msg_valid_confirm",
        content: { rType: 5 },
      },
    },
    {
      pendingManager: manager,
      isHighAdminFn: () => true,
      batchDelayMs: 0,
    }
  );
  assert.equal(handledValid, true);
  assert.equal(manager.hasPending("g_react"), false);
  assert.deepEqual(kickedMembers, ["cand_1"]);
  assert.ok(sentMessages.length > 0);
  const lastMsgText = typeof sentMessages[sentMessages.length - 1].msg === "string"
    ? sentMessages[sentMessages.length - 1].msg
    : sentMessages[sentMessages.length - 1].msg?.msg || "";
  assert.ok(lastMsgText.includes("KẾT QUẢ LỌC THÀNH VIÊN"));
});

test("LocmemService: re-verification before kick protects members promoted or active after preview", async () => {
  const manager = new PendingConfirmationManager(60000);
  manager.createRequest({
    groupId: "g_recheck",
    requestedBy: "admin_high",
    candidateUids: ["cand_promoted", "cand_now_active", "cand_still_inactive"],
    candidateNames: new Map([
      ["cand_promoted", "Promoted User"],
      ["cand_now_active", "Active User"],
      ["cand_still_inactive", "Lazy User"],
    ]),
    qualifiedDays: ["2026-10-01"],
    previewMsgIds: ["prev_1"],
    serverMsgId: "msg_recheck",
  });

  const kicked = [];
  const mockApi = {
    removeUserFromGroup: async (groupId, uids) => {
      kicked.push(...uids);
      return { status: 0, errorMembers: [] };
    },
    sendMessage: async () => ({ msgId: "summary" }),
    getGroupInfo: async (threadId = "g_recheck") => ({
      gridInfoMap: {
        [threadId]: {
          name: "Group Recheck",
          creatorId: "creator_id",
          // cand_promoted is now an admin!
          adminIds: ["admin_box", "cand_promoted"],
          memVerList: ["cand_promoted_0", "cand_now_active_0", "cand_still_inactive_0"],
        },
      },
    }),
  };

  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "recheck.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_recheck" });
  // cand_now_active sent a message after preview!
  const todayKey = getVietnamDateKey();
  store.recordActivity({
    groupId: "g_recheck",
    memberId: "cand_now_active",
    dateKey: todayKey,
    messageCount: 1,
  });

  await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_recheck",
      data: {
        uidFrom: "admin_high",
        msgId: "msg_recheck",
        content: { rType: 5 },
      },
    },
    {
      botUid: "bot_recheck",
      pendingManager: manager,
      isHighAdminFn: () => true,
      batchDelayMs: 0,
      storeOverride: store,
    }
  );

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Only cand_still_inactive should be kicked!
  assert.deepEqual(kicked, ["cand_still_inactive"]);
});

test("LocmemService: batching in groups of 20 and handling errorMembers", async () => {
  const manager = new PendingConfirmationManager(60000);
  const candidateUids = [];
  for (let i = 1; i <= 45; i++) {
    candidateUids.push(`user_${i}`);
  }

  manager.createRequest({
    groupId: "g_batch",
    requestedBy: "admin_high",
    candidateUids,
    candidateNames: new Map(candidateUids.map((id) => [id, `Name ${id}`])),
    qualifiedDays: ["2026-10-01"],
    serverMsgId: "msg_batch",
  });

  const batchSizes = [];
  const mockApi = {
    removeUserFromGroup: async (groupId, uids) => {
      batchSizes.push(uids.length);
      if (uids.includes("user_10")) {
        return { status: 0, errorMembers: ["user_10"] };
      }
      return { status: 0, errorMembers: [] };
    },
    sendMessage: async () => ({ msgId: "summary" }),
    getGroupInfo: async (threadId = "g_batch") => ({
      gridInfoMap: {
        [threadId]: {
          name: "Group Batch",
          creatorId: "creator_id",
          adminIds: [],
          memVerList: candidateUids.map((u) => `${u}_0`),
        },
      },
    }),
  };

  await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_batch",
      data: {
        uidFrom: "admin_high",
        msgId: "msg_batch",
        content: { rType: 5 },
      },
    },
    {
      pendingManager: manager,
      isHighAdminFn: () => true,
      batchDelayMs: 0,
    }
  );

  // 45 candidates split into batches of 20: 20, 20, 5
  assert.deepEqual(batchSizes, [20, 20, 5]);
});

test("LocmemService: protected identities (creator, admins, adminBot, adminLevelHigh, managed bots) excluded", async () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "protect.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_protect" });

  const groupId = "g_protect";
  const dates = getConsecutiveCalendarDays('2026-10-08', 30);
  const todayKey = "2026-10-08";

  for (const d of dates) {
    store.markCoverage(groupId, d, { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
    store.saveMemberSnapshot(groupId, [
      "creator_id",
      "admin_group_id",
      "admin_bot_id",
      "admin_high_id",
      "managed_bot_id",
      "current_bot_id",
      "regular_inactive_id",
    ], d);
  }

  const sentMessages = [];
  const mockApi = {
    getGroupInfo: async (threadId = "g_protect") => ({
      gridInfoMap: {
        [threadId]: {
          name: "Group Protect",
          creatorId: "creator_id",
          adminIds: ["admin_group_id", "current_bot_id"],
          memVerList: [
            "creator_id_0",
            "admin_group_id_0",
            "admin_bot_id_0",
            "admin_high_id_0",
            "managed_bot_id_0",
            "current_bot_id_0",
            "regular_inactive_id_0",
          ],
        },
      },
    }),
    sendMessage: async (msg, threadId) => {
      sentMessages.push({ msg, threadId });
      return { msgId: "preview_1" };
    },
    getGroupMembersInfo: async () => ({
      memberList: [
        { uid: "regular_inactive_id", name: "Nguyen Van A" },
      ],
    }),
  };

  const manager = new PendingConfirmationManager(60000);
  const result = await handleLocmemCommand({
    api: mockApi,
    threadId: groupId,
    senderId: "admin_high_id",
    botUid: "current_bot_id",
    todayKey,
    authorization: { isAdminLevelHigh: true },
    pendingManager: manager,
    storeOverride: store,
    protectedBotUids: new Set(["current_bot_id", "managed_bot_id"]),
    adminBotUids: new Set(["admin_bot_id"]),
    highAdminUids: new Set(["admin_high_id"]),
  });

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  const pending = manager.getPending(groupId);
  assert.ok(pending);
  // Only regular_inactive_id should be in candidateUids!
  assert.deepEqual(pending.candidateUids, ["regular_inactive_id"]);
  assert.ok(!pending.candidateUids.includes("creator_id"));
  assert.ok(!pending.candidateUids.includes("admin_group_id"));
  assert.ok(!pending.candidateUids.includes("admin_bot_id"));
  assert.ok(!pending.candidateUids.includes("admin_high_id"));
  assert.ok(!pending.candidateUids.includes("managed_bot_id"));
  assert.ok(!pending.candidateUids.includes("current_bot_id"));
});

test("Monthly cleanup: preserves at most today + 35 calendar days (<= 36 dates), records month key", async () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "cleanup.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_clean" });

  const groupId = "g_clean";
  // Setup 15 days of data
  for (let i = 1; i <= 15; i++) {
    const dayStr = String(i).padStart(2, "0");
    const d = `2026-09-${dayStr}`;
    store.markCoverage(groupId, d, { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
    store.saveMemberSnapshot(groupId, ["u1", "u2"], d);
    store.recordActivity({
      groupId,
      memberId: "u1",
      dateKey: d,
      messageCount: 5,
    });
  }

  const todayKey = "2026-10-01";
  store.markCoverage(groupId, todayKey, { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });

  const result = runMonthlyCleanup("bot_clean", {
    storeOverride: store,
    force: true,
    todayKey,
    monthKey: "2026-10",
  });

  assert.equal(result.cleaned, true);
  assert.ok(result.keptDatesCount === 36);

  // Check how many coverage dates remain
  const remainingCoverage = store.listStoredDateKeys(groupId);
  assert.ok(remainingCoverage.length === 16);

  // Subsequent cleanup in same month is skipped
  const secondRun = runMonthlyCleanup("bot_clean", {
    storeOverride: store,
    force: false,
    todayKey,
    monthKey: "2026-10",
  });
  assert.equal(secondRun.cleaned, false);
  assert.equal(secondRun.reason, "already_cleaned_for_month");

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Daily 35-day rolling retention prune: removes partitions >35 days while keeping 35-day window intact", async () => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "retention35");
  const store = new LocmemStore({ dbPath, botUid: "bot_ret35" });
  const groupId = "g_ret35";
  const todayKey = "2026-10-30";
  const keep35 = getConsecutiveCalendarDays(todayKey, 35);

  for (const d of ["2026-09-10", "2026-09-20", ...keep35, todayKey]) {
    store.markCoverage(groupId, d, { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
    store.saveMemberSnapshot(groupId, ["u1"], d);
  }

  const pruneRes = runDailyLocmemRetentionPrune("bot_ret35", {
    retentionDays: 35,
    todayKey,
    storeOverride: store,
  });

  assert.equal(pruneRes.removed, 2);
  const remaining = store.listStoredDateKeys(groupId);
  assert.equal(remaining.length, 36);
  assert.equal(remaining.includes("2026-09-10"), false);
  assert.equal(remaining.includes("2026-09-20"), false);
  for (const d of keep35) {
    assert.equal(remaining.includes(d), true, `Must keep ${d}`);
  }

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Command Registry & Policy Synchronization: locmem contracts", async () => {
  // 1. Registered in aggregate commandRegistry
  assert.ok(commandRegistry.lookup.has("locmem"), "locmem must be in commandRegistry");
  const def = commandRegistry.lookup.get("locmem")[0];
  assert.equal(def.scope, "group");
  assert.equal(def.permission, "adminLevelHigh");
  assert.equal(def.risk, "critical");
  assert.equal(def.executionLane, "control");

  // 2. Permission policy
  const perm = COMMAND_PERMISSION_POLICY["locmem"];
  assert.ok(perm, "locmem must have an entry in COMMAND_PERMISSION_POLICY");
  assert.equal(perm.effectScope, "group");
  assert.equal(perm.risk, "critical");
  assert.equal(perm.requiredRole, "adminLevelHigh");

  // 3. High risk policy
  assert.ok(HIGH_RISK_COMMANDS.has("locmem"), "locmem must be in HIGH_RISK_COMMANDS");

  // 4. Admin only mass commands
  assert.ok(ADMIN_ONLY_MASS_COMMANDS.has("locmem"), "locmem must be in ADMIN_ONLY_MASS_COMMANDS");
});

test("Integration: Main bot (different botName vs live UID) and child bot route events to isolated canonical databases", async (t) => {
  const tmpDir = createTempDir();
  const mainDbPath = path.join(tmpDir, "mybot", "instances", "admin", "data", "locmem-activity.sqlite");
  const childDbPath = path.join(tmpDir, "mybot", "instances", "child_bot_1", "data", "locmem-activity.sqlite");

  const mainStore = new LocmemStore({ dbPath: mainDbPath, botUid: "admin" });
  const childStore = new LocmemStore({ dbPath: childDbPath, botUid: "child_bot_1" });

  t.after(() => {
    closeAllLocmemStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mainCtx = {
    locmemDbPath: mainDbPath,
    botKey: "admin",
    liveZaloUid: "99887766",
    botName: "zalo-main-service",
    isMain: true,
  };

  const childCtx = {
    locmemDbPath: childDbPath,
    botKey: "child_bot_1",
    liveZaloUid: "55443322",
    botName: "zalo-child-service",
    isChild: true,
  };

  const todayKey = getVietnamDateKey();

  // Route events to main bot using different identifiers/representations
  trackLocmemMessage({}, {
    type: MessageType.GroupMessage,
    threadId: "g_main",
    data: { uidFrom: "user_main_1" },
  }, mainCtx);

  trackLocmemReaction({}, {
    isGroup: true,
    threadId: "g_main",
    data: { uidFrom: "user_main_1", content: { rType: 5 } },
  }, mainCtx);

  trackLocmemGroupAction({}, {
    threadId: "g_main",
    data: { sourceId: "user_main_1" },
  }, mainCtx);

  // Route event to child bot
  trackLocmemMessage({}, {
    type: MessageType.GroupMessage,
    threadId: "g_child",
    data: { uidFrom: "user_child_1" },
  }, childCtx);

  // Verify main database has main events
  const mainAct = mainStore.getMemberActivity("g_main", "user_main_1", todayKey);
  assert.ok(mainAct);
  assert.equal(mainAct.messageCount, 1);
  assert.equal(mainAct.reactionCount, 1);
  assert.equal(mainAct.groupActionCount, 1);

  // Verify main database does NOT have child event
  assert.equal(mainStore.getMemberActivity("g_child", "user_child_1", todayKey), null);

  // Verify child database has child event and NOT main events
  const childAct = childStore.getMemberActivity("g_child", "user_child_1", todayKey);
  assert.ok(childAct);
  assert.equal(childAct.messageCount, 1);
  assert.equal(childStore.getMemberActivity("g_main", "user_main_1", todayKey), null);
});

test("7-Day Window: downtime in the middle invalidates window without skipping to older dates", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "downtime.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_dt" });

  t.after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const groupId = "g_window_dt";
  const todayKey = "2026-10-08";
  const calendarDays = getConsecutiveCalendarDays(todayKey, 7);
  assert.equal(calendarDays.length, 7);

  // Older date (day -8) is complete
  store.markCoverage(groupId, "2026-09-30", { isComplete: true, coverageStatus: COVERAGE_STATUS.COMPLETE, snapshotSuccess: true });

  // 6 of the 7 days are complete, but calendarDays[3] (e.g. Day 4) has downtime
  for (let i = 0; i < 7; i++) {
    const d = calendarDays[i];
    if (i === 3) {
      store.markCoverage(groupId, d, { isComplete: false, coverageStatus: COVERAGE_STATUS.DOWNTIME });
    } else {
      store.markCoverage(groupId, d, { isComplete: true, coverageStatus: COVERAGE_STATUS.COMPLETE, snapshotSuccess: true });
    }
  }

  const windowCheck = store.getQualified7DayWindow(groupId, todayKey);
  assert.equal(windowCheck.isQualified, false);
  assert.equal(windowCheck.reason, "missing_or_incomplete_calendar_days");
  assert.equal(windowCheck.calendarDays.length, 7);
  assert.equal(windowCheck.completeDays.length, 6);

  // Must not skip downtime day to borrow 2026-09-30
  assert.ok(!windowCheck.completeDays.includes("2026-09-30"));

  // getInactiveCandidates returns [] fail-closed
  const candidates = store.getInactiveCandidates({
    groupId,
    completeDays: windowCheck.completeDays,
    todayDateKey: todayKey,
  });
  assert.deepEqual(candidates, []);
});

test("Membership: member rejoined under 7 days is protected until completing 7 full snapshot days", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "rejoin.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_rejoin" });

  t.after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const groupId = "g_rejoin";
  const todayKey = "2026-10-08";
  const calendarDays = getConsecutiveCalendarDays(todayKey, 7);

  // All 7 calendar days are complete
  for (const d of calendarDays) {
    store.markCoverage(groupId, d, { isComplete: true, coverageStatus: COVERAGE_STATUS.COMPLETE, snapshotSuccess: true });
  }

  // u_longtime is present in all 7 days
  // u_rejoined was present in days 0 and 1, but rejoined on day 2
  for (let i = 0; i < 2; i++) {
    store.saveMemberSnapshot(groupId, ["u_longtime", "u_rejoined"], calendarDays[i]);
  }

  // u_rejoined re-joins group -> resetMemberOnJoin wipes their past snapshot presence
  store.resetMemberOnJoin(groupId, "u_rejoined");

  // Remaining days snapshots saved with both members
  for (let i = 2; i < 7; i++) {
    store.saveMemberSnapshot(groupId, ["u_longtime", "u_rejoined"], calendarDays[i]);
  }

  const windowCheck = store.getQualified7DayWindow(groupId, todayKey);
  assert.equal(windowCheck.isQualified, true);

  const candidates = store.getInactiveCandidates({
    groupId,
    completeDays: windowCheck.completeDays,
    todayDateKey: todayKey,
  });

  // Only u_longtime is candidate; u_rejoined only has 5 days of snapshots and is protected
  assert.deepEqual(candidates, ["u_longtime"]);
  assert.ok(!candidates.includes("u_rejoined"));
});

test("Fail-Closed: candidate promoted to admin after preview is skipped via direct fresh groupInfo check", async (t) => {
  const manager = new PendingConfirmationManager(60000);
  const groupId = "g_promote_check";
  const msgId = "msg_promote_confirm";

  manager.createRequest({
    groupId,
    requestedBy: "admin_high",
    candidateUids: ["cand_promoted_user", "cand_normal_user"],
    candidateNames: new Map([
      ["cand_promoted_user", "Promoted"],
      ["cand_normal_user", "Normal Inactive"],
    ]),
    qualifiedDays: ["2026-10-01"],
    serverMsgId: msgId,
  });

  const kickedList = [];
  const mockApi = {
    removeUserFromGroup: async (gId, uids) => {
      kickedList.push(...uids);
      return { status: 0, errorMembers: [] };
    },
    sendMessage: async () => ({ msgId: "m1" }),
    // Direct fresh call returns cand_promoted_user as admin
    getGroupInfo: async () => ({
      creatorId: "creator_user",
      adminIds: ["admin_box", "cand_promoted_user"],
      memVerList: ["cand_promoted_user_0", "cand_normal_user_0"],
    }),
  };

  const handled = await handleLocmemReaction(
    mockApi,
    {
      threadId: groupId,
      data: {
        uidFrom: "admin_high",
        msgId,
        content: { rType: 5 },
      },
    },
    {
      pendingManager: manager,
      isHighAdminFn: () => true,
      batchDelayMs: 0,
    }
  );

  assert.equal(handled, true);
  // cand_promoted_user was skipped, only cand_normal_user was kicked
  assert.deepEqual(kickedList, ["cand_normal_user"]);
});

test("Fail-Closed: bot demoted/loses admin status before confirmation aborts kick entirely", async (t) => {
  const manager = new PendingConfirmationManager(60000);
  const groupId = "g_demoted_bot";
  const msgId = "msg_demote_confirm";

  manager.createRequest({
    groupId,
    botUid: "my_bot_uid",
    requestedBy: "admin_high",
    candidateUids: ["cand_1", "cand_2"],
    candidateNames: new Map([["cand_1", "U1"], ["cand_2", "U2"]]),
    qualifiedDays: ["2026-10-01"],
    serverMsgId: msgId,
  });

  let kickCalled = false;
  const mockApi = {
    removeUserFromGroup: async () => {
      kickCalled = true;
      return { status: 0, errorMembers: [] };
    },
    sendMessage: async () => ({ msgId: "m1" }),
    // Fresh group info: bot is NOT creator and NOT in adminIds
    getGroupInfo: async () => ({
      creatorId: "real_owner_uid",
      adminIds: ["other_admin_uid"],
      memVerList: ["cand_1_0", "cand_2_0"],
    }),
  };

  const handled = await handleLocmemReaction(
    mockApi,
    {
      threadId: groupId,
      data: {
        uidFrom: "admin_high",
        msgId,
        content: { rType: 5 },
      },
    },
    {
      botUid: "my_bot_uid",
      pendingManager: manager,
      isHighAdminFn: () => true,
      botIsAdmin: false, // Explicitly bot lost admin rights
    }
  );

  assert.equal(handled, false);
  assert.equal(kickCalled, false, "Must never call removeUserFromGroup if bot lost admin rights");
  assert.equal(manager.hasPending(groupId), false, "Pending request must be removed/cleared");
});

test("Fail-Closed: private reaction, un-reaction (rType <= 0), and heart on wrong message are rejected", async (t) => {
  const manager = new PendingConfirmationManager(60000);
  const groupId = "g_filter_react";
  const msgId = "msg_target_confirm";

  manager.createRequest({
    groupId,
    requestedBy: "admin_high",
    candidateUids: ["cand_target"],
    candidateNames: new Map([["cand_target", "Target"]]),
    qualifiedDays: ["2026-10-01"],
    serverMsgId: msgId,
  });

  const mockApi = {
    removeUserFromGroup: async () => ({ status: 0, errorMembers: [] }),
    sendMessage: async () => ({ msgId: "m1" }),
    getGroupInfo: async () => ({
      creatorId: "admin_box",
      adminIds: ["admin_box"],
      memVerList: ["cand_target_0"],
    }),
  };

  // 1. Private / Direct reaction
  const resPrivate = await handleLocmemReaction(
    mockApi,
    {
      isGroup: false,
      threadId: "private_chat",
      data: { uidFrom: "admin_high", msgId, content: { rType: 5 } },
    },
    { pendingManager: manager, isHighAdminFn: () => true }
  );
  assert.equal(resPrivate, false);
  assert.equal(manager.hasPending(groupId), true);

  // 2. Un-reaction (rType = 0 or -1)
  const resUnreact = await handleLocmemReaction(
    mockApi,
    {
      threadId: groupId,
      data: { uidFrom: "admin_high", msgId, content: { rType: 0 } },
    },
    { pendingManager: manager, isHighAdminFn: () => true }
  );
  assert.equal(resUnreact, false);
  assert.equal(manager.hasPending(groupId), true);

  // 3. Heart reaction on wrong message id
  const resWrongMsg = await handleLocmemReaction(
    mockApi,
    {
      threadId: groupId,
      data: { uidFrom: "admin_high", msgId: "wrong_msg_999", content: { rType: 5 } },
    },
    { pendingManager: manager, isHighAdminFn: () => true }
  );
  assert.equal(resWrongMsg, false);
  assert.equal(manager.hasPending(groupId), true);
});

test("Fail-Closed: kick API missing errorMembers or throwing mid-batch halts immediately with zero false-success", async (t) => {
  const manager = new PendingConfirmationManager(60000);
  const groupId = "g_fail_closed_batch";
  const msgId = "msg_fail_confirm";

  // 45 candidates => 3 batches (20, 20, 5)
  const candidateUids = Array.from({ length: 45 }, (_, i) => `user_${i + 1}`);
  manager.createRequest({
    groupId,
    requestedBy: "admin_high",
    candidateUids,
    candidateNames: new Map(candidateUids.map((id) => [id, `Name ${id}`])),
    qualifiedDays: ["2026-10-01"],
    serverMsgId: msgId,
  });

  let callCount = 0;
  let sentReport = "";
  const mockApi = {
    removeUserFromGroup: async (gId, batch) => {
      callCount++;
      if (callCount === 1) {
        // First batch succeeds
        return { status: 0, errorMembers: [] };
      }
      // Second batch returns invalid schema (missing errorMembers)
      return { status: 0 };
    },
    sendMessage: async (payload) => {
      if (typeof payload?.msg === "string" && payload.msg.includes("KẾT QUẢ")) {
        sentReport = payload.msg;
      }
      return { msgId: "m1" };
    },
    getGroupInfo: async () => ({
      creatorId: "creator_id",
      adminIds: ["admin_box"],
      memVerList: candidateUids.map((u) => `${u}_0`),
    }),
  };

  const handled = await handleLocmemReaction(
    mockApi,
    {
      threadId: groupId,
      data: {
        uidFrom: "admin_high",
        msgId,
        content: { rType: 5 },
      },
    },
    {
      pendingManager: manager,
      isHighAdminFn: () => true,
      batchDelayMs: 0,
    }
  );

  assert.equal(handled, true);
  // Batch 2 failed schema -> Batch 3 never called!
  assert.equal(callCount, 2);
  assert.ok(sentReport.includes("Đã kick thành công: 20"), "Only batch 1 should be kicked");
  assert.ok(sentReport.includes("Chưa xử lý (dừng do lỗi kết nối/quyền/schema): 25"), "Remaining 25 must be unprocessed");
});

test("Lifecycle: scanning timeout enforces deadline and forbids late pending confirmation creation", async () => {
  const manager = new PendingConfirmationManager(60000);
  const groupId = "g_timeout";

  const mockApi = {
    sendMessage: async () => ({ msgId: "m1" }),
    getGroupInfo: async () => ({
      creatorId: "creator_id",
      adminIds: ["admin_box"],
      memVerList: ["u1_0", "u2_0"],
    }),
  };

  // Provide already-exceeded deadline via scanDeadlineMs = 0
  const result = await handleLocmemCommand({
    api: mockApi,
    threadId: groupId,
    senderId: "admin_high",
    botUid: "admin",
    authorization: { isAdminLevelHigh: true },
    pendingManager: manager,
    scanDeadlineMs: 0,
  });

  assert.equal(result.code, "TIMEOUT");
  assert.equal(result.reason, "scan_deadline_exceeded");
  assert.equal(manager.hasPending(groupId), false, "Must not create pending request when deadline exceeded");
});

test("Lifecycle: shutdownLocmem checkpoints/closes databases and cancels schedulers", async (t) => {
  const tmpDir = createTempDir();
  const dbPath = path.join(tmpDir, "shutdown.sqlite");
  const store = new LocmemStore({ dbPath, botUid: "bot_shutdown" });

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  store.recordActivity({
    groupId: "g_shut",
    memberId: "u_shut",
    dateKey: "2026-10-01",
    messageCount: 5,
  });
  assert.equal(store.db.open, true);

  // Calling shutdownLocmem closes all active locmem stores and cleans up jobs
  shutdownLocmem("bot_shutdown");

  assert.equal(store.db.open, false, "SQLite database must be closed");

  // Re-calling is idempotent and does not throw
  assert.doesNotThrow(() => {
    shutdownLocmem();
  });
});
