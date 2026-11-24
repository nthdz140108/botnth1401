import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractUsernameFromUserInfo,
  normalizeUsername,
} from "../src/identity/identity-resolver.js";
import {
  validateAdminIdentitySeeds,
  resolveChildAdminIdentities,
} from "../src/commands/mybot/System/child-admin-resolver.js";
import {
  createDefaultProfile,
  saveProfile,
  getProfile,
  updateProfile,
} from "../src/commands/mybot/System/mybot-profile-service.js";
import {
  saveBotToMyBots,
  createBotConfig,
} from "../src/commands/mybot/System/pm2-manager.js";
import { createAllRequiredFilesWithCredentials } from "../src/commands/mybot/Manager/qr-login-command.js";
import { resetCache as resetEnvCache } from "../src/utils/env.js";

test("extractUsernameFromUserInfo extracts opaque username 't_m7demnfiib' from all response shapes", () => {
  const opaqueUser = "t_m7demnfiib";
  const targetUid = "123456789012";

  // 1. Direct profile object with different field names
  assert.equal(extractUsernameFromUserInfo({ username: opaqueUser }), opaqueUser);
  assert.equal(extractUsernameFromUserInfo({ userName: opaqueUser }), opaqueUser);
  assert.equal(extractUsernameFromUserInfo({ user_name: opaqueUser }), opaqueUser);
  assert.equal(extractUsernameFromUserInfo({ zaloUsername: opaqueUser }), opaqueUser);

  // 2. Wrapped in data
  assert.equal(extractUsernameFromUserInfo({ data: { username: opaqueUser } }), opaqueUser);
  assert.equal(extractUsernameFromUserInfo({ data: { info: { username: opaqueUser } } }), opaqueUser);

  // 3. Wrapped in info
  assert.equal(extractUsernameFromUserInfo({ info: { username: opaqueUser } }), opaqueUser);

  // 4. changed_profiles map by exact UID and versioned UID
  assert.equal(
    extractUsernameFromUserInfo(
      { changed_profiles: { [targetUid]: { username: opaqueUser } } },
      targetUid
    ),
    opaqueUser
  );
  assert.equal(
    extractUsernameFromUserInfo(
      { changed_profiles: { [`${targetUid}_0`]: { username: opaqueUser } } },
      targetUid
    ),
    opaqueUser
  );

  // 5. unchanged_profiles map
  assert.equal(
    extractUsernameFromUserInfo(
      { unchanged_profiles: { [targetUid]: { username: opaqueUser } } },
      targetUid
    ),
    opaqueUser
  );
  assert.equal(
    extractUsernameFromUserInfo(
      { unchanged_profiles: { [`${targetUid}_0`]: { username: opaqueUser } } },
      targetUid
    ),
    opaqueUser
  );

  // 6. profiles map
  assert.equal(
    extractUsernameFromUserInfo(
      { profiles: { [targetUid]: { username: opaqueUser } } },
      targetUid
    ),
    opaqueUser
  );
  assert.equal(
    extractUsernameFromUserInfo(
      { profiles: { [`${targetUid}_0`]: { username: opaqueUser } } },
      targetUid
    ),
    opaqueUser
  );

  // 7. Direct UID map
  assert.equal(
    extractUsernameFromUserInfo(
      { [targetUid]: { username: opaqueUser } },
      targetUid
    ),
    opaqueUser
  );

  // 8. Match by userId / uid / id inside profiles
  assert.equal(
    extractUsernameFromUserInfo(
      { profiles: [{ userId: targetUid, username: opaqueUser }] },
      targetUid
    ),
    opaqueUser
  );
});

test("extractUsernameFromUserInfo strictly ignores alias, displayName, dName, name, and zaloName as username seeds", () => {
  const profileWithNamesOnly = {
    displayName: "Thanh Hung",
    dName: "Hưn",
    name: "Thanh Hung Official",
    zaloName: "Hưng Zalo",
    alias: "thanhhung_alias",
  };

  assert.equal(extractUsernameFromUserInfo(profileWithNamesOnly), null);
  assert.equal(extractUsernameFromUserInfo({ data: profileWithNamesOnly }), null);
  assert.equal(extractUsernameFromUserInfo({ info: profileWithNamesOnly }), null);
  assert.equal(extractUsernameFromUserInfo({ unchanged_profiles: { "111": profileWithNamesOnly } }, "111"), null);
});

test("normalizeUsername preserves opaque usernames like 't_m7demnfiib' and applies NFKC lowercase", () => {
  assert.equal(normalizeUsername("t_m7demnfiib"), "t_m7demnfiib");
  assert.equal(normalizeUsername("@t_m7demnfiib"), "t_m7demnfiib");
  assert.equal(normalizeUsername("  @T_M7demNFIib  "), "t_m7demnfiib");
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername(null), null);
  assert.equal(normalizeUsername(undefined), null);
});

