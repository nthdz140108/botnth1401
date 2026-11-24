import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import * as registryModule from "../src/commands/command-registry.js";

const PHASE_7_COMMANDS = [
  "sendstk", "sendtask", "welcome", "bye", "updategroup",
  "antibadword", "antisetup", "antibot", "antiblockall", "antisdt",
  "antilink", "autojoin", "antijoin", "antiforward", "antitag",
  "antistickerlag", "antisticker", "antispam", "antinude", "antiundo",
];

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

const registryWith = (name, handler = async () => "ok") =>
  registryModule.createPhase7Registry({ [name]: handler });

test("Phase 7 exposes a testable lazy-handler factory", () => {
  assert.equal(typeof registryModule.createPhase7Handlers, "function");
});

test("Phase 7 lazy handlers load the expected exports and arguments", async () => {
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
  const handlers = registryModule.createPhase7Handlers(loadModule);
  const context = {
    api: "api",
    message: "message",
    groupSettings: "groupSettings",
    commandConfig: "commandConfig",
  };
  const expected = [
    ["sendstk", "./lenh-debug/send-all/sendsticker.js", "handleSendStickerCommand", ["api", "message", "groupSettings"]],
    ["sendtask", "./bot-manager/utilities.js", "handleSendTaskCommand", ["api", "message", "groupSettings", "commandConfig"]],
    ["welcome", "./bot-manager/welcome-bye.js", "handleWelcomeBye", ["api", "message", "groupSettings", "welcome"]],
    ["bye", "./bot-manager/welcome-bye.js", "handleWelcomeBye", ["api", "message", "groupSettings", "bye"]],
    ["updategroup", "./bot-manager/welcome-bye.js", "handleWelcomeBye", ["api", "message", "groupSettings", "updategroup"]],
    ["antibadword", "../service-debug/anti-service/anti-badword.js", "handleAntiBadWordCommand", ["api", "message", "groupSettings"]],
    ["antisetup", "../service-debug/anti-service/setup-anti.js", "handleSetupAntiCommand", ["api", "message", "groupSettings"]],
    ["antibot", "../service-debug/anti-service/anti-bot.js", "handleAntiBotCommand", ["api", "message", "groupSettings"]],
    ["antiblockall", "../service-debug/anti-service/anti-kick-all.js", "handleAntiKickBlockCommand", ["api", "message", "groupSettings"]],
    ["antisdt", "../service-debug/anti-service/anti-phone-number.js", "handleAntiPhoneNumberCommand", ["api", "message", "groupSettings"]],
    ["antilink", "../service-debug/anti-service/anti-link.js", "handleAntiLinkCommand", ["api", "message", "groupSettings"]],
    ["autojoin", "../service-debug/anti-service/auto-join.js", "handleAutoJoinCommand", ["api", "message", "groupSettings"]],
    ["antijoin", "../service-debug/anti-service/anti-join-leave.js", "handleAntiJoinLeaveCommand", ["api", "message", "groupSettings"]],
    ["antiforward", "../service-debug/anti-service/anti-forward.js", "handleAntiForwardCommand", ["api", "message", "groupSettings"]],
    ["antitag", "../service-debug/anti-service/anti-tag.js", "handleAntiTagCommand", ["api", "message", "groupSettings"]],
    ["antistickerlag", "../service-debug/anti-service/anti-stickerlag.js", "handleAntiEffectStickerCommand", ["api", "message", "groupSettings"]],
    ["antisticker", "../service-debug/anti-service/anti-sticker.js", "handleAntiAllEffectStickerCommand", ["api", "message", "groupSettings"]],
    ["antispam", "../service-debug/anti-service/anti-spam.js", "handleAntiSpamCommand", ["api", "message", "groupSettings"]],
    ["antinude", "../service-debug/anti-service/anti-nude/anti-nude.js", "handleAntiNudeCommand", ["api", "message", "groupSettings"]],
    ["antiundo", "../service-debug/anti-service/anti-undo.js", "handleAntiUndoCommand", ["api", "message", "groupSettings"]],
  ];

  for (const [command, modulePath, exportName, expectedArgs] of expected) {
    const result = await handlers[command](context);
    assert.equal(result.exportName, exportName, command);
    assert.deepEqual(result.args, expectedArgs, command);
  }

  const uniqueExpected = [...new Set(expected.map(([, modulePath]) => modulePath))];
  assert.deepEqual(loaded, uniqueExpected);
});

test("all Phase 7 commands deny private dispatch before invoking handlers", async () => {
  for (const command of PHASE_7_COMMANDS) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      scope: "private",
      commandParts: [command],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "SCOPE_DENIED", command);
    assert.equal(invoked, false, command);
  }
});

test("adminBot metadata blocks restricted Phase 7 commands for all users", async () => {
  for (const command of PHASE_7_COMMANDS.filter((name) => !["autojoin", "sendstk", "sendtask"].includes(name))) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      permissionLevel: "all",
      commandParts: [command],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "PERMISSION_DENIED", command);
    assert.equal(invoked, false, command);
  }

  for (const command of ["sendstk", "sendtask"]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      permissionLevel: "all",
      commandParts: [command],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "PERMISSION_DENIED", command);
    assert.equal(invoked, false, command);
  }
});

test("toggle commands accept an omitted optional argument", async () => {
  let receivedArgs;
  const result = await dispatchCommand({
    ...baseContext,
    commandParts: ["antispam"],
  }, registryWith("antispam", async ({ args }) => {
    receivedArgs = args;
    return "toggled";
  }));

  assert.equal(result.code, "HANDLED");
  assert.deepEqual(receivedArgs, []);
});

test("sendstk and sendtask dispatch through their handlers", async () => {
  for (const command of ["sendstk", "sendtask"]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...baseContext,
      commandParts: [command, "on"],
    }, registryWith(command, async () => {
      invoked = true;
      return "unexpected";
    }));

    assert.equal(result.code, "HANDLED", command);
    assert.equal(invoked, true, command);
  }
});

test("Phase 7 handler failures become structured errors", async () => {
  const result = await dispatchCommand({
    ...baseContext,
    commandParts: ["antibot"],
  }, registryWith("antibot", async () => {
    throw new Error("phase 7 handler failed");
  }));

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.definition.name, "antibot");
  assert.equal(result.error.message, "phase 7 handler failed");
});

test("welcome aliases select the canonical setting key", async () => {
  const welcomeMapping = await import("../src/commands/bot-manager/welcome-command.js").catch(() => ({}));

  assert.equal(typeof welcomeMapping.getWelcomeSettingKey, "function");
  assert.equal(welcomeMapping.getWelcomeSettingKey("welcome", "!"), "welcomeGroup");
  assert.equal(welcomeMapping.getWelcomeSettingKey("wl", "!"), "welcomeGroup");
  assert.equal(welcomeMapping.getWelcomeSettingKey("wlc", "!"), "welcomeGroup");
  assert.equal(welcomeMapping.getWelcomeSettingKey("bye", "!"), "byeGroup");
  assert.equal(welcomeMapping.getWelcomeSettingKey("updategroup", "!"), "updateGroup");
});
