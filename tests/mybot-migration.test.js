import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateBotProfiles, getProfile } from "../src/commands/mybot/System/mybot-profile-service.js";

test("migrateBotProfiles migrates legacy registry bots without data loss", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migration-test-"));
  await fs.mkdir(path.join(root, "mybot", "instances"), { recursive: true });

  const legacyRegistry = {
    "bot-legacy-1": {
      displayName: "Legacy Alpha",
      createdBy: "Owner A",
      description: "Legacy bot description",
      expiryAt: "2026-12-31T23:59:59.000Z",
    },
    "bot-legacy-2": {
      name: "Legacy Beta",
      ownerUid: "owner-b",
      displayName: "Beta Server",
    },
  };

  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(legacyRegistry));

  const results = migrateBotProfiles({ root });
  assert.equal(results.length, 2);

  const profile1 = getProfile("bot-legacy-1", { root });
  assert.equal(profile1.nameServer, "Legacy Alpha");
  assert.equal(profile1.ownerName, "Owner A");
  assert.equal(profile1.description, "Legacy bot description");
  assert.equal(profile1.trialStatus, "active");

  const profile2 = getProfile("bot-legacy-2", { root });
  assert.equal(profile2.ownerUid, "owner-b");
  assert.equal(profile2.nameServer, "Beta Server");
  assert.equal(profile2.trialStatus, "pending");
});
