import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  checkOwnerCreationQuota,
  commitCreationQuota,
  releaseCreationQuota,
  getOwnerActiveBotCount,
} from "../src/commands/mybot/System/mybot-creation-quota.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "../src/commands/mybot/System/mybots-registry.js";

test("creation quota: counts active bots by ownerUid and enforces limit", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "quota-test-"));
  const registryPath = path.join(tmpDir, "mybot", "mybots.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  const ownerUid = "888888888888";
  const registry = {
    admin: { name: "Main Bot", isMain: true, uid: "111111111111" },
    bot1: { name: "Bot 1", ownerUid, status: "stopped", uid: "bot1" },
    bot2: { name: "Bot 2", ownerUid, status: "running", uid: "bot2" },
    bot3: { name: "Bot 3", ownerUid, status: "rejected", uid: "bot3" }, // rejected should not count
    otherBot: { name: "Other", ownerUid: "999999999999", status: "running", uid: "otherBot" },
  };
  saveMyBotsRegistry(registry, registryPath);

  const count = getOwnerActiveBotCount(ownerUid, { projectRoot: tmpDir, registry });
  assert.equal(count, 2);

  const quota = checkOwnerCreationQuota(ownerUid, { projectRoot: tmpDir, maxBots: 2, registry });
  assert.equal(quota.allowed, false);
  assert.equal(quota.currentCount, 2);
  assert.equal(quota.remaining, 0);

  const quotaAdmin = checkOwnerCreationQuota("admin", { projectRoot: tmpDir, maxBots: 2 });
  assert.equal(quotaAdmin.allowed, true);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("creation quota: commit and release audit trail", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "quota-audit-"));
  const ownerUid = "888888888888";
  const botUid = "222222222222";

  commitCreationQuota(ownerUid, botUid, { projectRoot: tmpDir });
  releaseCreationQuota(ownerUid, botUid, { projectRoot: tmpDir });

  const auditPath = path.join(tmpDir, "mybot", "state", "creation-quota-audit.jsonl");
  assert.equal(fs.existsSync(auditPath), true);
  const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const rec1 = JSON.parse(lines[0]);
  const rec2 = JSON.parse(lines[1]);
  assert.equal(rec1.action, "create_commit");
  assert.equal(rec2.action, "release_quota");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
