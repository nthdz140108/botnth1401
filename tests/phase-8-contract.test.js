import test from "node:test";
import assert from "node:assert/strict";

import { createPhase8Handlers } from "../src/commands/command-registry.js";

test("Phase 8 exposes a testable lazy-handler factory", () => {
  assert.equal(typeof createPhase8Handlers, "function");
});

test("Phase 8 lazy handlers load the expected exports and arguments", async () => {
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
  const handlers = createPhase8Handlers(loadModule);
  const context = {
    api: "api",
    message: "message",
    groupInfo: "groupInfo",
    groupSettings: "groupSettings",
    aliasCommand: "aliasCommand",
  };
  const expected = [
    ["antiall", "../service-debug/anti-service/anti-all.js", "handleAntiAll", ["api", "message", "groupSettings"]],
    ["antitext", "../service-debug/anti-service/anti-text.js", "handleAntiText", ["api", "message", "groupSettings"]],
    ["antifile", "../service-debug/anti-service/anti-file.js", "handleAntiFile", ["api", "message", "groupSettings"]],
    ["antiphoto", "../service-debug/anti-service/anti-photo.js", "handleAntiPhotoVideo", ["api", "message", "groupSettings"]],
    ["antivoice", "../service-debug/anti-service/anti-voice.js", "handleAntiVoice", ["api", "message", "groupSettings"]],
    ["onlytext", "../service-debug/anti-service/anti-not-text.js", "handleOnlyText", ["api", "message", "groupSettings"]],
    ["ban", "./bot-manager/group-manage.js", "handleBlockBot", ["api", "message", "groupSettings"]],
    ["unban", "./bot-manager/group-manage.js", "handleUnblockBot", ["api", "message", "groupSettings"]],
    ["tagall", "../service-debug/chat-zalo/chat-general/chat-all.js", "chatAll", ["api", "message", "groupInfo", "aliasCommand"]],
    ["spamgroup", "./bot-manager/spamgroup.js", "spamgroup", ["api", "message"]],
    ["scold", "../service-debug/chat-bot/scold-user/scold-user.js", "scoldUser", ["api", "message"]],
    ["approve", "./bot-manager/welcome-bye.js", "handleApprove", ["api", "message", "groupSettings"]],
    ["learn", "../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleLearnCommand", ["api", "message", "groupSettings"]],
    ["learnnow", "../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleLearnCommand", ["api", "message", "groupSettings"]],
    ["unlearn", "../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleLearnCommand", ["api", "message", "groupSettings"]],
    ["reply", "../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleReplyCommand", ["api", "message", "groupSettings"]],
    ["autoreply", "../service-debug/api-crawl/assistant-ai/auto-reply.js", "handleAutoReplyCommand", ["api", "message", "aliasCommand", "groupSettings"]],
    ["undo", "./bot-manager/utilities.js", "handleUndoMessage", ["api", "message"]],
    ["todo", "./bot-manager/utilities.js", "handleSendToDo", ["api", "message"]],
    ["sendp", "./bot-manager/utilities.js", "handleSendMessagePrivate", ["api", "message"]],
  ];

  for (const [command, modulePath, exportName, expectedArgs] of expected) {
    const result = await handlers[command](context);
    assert.equal(result.exportName, exportName, command);
    assert.deepEqual(result.args, expectedArgs, command);
  }

  const uniqueExpected = [...new Set(expected.map(([, modulePath]) => modulePath))];
  assert.deepEqual(loaded, uniqueExpected);
});
