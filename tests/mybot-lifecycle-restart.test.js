import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  restartBotRuntime,
  saveSpawnedPid,
  getSpawnedPid,
  updateMyBotRecord,
} from "../src/commands/mybot/System/pm2-manager.js";
import {
  sendNotifyToOwners,
} from "../src/commands/mybot/System/mybot-lifecycle.js";

async function createFixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-lifecycle-test-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "configs"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });

  const adminConfig = {
    botId: "admin",
    displayName: "Main Bot",
    isMain: true,
  };
  await fs.writeFile(path.join(root, "assets", "config.json"), JSON.stringify(adminConfig), "utf8");

  const registry = {
    "child-bot-1": {
      uid: "child-uid-111",
      name: "child-bot-1",
      displayName: "First Child Bot",
      ownerUid: "owner-alpha",
      webPort: "5551",
      status: "running",
      pid: "1111",
    },
    "child-bot-2": {
      uid: "child-uid-222",
      name: "child-bot-2",
      displayName: "Second Child Bot (Same Owner)",
      ownerUid: "owner-alpha",
      webPort: "5552",
      status: "running",
      pid: "2222",
    },
    "child-bot-3": {
      uid: "child-uid-333",
      name: "child-bot-3",
      displayName: "Third Child Bot (Missing Owner)",
      ownerUid: null,
      webPort: "5553",
      status: "stopped",
      pid: null,
    },
  };
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(registry, null, 2), "utf8");

  return {
    root,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("Task 5: restartBotRuntime returns structured proof including previousPid, botKey, uid, and launch result", async () => {
  const env = await createFixtureProject();
  try {
    // Record mock initial running state
    await updateMyBotRecord("child-bot-1", { pid: "1111", status: "running" }, env.root);

    // Call restartBotRuntime in mock launch mode
    const result = await restartBotRuntime("child-bot-1", {
      projectRoot: env.root,
      env: { TEST_MOCK_LAUNCH: "true" },
    });

    assert.equal(result.success, true);
    assert.equal(result.previousPid, 1111);
    assert.equal(result.botKey, "child-bot-1");
    assert.equal(result.uid, "child-uid-111");
    assert.equal(result.pid, 99999);
  } finally {
    await env.cleanup();
  }
});

test("Task 6: sendNotifyToOwners tracks delivered vs accepted receipts and records audit log", async () => {
  const env = await createFixtureProject();
  try {
    const targets = [
      { key: "child-bot-1", uid: "child-uid-111", displayName: "Bot 1", ownerUid: "owner-alpha" },
      { key: "child-bot-2", uid: "child-uid-222", displayName: "Bot 2", ownerUid: "owner-alpha" }, // duplicate owner
      { key: "child-bot-3", uid: "child-uid-333", displayName: "Bot 3", ownerUid: null, ownerResolution: "missing" }, // missing owner
      { key: "admin", uid: "admin", isMain: true, ownerUid: "admin" }, // main bot - filtered out
    ];

    const sentInvocations = [];
    const mockSendFn = async (ownerUid, text) => {
      sentInvocations.push({ ownerUid, text });
      if (ownerUid === "owner-alpha") {
        return { msgId: "msg-id-alpha-999" };
      }
      return { success: true };
    };

    const report = await sendNotifyToOwners({
      targets,
      messageText: "Test System Maintenance Broadcast",
      sendFn: mockSendFn,
      concurrency: 2,
      projectRoot: env.root,
    });

    // 1. Verification of counts & deduplication
    assert.equal(report.totalChildBots, 3);
    assert.equal(report.totalOwners, 1); // only owner-alpha
    assert.equal(report.successCount, 1);
    assert.equal(report.dedupedCount, 1);
    assert.equal(report.missingOwnerCount, 1);
    assert.equal(report.deliveredCount, 1);
    assert.equal(report.deliveredOwners[0].receipt, "msg-id-alpha-999");
    assert.equal(report.missingOwnerBots[0].key, "child-bot-3");

    // 2. Outbound invocations happened once for owner-alpha
    assert.equal(sentInvocations.length, 1);
    assert.equal(sentInvocations[0].ownerUid, "owner-alpha");

    // 3. Verification of audit log written to logs/owner-notify-audit.jsonl
    const auditFile = path.join(env.root, "logs", "owner-notify-audit.jsonl");
    const auditContent = await fs.readFile(auditFile, "utf8");
    const auditRecords = auditContent.trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(auditRecords.length, 1);
    assert.equal(auditRecords[0].ownerUid, "owner-alpha");
    assert.equal(auditRecords[0].status, "delivered");
    assert.equal(auditRecords[0].receipt, "msg-id-alpha-999");
    assert.deepEqual(auditRecords[0].botKeys, ["child-bot-1", "child-bot-2"]);
  } finally {
    await env.cleanup();
  }
});
