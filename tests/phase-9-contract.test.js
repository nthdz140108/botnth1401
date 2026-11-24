import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASE_9_COMMANDS,
  createPhase9Handlers,
  createPhase9Registry,
} from "../src/commands/command-registry.js";

const EXPECTED_COMMANDS = [
  "kick", "block", "taget", "kickall", "blockall",
  "keygold", "keysilver", "unkey", "join", "leave", "listgroups",
  "scangroups", "deletemessage", "restart", "listblockbot", "blockbot",
  "unblockbot", "whitelist", "alias", "downloadresource", "deleteresource",
  "keylist",
];

const context = {
  api: "api",
  message: "message",
  groupInfo: "groupInfo",
  groupAdmins: "groupAdmins",
  groupSettings: "groupSettings",
  isAdminLevelHighest: true,
  aliasCommand: "aliasCommand",
  commandParts: ["alias", "list"],
};

test("Phase 9 exposes exactly the 23 required canonical commands", () => {
  assert.deepEqual(PHASE_9_COMMANDS, EXPECTED_COMMANDS);
  const registry = createPhase9Registry();
  assert.deepEqual(registry.definitions.map(({ name }) => name), EXPECTED_COMMANDS);
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("Phase 9 lazy adapters preserve handler exports and argument order", async () => {
  const loaded = [];
  const loadModule = async (modulePath) => {
    loaded.push(modulePath);
    return new Proxy({}, {
      get(_target, exportName) {
        if (exportName === "then") return undefined;
        return (...args) => ({ exportName, args });
      },
    });
  };

  const handlers = createPhase9Handlers(loadModule);
  const expected = [
    ["kick", "./bot-manager/group-manage.js", "handleKick", ["api", "message", "groupInfo"]],
    ["block", "./bot-manager/group-manage.js", "handleBlock", ["api", "message", "groupInfo"]],
    ["taget", "./bot-manager/group-manage.js", "handleTaget", ["api", "message", "groupInfo"]],
    ["kickall", "./bot-manager/group-manage.js", "handleKickAll", ["api", "message", "groupInfo"]],
    ["blockall", "./bot-manager/group-manage.js", "handleBlockAll", ["api", "message", "groupInfo"]],
    ["keygold", "./bot-manager/group-manage.js", "handleKeyCommands", ["api", "message", "groupSettings", true]],
    ["keysilver", "./bot-manager/group-manage.js", "handleKeyCommands", ["api", "message", "groupSettings", true]],
    ["unkey", "./bot-manager/group-manage.js", "handleKeyCommands", ["api", "message", "groupSettings", true]],
    ["join", "./bot-manager/remote-action-group.js", "handleJoinGroup", ["api", "message"]],
    ["leave", "./bot-manager/remote-action-group.js", "handleLeaveGroup", ["api", "message"]],
    ["listgroups", "./bot-manager/remote-action-group.js", "handleShowGroupsList", ["api", "message", "aliasCommand"]],
    ["scangroups", "./bot-manager/scan-group.js", "scanGroupsWithAction", ["api", "message", "groupInfo", "aliasCommand"]],
    ["deletemessage", "./bot-manager/recent-message.js", "handleDeleteMessage", ["api", "message", "groupAdmins", "aliasCommand"]],
    ["restart", "../utils/util.js", "restartSelf", ["api", "message", "aliasCommand"]],
    ["listblockbot", "./bot-manager/group-manage.js", "handleListBlockBot", ["api", "message"]],
    ["blockbot", "./bot-manager/group-manage.js", "handleBlockBot", ["api", "message", "groupSettings"]],
    ["unblockbot", "./bot-manager/group-manage.js", "handleUnblockBot", ["api", "message", "groupSettings"]],
    ["whitelist", "../service-debug/anti-service/white-list.js", "handleWhiteList", ["api", "message", "groupSettings", "groupAdmins"]],
    ["alias", "./bot-manager/utilities.js", "handleAliasCommand", ["api", "message", ["alias", "list"]]],
    ["downloadresource", "../service-debug/utilities/download-resource.js", "handleDownloadResource", ["api", "message", "aliasCommand"]],
    ["deleteresource", "../service-debug/utilities/download-resource.js", "handleDeleteResource", ["api", "message", "aliasCommand"]],
    ["keylist", "./bot-manager/key-list.js", "handleListKeyCommand", ["api", "message"]],
  ];

  for (const [command, , exportName, expectedArgs] of expected) {
    const result = await handlers[command](context);
    assert.equal(result.exportName, exportName, command);
    assert.deepEqual(result.args, expectedArgs, command);
  }

  const uniqueExpected = [...new Set(expected.map(([, modulePath]) => modulePath))];
  assert.deepEqual(loaded, uniqueExpected);
});

test("Phase 9 aliases resolve without collisions", () => {
  const registry = createPhase9Registry();
  const expectedAliases = {
    sut: "kick",
    "c\u00fat": "kick",
    chan: "block",
    "c\u00fatall": "kickall",
    "bi\u1ebfnall": "blockall",
    keyvang: "keygold",
    keybac: "keysilver",
    xoakey: "unkey",
    thamgianhom: "join",
    out: "leave",
    lgr: "listgroups",
    scgr: "scangroups",
    delmsg: "deletemessage",
    del: "deletemessage",
    rs: "restart",
    lsbot: "listblockbot",
    blbot: "blockbot",
    unblbot: "unblockbot",
    wls: "whitelist",
    dlrsrc: "downloadresource",
    delrsrc: "deleteresource",
    listkey: "keylist",
  };

  for (const [alias, canonical] of Object.entries(expectedAliases)) {
    assert.equal(registry.lookup.get(alias)?.[0]?.name, canonical, alias);
  }
  assert.equal(new Set(registry.lookup.keys()).size, registry.lookup.size);
});
