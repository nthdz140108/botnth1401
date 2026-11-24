import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  getSortedBotList,
  resolveTargetBots,
  calculateExtendExpiry,
  calculateMinusExpiry,
  extendBotExpiryLogic,
  deleteChildBotLogic,
  cleanExpiredBotsLogic,
  executeNotifyBroadcast,
} from "../src/commands/mybot/System/mybot-lifecycle.js";

test("getSortedBotList sorts Main Bot first, then createdAt, then uid", () => {
  const registry = {
    "bot_c": { uid: "333", displayName: "Bot C", createdAt: "2026-08-10T00:00:00.000Z" },
    "admin": { uid: "admin_uid", displayName: "Admin Bot", isMain: true, createdAt: "2026-08-15T00:00:00.000Z" },
    "bot_a": { uid: "111", displayName: "Bot A", createdAt: "2026-08-01T00:00:00.000Z" },
    "bot_b": { uid: "222", displayName: "Bot B", createdAt: "2026-08-05T00:00:00.000Z" },
  };

  const list = getSortedBotList(registry);
  assert.equal(list.length, 4);
  assert.equal(list[0].key, "admin");
  assert.equal(list[1].key, "bot_a");
  assert.equal(list[2].key, "bot_b");
  assert.equal(list[3].key, "bot_c");
});

test("resolveTargetBots handles index, UID, multiple, and all (excluding main bot on delete)", () => {
  const registry = {
    "admin": { uid: "admin_uid", displayName: "Admin Bot", isMain: true, createdAt: "2026-08-01T00:00:00.000Z" },
    "bot_1": { uid: "11111", displayName: "Bot 1", createdAt: "2026-08-02T00:00:00.000Z" },
    "bot_2": { uid: "22222", displayName: "Bot 2", createdAt: "2026-08-03T00:00:00.000Z" },
  };

  // 1-based index
  const t1 = resolveTargetBots({ selector: { type: "index", value: 2 }, myBots: registry });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].key, "bot_1");

  // UID
  const t2 = resolveTargetBots({ selector: { type: "uid", value: "22222" }, myBots: registry });
  assert.equal(t2.length, 1);
  assert.equal(t2[0].key, "bot_2");

  // Multiple CSV
  const t3 = resolveTargetBots({ selector: { type: "multiple", items: ["2", "3"] }, myBots: registry });
  assert.equal(t3.length, 2);
  assert.equal(t3[0].key, "bot_1");
  assert.equal(t3[1].key, "bot_2");

  // all on action = "delete" must EXCLUDE main bot
  const tAllDel = resolveTargetBots({ selector: { type: "all" }, myBots: registry, action: "delete" });
  assert.equal(tAllDel.length, 2);
  assert.equal(tAllDel.some((b) => b.isMain || b.key === "admin"), false);
});

test("calculateExtendExpiry handles valid remaining time, expired time, and -1", () => {
  const now = Date.now();
  const future1Day = new Date(now + 24 * 3600 * 1000).toISOString();
  const past1Day = new Date(now - 24 * 3600 * 1000).toISOString();

  // Extend 1 day on active bot -> now + 2 days
  const extActive = calculateExtendExpiry(future1Day, 24 * 3600 * 1000, now);
  const diff1 = new Date(extActive).getTime() - new Date(future1Day).getTime();
  assert.equal(diff1, 24 * 3600 * 1000);

  // Extend 1 day on expired bot -> now + 1 day
  const extExpired = calculateExtendExpiry(past1Day, 24 * 3600 * 1000, now);
  const diff2 = new Date(extExpired).getTime() - now;
  assert.equal(diff2, 24 * 3600 * 1000);

  // Extend -1 -> permanent
  assert.equal(calculateExtendExpiry(future1Day, -1, now), "-1");
  assert.equal(calculateExtendExpiry("-1", 24 * 3600 * 1000, now), "-1");
});

test("calculateMinusExpiry reduces expiry date or expires bot", () => {
  const now = Date.now();
  const future2Days = new Date(now + 2 * 24 * 3600 * 1000).toISOString();

  // Minus 1 day
  const minusRes = calculateMinusExpiry(future2Days, 24 * 3600 * 1000, now);
  const diff = new Date(future2Days).getTime() - new Date(minusRes).getTime();
  assert.equal(diff, 24 * 3600 * 1000);

  // Minus -1 -> expire immediately
  const minusPerm = calculateMinusExpiry(future2Days, -1, now);
  assert.ok(new Date(minusPerm).getTime() <= now);
});

