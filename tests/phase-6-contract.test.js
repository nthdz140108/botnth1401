import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import {
  createPhase6Handlers,
  createPhase6Registry,
} from "../src/commands/command-registry.js";

const baseContext = {
  scope: "group",
  permissionLevel: "adminLevelHigh",
  config: {},
  dbReady: true,
  api: {},
  message: {},
  groupSettings: {},
  dependencies: {
    zaloSession: true,
    python: true,
    ffmpeg: true,
    ffprobe: true,
  },
};

const registryWith = (name, handler = async () => "ok") => createPhase6Registry({ [name]: handler });

test("Phase 6 lazy adapters preserve existing handler exports and arguments", async () => {
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
  const handlers = createPhase6Handlers(loadModule);
  const context = {
    api: "api",
    message: "message",
    threadId: "thread",
    args: ["arg"],
    commandParts: ["setcmd", "on", "help"],
    groupInfo: "groupInfo",
    groupSettings: "groupSettings",
    groupAdmins: "groupAdmins",
    isAdminLevelHighest: true,
    aliasCommand: "atd",
  };
  const expected = [
    ["lich", "./lich-command.js", "handleCalendarCommand", ["api", "message", ["arg"]]],
    ["manager", "./instructions/help.js", "adminCommand", ["api", "message"]],
    ["listmute", "../service-debug/anti-service/mute-user.js", "handleMuteList", ["api", "message", "groupSettings"]],
    ["settinggroup", "./bot-manager/group-manage.js", "handleSettingGroupCommand", ["api", "message", "groupInfo", "atd"]],
    ["changelink", "./bot-manager/utilities.js", "handleChangeGroupLink", ["api", "message"]],
    ["listadmin", "./bot-manager/admin-manager.js", "executeAdminCommand", [context]],
    ["add", "./bot-manager/admin-manager.js", "executeAdminCommand", [context]],
    ["remove", "./bot-manager/admin-manager.js", "executeAdminCommand", [context]],
    ["setcmd", "./manager-command/set-command.js", "handleSetCommandActive", ["api", "message", ["setcmd", "on", "help"]]],
    ["bot", "./bot-manager/active-bot.js", "handleActiveBotUser", ["api", "message", "groupSettings", null]],
    ["autodownload", "../service-debug/api-crawl/download/auto-download.js", "handleAutoDownloadCommand", ["api", "message", "atd", "groupSettings"]],
    ["mute", "../service-debug/anti-service/mute-user.js", "handleMuteUser", ["api", "message", "groupSettings", "groupAdmins"]],
    ["unmute", "../service-debug/anti-service/mute-user.js", "handleUnmuteUser", ["api", "message", "groupSettings"]],
    ["prefix", "./bot-manager/prefix.js", "handlePrefixCommand", ["api", "message", true]],
    ["sendtext", "./lenh-debug/send-all/autosendtext.js", "handleAutoSendTextCommand", ["api", "message", "groupSettings"]],
  ];

  for (const [command, modulePath, exportName, expectedArgs] of expected) {
    const result = await handlers[command](context);
    assert.equal(result.exportName, exportName, command);
    assert.deepEqual(result.args, expectedArgs, command);
  }

  const uniqueExpected = [...new Set(expected.map(([, modulePath]) => modulePath))];
  assert.deepEqual(loaded, uniqueExpected);
});

test("group-only Phase 6 commands deny private dispatch before their handlers run", async () => {
  for (const command of ["manager", "listmute", "settinggroup", "changelink", "autodownload", "mute", "unmute", "sendtext"]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      scope: "private",
      commandParts: [command, "sample", "extra"],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "SCOPE_DENIED", command);
    assert.equal(invoked, false, command);
  }
});

test("permission metadata blocks restricted Phase 6 commands before invocation", async () => {
  for (const command of ["bot", "listadmin", "add", "remove", "mute", "unmute", "setcmd"]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      permissionLevel: "all",
      commandParts: [command, "sample"],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "PERMISSION_DENIED", command);
    assert.equal(invoked, false, command);
  }
});

test("setcmd requires its action and command arguments", async () => {
  let invoked = false;
  const result = await dispatchCommand({
    ...baseContext,
    permissionLevel: "adminLevelHigh",
    commandParts: ["setcmd"],
  }, registryWith("setcmd", async () => {
    invoked = true;
  }));

  assert.equal(result.code, "MISSING_ARGUMENT");
  assert.equal(result.definition.name, "setcmd");
  assert.equal(invoked, false);
});

test("Phase 6 commands dispatch through their handlers", async () => {
  for (const command of ["lich", "sendtext", "add", "remove"]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      commandParts: [command, "sample"],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "HANDLED", command);
    assert.equal(invoked, true, command);
  }
});

test("Phase 6 handler failures become structured errors", async () => {
  const result = await dispatchCommand({
    ...baseContext,
    commandParts: ["manager"],
    }, registryWith("manager", async () => {
    throw new Error("phase 6 handler failed");
  }));

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.definition.name, "manager");
  assert.equal(result.error.message, "phase 6 handler failed");
});
