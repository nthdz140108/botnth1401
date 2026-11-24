import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import {
  PHASE_1_COMMANDS,
  PHASE_2_COMMANDS,
  PHASE_3_COMMANDS,
  PHASE_4_COMMANDS,
  PHASE_5_COMMANDS,
  PHASE_6_COMMANDS,
  PHASE_7_COMMANDS,
  PHASE_8_COMMANDS,
  PHASE_9_COMMANDS,
  PHASE_10_COMMANDS,
  PHASE_11_COMMANDS,
  createCommandRegistryForPhases,
  createPhase9Registry,
} from "../src/commands/command-registry.js";

const phase9Context = (commandParts, overrides = {}) => ({
  commandParts,
  scope: "group",
  permissionLevel: "adminLevelHigh",
  isMainBotAdmin: true,
  config: {},
  dbReady: true,
  api: {},
  message: {},
  groupInfo: {},
  groupAdmins: [],
  groupSettings: {},
  dependencies: {
    zaloSession: true,
    python: true,
    ffmpeg: true,
    ffprobe: true,
  },
  ...overrides,
});

const overridesFor = (names) => Object.fromEntries(
  names.map((name) => [name, async ({ aliasCommand }) => ({ command: aliasCommand })]),
);

test("Phase 9 dispatches all canonical commands without live side effects", async () => {
  const registry = createPhase9Registry(overridesFor(PHASE_9_COMMANDS));
  for (const command of PHASE_9_COMMANDS) {
    const args = [command];
    if (["buff", "join", "scangroups", "deletemessage", "alias", "downloadresource", "deleteresource"].includes(command)) {
      args.push("sample");
    }
    const result = await dispatchCommand(phase9Context(args), registry);
    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
  }
});

test("the aggregate registry contains all 218 canonical commands", () => {
  const allCommands = [
    ...PHASE_1_COMMANDS, ...PHASE_2_COMMANDS, ...PHASE_3_COMMANDS,
    ...PHASE_4_COMMANDS, ...PHASE_5_COMMANDS, ...PHASE_6_COMMANDS,
    ...PHASE_7_COMMANDS, ...PHASE_8_COMMANDS, ...PHASE_9_COMMANDS,
    ...PHASE_10_COMMANDS, ...PHASE_11_COMMANDS,
  ];
  const registry = createCommandRegistryForPhases(overridesFor(allCommands));
  assert.deepEqual(registry.definitions.map(({ name }) => name), allCommands);
  assert.equal(registry.definitions.length, 218);
  assert.equal(registry.lookup.size, new Set(registry.lookup.keys()).size);
});

test("Phase 9 enforces scope, permission, and missing argument gates", async () => {
  const registry = createPhase9Registry({
    kick: async () => { throw new Error("must not run"); },
    listblockbot: async () => { throw new Error("must not run"); },
    join: async () => { throw new Error("must not run"); },
  });

  const privateKick = await dispatchCommand(phase9Context(["kick"], { scope: "private" }), registry);
  assert.equal(privateKick.code, "SCOPE_DENIED");

  const regularList = await dispatchCommand(phase9Context(["listblockbot"], { permissionLevel: "all" }), registry);
  assert.equal(regularList.code, "PERMISSION_DENIED");

  const missingJoin = await dispatchCommand(phase9Context(["join"]), registry);
  assert.equal(missingJoin.code, "MISSING_ARGUMENT");
});

test("Phase 9 handler failures become structured errors", async () => {
  const registry = createPhase9Registry({ restart: async () => { throw new Error("restart failed"); } });
  const result = await dispatchCommand(phase9Context(["restart"]), registry);
  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.definition.name, "restart");
  assert.equal(result.error.message, "restart failed");
});

