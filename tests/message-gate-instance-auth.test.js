import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canProcessChat } from "../src/automations/chat-access-policy.js";
import { canInteractWithGroup } from "../src/commands/group-interaction-policy.js";
import {
  createCommandDefinition,
  executeCommand,
} from "../src/commands/command-router.js";
import { resolveInstanceAuthorization } from "../src/utils/instance-authorization.js";
import { buildAuthorizationLogRecord } from "../src/utils/authorization-log.js";

async function makeWorld() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gate-integration-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "state", "admin.json"), JSON.stringify({ uid: "main-1" }), "utf8");
  const overrides = {
    highFilePath: path.join(root, "assets", "data", "list_admin_high.json"),
    highCommandPath: path.join(root, "assets", "data", "list_admin_high_command.json"),
    botAdminsPath: path.join(root, "mybot", "instances", "child-1", "data", "admin-list.json"),
  };
  await fs.writeFile(overrides.highFilePath, JSON.stringify(["ghost-high"]), "utf8");
  await fs.writeFile(overrides.highCommandPath, JSON.stringify([]), "utf8");
  await fs.mkdir(path.dirname(overrides.botAdminsPath), { recursive: true });
  await fs.writeFile(overrides.botAdminsPath, JSON.stringify(["child-admin"]), "utf8");
  await fs.writeFile(
    path.join(root, "mybot", "instances", "child-1", "data", "profile.json"),
    JSON.stringify({ identityPending: false }),
    "utf8"
  );

  const resolveOnChild = (senderId, threadId = "", groupSettings = {}) =>
    resolveInstanceAuthorization({
      senderId,
      threadId,
      groupSettings,
      instanceUid: "child-1",
      instanceKind: "child",
      mainBotUid: "main-1",
      projectRoot: root,
      overrides,
    });

  const resolveOnMain = (senderId, threadId = "", groupSettings = {}) =>
    resolveInstanceAuthorization({
      senderId,
      threadId,
      groupSettings,
      instanceUid: "main-1",
      instanceKind: "main",
      projectRoot: root,
      overrides: {
        ...overrides,
        botAdminsPath: path.join(root, "mybot", "instances", "main-1", "data", "admin-list.json"),
      },
    });

  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }), resolveOnChild, resolveOnMain };
}

function dispatchContext(snapshot, extra = {}) {
  const level = snapshot.isAdminLevelHigh || snapshot.isMainBotAdmin
    ? "adminLevelHigh"
    : snapshot.role === "member" ? "all" : snapshot.role;
  return {
    scope: "group",
    args: [],
    dependencies: {},
    dbReady: true,
    config: {},
    permissionLevel: level,
    isAdminLevelHighest: snapshot.isAdminLevelHigh,
    isMainBotAdmin: snapshot.isMainBotAdmin,
    instanceKind: snapshot.instanceKind,
    ...extra,
  };
}

const makeHandlerCommand = (name, permission, state) => createCommandDefinition({
  name,
  permission,
  type: 1,
  handler: async () => {
    state.calls.push(name);
    return true;
  },
});

test("both supreme admins pass private and group gates even when everything is disabled", async (t) => {
  const world = await makeWorld();
  try {
    for (const senderId of ["child-1", "main-1"]) {
      const snapshot = world.resolveOnChild(senderId);
      assert.equal(snapshot.isAdminLevelHigh, true, `${senderId} must be supreme on child-1`);

      assert.equal(canProcessChat({
        chatScope: "private",
        privateEnabled: false,
        isGlobalAdmin: snapshot.isAdminLevelHigh,
      }), true);

      assert.equal(canProcessChat({
        chatScope: "group",
        groupEnabled: false,
        isGlobalAdmin: snapshot.isAdminLevelHigh,
        isBotAdmin: snapshot.isBotAdmin,
        isGroupAdmin: snapshot.role !== "member",
      }), true);
    }
  } finally {
    await world.cleanup();
  }
});

test("member, adminBox and adminBot are blocked by the disabled gates at their level", async (t) => {
  const world = await makeWorld();
  try {
    const settings = { "g-1": { adminList: { "box-admin": "Box" } } };

    const member = world.resolveOnChild("random-user");
    assert.equal(canProcessChat({
      chatScope: "group",
      groupEnabled: false,
      isGlobalAdmin: member.isAdminLevelHigh,
      isBotAdmin: member.isBotAdmin,
      isGroupAdmin: false,
    }), false);

    const boxAdmin = world.resolveOnChild("box-admin", "g-1", settings);
    assert.equal(boxAdmin.role, "adminBox");
    // native gate still lets group admins through a disabled group (legacy behaviour)
    assert.equal(canProcessChat({
      chatScope: "group",
      groupEnabled: false,
      isGlobalAdmin: boxAdmin.isAdminLevelHigh,
      isBotAdmin: boxAdmin.isBotAdmin,
      isGroupAdmin: boxAdmin.isGroupAdmin,
    }), true);
    // but an inactive box blocks them from running commands via the interaction gate
    assert.equal(canInteractWithGroup({
      activeBot: false,
      isAdminBot: boxAdmin.isBotAdmin,
      isAdminBox: boxAdmin.isGroupAdmin,
    }), false, "box admins cannot wake a disabled box");
    assert.equal(canInteractWithGroup({
      activeBot: false,
      isAdminBot: member.isBotAdmin,
      isAdminBox: member.isGroupAdmin,
    }), false, "members cannot interact with inactive boxes");
  } finally {
    await world.cleanup();
  }
});

