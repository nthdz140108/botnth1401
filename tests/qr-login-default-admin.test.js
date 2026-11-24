import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBotRuntimeContext,
  getInitialAdminList,
  seedRuntimeFiles,
} from "../src/utils/bot-runtime-context.js";
import { createAllRequiredFiles, createBotConfig } from "../src/commands/mybot/System/pm2-manager.js";
import { initAdminHandle } from "../src/commands/bot-manager/init-admin.js";
import { appContext } from "../src/api-zalo/context.js";
import { resetCache as resetEnvCache } from "../src/utils/env.js";

test("getInitialAdminList includes Main Bot accounts from state and global files for Main Bot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-admin-test-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });

  await fs.writeFile(
    path.join(root, "mybot", "state", "admin.json"),
    JSON.stringify({ uid: "admin-bot-uid-123" }),
  );
  await fs.writeFile(
    path.join(root, "assets", "data", "list_admin.json"),
    JSON.stringify(["global-admin-456"]),
  );

  const initialAdminsMain = getInitialAdminList("admin", root);
  assert.equal(initialAdminsMain.includes("admin-bot-uid-123"), true, "Must include admin bot UID from admin.json for main bot");
  assert.equal(initialAdminsMain.includes("global-admin-456"), true, "Must include global admin UID from list_admin.json for main bot");

  // For child bot, getInitialAdminList must NOT leak global admin files
  const initialAdminsChild = getInitialAdminList("new-child-bot-789", root);
  assert.equal(initialAdminsChild.includes("global-admin-456"), false, "Child bot must NOT inherit global admin list");
});

test("getInitialAdminList is resilient against missing state, broken JSON, or empty UIDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-admin-broken-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });

  // Corrupted JSON in admin.json
  await fs.writeFile(
    path.join(root, "mybot", "state", "admin.json"),
    "{ invalid json content !!!",
  );

  const adminsBrokenJson = getInitialAdminList("admin", root);
  assert.equal(Array.isArray(adminsBrokenJson), true);
  assert.equal(adminsBrokenJson.includes("admin"), false);

  // Empty UID in admin.json
  await fs.writeFile(
    path.join(root, "mybot", "state", "admin.json"),
    JSON.stringify({ uid: "   ", botUid: "" }),
  );
  const adminsEmptyUid = getInitialAdminList("admin", root);
  assert.equal(Array.isArray(adminsEmptyUid), true);
  assert.equal(adminsEmptyUid.includes(""), false);
  assert.equal(adminsEmptyUid.includes("   "), false);

  // Missing state dir entirely
  const nonExistentRoot = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
  const adminsNoDir = getInitialAdminList("admin", nonExistentRoot);
  assert.deepEqual(adminsNoDir, []);
});

test("getInitialAdminList for Main Bot reads from registry, role-registry, and global admin files with deduplication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-admin-registry-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });

  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      admin: { uid: "registry-admin-100", status: "running" },
      mainBot: { uid: "registry-main-200", isMain: true },
    }),
  );
  await fs.writeFile(
    path.join(root, "mybot", "role-registry.json"),
    JSON.stringify({
      adminBotId: "role-admin-300",
      primaryBotId: "role-primary-400",
    }),
  );
  await fs.writeFile(
    path.join(root, "assets", "data", "list_admin.json"),
    JSON.stringify(["global-admin-1", "duplicate-uid-999", "admin"]),
  );
  await fs.writeFile(
    path.join(root, "assets", "json-data", "list_admin.json"),
    JSON.stringify(["legacy-global-2", "duplicate-uid-999", ""]),
  );

  const admins = getInitialAdminList("admin", root);

  assert.equal(admins.includes("registry-admin-100"), true);
  assert.equal(admins.includes("registry-main-200"), true);
  assert.equal(admins.includes("role-admin-300"), true);
  assert.equal(admins.includes("role-primary-400"), true);
  assert.equal(admins.includes("global-admin-1"), true);
  assert.equal(admins.includes("legacy-global-2"), true);
  assert.equal(admins.includes("admin"), false, "Literal 'admin' placeholder must be excluded");
});

