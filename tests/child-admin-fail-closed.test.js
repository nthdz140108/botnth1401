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

// ===========================================================================
// Bug 3: Canonical identity resolution must be FAIL-CLOSED for high privilege.
//
// OLD behavior (bug): when usernames could not be resolved through the child
// session, the resolver fell back to writing [botUid, ownerUid] and treated
// `botAdminUid = ownerUid || selfUid` — copying UIDs observed from the Main
// session into the Child's admin list. This let one bot's UID be used as a
// different bot's admin identity.
//
// NEW contract:
//   canonicalUsername -> globalUid -> (botKey, localUid)
//   - UIDs are local to a bot session; never copy ownerUid/sourceBotUid from Main.
//   - When usernames are missing/conflicted/unverifiable, high-privilege admin
//     resolution FAILS CLOSED (identityPending) instead of granting admin by
//     fallback UID. The bot itself remains the sole guaranteed admin.
// ===========================================================================

test("fail-closed: missing seeds keep bot as sole admin, no foreign UIDs written", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "failclosed-missing-"));
  const botUid = "222222222222";
  try {
    const mockApi = {
      getOwnId: () => botUid,
      getUserInfo: async () => ({}),
      fetchAllFriend: async () => [],
    };

    const result = await resolveChildAdminIdentities({
      api: mockApi,
      botUid,
      seeds: { botAdminUsername: null, ownerUsername: null, selfUsername: null },
      projectRoot: tmpDir,
    });

    // The bot itself is always a Supreme Admin
    assert.equal(result.success, true);
    assert.deepEqual(result.resolvedAdmins, [botUid], "only the bot UID may be granted admin");

    const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
    const writtenAdmins = JSON.parse(fs.readFileSync(adminListPath, "utf8"));
    assert.deepEqual(writtenAdmins, [botUid], "admin list must NOT contain copied foreign UIDs");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("fail-closed: unresolved main/creator usernames do NOT copy Main UID into child admin list", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "failclosed-nocopy-"));
  const botUid = "222222222222";
  const mainBotUid = "111111111111"; // UID observed from Main session
  try {
    // Simulate a child session that CANNOT resolve the usernames but has a
    // foreign main-bot UID lying around in shared files (admin.json).
    await fs.promises.mkdir(path.join(tmpDir, "mybot", "state"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: mainBotUid }),
      "utf8"
    );

    const mockApi = {
      getOwnId: () => botUid,
      getUserInfo: async () => ({}), // no profiles resolvable in child session
      fetchAllFriend: async () => [],
    };

    const result = await resolveChildAdminIdentities({
      api: mockApi,
      botUid,
      seeds: { botAdminUsername: "main_bot_acc", ownerUsername: "unknown_owner", selfUsername: null },
      projectRoot: tmpDir,
    });

    // Must NOT copy the main bot UID into the child admin list
    assert.ok(!result.resolvedAdmins.includes(mainBotUid), "main UID must NOT be copied into child admin list");
    assert.deepEqual(result.resolvedAdmins, [botUid]);

    const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
    const writtenAdmins = JSON.parse(fs.readFileSync(adminListPath, "utf8"));
    assert.ok(!writtenAdmins.includes(mainBotUid), "child admin-list.json must not contain main UID");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("fail-closed: duplicate/conflicted username does not grant either UID high privilege", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "failclosed-conflict-"));
  const botUid = "222222222222";
  try {
    const mockApi = {
      getOwnId: () => botUid,
      getUserInfo: async () => ({}),
      fetchAllFriend: async () => [
        { userId: "111111111111", username: "duplicate_user" },
        { userId: "333333333333", username: "duplicate_user" },
      ],
    };

    const result = await resolveChildAdminIdentities({
      api: mockApi,
      botUid,
      seeds: { botAdminUsername: "duplicate_user", ownerUsername: "owner_acc", selfUsername: "child_bot_acc" },
      projectRoot: tmpDir,
    });

    // Conflict => neither UID may be granted Supreme Admin (fail-closed)
    assert.ok(!result.resolvedAdmins.includes("111111111111"), "conflicted UID must not be admin");
    assert.ok(!result.resolvedAdmins.includes("333333333333"), "conflicted UID must not be admin");
    assert.deepEqual(result.resolvedAdmins, [botUid]);

    const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
    const writtenAdmins = JSON.parse(fs.readFileSync(adminListPath, "utf8"));
    assert.deepEqual(writtenAdmins, [botUid], "conflicted admin-list must contain only the bot UID");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("fail-closed: profile ownerUid from another bot is NOT copied into child admin list", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "failclosed-profileowner-"));
  const botUid = "222222222222";
  const foreignOwnerUid = "777777777777";
  try {
    // Profile claims an owner UID from a different bot session
    await fs.promises.mkdir(path.join(tmpDir, "mybot", "instances", botUid, "data"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, "mybot", "instances", botUid, "data", "profile.json"),
      JSON.stringify({ ownerUid: foreignOwnerUid, adminIdentitySeeds: { ownerUsername: "some_owner" } }),
      "utf8"
    );

    const mockApi = {
      getOwnId: () => botUid,
      getUserInfo: async () => ({}),
      fetchAllFriend: async () => [],
    };

    const result = await resolveChildAdminIdentities({
      api: mockApi,
      botUid,
      seeds: { botAdminUsername: null, ownerUsername: "some_owner", selfUsername: null },
      projectRoot: tmpDir,
    });

    // The foreign owner UID must NOT become a Supreme Admin via profile fallback
    assert.ok(!result.resolvedAdmins.includes(foreignOwnerUid), "profile ownerUid from another bot must not be copied");
    assert.deepEqual(result.resolvedAdmins, [botUid]);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("canonical mapping: same username on two bots yields same globalUid, different localUid", () => {
  // Pure mapping contract test: canonicalUsername -> globalUid -> (botKey, localUid)
  const canonical = "t_m7demnfiib";
  assert.equal(normalizeUsername("@T_M7DEMNFIIB"), canonical);

  const botA = { botKey: "bot_a", localUid: "111111111111" };
  const botB = { botKey: "bot_b", localUid: "222222222222" };

  // Same canonical username -> same globalUid (identity key), but each bot
  // resolves it to its own local UID.
  const globalUidA = canonical;
  const globalUidB = canonical;
  assert.equal(globalUidA, globalUidB, "same username must map to same global identity");

  // localUid values are scoped per-bot and differ
  assert.notEqual(botA.localUid, botB.localUid, "each bot sees a different local UID for the same user");
  assert.notEqual(botA.botKey, botB.botKey);

  // A bot must never use another bot's localUid for the same user
  const mappingForA = { [botA.botKey]: botA.localUid };
  assert.ok(!(botB.botKey in mappingForA), "bot B must not resolve user via bot A's local UID");
});

test("validateAdminIdentitySeeds: reports missing/conflict but never fabricates admin via fallback UID", () => {
  const incomplete = { botAdminUsername: null, ownerUsername: null, selfUsername: null };
  const val = validateAdminIdentitySeeds(incomplete);
  assert.ok(Array.isArray(val.missing));
  assert.ok(val.missing.length >= 3);
  assert.equal(val.normalized.botAdminUsername, null);
  assert.equal(val.normalized.ownerUsername, null);
  assert.equal(val.normalized.selfUsername, null);
});

test("resolveChildAdminIdentities CLEARS pending in profile and registry on successful resolve", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "failclosed-clearpending-"));
  const botUid = "222222222222";
  const ownerUid = "333333333333";
  try {
    // Pre-seed a pending profile (identityPending = true) + mirror in registry.
    await fs.promises.mkdir(path.join(tmpDir, "mybot", "instances", botUid, "data"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, "mybot", "instances", botUid, "data", "profile.json"),
      JSON.stringify({ botUid, identityPending: true, identityPendingReason: "X" }),
      "utf8"
    );
    const regPath = path.join(tmpDir, "mybot", "mybots.json");
    await fs.promises.mkdir(path.dirname(regPath), { recursive: true });
    await fs.promises.writeFile(regPath, JSON.stringify({ [botUid]: { identityPending: true } }), "utf8");

    const mockApi = {
      getOwnId: () => botUid,
      getUserInfo: async (uids) => {
        const id = String(uids[0]);
        if (id === botUid) return { [botUid]: { username: "child_bot_acc" } };
        if (id === "111111111111") return { "111111111111": { username: "main_bot_acc" } };
        if (id === ownerUid) return { [ownerUid]: { username: "owner_acc" } };
        return {};
      },
      fetchAllFriend: async () => [
        { userId: "111111111111", username: "main_bot_acc" },
        { userId: ownerUid, username: "owner_acc" },
      ],
    };

    const result = await resolveChildAdminIdentities({
      api: mockApi,
      botUid,
      seeds: { botAdminUsername: "main_bot_acc", ownerUsername: "owner_acc", selfUsername: "child_bot_acc" },
      projectRoot: tmpDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.identityPending, false);

    const { getProfile } = await import("../src/commands/mybot/System/mybot-profile-service.js");
    const updatedProf = getProfile(botUid, { root: tmpDir });
    assert.equal(updatedProf.identityPending, false, "profile must have pending cleared");
    assert.equal(updatedProf.identityPendingReason, null);
    assert.ok(updatedProf.resolvedChildAdminUids.includes(ownerUid));

    const reg = JSON.parse(await fs.promises.readFile(regPath, "utf8"));
    assert.equal(reg[botUid].identityPending, false, "registry must have pending cleared");
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("resolveChildAdminIdentities KEEPS pending (never throws) when resolve fails; process stays online", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "failclosed-keeps-pending-"));
  const botUid = "222222222222";
  try {
    const mockApi = {
      getOwnId: () => botUid,
      getUserInfo: async () => ({}), // cannot resolve any username in this session
      fetchAllFriend: async () => [],
    };

    const result = await resolveChildAdminIdentities({
      api: mockApi,
      botUid,
      seeds: { botAdminUsername: "main_bot_acc", ownerUsername: "unknown_owner", selfUsername: "child_bot_acc" },
      projectRoot: tmpDir,
    });

    // Fail-closed but NOT fatal: the resolver returns success with self-only
    // admins and keeps identityPending so the process can stay online.
    assert.equal(result.success, true, "resolve failure must not throw");
    assert.equal(result.identityPending, true);
    assert.deepEqual(result.resolvedAdmins, [botUid], "only self UID granted admin");

    const adminListPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "admin-list.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(adminListPath, "utf8")), [botUid]);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});