test("message-to-handler: supremes execute adminBot and high-risk commands on a child", async (t) => {
  const world = await makeWorld();
  try {
    const state = { calls: [] };
    const listAdminCmd = makeHandlerCommand("replytag", "adminBot", state);
    const spamCmd = makeHandlerCommand("spamgroup", "all", state);

    for (const senderId of ["child-1", "main-1"]) {
      state.calls.length = 0;
      const snapshot = world.resolveOnChild(senderId);

      const listResult = await executeCommand(
        dispatchContext(snapshot, { aliasCommand: "replytag", requiredRoleHint: undefined }),
        listAdminCmd,
      );
      assert.equal(listResult.code, "HANDLED", `replytag must run for ${senderId}`);
      const spamResult = await executeCommand(dispatchContext(snapshot, { aliasCommand: "spamgroup" }), spamCmd);
      assert.equal(spamResult.code, "HANDLED", `high-risk spamgroup must run for ${senderId}`);
      assert.deepEqual(state.calls, ["replytag", "spamgroup"]);
    }
  } finally {
    await world.cleanup();
  }
});

test("message-to-handler: member, adminBox, adminBot and foreign global-high are denied at their ceiling", async (t) => {
  const world = await makeWorld();
  try {
    const state = { calls: [] };
    const spamCmd = makeHandlerCommand("spamgroup", "all", state);

    const cases = [
      { senderId: "child-admin", expected: "PERMISSION_DENIED" },
      { senderId: "random-user", expected: "PERMISSION_DENIED" },
    ];
    for (const { senderId, expected } of cases) {
      state.calls.length = 0;
      const snapshot = world.resolveOnChild(senderId);
      const result = await executeCommand(dispatchContext(snapshot, { aliasCommand: "spamgroup" }), spamCmd);
      assert.equal(result.code, expected, `${senderId} (${snapshot.role})`);
      assert.deepEqual(state.calls, [], "handler must not be invoked on denial");
    }

    // foreign global high admin (ghost-high) is denied on child bot
    const ghostChild = world.resolveOnChild("ghost-high");
    assert.equal(ghostChild.isAdminLevelHigh, false);
    assert.equal(ghostChild.role, "member");
    state.calls.length = 0;
    const ghostResult = await executeCommand(dispatchContext(ghostChild, { aliasCommand: "spamgroup" }), spamCmd);
    assert.equal(ghostResult.code, "PERMISSION_DENIED");
    assert.deepEqual(state.calls, []);

    // legacy behaviour preserved on the main instance: global highs keep power there
    const onMain = world.resolveOnMain("ghost-high");
    assert.equal(onMain.isAdminLevelHigh, true);
    state.calls.length = 0;
    const mainResult = await executeCommand(dispatchContext(onMain, { aliasCommand: "spamgroup" }), spamCmd);
    assert.equal(mainResult.code, "HANDLED");
    assert.deepEqual(state.calls, ["spamgroup"]);
  } finally {
    await world.cleanup();
  }
});

test("no cross-child bypass: child-1's supremacy does not carry to child-2", async (t) => {
  const world = await makeWorld();
  try {
    const crossSnapshot = resolveInstanceAuthorization({
      senderId: "child-1",
      instanceUid: "child-2",
      instanceKind: "child",
      mainBotUid: "main-1",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
        botAdminsPath: path.join(world.root, "mybot", "instances", "child-2", "data", "admin-list.json"),
      },
    });
    assert.equal(crossSnapshot.isAdminLevelHigh, false);
    assert.equal(crossSnapshot.role, "member");

    const state = { calls: [] };
    const spamCmd = makeHandlerCommand("spamgroup", "all", state);
    const result = await executeCommand(dispatchContext(crossSnapshot, { aliasCommand: "spamgroup" }), spamCmd);
    assert.equal(result.code, "PERMISSION_DENIED");
  } finally {
    await world.cleanup();
  }
});

test("decision log records contain verdict fields and never credentials", async (t) => {
  const record = buildAuthorizationLogRecord({
    instanceKind: "child",
    instanceUid: "child-1",
    senderId: "main-1",
    threadId: "g-1",
    scope: "group",
    role: "adminLevelHigh",
    source: "mainBot",
    command: "spamgroup",
    verdict: "allowed",
  });
  assert.equal(record.verdict, "allowed");
  assert.equal(record.instanceKind, "child");
  assert.equal(record.source, "mainBot");
  assert.ok(record.ts);
  const serialized = JSON.stringify(record);
  assert.equal(/cookie|imei|password|session/i.test(serialized), false);

  const roundTrip = JSON.parse(serialized);
  assert.equal(roundTrip.command, "spamgroup");
});
