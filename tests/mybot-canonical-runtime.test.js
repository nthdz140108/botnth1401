import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  updateMyBotRecord,
  checkSpawnedProcessStatus,
  killSpawnedProcess,
  saveSpawnedPid,
  getSpawnedPid,
  removeSpawnedRecord,
  updateBotStatus,
  checkExistingBot,
  createAllRequiredFiles,
  createBotConfig,
} from "../src/commands/mybot/System/pm2-manager.js";
import {
  resolveBotPaths,
  resolveManagedBotList,
  resolveManagedBotTargetRecord,
} from "../src/commands/mybot/System/mybot-identity.js";
import {
  readChildAdminList,
  writeChildAdminList,
  addChildAdmin,
  removeChildAdmin,
  resolveChildAuthorization,
} from "../src/utils/child-authorization.js";

async function createFixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-canonical-test-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "configs"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "instances", "child-100-real-uid", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });

  const globalHighAdmins = ["global-admin-1", "global-admin-2"];
  await fs.writeFile(path.join(root, "assets", "data", "list_admin_high.json"), JSON.stringify(globalHighAdmins), "utf8");

  const adminConfig = {
    botId: "main-admin-real-uid",
    displayName: "Main Bot",
    isMain: true,
  };
  await fs.writeFile(path.join(root, "assets", "config.json"), JSON.stringify(adminConfig), "utf8");
  await fs.writeFile(path.join(root, "mybot", "state", "admin.json"), JSON.stringify({ uid: "main-admin-real-uid" }), "utf8");

  const registry = {
    admin: {
      isMain: true,
      name: "admin",
      displayName: "Main Admin Bot",
      uid: "main-admin-real-uid",
      webPort: "2000",
      status: "running",
      ownerUid: "admin",
    },
    "alias-child-1": {
      uid: "child-100-real-uid",
      name: "alias-child-1",
      displayName: "First Child Bot",
      ownerUid: "owner-user-1",
      webPort: "4001",
      status: "stopped",
      pid: null,
      consolePid: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  };
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(registry, null, 2), "utf8");

  return {
    root,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("Task 1: updateMyBotRecord updates record using real UID when registry key is alias", async () => {
  const env = await createFixtureProject();
  try {
    // Call updater using real UID "child-100-real-uid" (which differs from key "alias-child-1")
    const updated = await updateMyBotRecord("child-100-real-uid", {
      status: "running",
      pid: "54321",
    }, env.root);

    assert.equal(updated, true);

    const raw = JSON.parse(await fs.readFile(path.join(env.root, "mybot", "mybots.json"), "utf8"));
    assert.equal(raw["alias-child-1"].status, "running");
    assert.equal(raw["alias-child-1"].pid, "54321");
  } finally {
    await env.cleanup();
  }
});

test("Task 1: saveSpawnedPid and getSpawnedPid operate seamlessly on alias keys and real UIDs", async () => {
  const env = await createFixtureProject();
  try {
    await saveSpawnedPid("child-100-real-uid", 12345, env.root);
    const readPidByRealUid = await getSpawnedPid("child-100-real-uid", env.root);
    const readPidByKey = await getSpawnedPid("alias-child-1", env.root);

    assert.equal(readPidByRealUid, 12345);
    assert.equal(readPidByKey, 12345);
  } finally {
    await env.cleanup();
  }
});

test("Task 1: root isolation ensures customRoot does not touch default checkout paths", async () => {
  const env1 = await createFixtureProject();
  const env2 = await createFixtureProject();
  try {
    await updateMyBotRecord("alias-child-1", { status: "running" }, env1.root);
    await updateMyBotRecord("alias-child-1", { status: "maintenance" }, env2.root);

    const raw1 = JSON.parse(await fs.readFile(path.join(env1.root, "mybot", "mybots.json"), "utf8"));
    const raw2 = JSON.parse(await fs.readFile(path.join(env2.root, "mybot", "mybots.json"), "utf8"));

    assert.equal(raw1["alias-child-1"].status, "running");
    assert.equal(raw2["alias-child-1"].status, "maintenance");
  } finally {
    await env1.cleanup();
    await env2.cleanup();
  }
});

test("Task 1: resolveBotPaths recognizes string UID of Main Bot as isMain=true", async () => {
  const env = await createFixtureProject();
  try {
    // Passing "main-admin-real-uid" (string) should resolve isMain=true via admin state/registry
    const paths = resolveBotPaths("main-admin-real-uid", env.root);
    assert.equal(paths.isMain, true);
    assert.equal(paths.canonicalKey, "main-admin-real-uid");
    assert.ok(paths.credentialPath.endsWith(path.join("assets", "config.json")));

    // Passing child real UID resolves isMain=false
    const childPaths = resolveBotPaths("child-100-real-uid", env.root);
    assert.equal(childPaths.isMain, false);
    assert.ok(childPaths.credentialPath.endsWith(path.join("mybot", "credentials", "child-100-real-uid.json")));
  } finally {
    await env.cleanup();
  }
});

test("Task 3: child-local authorization maintains isolated admin list and protects global files", async () => {
  const env = await createFixtureProject();
  try {
    const childUid = "child-100-real-uid";

    // 1. Initial child admin list
    const initialAdmins = readChildAdminList(childUid, { projectRoot: env.root });
    assert.deepEqual(initialAdmins, []);

    // 2. Add local admin for child bot
    const afterAdd = addChildAdmin(childUid, "local-mod-999", { projectRoot: env.root });
    assert.deepEqual(afterAdd, ["local-mod-999"]);

    // Verify written to child instance data directory
    const storedList = JSON.parse(await fs.readFile(path.join(env.root, "mybot", "instances", childUid, "data", "admin-list.json"), "utf8"));
    assert.deepEqual(storedList, ["local-mod-999"]);

    // Verify global high-admin file in assets/data is completely unmodified!
    const globalHigh = JSON.parse(await fs.readFile(path.join(env.root, "assets", "data", "list_admin_high.json"), "utf8"));
    assert.deepEqual(globalHigh, ["global-admin-1", "global-admin-2"]);

    // 3. Test resolveChildAuthorization
    // Case A: Global high admin
    const authGlobalHigh = resolveChildAuthorization({
      childUid,
      actorUid: "global-admin-1",
      projectRoot: env.root,
    });
    assert.equal(authGlobalHigh.role, "adminLevelHigh");
    assert.equal(authGlobalHigh.isAdminLevelHigh, true);
    assert.equal(authGlobalHigh.isMainBotAdmin, true);

    // Case B: Child bot owner
    const authOwner = resolveChildAuthorization({
      childUid,
      actorUid: "owner-user-1",
      projectRoot: env.root,
    });
    assert.equal(authOwner.role, "adminBot");
    assert.equal(authOwner.isOwner, true);
    assert.equal(authOwner.isBotAdmin, true);

    // Case C: Child local admin
    const authLocalMod = resolveChildAuthorization({
      childUid,
      actorUid: "local-mod-999",
      projectRoot: env.root,
    });
    assert.equal(authLocalMod.role, "adminBot");
    assert.equal(authLocalMod.isBotAdmin, true);

    // Case D: Regular user
    const authUser = resolveChildAuthorization({
      childUid,
      actorUid: "stranger-123",
      projectRoot: env.root,
    });
    assert.equal(authUser.role, "user");
    assert.equal(authUser.isBotAdmin, false);

    // 4. Remove local admin
    const afterRemove = removeChildAdmin(childUid, "local-mod-999", { projectRoot: env.root });
    assert.deepEqual(afterRemove, []);
  } finally {
    await env.cleanup();
  }
});