test("createAllRequiredFiles creates instance structure and isolates child bot admin files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-create-files-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    await fs.writeFile(
      path.join(root, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "admin-master-uid" }),
    );

    const botUid = "new-bot-uid-111";
    const botConfig = createBotConfig(botUid, 4444);
    const args = ["create", "test-imei", JSON.stringify({ zpw_sek: "test" })];

    await createAllRequiredFiles(botUid, args, botConfig);

    const adminConfigFile = path.join(root, botConfig.adminFilePath);
    assert.equal(await fs.access(adminConfigFile).then(() => true).catch(() => false), true);

    const runtimeContext = createBotRuntimeContext({ uid: botUid, ...botConfig });
    assert.equal(await fs.access(runtimeContext.adminListPath).then(() => true).catch(() => false), true);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
  }
});

test("initAdminHandle does not block child bot startup: fallback writes bot UID as Supreme Admin when seeds missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "init-admin-test-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "configs"), { recursive: true });
  const previousProjectRoot = process.env.PROJECT_ROOT;
  const previousConfigPath = process.env.CONFIG_PATH;
  const previousBotName = process.env.BOT_NAME;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    const botUid = "child-bot-uid-222";
    const botConfig = createBotConfig(botUid, 4445);
    const botConfigPath = path.join(root, "mybot", "bots", `${botUid}.json`);
    await fs.mkdir(path.dirname(botConfigPath), { recursive: true });
    await fs.writeFile(botConfigPath, JSON.stringify(botConfig, null, 2));

    process.env.CONFIG_PATH = botConfigPath;
    process.env.BOT_NAME = botUid;
    appContext.uid = botUid;
    resetEnvCache();

    // 1. Without identity seeds, child bot must NOT fail — fallback writes bot UID as admin
    const mockApiFail = {
      is_main_bot: false,
      getOwnId: () => botUid,
    };
    await initAdminHandle(mockApiFail);

    const runtimeContext = createBotRuntimeContext({ uid: botUid, ...botConfig });
    assert.equal(await fs.access(runtimeContext.adminListPath).then(() => true).catch(() => false), true, "Runtime admin list must exist after fallback");
    const fallbackAdmins = JSON.parse(await fs.readFile(runtimeContext.adminListPath, "utf8"));
    assert.equal(fallbackAdmins.includes(botUid), true, "Fallback must write bot UID as admin");

    // 2. With valid identity seeds and API session, child bot successfully resolves 3 local UIDs
    const mainBotUid = "111111111111";
    const ownerUid = "333333333333";
    const mockApiSuccess = {
      is_main_bot: false,
      getOwnId: () => botUid,
      getUserInfo: async (uids) => {
        const id = String(uids[0]);
        if (id === botUid) return { [botUid]: { username: "child_acc" } };
        if (id === mainBotUid) return { [mainBotUid]: { username: "main_acc" } };
        if (id === ownerUid) return { [ownerUid]: { username: "owner_acc" } };
        return {};
      },
      fetchAllFriend: async () => [
        { userId: mainBotUid, username: "main_acc" },
        { userId: ownerUid, username: "owner_acc" },
      ],
    };

    const seeds = {
      botAdminUsername: "main_acc",
      ownerUsername: "owner_acc",
      selfUsername: "child_acc",
    };

    // Save profile with seeds
    const { saveProfile, createDefaultProfile } = await import("../src/commands/mybot/System/mybot-profile-service.js");
    saveProfile(botUid, createDefaultProfile(botUid, {
      ownerUid,
      adminIdentitySeeds: seeds,
      identityPending: false,
    }), { root });

    await initAdminHandle(mockApiSuccess);

    const runtimeContext2 = createBotRuntimeContext({ uid: botUid, ...botConfig });
    const runtimeAdmins = JSON.parse(await fs.readFile(runtimeContext2.adminListPath, "utf8"));
    assert.deepEqual(runtimeAdmins.sort(), [mainBotUid, botUid, ownerUid].sort());
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    if (previousConfigPath === undefined) {
      delete process.env.CONFIG_PATH;
    } else {
      process.env.CONFIG_PATH = previousConfigPath;
    }
    if (previousBotName === undefined) {
      delete process.env.BOT_NAME;
    } else {
      process.env.BOT_NAME = previousBotName;
    }
    appContext.uid = null;
    resetEnvCache();
  }
});