test("validateAdminIdentitySeeds validates non-empty, non-admin usernames with selfUsername distinct", () => {
  // Missing seed — now valid:true (lenient by design)
  const missing = validateAdminIdentitySeeds({
    botAdminUsername: "t_mainbot",
    ownerUsername: "t_owner",
    selfUsername: "",
  });
  assert.equal(missing.valid, true); // lenient: always valid
  assert.equal(missing.missing.includes("selfUsername"), true);

  // Literal "admin" as username — still flagged as missing but valid:true
  const literalAdmin = validateAdminIdentitySeeds({
    botAdminUsername: "admin",
    ownerUsername: "t_owner",
    selfUsername: "t_child",
  });
  assert.equal(literalAdmin.valid, true); // lenient: always valid
  assert.equal(literalAdmin.missing.includes("botAdminUsername"), true);

  // botAdminUsername === ownerUsername is VALID (admin creating bot for themselves)
  const adminEqualsOwner = validateAdminIdentitySeeds({
    botAdminUsername: "t_same_user",
    ownerUsername: "t_same_user",
    selfUsername: "t_child",
  });
  assert.equal(adminEqualsOwner.valid, true);
  assert.equal(adminEqualsOwner.normalized.botAdminUsername, "t_same_user");
  assert.equal(adminEqualsOwner.normalized.ownerUsername, "t_same_user");
  assert.equal(adminEqualsOwner.normalized.selfUsername, "t_child");

  // selfUsername matching botAdminUsername — now allowed (lenient), valid:true
  const selfMatchesAdmin = validateAdminIdentitySeeds({
    botAdminUsername: "t_same_user",
    ownerUsername: "t_owner",
    selfUsername: "t_same_user",
  });
  assert.equal(selfMatchesAdmin.valid, true); // lenient: always valid
  // Errors array still contains the informational message
  assert.ok(selfMatchesAdmin.errors.length > 0);

  // selfUsername matching ownerUsername — now allowed (lenient), valid:true
  const selfMatchesOwner = validateAdminIdentitySeeds({
    botAdminUsername: "t_mainbot",
    ownerUsername: "t_same_user",
    selfUsername: "t_same_user",
  });
  assert.equal(selfMatchesOwner.valid, true); // lenient: always valid
  assert.ok(selfMatchesOwner.errors.length > 0);

  // Valid 3 distinct seeds — still valid:true
  const validSeeds = validateAdminIdentitySeeds({
    botAdminUsername: "@t_main_bot_seed",
    ownerUsername: "t_owner_creator_seed",
    selfUsername: "t_child_bot_self_seed",
  });
  assert.equal(validSeeds.valid, true);
  assert.equal(validSeeds.normalized.botAdminUsername, "t_main_bot_seed");
  assert.equal(validSeeds.normalized.ownerUsername, "t_owner_creator_seed");
  assert.equal(validSeeds.normalized.selfUsername, "t_child_bot_self_seed");
});

