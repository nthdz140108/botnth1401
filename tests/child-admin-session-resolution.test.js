import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  normalizeUsername,
  validateAdminIdentitySeeds,
  resolveChildAdminIdentities,
} from "../src/commands/mybot/System/child-admin-resolver.js";
import {
  resolveInstanceAuthorization,
  listInstanceSupremeAdmins,
} from "../src/utils/instance-authorization.js";

test("child admin resolver: normalizeUsername strips @, trims, and applies NFKC lowercase", () => {
  assert.equal(normalizeUsername("@Admin_User_1"), "admin_user_1");
  assert.equal(normalizeUsername("  @Trần_Hưng  "), "trần_hưng");
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername(null), null);
});

test("child admin resolver: validateAdminIdentitySeeds reports missing seeds (informational, never fabricates admins)", () => {
  const incomplete = { botAdminUsername: "mainbot", ownerUsername: "owner1" };
  const val1 = validateAdminIdentitySeeds(incomplete);
  assert.equal(val1.valid, true); // never blocks startup
  assert.ok(val1.missing.includes("selfUsername"));
  assert.equal(val1.normalized.selfUsername, null);
  assert.equal(val1.normalized.ownerUsername, "owner1");

  const complete = {
    botAdminUsername: "@Main_Bot_Official",
    ownerUsername: "Owner_Zalo_User",
    selfUsername: "Child_Bot_Zalo",
  };
  const val2 = validateAdminIdentitySeeds(complete);
  assert.equal(val2.valid, true);
  assert.deepEqual(val2.normalized, {
    botAdminUsername: "main_bot_official",
    ownerUsername: "owner_zalo_user",
    selfUsername: "child_bot_zalo",
  });
});

