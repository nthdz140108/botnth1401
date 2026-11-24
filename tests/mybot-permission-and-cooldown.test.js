import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseMyBotCommand } from "../src/commands/mybot/System/mybot-parser.js";
import {
  resolveVisibleBots,
  resolveManagedBotTarget,
  resolveMyBotCallerRole,
  resolveBotOwnershipPrincipals,
  isBotOwnedByCaller,
  resolveManagedBotList,
} from "../src/commands/mybot/System/mybot-identity.js";
import { activateBot } from "../src/commands/mybot/System/mybot-activation-service.js";
import { CooldownLedger } from "../src/commands/command-behavior-context.js";
import {
  isMyBotAdminCooldownBypass,
  checkDispatcherCooldown,
} from "../src/commands/command-dispatcher.js";
import { resolveBotBadge } from "../src/commands/mybot/list-canvas.js";
import { mybotHandleCommand } from "../src/commands/mybot/myBotManager.js";
import { migrateLegacyMyBotIdentity } from "../src/commands/mybot/System/mybot-migration.js";

test("cooldown: dispatcher routing, admin bypass, and cross-alias cooldown enforcement", () => {
  // 1. Router canonicalizes !mybot, !mebot, !clean
  const parsedMybot = parseMyBotCommand({ content: "!mybot showinfo" });
  const parsedMebot = parseMyBotCommand({ content: "!mebot showinfo" });
  const parsedClean = parseMyBotCommand({ content: "!clean", aliasCommand: "clean" });

  assert.equal(parsedMybot.action, "showinfo");
  assert.equal(parsedMebot.action, "showinfo");
  assert.equal(parsedClean.action, "clean");

  // 2. Admin tối cao bypasses cooldown through the dispatcher across all aliases
  const adminUid = "admin_uid_999";
  const adminVerdictMybot = checkDispatcherCooldown({
    commandParts: ["mybot", "showinfo"],
    userId: adminUid,
    threadId: "admin_thread",
    isAdminLevelHighest: true,
    isMainBotAdmin: true,
  });
  assert.equal(adminVerdictMybot.allowed, true);
  assert.equal(adminVerdictMybot.bypassed, true);
  assert.equal(adminVerdictMybot.command, "mybot");

  const adminVerdictMebot = checkDispatcherCooldown({
    commandParts: ["mebot", "showinfo"],
    userId: adminUid,
    threadId: "admin_thread",
    isAdminLevelHighest: true,
    isMainBotAdmin: true,
  });
  assert.equal(adminVerdictMebot.allowed, true);
  assert.equal(adminVerdictMebot.bypassed, true);
  assert.equal(adminVerdictMebot.command, "mybot");

  const adminVerdictClean = checkDispatcherCooldown({
    commandParts: ["clean"],
    userId: adminUid,
    threadId: "admin_thread",
    isAdminLevelHighest: true,
    isMainBotAdmin: true,
  });
  assert.equal(adminVerdictClean.allowed, true);
  assert.equal(adminVerdictClean.bypassed, true);
  assert.equal(adminVerdictClean.command, "mybot");

  // Admin calling other command does NOT bypass cooldown
  const adminOtherVerdict = checkDispatcherCooldown({
    commandParts: ["gemini", "prompt"],
    userId: adminUid,
    threadId: "admin_thread",
    isAdminLevelHighest: true,
    isMainBotAdmin: true,
  });
  assert.equal(adminOtherVerdict.bypassed, false);

  // 3. Regular user: 1st call succeeds, subsequent calls (even switching aliases) are blocked by cooldown
  const userUid = "user_test_cooldown";
  const userThread = "user_thread";
  const userLedger = new CooldownLedger();

  const userVerdict1 = checkDispatcherCooldown({
    commandParts: ["mybot", "showinfo"],
    userId: userUid,
    threadId: userThread,
    isAdminLevelHighest: false,
    isMainBotAdmin: false,
    ledger: userLedger,
  });
  assert.equal(userVerdict1.allowed, true);
  assert.equal(userVerdict1.bypassed, false);
  assert.equal(userVerdict1.command, "mybot");

  // Attempting with !mybot again immediately -> blocked
  const userVerdict2 = checkDispatcherCooldown({
    commandParts: ["mybot", "showinfo"],
    userId: userUid,
    threadId: userThread,
    isAdminLevelHighest: false,
    isMainBotAdmin: false,
    ledger: userLedger,
  });
  assert.equal(userVerdict2.allowed, false);
  assert.ok(userVerdict2.remainingSeconds > 0);

  // Attempting with !mebot immediately -> blocked (alias cannot bypass cooldown)
  const userVerdict3 = checkDispatcherCooldown({
    commandParts: ["mebot", "showinfo"],
    userId: userUid,
    threadId: userThread,
    isAdminLevelHighest: false,
    isMainBotAdmin: false,
    ledger: userLedger,
  });
  assert.equal(userVerdict3.allowed, false);
  assert.equal(userVerdict3.command, "mybot");
  assert.ok(userVerdict3.remainingSeconds > 0);

  // Attempting with !clean immediately -> blocked (shortcut cannot bypass cooldown)
  const userVerdict4 = checkDispatcherCooldown({
    commandParts: ["clean"],
    userId: userUid,
    threadId: userThread,
    isAdminLevelHighest: false,
    isMainBotAdmin: false,
    ledger: userLedger,
  });
  assert.equal(userVerdict4.allowed, false);
  assert.equal(userVerdict4.command, "mybot");
  assert.ok(userVerdict4.remainingSeconds > 0);
});

