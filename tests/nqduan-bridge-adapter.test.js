import test from "node:test";
import assert from "node:assert/strict";

import {
  NQDUAN_COMMAND_GROUPS,
  classifyNqduanCommand,
  createNqduanApiAdapter,
  createNqduanBridgeRuntime,
  createNqduanDependencyAdapter,
  normalizeNqduanMessage,
} from "../src/commands/bot-manager/nqduan-adapter.js";

test("Nqduan command groups are classified by capability family", () => {
  assert.deepEqual(Object.keys(NQDUAN_COMMAND_GROUPS), [
    "friends",
    "group",
    "media",
    "utility",
    "antiService",
    "highRisk",
  ]);

  assert.equal(classifyNqduanCommand("target").group, "antiService");
  assert.equal(classifyNqduanCommand("kickimg").group, "antiService");
  assert.equal(classifyNqduanCommand("antigif").group, "antiService");
  assert.equal(classifyNqduanCommand("thoitiet").group, "utility");
  assert.equal(classifyNqduanCommand("key").group, "highRisk");
});

test("Nqduan bridge normalizes HHH-style context and dependency diagnostics", () => {
  const message = normalizeNqduanMessage({
    threadId: "thread-1",
    content: "!kickimg on",
    senderId: "user-1",
    senderName: "Tester",
    mentions: [{ uid: "friend-1", pos: 8, len: 8 }],
    type: "group",
  });

  assert.equal(message.threadId, "thread-1");
  assert.equal(message.data.uidFrom, "user-1");
  assert.equal(message.data.dName, "Tester");
  assert.equal(message.data.content, "!kickimg on");
  assert.equal(message.data.mentions.length, 1);

  const dependencies = createNqduanDependencyAdapter({
    database: false,
    ffmpeg: { available: false, reason: "missing ffmpeg" },
    python: { available: true, executable: "python3" },
    apiKeys: { HOANGDEV_API_KEY: "" },
  });

  const summary = dependencies.summary();
  assert.equal(summary.find((entry) => entry.name === "database").available, false);
  assert.equal(summary.find((entry) => entry.name === "ffmpeg").available, false);
  assert.equal(summary.find((entry) => entry.name === "python").available, true);
  assert.equal(summary.find((entry) => entry.name === "apiKey").available, false);

  assert.throws(() => dependencies.ensure("ffmpeg", { commandName: "sticker" }), (error) => {
    assert.equal(error.code, "NQDUAN_DEPENDENCY_MISSING");
    assert.equal(error.dependency, "ffmpeg");
    assert.equal(error.commandName, "sticker");
    return true;
  });
});

test("Nqduan API adapter exposes method aliases and normalizes missing method errors", async () => {
  const calls = [];
  const api = createNqduanApiAdapter({
    sendMessage(payload, threadId, type) {
      calls.push(["sendMessage", payload, threadId, type]);
      return { ok: true };
    },
    leaveGroup(threadId) {
      calls.push(["leaveGroup", threadId]);
      return { ok: true };
    },
  });

  await api.sendMessageToThread({ msg: "hello" }, "thread-1", "group");
  await api.leaveGroup("thread-2");

  assert.deepEqual(calls, [
    ["sendMessage", { msg: "hello" }, "thread-1", "group"],
    ["leaveGroup", "thread-2"],
  ]);

  assert.throws(() => api.disperseGroup("thread-3"), (error) => {
    assert.equal(error.code, "NQDUAN_API_METHOD_MISSING");
    assert.equal(error.method, "disperseGroup");
    return true;
  });
});

test("Nqduan bridge runs a legacy handler from a normalized HHH context", async () => {
  const calls = [];
  const runtime = createNqduanBridgeRuntime({
    commandName: "kickimg",
    api: {
      sendMessage(payload, threadId, type) {
        calls.push(["sendMessage", payload, threadId, type]);
        return { ok: true };
      },
    },
    message: {
      threadId: "group-99",
      content: "!kickimg on",
      senderId: "user-9",
      senderName: "Bridge Tester",
      type: "group",
    },
    groupSettings: {},
    permissionLevel: "adminLevelHigh",
    isAdminLevelHighest: true,
    dependencies: {
      database: true,
      ffmpeg: true,
      python: true,
      apiKeys: { HOANGDEV_API_KEY: "test-key" },
    },
  });

  assert.equal(runtime.command.group, "antiService");
  assert.equal(runtime.permissions.allowed, true);
  assert.equal(runtime.message.data.uidFrom, "user-9");

  const result = await (async (api, message, groupSettings) => {
    await api.sendMessageToThread({ msg: "bridge-ok" }, message.threadId, message.type);
    groupSettings[message.threadId] = { enableKickImage: true };
    return {
      threadId: message.threadId,
      senderId: message.data.uidFrom,
      content: message.data.content,
      groupSettings,
    };
  })(runtime.api, runtime.message, runtime.groupSettings);

  assert.equal(result.threadId, "group-99");
  assert.equal(result.senderId, "user-9");
  assert.equal(result.content, "!kickimg on");
  assert.equal(runtime.groupSettings["group-99"].enableKickImage, true);
  assert.equal(calls.length > 0, true);
});