test("child admin resolver: resolves 3 distinct local UIDs from child session API and writes admin-list.json + audit", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "child-admin-test-"));
  const botUid = "222222222222";
  const mainBotUid = "111111111111";
  const ownerUid = "333333333333";

  // Mock child session api
  const mockApi = {
    getOwnId: () => botUid,
    getUserInfo: async (uids) => {
      const id = String(uids[0]);
      if (id === botUid) return { [botUid]: { username: "child_bot_acc" } };
      if (id === mainBotUid) return { [mainBotUid]: { username: "main_bot_acc" } };
      if (id === ownerUid) return { [ownerUid]: { username: "owner_user_acc" } };
      return {};
    },
    fetchAllFriend: async () => [
      { userId: mainBotUid, username: "main_bot_acc" },
      { userId: ownerUid, username: "owner_user_acc" },
    ],
  };

  const seeds = {
    botAdminUsername: "main_bot_acc",
    ownerUsername: "owner_user_acc",
    selfUsername: "child_bot_acc",
  };

  const result = await resolveChildAdminIdentities({
    api: mockApi,
    botUid,
    seeds,
    projectRoot: tmpDir,
  });

  assert.equal(result.success, true);
  assert.equal(result.selfUid, botUid);
  assert.equal(result.ownerUid, ownerUid);
  assert.equal(result.botAdminUid, mainBotUid);
  assert.deepEqual(result.resolvedAdmins.sort(), [mainBotUid, botUid, ownerUid].sort());

  // Check admin-list.json file content
  const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
  assert.equal(fs.existsSync(adminListPath), true);
  const writtenAdmins = JSON.parse(fs.readFileSync(adminListPath, "utf8"));
  assert.deepEqual(writtenAdmins.sort(), [mainBotUid, botUid, ownerUid].sort());

  // Check audit file content
  const auditPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-identity-audit.json");
  assert.equal(fs.existsSync(auditPath), true);
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  assert.equal(audit.status, "verified");
  assert.equal(audit.resolvedUids.ownerUid, ownerUid);

  // Verify profile was updated with identityPending = false and resolvedChildAdminUids
  const { getProfile } = await import("../src/commands/mybot/System/mybot-profile-service.js");
  const updatedProf = getProfile(botUid, { root: tmpDir });
  assert.equal(updatedProf.identityPending, false);
  assert.deepEqual(updatedProf.resolvedChildAdminUids.sort(), [mainBotUid, botUid, ownerUid].sort());
  assert.ok(updatedProf.adminIdentityResolvedAt);

  // Test child instance authorization with the resolved local admin list
  const authMain = resolveInstanceAuthorization({
    senderId: mainBotUid,
    threadId: "group1",
    instanceUid: botUid,
    instanceKind: "child",
    projectRoot: tmpDir,
  });
  assert.equal(authMain.role, "adminLevelHigh");

  const authOwner = resolveInstanceAuthorization({
    senderId: ownerUid,
    threadId: "group1",
    instanceUid: botUid,
    instanceKind: "child",
    projectRoot: tmpDir,
  });
  assert.equal(authOwner.role, "adminLevelHigh");

  const authSelf = resolveInstanceAuthorization({
    senderId: botUid,
    threadId: "group1",
    instanceUid: botUid,
    instanceKind: "child",
    projectRoot: tmpDir,
  });
  assert.equal(authSelf.role, "adminLevelHigh");

  const authRandom = resolveInstanceAuthorization({
    senderId: "999999999999",
    threadId: "group1",
    instanceUid: botUid,
    instanceKind: "child",
    projectRoot: tmpDir,
  });
  assert.equal(authRandom.role, "member");

  // Verify listInstanceSupremeAdmins on child instance contains all 3
  const supremeList = listInstanceSupremeAdmins({
    instanceUid: botUid,
    instanceKind: "child",
    mainBotUid,
    projectRoot: tmpDir,
  });
  const supremeUids = supremeList.map((s) => s.uid);
  assert.equal(supremeUids.includes(mainBotUid), true);
  assert.equal(supremeUids.includes(botUid), true);
  assert.equal(supremeUids.includes(ownerUid), true);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("child admin resolver: does not fail when usernames cannot be resolved — only bot UID remains a Supreme Admin (fail-closed)", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "child-fallback-"));
  const botUid = "222222222222";

  const mockApi = {
    getOwnId: () => botUid,
    getUserInfo: async () => ({}),
    fetchAllFriend: async () => [],
  };

  const seeds = {
    botAdminUsername: "main_bot_acc",
    ownerUsername: "unknown_owner",
    selfUsername: "child_bot_acc",
  };

  const result = await resolveChildAdminIdentities({
    api: mockApi,
    botUid,
    seeds,
    projectRoot: tmpDir,
  });

  // Must NOT throw: bot itself is always a Supreme Admin
  assert.equal(result.success, true);
  assert.equal(result.selfUid, botUid);
  // Unresolved owner / main usernames must NOT copy foreign UIDs; the bot UID
  // remains the sole guaranteed Supreme Admin (fail-closed).
  assert.equal(result.ownerUid, null, "unresolved owner must not fall back to a foreign UID");
  assert.equal(result.botAdminUid, null, "unresolved main-admin must not fall back to owner/self UID");
  assert.deepEqual(result.resolvedAdmins, [botUid]);

  const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
  assert.equal(fs.existsSync(adminListPath), true);
  const writtenAdmins = JSON.parse(fs.readFileSync(adminListPath, "utf8"));
  assert.deepEqual(writtenAdmins, [botUid], "admin list must contain ONLY the verified bot UID");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("child admin resolver: does not fail on duplicate username conflict — bot UID is the only admin (fail-closed)", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "child-conflict-"));
  const botUid = "222222222222";

  const mockApi = {
    getOwnId: () => botUid,
    getUserInfo: async () => ({}),
    fetchAllFriend: async () => [
      { userId: "111111111111", username: "duplicate_user" },
      { userId: "333333333333", username: "duplicate_user" },
    ],
  };

  const seeds = {
    botAdminUsername: "duplicate_user",
    ownerUsername: "owner_acc",
    selfUsername: "child_bot_acc",
  };

  const result = await resolveChildAdminIdentities({
    api: mockApi,
    botUid,
    seeds,
    projectRoot: tmpDir,
  });

  // Identity conflicts must NEVER grant a contested UID high privilege; the bot
  // UID remains the only Supreme Admin (fail-closed).
  assert.equal(result.success, true);
  assert.equal(result.selfUid, botUid);
  assert.ok(!result.resolvedAdmins.includes("111111111111"), "conflicted UID must not be admin");
  assert.ok(!result.resolvedAdmins.includes("333333333333"), "conflicted UID must not be admin");
  assert.deepEqual(result.resolvedAdmins, [botUid]);

  const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
  assert.equal(fs.existsSync(adminListPath), true);
  const writtenAdmins = JSON.parse(fs.readFileSync(adminListPath, "utf8"));
  assert.deepEqual(writtenAdmins, [botUid], "conflicted admin-list must contain only the bot UID");

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