test("extendBotExpiryLogic updates expiry without starting bot and transitions expired bot to stopped", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-ext-test-"));
  const mybotDir = path.join(tmpDir, "mybot");
  await fs.mkdir(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  const registry = {
    "bot_1": {
      uid: "11111",
      displayName: "Bot 1",
      status: "expired",
      expiryAt: new Date(Date.now() - 100000).toISOString(),
    },
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  let startCalled = false;
  const mockStart = async () => { startCalled = true; };

  const result = await extendBotExpiryLogic({
    registryPath,
    botKey: "bot_1",
    durationMs: 7 * 24 * 3600 * 1000,
    startBotFn: mockStart,
  });

  assert.equal(result.success, true);
  assert.equal(startCalled, false, "extend must NOT auto-start bot");

  const updatedRegistry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(updatedRegistry.bot_1.status, "stopped", "expired bot must transition to stopped after extension");
  assert.ok(new Date(updatedRegistry.bot_1.expiryAt).getTime() > Date.now());
});

test("deleteChildBotLogic safely removes bot files and registry entry, protects main bot", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-del-test-"));
  const mybotDir = path.join(tmpDir, "mybot");
  await fs.mkdir(path.join(mybotDir, "credentials"), { recursive: true });
  await fs.mkdir(path.join(mybotDir, "configs"), { recursive: true });
  await fs.mkdir(path.join(mybotDir, "instances", "11111"), { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  const childCredFile = path.join(mybotDir, "credentials", "11111.json");
  const childInstanceFile = path.join(mybotDir, "instances", "11111", "data.json");
  await fs.writeFile(childCredFile, '{"secret":"do-not-leak"}', "utf8");
  await fs.writeFile(childInstanceFile, '{"state":"ok"}', "utf8");

  const registry = {
    "admin": { uid: "admin_uid", isMain: true, status: "running" },
    "11111": { uid: "11111", displayName: "Child Bot", status: "running" },
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  // Attempting to delete main bot should fail
  await assert.rejects(async () => {
    await deleteChildBotLogic({
      projectRoot: tmpDir,
      registryPath,
      botKey: "admin",
    });
  }, /Không thể xóa hoặc vô hiệu hóa Main Bot/i);

  // Deleting child bot
  let deletePm2Called = false;
  let killProcessCalled = false;

  const result = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "11111",
    deleteProcessFn: async (key) => {
      deletePm2Called = true;
      return { success: true, pm2Name: key, verifiedAbsent: true, ownershipVerified: true, detail: "mock deleted" };
    },
    killProcessFn: async () => { killProcessCalled = true; },
  });

  assert.equal(result.success, true);
  assert.equal(deletePm2Called, true);
  assert.equal(killProcessCalled, true);

  // File cleanup check
  const credExists = await fs.access(childCredFile).then(() => true).catch(() => false);
  const instanceExists = await fs.access(childInstanceFile).then(() => true).catch(() => false);
  assert.equal(credExists, false);
  assert.equal(instanceExists, false);

  // Registry record check
  const updatedRegistry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(updatedRegistry["11111"], undefined);
});

test("cleanExpiredBotsLogic removes only expired child bots", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-clean-test-"));
  const mybotDir = path.join(tmpDir, "mybot");
  await fs.mkdir(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  const registry = {
    "admin": { uid: "admin_uid", isMain: true, expiryAt: "-1" },
    "active_bot": { uid: "active_uid", expiryAt: new Date(Date.now() + 100000).toISOString() },
    "expired_bot": { uid: "expired_uid", expiryAt: new Date(Date.now() - 100000).toISOString() },
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  const deletedKeys = [];
  const cleanResult = await cleanExpiredBotsLogic({
    projectRoot: tmpDir,
    registryPath,
    deleteFn: async ({ botKey }) => {
      deletedKeys.push(botKey);
      return { success: true, botKey };
    },
  });

  assert.deepEqual(deletedKeys, ["expired_bot"]);
  assert.equal(cleanResult.cleaned.length, 1);
  assert.equal(cleanResult.cleaned[0].botKey, "expired_bot");
});

test("executeNotifyBroadcast limits concurrency and reports partial failure", async () => {
  const targetUids = ["uid_1", "uid_2", "uid_3", "uid_4"];
  const sent = [];

  const mockSend = async (uid, text) => {
    sent.push(uid);
    if (uid === "uid_3") {
      throw new Error("Send failed for uid_3");
    }
    return { success: true };
  };

  const report = await executeNotifyBroadcast({
    targetUids,
    messageText: "Test Notification",
    sendFn: mockSend,
    concurrency: 2,
  });

  assert.equal(report.total, 4);
  assert.equal(report.successCount, 3);
  assert.equal(report.failCount, 1);
  assert.deepEqual(report.failedUids, ["uid_3"]);
});