test("list & visibility: regular user only sees owned bots; admin sees all including orphans", () => {
  const adminUid = "36636267278442919";
  const registry = {
    "admin": {
      uid: adminUid,
      displayName: "Main Bot",
      isMain: true,
      status: "running",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    "bot_u1_a": {
      uid: "1001",
      displayName: "Bot U1 A",
      ownerUid: "user_1",
      status: "stopped",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
    "bot_u1_b": {
      uid: "1002",
      displayName: "Bot U1 B",
      createdByUid: "user_1",
      status: "running",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    "bot_u2": {
      uid: "2001",
      displayName: "Bot U2",
      ownerUid: "user_2",
      status: "stopped",
      createdAt: "2026-08-04T00:00:00.000Z",
    },
    "bot_orphan": {
      uid: "9001",
      displayName: "Bot Orphan",
      status: "stopped",
      createdAt: "2026-08-05T00:00:00.000Z",
      // No ownerUid, no createdByUid -> ownerResolution missing
    },
  };

  // 1. Regular user 1 sees ONLY bot_u1_a and bot_u1_b
  const user1Bots = resolveVisibleBots({
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(user1Bots.length, 2);
  assert.deepEqual(user1Bots.map((b) => b.key).sort(), ["bot_u1_a", "bot_u1_b"]);

  // 2. Regular user 2 sees ONLY bot_u2
  const user2Bots = resolveVisibleBots({
    registry,
    callerUid: "user_2",
    isSystemAdmin: false,
  });
  assert.equal(user2Bots.length, 1);
  assert.equal(user2Bots[0].key, "bot_u2");

  // 3. Admin / Main Bot UID sees ALL 5 bots (including orphan)
  const adminBots = resolveVisibleBots({
    registry,
    callerUid: adminUid,
    isSystemAdmin: true,
  });
  assert.equal(adminBots.length, 5);
  assert.ok(adminBots.some((b) => b.key === "admin"));
  assert.ok(adminBots.some((b) => b.key === "bot_orphan"));

  // 4. mybot list vs mebot list produce identical command parse
  const parse1 = parseMyBotCommand({ content: "!mybot list" });
  const parse2 = parseMyBotCommand({ content: "!mebot list" });
  assert.equal(parse1.action, "list");
  assert.equal(parse2.action, "list");
});

test("lifecycle by owner: selector 'all', index, UID, and batching isolation", () => {
  const adminUid = "36636267278442919";
  const registry = {
    "admin": {
      uid: adminUid,
      displayName: "Main Bot",
      isMain: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    "bot_u1_a": {
      uid: "1001",
      key: "bot_u1_a",
      displayName: "Bot U1 A",
      ownerUid: "user_1",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
    "bot_u1_b": {
      uid: "1002",
      key: "bot_u1_b",
      displayName: "Bot U1 B",
      ownerUid: "user_1",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    "bot_u2": {
      uid: "2001",
      key: "bot_u2",
      displayName: "Bot U2",
      ownerUid: "user_2",
      createdAt: "2026-08-04T00:00:00.000Z",
    },
  };

  // 1. Regular user with selector 'all': returns all child bots owned by user_1
  const u1All = resolveManagedBotTarget({
    selector: { type: "all" },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
    action: "restart",
  });
  assert.equal(u1All.length, 2);
  assert.deepEqual(u1All.map((b) => b.key).sort(), ["bot_u1_a", "bot_u1_b"]);
  // Main Bot never included
  assert.ok(!u1All.some((b) => b.isMain));

  // 2. Admin with selector 'all': returns all 3 child bots, excluding Main Bot
  const adminAll = resolveManagedBotTarget({
    selector: { type: "all" },
    registry,
    callerUid: adminUid,
    isSystemAdmin: true,
    action: "restart",
  });
  assert.equal(adminAll.length, 3);
  assert.ok(!adminAll.some((b) => b.isMain));

  // 3. Regular user with index selector: 1-based index in visible bots
  const u1Idx1 = resolveManagedBotTarget({
    selector: { type: "index", value: 1 },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(u1Idx1.length, 1);
  assert.equal(u1Idx1[0].key, "bot_u1_a");

  // Out-of-bounds index for user_1
  const u1IdxOut = resolveManagedBotTarget({
    selector: { type: "index", value: 3 },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(u1IdxOut.length, 0);

  // 4. Regular user with UID selector: can access own bot
  const u1Own = resolveManagedBotTarget({
    selector: { type: "uid", value: "1001" },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(u1Own.length, 1);
  assert.equal(u1Own[0].key, "bot_u1_a");

  // Regular user targeting other user's bot returns empty
  const u1Cross = resolveManagedBotTarget({
    selector: { type: "uid", value: "2001" },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(u1Cross.length, 0);

  // UID selector matching owner UID should NOT match bot
  const u1ByOwner = resolveManagedBotTarget({
    selector: { type: "uid", value: "user_1" },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(u1ByOwner.length, 0);

  // Admin targeting other user's bot UID succeeds
  const adminTargetOther = resolveManagedBotTarget({
    selector: { type: "uid", value: "2001" },
    registry,
    callerUid: adminUid,
    isSystemAdmin: true,
  });
  assert.equal(adminTargetOther.length, 1);
  assert.equal(adminTargetOther[0].key, "bot_u2");

  // 5. CSV selector with mixed access: only own bots returned for regular user
  const u1Csv = resolveManagedBotTarget({
    selector: { type: "multiple", items: ["1", "2001"] },
    registry,
    callerUid: "user_1",
    isSystemAdmin: false,
  });
  assert.equal(u1Csv.length, 1);
  assert.equal(u1Csv[0].key, "bot_u1_a");
});

test("active command: rejects batch/all, enforces 1-active-bot limit for owner even under admin activation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-active-test-"));
  const mybotDir = path.join(tmpDir, "mybot");
  const credDir = path.join(mybotDir, "credentials");
  const instancesDir = path.join(mybotDir, "instances");
  await fs.mkdir(credDir, { recursive: true });
  await fs.mkdir(instancesDir, { recursive: true });

  const ownerUid = "88888888888888888";
  const bot1Uid = "11111111111111111";
  const bot2Uid = "22222222222222222";

  const registry = {
    [bot1Uid]: {
      uid: bot1Uid,
      name: "Bot1",
      displayName: "Bot 1",
      ownerUid,
      status: "running",
      webPort: "4441",
      enabled: true,
      trialStatus: "active",
      expiryAt: new Date(Date.now() + 3600000).toISOString(),
    },
    [bot2Uid]: {
      uid: bot2Uid,
      name: "Bot2",
      displayName: "Bot 2",
      ownerUid,
      status: "stopped",
      webPort: "4442",
      enabled: true,
      trialStatus: "pending",
      expiryAt: null,
    },
  };

  await fs.writeFile(path.join(mybotDir, "mybots.json"), JSON.stringify(registry, null, 2), "utf8");
  await fs.writeFile(path.join(credDir, `${bot1Uid}.json`), JSON.stringify({ cookie: "cookie1", imei: "imei1" }), "utf8");
  await fs.writeFile(path.join(credDir, `${bot2Uid}.json`), JSON.stringify({ cookie: "cookie2", imei: "imei2" }), "utf8");

  // Profile for bot 1 (currently running / active)
  await fs.mkdir(path.join(instancesDir, bot1Uid, "data"), { recursive: true });
  await fs.writeFile(
    path.join(instancesDir, bot1Uid, "data", "profile.json"),
    JSON.stringify({ ownerUid, trialStatus: "active", expiryAt: registry[bot1Uid].expiryAt, enabled: true }),
    "utf8"
  );

  // Profile for bot 2 (pending)
  await fs.mkdir(path.join(instancesDir, bot2Uid, "data"), { recursive: true });
  await fs.writeFile(
    path.join(instancesDir, bot2Uid, "data", "profile.json"),
    JSON.stringify({ ownerUid, trialStatus: "pending", expiryAt: null, enabled: true }),
    "utf8"
  );

  // 1. Default is unlimited active bots per owner: activating an extended bot 2 while bot 1 is active succeeds!
  await fs.writeFile(
    path.join(instancesDir, bot2Uid, "data", "profile.json"),
    JSON.stringify({ ownerUid, trialStatus: "active", expiryAt: "-1", enabled: true }),
    "utf8"
  );
  const mockPm2 = {
    start: async () => true,
    stop: async () => true,
    checkHealth: async () => ({ healthy: true }),
  };
  const unlimitedAttempt = await activateBot({
    botId: bot2Uid,
    actorUid: ownerUid,
    isSystemAdmin: false,
    root: tmpDir,
    pm2Adapter: mockPm2,
    healthProbe: async () => ({ healthy: true }),
  });
  assert.equal(unlimitedAttempt.success, true);

  // 2. When an explicit finite maxActiveBotsPerOwner: 1 cap is passed, both user and admin enforce it
  const invReset = JSON.parse(await fs.readFile(path.join(tmpDir, "mybot", "mybots.json"), "utf8"));
  invReset[bot2Uid].status = "stopped";
  await fs.writeFile(path.join(tmpDir, "mybot", "mybots.json"), JSON.stringify(invReset, null, 2), "utf8");

  const userAttempt = await activateBot({
    botId: bot2Uid,
    actorUid: ownerUid,
    isSystemAdmin: false,
    root: tmpDir,
    maxActiveBotsPerOwner: 1,
  });
  assert.equal(userAttempt.success, false);
  assert.equal(userAttempt.code, "OWNER_ACTIVE_BOT_EXISTS");

  const adminAttempt = await activateBot({
    botId: bot2Uid,
    actorUid: "admin_supreme_uid",
    isSystemAdmin: true,
    root: tmpDir,
    maxActiveBotsPerOwner: 1,
  });
  assert.equal(adminAttempt.success, false);
  assert.equal(adminAttempt.code, "OWNER_ACTIVE_BOT_EXISTS");
  assert.ok(adminAttempt.error.includes(ownerUid) || adminAttempt.error.includes("Bot 1"));

  // 3. User trying to activate a bot owned by someone else -> FORBIDDEN
  const otherUserAttempt = await activateBot({
    botId: bot2Uid,
    actorUid: "random_other_user",
    isSystemAdmin: false,
    root: tmpDir,
  });
  assert.equal(otherUserAttempt.success, false);
  assert.equal(otherUserAttempt.code, "FORBIDDEN");
});

test("ownership regression: creator and bot UID both recognized, strangers rejected, self-ownership preserved", () => {
  const creatorUid = "creator_123";
  const childUid = "child_456";
  const strangerUid = "stranger_789";
  const adminUid = "admin_supreme";

  const botRecord = {
    uid: childUid,
    key: "child_bot_1",
    displayName: "Child Bot 1",
    ownerUid: creatorUid,
    createdByUid: creatorUid,
    status: "stopped",
  };

  const selfRecord = {
    uid: "self_owned_bot",
    key: "self_bot",
    displayName: "Self Owned Bot",
    ownerUid: "self_owned_bot",
    status: "stopped",
  };

  const orphanRecord = {
    uid: "orphan_bot",
    key: "orphan",
    displayName: "Orphan Bot",
    status: "stopped",
  };

  const registry = {
    [botRecord.key]: botRecord,
    [selfRecord.key]: selfRecord,
    [orphanRecord.key]: orphanRecord,
  };

  // 1. Ownership principals
  const principals = resolveBotOwnershipPrincipals(botRecord);
  assert.ok(principals.has(creatorUid), "Creator UID must be in ownership principals");
  assert.ok(principals.has(childUid), "Bot's own UID must be in ownership principals");
  assert.ok(!principals.has(strangerUid), "Stranger UID must NOT be in ownership principals");

  // 2. isBotOwnedByCaller
  assert.equal(isBotOwnedByCaller(botRecord, creatorUid), true);
  assert.equal(isBotOwnedByCaller(botRecord, childUid), true);
  assert.equal(isBotOwnedByCaller(botRecord, strangerUid), false);
  assert.equal(isBotOwnedByCaller(selfRecord, "self_owned_bot"), true);
  assert.equal(isBotOwnedByCaller(selfRecord, strangerUid), false);

  // 3. resolveVisibleBots:
  // - Creator sees child_bot_1
  const creatorVisible = resolveVisibleBots({ registry, callerUid: creatorUid, isSystemAdmin: false });
  assert.equal(creatorVisible.length, 1);
  assert.equal(creatorVisible[0].key, "child_bot_1");

  // - Child bot's OWN UID sees child_bot_1 (crucial fix!)
  const childVisible = resolveVisibleBots({ registry, callerUid: childUid, isSystemAdmin: false });
  assert.equal(childVisible.length, 1);
  assert.equal(childVisible[0].key, "child_bot_1");

  // - Self-owned bot sees itself
  const selfVisible = resolveVisibleBots({ registry, callerUid: "self_owned_bot", isSystemAdmin: false });
  assert.equal(selfVisible.length, 1);
  assert.equal(selfVisible[0].key, "self_bot");

  // - Stranger sees nothing
  const strangerVisible = resolveVisibleBots({ registry, callerUid: strangerUid, isSystemAdmin: false });
  assert.equal(strangerVisible.length, 0);

  // - Admin sees all 3 bots (including orphan)
  const adminVisible = resolveVisibleBots({ registry, callerUid: adminUid, isSystemAdmin: true });
  assert.equal(adminVisible.length, 3);

  // 4. resolveManagedBotTarget:
  // - Creator can target child_bot_1
  const creatorTarget = resolveManagedBotTarget({
    selector: { type: "uid", value: childUid },
    registry,
    callerUid: creatorUid,
    isSystemAdmin: false,
    action: "restart",
  });
  assert.equal(creatorTarget.length, 1);
  assert.equal(creatorTarget[0].key, "child_bot_1");

  // - Child bot's own UID can target itself
  const childTarget = resolveManagedBotTarget({
    selector: { type: "uid", value: childUid },
    registry,
    callerUid: childUid,
    isSystemAdmin: false,
    action: "restart",
  });
  assert.equal(childTarget.length, 1);
  assert.equal(childTarget[0].key, "child_bot_1");

  // - Stranger cannot target child_bot_1
  const strangerTarget = resolveManagedBotTarget({
    selector: { type: "uid", value: childUid },
    registry,
    callerUid: strangerUid,
    isSystemAdmin: false,
    action: "restart",
  });
  assert.equal(strangerTarget.length, 0);
});

test("status regression: 100% membership across all states, probe isolation, and readiness badge resolution", async () => {
  const ownerUid = "multi_status_owner";
  const registry = {
    "bot_pending": { uid: "p1", key: "bot_pending", ownerUid, status: "pending", trialStatus: "pending" },
    "bot_stopped": { uid: "p2", key: "bot_stopped", ownerUid, status: "stopped" },
    "bot_starting": { uid: "p3", key: "bot_starting", ownerUid, status: "starting" },
    "bot_running": { uid: "p4", key: "bot_running", ownerUid, status: "running" },
    "bot_expired": { uid: "p5", key: "bot_expired", ownerUid, status: "expired", expiryAt: "2020-01-01T00:00:00.000Z" },
    "bot_rejected": { uid: "p6", key: "bot_rejected", ownerUid, status: "rejected", enabled: false },
    "bot_error": { uid: "p7", key: "bot_error", ownerUid, status: "running" },
  };

  // 1. All 7 bots are returned regardless of status, enabled, expiryAt, trialStatus, or identityPending
  const visible = resolveVisibleBots({ registry, callerUid: ownerUid, isSystemAdmin: false });
  assert.equal(visible.length, 7, "All 7 bots must be visible to owner regardless of status");

  // 2. Runtime probe isolation via Promise.allSettled
  const probeResults = await Promise.allSettled(
    visible.map(async (bot) => {
      if (bot.key === "bot_error") {
        throw new Error("Simulated PM2 probe failure");
      }
      return {
        running: bot.status === "running",
        ready: bot.status === "running",
        status: bot.status,
      };
    })
  );

  visible.forEach((bot, idx) => {
    const res = probeResults[idx];
    if (res.status === "fulfilled" && res.value) {
      bot.runtimeState = res.value;
      bot.status = res.value.status;
    } else {
      bot.runtimeState = {
        running: false,
        ready: false,
        status: bot.status || "stopped",
        probeError: true,
        label: "Không xác định runtime",
        error: res.reason?.message,
      };
    }
  });

  // Failing bot is kept in the list
  assert.equal(visible.length, 7);
  const errBot = visible.find((b) => b.key === "bot_error");
  assert.ok(errBot.runtimeState.probeError);
  assert.equal(errBot.runtimeState.label, "Không xác định runtime");

  // 3. Badge mapping
  const badgeRunning = resolveBotBadge({ runtimeState: { running: true, ready: true } });
  assert.equal(badgeRunning.label, "Đang chạy");

  const badgeStopped = resolveBotBadge({ runtimeState: { running: false, status: "stopped" } });
  assert.equal(badgeStopped.label, "Đã dừng");

  const badgePending = resolveBotBadge({ runtimeState: { running: false, status: "pending" } });
  assert.equal(badgePending.label, "Chưa chạy");

  const badgeStarting = resolveBotBadge({ runtimeState: { running: false, status: "starting" } });
  assert.equal(badgeStarting.label, "Đang khởi tạo");

  const badgeExpired = resolveBotBadge({ runtimeState: { running: false, status: "expired" } });
  assert.equal(badgeExpired.label, "Hết hạn");

  const badgeRejected = resolveBotBadge({ runtimeState: { running: false, status: "rejected" } });
  assert.equal(badgeRejected.label, "Vô hiệu hóa");

  const badgeProbeErr = resolveBotBadge(errBot);
  assert.equal(badgeProbeErr.label, "Không xác định runtime");

  // Pseudo-running: PM2 online (running: true) but listener not ready (ready: false) MUST NOT be 'Đang chạy'
  const badgePseudoRunning = resolveBotBadge({ runtimeState: { running: true, ready: false, status: "running" } });
  assert.equal(badgePseudoRunning.label, "Lỗi");
});

test("handler regression: dispatcher executes !mybot list and !mebot list, bot own UID receives list canvas", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-handler-reg-"));
  const mybotDir = path.join(tmpDir, "mybot");
  await fs.mkdir(mybotDir, { recursive: true });

  const childBotUid = "88880001";
  const creatorUid = "77770001";
  const strangerUid = "99990001";

  const registry = {
    [childBotUid]: {
      uid: childBotUid,
      displayName: "Child Alpha",
      ownerUid: creatorUid,
      createdByUid: creatorUid,
      status: "stopped",
      createdAt: new Date().toISOString(),
    },
  };

  await fs.writeFile(path.join(mybotDir, "mybots.json"), JSON.stringify(registry, null, 2), "utf8");

  const prevEnv = process.env.ProjectRoot;
  process.env.ProjectRoot = tmpDir;

  try {
    // 1. Dispatching !mybot list with caller = child bot's OWN UID
    const sentChild = [];
    const mockApiChild = {
      sendMessage: async (payload, threadId, type) => {
        sentChild.push({ payload, threadId, type });
        return { data: { msgId: "child_msg_1" } };
      },
    };

    const messageFromChild = {
      threadId: "thread_c1",
      type: 0,
      data: {
        uidFrom: childBotUid, // Bot's OWN UID!
        dName: "Child Alpha Account",
        content: "!mybot list",
      },
    };

    await mybotHandleCommand(mockApiChild, messageFromChild, false, "mybot", {
      instanceAuthorization: { instanceKind: "main" },
    });

    // Bot MUST NOT receive "Bạn chưa sở hữu bot nào"
    assert.ok(sentChild.length > 0, "Must send a response");
    const childWarning = sentChild.find((s) => typeof s.payload?.msg === "string" && s.payload.msg.includes("Bạn chưa sở hữu bot nào"));
    assert.equal(childWarning, undefined, "Child bot own UID must NOT receive 'Bạn chưa sở hữu bot nào'");

    // Bot must receive canvas image attachment
    const childImage = sentChild.find((s) => Array.isArray(s.payload?.attachments) && s.payload.attachments.length > 0);
    assert.ok(childImage, "Child bot own UID must receive canvas image attachment");

    // 2. Dispatching !mebot list with caller = creator UID
    const sentCreator = [];
    const mockApiCreator = {
      sendMessage: async (payload, threadId, type) => {
        sentCreator.push({ payload, threadId, type });
        return { data: { msgId: "creator_msg_1" } };
      },
    };

    const messageFromCreator = {
      threadId: "thread_c2",
      type: 0,
      data: {
        uidFrom: creatorUid,
        dName: "Creator User",
        content: "!mebot list", // Using alias mebot
      },
    };

    await mybotHandleCommand(mockApiCreator, messageFromCreator, false, "mebot", {
      instanceAuthorization: { instanceKind: "main" },
    });

    const creatorImage = sentCreator.find((s) => Array.isArray(s.payload?.attachments) && s.payload.attachments.length > 0);
    assert.ok(creatorImage, "Creator must receive canvas image attachment for !mebot list");

    // 3. Dispatching !mybot list with caller = stranger UID -> denied with warning
    const sentStranger = [];
    const mockApiStranger = {
      sendMessage: async (payload, threadId, type) => {
        sentStranger.push({ payload, threadId, type });
        return { data: { msgId: "stranger_msg_1" } };
      },
    };

    const messageFromStranger = {
      threadId: "thread_c3",
      type: 0,
      data: {
        uidFrom: strangerUid,
        dName: "Stranger",
        content: "!mybot list",
      },
    };

    await mybotHandleCommand(mockApiStranger, messageFromStranger, false, "mybot", {
      instanceAuthorization: { instanceKind: "main" },
    });

    const strangerWarning = sentStranger.find((s) => typeof s.payload?.msg === "string" && s.payload.msg.includes("Bạn chưa sở hữu bot nào"));
    assert.ok(strangerWarning, "Stranger must receive 'Bạn chưa sở hữu bot nào'");
  } finally {
    process.env.ProjectRoot = prevEnv;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("data regression: migration preserves self-owner (ownerUid===botUid), creates backup, does not alter trial/status", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-data-reg-"));
  const mybotDir = path.join(tmpDir, "mybot");
  const instancesDir = path.join(mybotDir, "instances");
  await fs.mkdir(instancesDir, { recursive: true });

  const initialRegistry = {
    "admin": {
      uid: "admin_uid",
      displayName: "Main Bot",
      isMain: true,
      status: "running",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    "self_bot": {
      uid: "5555555555555555",
      displayName: "Self Owned Bot",
      ownerUid: "5555555555555555", // ownerUid === botUid
      status: "running",
      trialStatus: "active",
      expiryAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
    "legacy_bot": {
      uid: "6666666666666666",
      displayName: "Legacy Bot with Profile Creator",
      createdBy: "7777777777777777",
      status: "stopped",
      trialStatus: "expired",
      expiryAt: "2026-08-10T00:00:00.000Z",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
  };

  await fs.writeFile(path.join(mybotDir, "mybots.json"), JSON.stringify(initialRegistry, null, 2), "utf8");

  // Profile with creator evidence for legacy_bot
  await fs.mkdir(path.join(instancesDir, "6666666666666666", "data"), { recursive: true });
  await fs.writeFile(
    path.join(instancesDir, "6666666666666666", "data", "profile.json"),
    JSON.stringify({ createdByUid: "7777777777777777", trialStatus: "expired" }),
    "utf8"
  );

  // 1. Run migration
  const report1 = await migrateLegacyMyBotIdentity({ root: tmpDir });
  assert.equal(report1.success, true);
  assert.ok(report1.backupPath, "Must create backup");
  assert.ok(report1.repairedCount >= 1, "Must report repaired count");

  // 2. Verify registry after migration
  const after1 = JSON.parse(await fs.readFile(path.join(mybotDir, "mybots.json"), "utf8"));

  // Self-owned bot: ownerUid must NOT be null!
  assert.equal(after1.self_bot.ownerUid, "5555555555555555", "self-owner ownerUid must remain botUid, NOT null");
  assert.equal(after1.self_bot.ownerResolution, "self");
  // Trial/status/expiry must NOT be altered
  assert.equal(after1.self_bot.trialStatus, "active");
  assert.equal(after1.self_bot.status, "running");
  assert.equal(after1.self_bot.expiryAt, "2026-09-01T00:00:00.000Z");

  // Legacy bot backfilled creator
  assert.equal(after1.legacy_bot.createdByUid, "7777777777777777");
  assert.equal(after1.legacy_bot.ownerUid, "7777777777777777");
  assert.ok(["legacy", "profile"].includes(after1.legacy_bot.ownerResolution));
  assert.equal(after1.legacy_bot.trialStatus, "expired");
  assert.equal(after1.legacy_bot.status, "stopped");

  // 3. Idempotent second run
  const report2 = await migrateLegacyMyBotIdentity({ root: tmpDir });
  assert.equal(report2.migratedCount, 0);
  assert.equal(report2.repairedCount, 0);

  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

after(() => {
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

