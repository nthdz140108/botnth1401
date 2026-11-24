import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AUTH_SOURCES,
  inferInstanceKind,
  listInstanceSupremeAdmins,
  resolveInstanceAuthorization,
  resolveMainBotUid,
} from "../src/utils/instance-authorization.js";

async function makeAuthWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instance-auth-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  // main instance workspace: the deployment's operator list (no ghost-high!)
  await fs.mkdir(path.join(root, "mybot", "instances", "admin", "data"), { recursive: true });
  await fs.writeFile(
    path.join(root, "mybot", "instances", "admin", "data", "admin-list.json"),
    JSON.stringify(["main-1"]),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "mybot", "state", "admin.json"),
    JSON.stringify({ uid: "main-1" }),
    "utf8",
  );
  const highFilePath = path.join(root, "assets", "data", "list_admin_high.json");
  const highCommandPath = path.join(root, "assets", "data", "list_admin_high_command.json");
  await fs.writeFile(highFilePath, JSON.stringify(["ghost-high"]), "utf8");
  await fs.writeFile(highCommandPath, JSON.stringify([]), "utf8");

  const mkChildOverrides = (botUid) => ({
    highFilePath,
    highCommandPath,
    botAdminsPath: path.join(root, "mybot", "instances", botUid, "data", "admin-list.json"),
  });

  const child1Overrides = mkChildOverrides("child-1");
  await fs.mkdir(path.dirname(child1Overrides.botAdminsPath), { recursive: true });
  await fs.writeFile(child1Overrides.botAdminsPath, JSON.stringify(["child-admin"]), "utf8");
  await fs.writeFile(
    path.join(root, "mybot", "instances", "child-1", "data", "profile.json"),
    JSON.stringify({ identityPending: false }),
    "utf8",
  );
  await fs.mkdir(path.join(root, "mybot", "instances", "main-1", "data"), { recursive: true });
  await fs.writeFile(
    path.join(root, "mybot", "instances", "main-1", "data", "profile.json"),
    JSON.stringify({ identityPending: false }),
    "utf8",
  );

  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
    childResolve: ({ senderId, threadId = "", groupSettings = {}, instanceUid = "child-1", instanceKind = "child" } = {}) =>
      resolveInstanceAuthorization({
        senderId,
        threadId,
        groupSettings,
        instanceUid,
        instanceKind,
        mainBotUid: "main-1",
        projectRoot: root,
        overrides: mkChildOverrides(instanceUid),
      }),
    groupSettings: {
      "g-1": { adminList: { "box-admin": "Box Admin" } },
      "g-2": { adminList: {} },
    },
  };
}

test("child instance: own UID and real main-bot UID are the only supreme admins", async (t) => {
  const world = await makeAuthWorld();
  try {
    const self = world.childResolve({ senderId: "child-1" });
    assert.equal(self.role, "adminLevelHigh");
    assert.equal(self.source, AUTH_SOURCES.INSTANCE_SELF);
    assert.equal(self.isAdminLevelHigh, true);
    assert.equal(self.isBotAdmin, true);
    assert.equal(self.isGroupAdmin, true);

    const main = world.childResolve({ senderId: "main-1" });
    assert.equal(main.role, "adminLevelHigh");
    assert.equal(main.source, AUTH_SOURCES.MAIN_BOT);
    assert.equal(main.isMainBotAdmin, true);
  } finally {
    await world.cleanup();
  }
});

test("child precedence: main-bot UID ranks above self when identities overlap", async (t) => {
  const world = await makeAuthWorld();
  try {
    // sender matches both the main-bot UID and the configured self UID
    const overlapping = world.childResolve({
      senderId: "main-1",
      instanceUid: "main-1",
      instanceKind: "child",
    });
    assert.equal(overlapping.isAdminLevelHigh, true);
    assert.equal(overlapping.source, AUTH_SOURCES.MAIN_BOT, "MAIN-BOT must win over INSTANCE_SELF");
  } finally {
    await world.cleanup();
  }
});

test("child instance: global high admins do not leak into child supreme tier", async (t) => {
  const world = await makeAuthWorld();
  try {
    const fileHigh = world.childResolve({ senderId: "ghost-high" });
    assert.equal(fileHigh.role, "member");
    assert.equal(fileHigh.isAdminLevelHigh, false);
    assert.equal(fileHigh.isBotAdmin, false);

    const outsider = world.childResolve({ senderId: "random-outsider" });
    assert.equal(outsider.role, "member");
    assert.equal(outsider.isAdminLevelHigh, false);
    assert.equal(outsider.isBotAdmin, false);

    // separately assigned to this child's admin list
    const promoted = world.childResolve({ senderId: "child-admin" });
    assert.equal(promoted.role, "adminBot");
    assert.equal(promoted.source, AUTH_SOURCES.INSTANCE_ADMIN_LIST);
    assert.equal(promoted.isAdminLevelHigh, false);
    assert.equal(promoted.isBotAdmin, true);
  } finally {
    await world.cleanup();
  }
});

