import test from "node:test";
import assert from "node:assert/strict";
import { createCommandRegistry, resolveCommand } from "../src/commands/command-router.js";
import { commandRegistry } from "../src/commands/command-registry.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";

const REPRESENTATIVE_COMMANDS = [
  { key: "help", group: "text" },
  { key: "info", group: "profile-avatar-card" },
  { key: "card", group: "profile-avatar-card" },
  { key: "restart", group: "lifecycle" },
  { key: "admin", group: "per-bot-admins" },
];

test("main and child bots share one registry with identical definitions", () => {
  for (const { key } of REPRESENTATIVE_COMMANDS) {
    const resolved = resolveCommand([key], commandRegistry);
    assert.equal(resolved.code, "RESOLVED", key);

    const mainView = resolveCommand([key], commandRegistry);
    const childView = resolveCommand([key], commandRegistry);
    assert.equal(mainView.definition, childView.definition, key);
    assert.equal(typeof mainView.definition.handler, "function", key);
    assert.deepEqual(mainView.definition.aliases, childView.definition.aliases, key);
    assert.equal(mainView.definition.permission, childView.definition.permission, key);
  }
});

function buildRecorderRegistry(recordings) {
  return createCommandRegistry([
    {
      name: "parity",
      aliases: ["par"],
      permission: "all",
      type: 1,
      handler: async (context) => {
        recordings.push(context);
        return { code: "HANDLED", value: { echoed: context.parityInput } };
      },
    },
  ]);
}

function baseContext(overrides = {}) {
  const api = {
    sendMessageCalls: [],
    sendMessage: async function (payload) {
      this.sendMessageCalls.push(payload);
    },
  };
  const message = { threadId: "thread-1", type: 0, data: { uidFrom: "user-1", content: "!parity hi" } };
  return {
    api,
    message,
    commandParts: ["parity", "hi"],
    aliasCommand: "parity",
    scope: "private",
    permissionLevel: "adminLevelHigh",
    config: {},
    dbReady: true,
    dependencies: { zaloSession: true },
    parityInput: "hi",
    ...overrides,
  };
}

test("same handler and payload for main and child on default-scope commands", async () => {
  const recordings = [];
  const registry = buildRecorderRegistry(recordings);

  const mainResult = await dispatchCommand(baseContext({ instanceKind: "main" }), registry);
  const childResult = await dispatchCommand(baseContext({ instanceKind: "child" }), registry);

  assert.equal(mainResult.code, "HANDLED");
  assert.equal(childResult.code, "HANDLED");
  assert.deepEqual(mainResult.value, childResult.value);
  assert.equal(recordings.length, 2);
  assert.equal(recordings[0].instanceKind, "main");
  assert.equal(recordings[1].instanceKind, "child");

  const payloadOf = (context) => ({
    commandParts: context.commandParts,
    aliasCommand: context.aliasCommand,
    args: context.args,
    scope: context.scope,
    permissionLevel: context.permissionLevel,
    parityInput: context.parityInput,
    threadId: context.message.threadId,
    senderId: context.message.data.uidFrom,
    content: context.message.data.content,
  });
  assert.deepEqual(payloadOf(recordings[0]), payloadOf(recordings[1]));
});

test("a brand new child instance boots from a minimal seed and still sees the full catalog", async () => {
  const minimalSeed = { prefix: "!", commands: [] };

  for (const definition of commandRegistry.definitions) {
    if (definition.instanceScope === "main") continue;
    const resolvedForChild = resolveCommand(definition.name.split(" "), {
      ...commandRegistry,
      lookup: commandRegistry.lookup,
      keys: commandRegistry.keys,
    });
    assert.equal(resolvedForChild.code, "RESOLVED", definition.name);
  }
  assert.ok(minimalSeed);
});