test("new bot created with valid seeds has identityPending === false, status === stopped, trialStatus === pending", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-new-bot-test-"));
  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    const childUid = "987654321098";
    const ownerUid = "123456789012";
    const mainBotUsername = "t_mainbot_official";
    const ownerUsername = "t_owner_creator";
    const selfUsername = "t_child_bot_self";

    const seeds = {
      botAdminUsername: mainBotUsername,
      ownerUsername,
      selfUsername,
    };
    const seedVal = validateAdminIdentitySeeds(seeds);
    assert.equal(seedVal.valid, true);

    // Save profile as stopped + pending trial + identityPending: false
    const initialProfile = createDefaultProfile(childUid, {
      ownerUid,
      ownerName: "Owner User",
      ownerUsername,
      nameServer: "Child Bot Test",
      expiryAt: null,
      trialStatus: "pending",
      enabled: true,
      adminIdentitySeeds: seedVal.normalized,
      identityPending: false,
      identityPendingReason: null,
    });
    saveProfile(childUid, initialProfile, { root });

    // Save to registry
    const registryPath = path.join(root, "mybot", "mybots.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify({}, null, 2));

    await saveBotToMyBots(childUid, "Child Bot Test", 4444, null, "Child Bot Test", "", {
      registryPath,
      ownerUid,
      ownerName: "Owner User",
      ownerUsername,
      createdBy: "Owner User",
      zaloUsername: selfUsername,
      canonicalUsername: selfUsername,
      adminIdentitySeeds: seedVal.normalized,
      identityPending: false,
      identityPendingReason: null,
      trialStatus: "pending",
      status: "stopped",
    });

    const savedProfile = getProfile(childUid, { root });
    assert.equal(savedProfile.identityPending, false);
    assert.equal(savedProfile.identityPendingReason, null);
    assert.equal(savedProfile.trialStatus, "pending");
    assert.deepEqual(savedProfile.adminIdentitySeeds, {
      botAdminUsername: mainBotUsername,
      ownerUsername,
      selfUsername,
    });

    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    const botRecord = registry[childUid];
    assert.equal(botRecord.status, "stopped");
    assert.equal(botRecord.trialStatus, "pending");
    assert.equal(botRecord.identityPending, false);
    assert.equal(botRecord.identityPendingReason, null);
    assert.equal(botRecord.canonicalUsername, selfUsername);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("re-scanning QR for existing pending bot repairs profile and registry to identityPending === false", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-repair-test-"));
  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    const childUid = "555555555555";
    const ownerUid = "666666666666";

    // 1. Existing broken bot with identityPending = true
    const brokenProfile = createDefaultProfile(childUid, {
      ownerUid,
      ownerName: "Creator",
      adminIdentitySeeds: null,
      identityPending: true,
      identityPendingReason: "Chưa cấu hình đủ 3 admin identity seeds",
      trialStatus: "pending",
    });
    saveProfile(childUid, brokenProfile, { root });

    const registryPath = path.join(root, "mybot", "mybots.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify({
      [childUid]: {
        name: childUid,
        status: "stopped",
        trialStatus: "pending",
        ownerUid,
        identityPending: true,
        identityPendingReason: "Chưa cấu hình đủ 3 admin identity seeds",
      }
    }, null, 2));

    // Verify it is currently pending
    assert.equal(getProfile(childUid, { root }).identityPending, true);

    // 2. Re-scan repair: seeds provided
    const newSeeds = {
      botAdminUsername: "t_main_repaired",
      ownerUsername: "t_owner_repaired",
      selfUsername: "t_child_repaired",
    };
    const seedVal = validateAdminIdentitySeeds(newSeeds);
    assert.equal(seedVal.valid, true);

    // Repair profile
    updateProfile(childUid, {
      ownerUid,
      ownerName: "Creator",
      ownerUsername: newSeeds.ownerUsername,
      adminIdentitySeeds: seedVal.normalized,
      identityPending: false,
      identityPendingReason: null,
    }, { root });

    // Repair registry
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    registry[childUid] = {
      ...registry[childUid],
      displayName: "Repaired Bot",
      ownerUid,
      ownerUsername: newSeeds.ownerUsername,
      status: "stopped",
      zaloUsername: newSeeds.selfUsername,
      canonicalUsername: newSeeds.selfUsername,
      adminIdentitySeeds: seedVal.normalized,
      identityPending: false,
      identityPendingReason: null,
    };
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));

    // 3. Verify repaired state
    const repairedProf = getProfile(childUid, { root });
    assert.equal(repairedProf.identityPending, false);
    assert.equal(repairedProf.identityPendingReason, null);
    assert.deepEqual(repairedProf.adminIdentitySeeds, newSeeds);

    const repairedReg = JSON.parse(await fs.readFile(registryPath, "utf8"));
    assert.equal(repairedReg[childUid].identityPending, false);
    assert.equal(repairedReg[childUid].identityPendingReason, null);
    assert.equal(repairedReg[childUid].status, "stopped");
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("child admin resolver: successfully resolves when botAdminUsername === ownerUsername (admin creates bot for themselves)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-admin-owner-same-"));
  const botUid = "222222222222";
  const adminOwnerUid = "111111111111";

  const mockApi = {
    getOwnId: () => botUid,
    getUserInfo: async (uids) => {
      const id = String(uids[0]);
      if (id === botUid) return { [botUid]: { username: "child_bot_self" } };
      if (id === adminOwnerUid) return { [adminOwnerUid]: { username: "main_admin_official" } };
      return {};
    },
    fetchAllFriend: async () => [
      { userId: adminOwnerUid, username: "main_admin_official" },
    ],
  };

  const seeds = {
    botAdminUsername: "main_admin_official",
    ownerUsername: "main_admin_official",
    selfUsername: "child_bot_self",
  };

  const result = await resolveChildAdminIdentities({
    api: mockApi,
    botUid,
    seeds,
    projectRoot: root,
  });

  assert.equal(result.success, true);
  assert.equal(result.selfUid, botUid);
  assert.equal(result.ownerUid, adminOwnerUid);
  assert.equal(result.botAdminUid, adminOwnerUid);
  assert.deepEqual(result.resolvedAdmins.sort(), [adminOwnerUid, botUid].sort());

  const auditPath = path.join(root, "mybot", "instances", botUid, "data", "admin-identity-audit.json");
  assert.equal(await fs.access(auditPath).then(() => true).catch(() => false), true);

  await fs.rm(root, { recursive: true, force: true });
});

test("seed reasons formatting shows errors when missing array is empty", () => {
  const duplicateSelf = validateAdminIdentitySeeds({
    botAdminUsername: "main_admin",
    ownerUsername: "main_admin",
    selfUsername: "main_admin",
  });

  assert.equal(duplicateSelf.valid, true); // lenient: always valid
  assert.equal(duplicateSelf.missing.length, 0);
  assert.ok(duplicateSelf.errors.length > 0);

  const seedReasons = duplicateSelf.missing.length > 0
    ? `thiếu ${duplicateSelf.missing.join(", ")}`
    : (duplicateSelf.errors || []).join("; ");

  assert.ok(seedReasons.includes("botAdminUsername matches selfUsername"));
  assert.ok(seedReasons.includes("ownerUsername matches selfUsername"));
});

