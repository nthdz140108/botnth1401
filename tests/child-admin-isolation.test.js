import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeAdminCommand } from "../src/commands/bot-manager/admin-manager.js";
import { resolveInstanceAuthorization, listInstanceSupremeAdmins } from "../src/utils/instance-authorization.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { commandRegistry } from "../src/commands/command-registry.js";
import { getInitialAdminList } from "../src/utils/bot-runtime-context.js";
import { mybotHandleCommand } from "../src/commands/mybot/myBotManager.js";
import { appContext } from "../src/api-zalo/context.js";
import { setEnvVars, resetCache } from "../src/utils/env.js";

async function makeChildWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "child-admin-test-"));
  const mainBotUid = "111222333";
  const childBotUid = "888999000";

  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "instances", "admin", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "instances", childBotUid, "data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "configs"), { recursive: true });

  // Main bot state
  await fs.writeFile(
    path.join(root, "mybot", "state", "admin.json"),
    JSON.stringify({ uid: mainBotUid, displayName: "Main Bot Admin", avatar: "https://avatar.main/bot.png" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      admin: { uid: mainBotUid, displayName: "Main Bot Admin", avatar: "https://avatar.main/bot.png", isMain: true },
      [childBotUid]: { uid: childBotUid, displayName: "Child Bot 1", avatar: "https://avatar.child/bot.png", isMain: false },
    }),
    "utf8",
  );

  const highFilePath = path.join(root, "assets", "data", "list_admin_high.json");
  const highCommandPath = path.join(root, "assets", "data", "list_admin_high_command.json");
  const childAdminListPath = path.join(root, "mybot", "instances", childBotUid, "data", "admin-list.json");
  const childHighPath = path.join(root, "mybot", "instances", childBotUid, "data", "admin-high.json");
  const childLegacyAdminPath = path.join(root, "mybot", "configs", `list_admin-${childBotUid}.json`);

  await fs.writeFile(highFilePath, JSON.stringify([mainBotUid]), "utf8");
  await fs.writeFile(highCommandPath, JSON.stringify([]), "utf8");
  await fs.writeFile(childAdminListPath, JSON.stringify([childBotUid]), "utf8");
  await fs.writeFile(childHighPath, JSON.stringify([mainBotUid]), "utf8");
  await fs.writeFile(childLegacyAdminPath, JSON.stringify([childBotUid]), "utf8");

  const overrides = {
    highFilePath,
    highCommandPath,
    botAdminsPath: childAdminListPath,
    childHighPath,
  };

  const sentMessages = [];
  const mockApi = {
    sentMessages,
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return { status: 0 };
    },
    getUserInfo: async (uids) => {
      const unchanged_profiles = {};
      for (const uid of Array.isArray(uids) ? uids : [uids]) {
        if (uid === mainBotUid) {
          unchanged_profiles[uid] = { userId: uid, zaloName: "Main Owner", avatar: "https://avatar.main/bot.png" };
        } else if (uid === childBotUid) {
          unchanged_profiles[uid] = { userId: uid, zaloName: "Child Self", avatar: "https://avatar.child/bot.png" };
        } else {
          unchanged_profiles[uid] = { userId: uid, zaloName: `User_${uid}`, avatar: `https://avatar.user/${uid}.png` };
        }
      }
      return { unchanged_profiles, changed_profiles: {} };
    },
  };

  return {
    root,
    mainBotUid,
    childBotUid,
    highFilePath,
    highCommandPath,
    childAdminListPath,
    childHighPath,
    childLegacyAdminPath,
    overrides,
    mockApi,
    sentMessages,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("child bot: initial admin list contains only the child UID (foreign main UID not auto-seeded)", async () => {
  const world = await makeChildWorld();
  try {
    const initial = getInitialAdminList(world.childBotUid, world.root);
    assert.deepEqual(initial.sort(), [world.childBotUid]);
  } finally {
    await world.cleanup();
  }
});

test("child bot: childBotUid and mainBotUid (assigned via child admin-high) resolve to adminLevelHigh supreme admins", async () => {
  const world = await makeChildWorld();
  try {
    // The main operator UID is Supreme on the child ONLY because it was assigned
    // into the child's own admin-high list (command-assigned tier), never because
    // it appears in shared Main state.
    const mainAuth = resolveInstanceAuthorization({
      senderId: world.mainBotUid,
      instanceUid: world.childBotUid,
      instanceKind: "child",
      mainBotUid: world.mainBotUid,
      projectRoot: world.root,
      overrides: world.overrides,
    });
    assert.equal(mainAuth.role, "adminLevelHigh");
    assert.equal(mainAuth.isAdminLevelHigh, true);
    assert.equal(mainAuth.isMainBotAdmin, true);

    const childSelfAuth = resolveInstanceAuthorization({
      senderId: world.childBotUid,
      instanceUid: world.childBotUid,
      instanceKind: "child",
      mainBotUid: world.mainBotUid,
      projectRoot: world.root,
      overrides: world.overrides,
    });
    assert.equal(childSelfAuth.role, "adminLevelHigh");
    assert.equal(childSelfAuth.isAdminLevelHigh, true);
  } finally {
    await world.cleanup();
  }
});

test("child bot: !admin add qtv on child bot modifies child admin-high.json, NEVER main high list", async () => {
  const world = await makeChildWorld();
  try {
    const newAdminUid = "999888777";
    await executeAdminCommand({
      api: world.mockApi,
      message: {
        threadId: "group-1",
        type: 1,
        data: {
          uidFrom: world.mainBotUid,
          content: `!admin add qtv ${newAdminUid}`,
        },
      },
      scope: "group",
      botUid: world.childBotUid,
      instanceKind: "child",
      projectRoot: world.root,
      mainBotUid: world.mainBotUid,
      overrides: world.overrides,
    });

    // 1. High command path of main bot MUST remain empty
    const mainHighList = JSON.parse(await fs.readFile(world.highCommandPath, "utf8"));
    assert.deepEqual(mainHighList, [], "Main high command list must NOT be modified by child bot");

    // 2. Child bot's admin-high.json MUST have the new admin
    const childHighList = JSON.parse(await fs.readFile(world.childHighPath, "utf8"));
    assert.ok(childHighList.includes(newAdminUid), "Child admin-high list must contain newly added admin");

    // 3. New admin is recognized as adminLevelHigh on child bot
    const newAdminAuth = resolveInstanceAuthorization({
      senderId: newAdminUid,
      instanceUid: world.childBotUid,
      instanceKind: "child",
      mainBotUid: world.mainBotUid,
      projectRoot: world.root,
      overrides: world.overrides,
    });
    assert.equal(newAdminAuth.role, "adminLevelHigh");
    assert.equal(newAdminAuth.isAdminLevelHigh, true);
  } finally {
    await world.cleanup();
  }
});

test("child bot: !admin add on child bot modifies child admin-list.json (bot admin tier)", async () => {
  const world = await makeChildWorld();
  try {
    const newBotAdminUid = "777666555";
    await executeAdminCommand({
      api: world.mockApi,
      message: {
        threadId: "group-1",
        type: 1,
        data: {
          uidFrom: world.mainBotUid,
          content: `!admin add ${newBotAdminUid}`,
        },
      },
      scope: "group",
      botUid: world.childBotUid,
      instanceKind: "child",
      projectRoot: world.root,
      mainBotUid: world.mainBotUid,
      overrides: world.overrides,
    });

    const childList = JSON.parse(await fs.readFile(world.childAdminListPath, "utf8"));
    assert.ok(childList.includes(newBotAdminUid), "Child admin list must contain newly added bot admin");

    const auth = resolveInstanceAuthorization({
      senderId: newBotAdminUid,
      instanceUid: world.childBotUid,
      instanceKind: "child",
      mainBotUid: world.mainBotUid,
      projectRoot: world.root,
      overrides: world.overrides,
    });
    assert.equal(auth.role, "adminBot");
    assert.equal(auth.isBotAdmin, true);
    assert.equal(auth.isAdminLevelHigh, false);
  } finally {
    await world.cleanup();
  }
});

test("child bot: cannot remove supreme admins from child admin-high.json", async () => {
  const world = await makeChildWorld();
  try {
    // Attempt removing main bot UID from child bot admin-high
    await executeAdminCommand({
      api: world.mockApi,
      message: {
        threadId: "group-1",
        type: 1,
        data: {
          uidFrom: world.mainBotUid,
          content: `!admin remove qtv ${world.mainBotUid}`,
        },
      },
      scope: "group",
      botUid: world.childBotUid,
      instanceKind: "child",
      projectRoot: world.root,
      mainBotUid: world.mainBotUid,
      overrides: world.overrides,
    });

    const lastMsg = world.sentMessages[world.sentMessages.length - 1];
    assert.match(lastMsg.payload.msg, /Không thể xóa Quản trị Tối cao/);

    // Ensure main bot UID is still present in child admin-high.json
    const childHighList = JSON.parse(await fs.readFile(world.childHighPath, "utf8"));
    assert.ok(childHighList.includes(world.mainBotUid));
  } finally {
    await world.cleanup();
  }
});

test("child bot: mybot command is denied on child instances", async () => {
  const world = await makeChildWorld();
  try {
    // 1. Dispatch through command dispatcher
    const result = await dispatchCommand({
      commandParts: ["mybot", "help"],
      scope: "group",
      threadId: "group-1",
      senderId: world.mainBotUid,
      instanceKind: "child",
      api: world.mockApi,
      message: { threadId: "group-1", type: 1, data: { uidFrom: world.mainBotUid, content: "!mybot help" } },
    });

    assert.equal(result.code, "INSTANCE_DENIED");

    // 2. Direct mybotHandleCommand call in child context
    const prevUid = appContext.uid;
    appContext.uid = world.childBotUid;
    setEnvVars({ PROJECT_ROOT: world.root, BOT_NAME: world.childBotUid });
    try {
      await mybotHandleCommand(world.mockApi, {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: world.mainBotUid, dName: "Main", content: "!mybot help" },
      });
      const deniedMsg = world.sentMessages[world.sentMessages.length - 1];
      assert.match(deniedMsg.payload.msg, /Lệnh này chỉ khả dụng trên bot admin/);
    } finally {
      appContext.uid = prevUid;
      resetCache();
    }
  } finally {
    await world.cleanup();
  }
});

test("child bot: listadmin displays supreme admins and resolves avatars and names properly", async () => {
  const world = await makeChildWorld();
  try {
    let renderedPayload = null;
    await executeAdminCommand({
      api: world.mockApi,
      message: {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: world.mainBotUid, content: "!admin list" },
      },
      scope: "group",
      botUid: world.childBotUid,
      instanceKind: "child",
      projectRoot: world.root,
      mainBotUid: world.mainBotUid,
      overrides: world.overrides,
      createAdminListImage: async (payload) => {
        renderedPayload = payload;
        return null;
      },
    });

    assert.ok(renderedPayload, "Canvas renderer must have been called");
    assert.equal(renderedPayload.highAdmins.length >= 2, true);

    const mainEntry = renderedPayload.highAdmins.find((a) => a.id === world.mainBotUid);
    assert.ok(mainEntry, "Main bot must be in highAdmins");
    assert.ok(mainEntry.avatar, "Main bot avatar must be resolved");

    const childEntry = renderedPayload.highAdmins.find((a) => a.id === world.childBotUid);
    assert.ok(childEntry, "Child bot must be in highAdmins");
    assert.ok(childEntry.avatar, "Child bot avatar must be resolved");
  } finally {
    await world.cleanup();
  }
});
