import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveManagedBotList,
  resolveManagedBotTarget,
} from "../src/commands/mybot/System/mybot-identity.js";
import { saveMyBotsRegistry } from "../src/commands/mybot/System/mybots-registry.js";
import { saveProfile, createDefaultProfile } from "../src/commands/mybot/System/mybot-profile-service.js";

test("owner visibility: regular users only see their owned bots, admin sees all", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "visibility-test-"));
  const registryPath = path.join(tmpDir, "mybot", "mybots.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  const owner1 = "111111111111";
  const owner2 = "222222222222";

  const seeds = {
    botAdminUsername: "main_bot",
    ownerUsername: "user1",
    selfUsername: "child1",
  };

  const registry = {
    admin: { name: "Main Bot", isMain: true, uid: "main1" },
    bot1: { name: "Bot 1", ownerUid: owner1, status: "stopped", uid: "bot1", adminIdentitySeeds: seeds },
    bot2: { name: "Bot 2", ownerUid: owner1, status: "running", uid: "bot2", adminIdentitySeeds: seeds },
    bot3: { name: "Bot 3", ownerUid: owner2, status: "running", uid: "bot3", adminIdentitySeeds: seeds },
    pendingBot: { name: "Pending", ownerUid: owner1, status: "stopped", uid: "pendingBot", identityPending: true },
  };
  saveMyBotsRegistry(registry, registryPath);

  for (const [k, v] of Object.entries(registry)) {
    if (k === "admin") continue;
    const prof = createDefaultProfile(v.uid, {
      ownerUid: v.ownerUid,
      adminIdentitySeeds: v.adminIdentitySeeds,
      identityPending: v.identityPending,
    });
    saveProfile(v.uid, prof, { root: tmpDir });
  }

  // 1. Regular user owner1 list with includePending: true (default for list and showinfo)
  const user1ListDefault = resolveManagedBotList({
    projectRoot: tmpDir,
    registry,
    ownerUid: owner1,
    includeMain: false,
    includePending: true,
  });
  assert.equal(user1ListDefault.length, 3);
  assert.deepEqual(user1ListDefault.map((b) => b.uid), ["bot1", "bot2", "pendingBot"]);

  // User 2 only sees bot3 (isolated from user 1)
  const user2List = resolveManagedBotList({
    projectRoot: tmpDir,
    registry,
    ownerUid: owner2,
    includeMain: false,
    includePending: true,
  });
  assert.equal(user2List.length, 1);
  assert.equal(user2List[0].uid, "bot3");

  // If includePending is explicitly false:
  const user1ListNoPending = resolveManagedBotList({
    projectRoot: tmpDir,
    registry,
    ownerUid: owner1,
    includeMain: false,
    includePending: false,
  });
  assert.equal(user1ListNoPending.length, 2);
  assert.deepEqual(user1ListNoPending.map((b) => b.uid), ["bot1", "bot2"]);

  // 2. Admin list
  const adminList = resolveManagedBotList({
    projectRoot: tmpDir,
    registry,
    includeMain: true,
    includePending: true,
  });
  assert.equal(adminList.length, 5);

  // 3. Selector index resolution for regular user vs admin
  // For user1: index 1 -> bot1, index 2 -> bot2, index 3 -> pendingBot
  const target1 = resolveManagedBotTarget({
    selector: { type: "index", value: 1 },
    registry,
    callerUid: owner1,
    isSystemAdmin: false,
    projectRoot: tmpDir,
  });
  assert.equal(target1.length, 1);
  assert.equal(target1[0].uid, "bot1");

  const target2 = resolveManagedBotTarget({
    selector: { type: "index", value: 2 },
    registry,
    callerUid: owner1,
    isSystemAdmin: false,
    projectRoot: tmpDir,
  });
  assert.equal(target2.length, 1);
  assert.equal(target2[0].uid, "bot2");

  const target3 = resolveManagedBotTarget({
    selector: { type: "index", value: 3 },
    registry,
    callerUid: owner1,
    isSystemAdmin: false,
    projectRoot: tmpDir,
  });
  assert.equal(target3.length, 1);
  assert.equal(target3[0].uid, "pendingBot");

  // User 1 cannot access bot3 via index 4
  const targetOutOfRange = resolveManagedBotTarget({
    selector: { type: "index", value: 4 },
    registry,
    callerUid: owner1,
    isSystemAdmin: false,
    projectRoot: tmpDir,
  });
  assert.equal(targetOutOfRange.length, 0);

  // Admin index 1 resolves to Main Bot
  const adminTarget1 = resolveManagedBotTarget({
    selector: { type: "index", value: 1 },
    registry,
    callerUid: "admin",
    isSystemAdmin: true,
    projectRoot: tmpDir,
  });
  assert.equal(adminTarget1.length, 1);
  assert.equal(adminTarget1[0].isMain, true);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