test("child instance: box admin only holds power inside its own group", async (t) => {
  const world = await makeAuthWorld();
  try {
    const inGroup = world.childResolve({
      senderId: "box-admin",
      threadId: "g-1",
      groupSettings: world.groupSettings,
    });
    assert.equal(inGroup.role, "adminBox");
    assert.equal(inGroup.source, AUTH_SOURCES.BOX_ADMIN_LIST);
    assert.equal(inGroup.isGroupAdmin, true);
    assert.equal(inGroup.isBotAdmin, false);

    const otherGroup = world.childResolve({
      senderId: "box-admin",
      threadId: "g-2",
      groupSettings: world.groupSettings,
    });
    assert.equal(otherGroup.role, "member");
  } finally {
    await world.cleanup();
  }
});

test("main instance keeps legacy four-tier behaviour for the same UIDs", async (t) => {
  const world = await makeAuthWorld();
  try {
    const base = {
      instanceUid: "main-1",
      instanceKind: "main",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
        botAdminsPath: path.join(world.root, "mybot", "instances", "main-1", "data", "admin-list.json"),
      },
    };
    await fs.mkdir(path.dirname(base.overrides.botAdminsPath), { recursive: true });
    await fs.writeFile(base.overrides.botAdminsPath, JSON.stringify(["main-bot-admin"]), "utf8");

    const self = resolveInstanceAuthorization({ senderId: "main-1", ...base });
    assert.equal(self.role, "adminLevelHigh");
    assert.equal(self.source, AUTH_SOURCES.INSTANCE_SELF);
    assert.equal(self.isMainBotAdmin, true);

    const fileHigh = resolveInstanceAuthorization({ senderId: "ghost-high", ...base });
    assert.equal(fileHigh.role, "adminLevelHigh");
    assert.equal(fileHigh.source, AUTH_SOURCES.GLOBAL_HIGH_FILE);
    assert.equal(fileHigh.isMainBotAdmin, true, "on main, global highs stay main operators");

    const botAdmin = resolveInstanceAuthorization({ senderId: "main-bot-admin", ...base });
    assert.equal(botAdmin.role, "adminBot");

    const boxAdmin = resolveInstanceAuthorization({
      senderId: "box-admin",
      threadId: "g-1",
      groupSettings: world.groupSettings,
      ...base,
    });
    assert.equal(boxAdmin.role, "adminBox");

    const member = resolveInstanceAuthorization({ senderId: "random-user", ...base });
    assert.equal(member.role, "member");
  } finally {
    await world.cleanup();
  }
});

test("no cross-child bypass between two child instances", async (t) => {
  const world = await makeAuthWorld();
  try {
    const crossChild = world.childResolve({
      senderId: "child-1",
      instanceUid: "child-2",
      instanceKind: "child",
    });
    assert.equal(crossChild.role, "member");
    assert.equal(crossChild.isAdminLevelHigh, false);
  } finally {
    await world.cleanup();
  }
});

test("inferInstanceKind and resolveMainBotUid derive identity from persisted state", async (t) => {
  const world = await makeAuthWorld();
  try {
    assert.equal(resolveMainBotUid({ projectRoot: world.root }), "main-1");
    assert.equal(inferInstanceKind("child-1", { projectRoot: world.root, mainBotUid: "main-1" }), "child");
    assert.equal(inferInstanceKind("main-1", { projectRoot: world.root, mainBotUid: "main-1" }), "main");
    assert.equal(inferInstanceKind("admin", { projectRoot: world.root }), "main");
    // fresh install without any persisted identity behaves as legacy single instance
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "auth-fresh-"));
    try {
      assert.equal(resolveMainBotUid({ projectRoot: fresh }), "");
      assert.equal(inferInstanceKind("someone", { projectRoot: fresh }), "main");
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
    }
  } finally {
    await world.cleanup();
  }
});

test("listInstanceSupremeAdmins reflects effective supremacy per instance kind", async (t) => {
  const world = await makeAuthWorld();
  try {
    const childSupremes = listInstanceSupremeAdmins({
      instanceUid: "child-1",
      instanceKind: "child",
      mainBotUid: "main-1",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
      },
    });
    assert.deepEqual(childSupremes.map((entry) => entry.uid), ["main-1", "child-1"]);
    assert.deepEqual(childSupremes.map((entry) => entry.source), ["MAIN-BOT", "SELF"]);

    const mainSupremes = listInstanceSupremeAdmins({
      instanceUid: "main-1",
      instanceKind: "main",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
      },
    });
    assert.deepEqual([...new Set(mainSupremes.map((entry) => entry.uid))].sort(), ["ghost-high"]);
    assert.equal(mainSupremes[0].source, "FILE");
  } finally {
    await world.cleanup();
  }
});
