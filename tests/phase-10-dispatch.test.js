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
  createPhase10Registry,
} from "../src/commands/command-registry.js";

const phase10Context = (commandParts, overrides = {}) => ({
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
  isAdminLevelHighest: true,
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

test("Phase 10 dispatches the remaining Nqduan commands through a mock Zalo session", async () => {
  const registry = createPhase10Registry(overridesFor(PHASE_10_COMMANDS));
  for (const command of PHASE_10_COMMANDS) {
    const args = [command];
    if (["target", "key"].includes(command)) {
      args.push("sample");
    }
    const result = await dispatchCommand(phase10Context(args), registry);
    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
  }
});

test("Phase 10 high-risk commands execute directly without dry-run confirmation for main bot admin", async () => {
  const registry = createPhase10Registry(overridesFor(PHASE_10_COMMANDS));
  for (const command of PHASE_10_COMMANDS) {
    const args = [command];
    if (["target", "key"].includes(command)) {
      args.push("sample");
    }
    const result = await dispatchCommand(phase10Context(args, {
      dryRun: false,
      isMainBotAdmin: true,
    }), registry);
    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
  }
});

test("Phase 10 high-risk commands deny insufficient permission before execution", async () => {
  const registry = createPhase10Registry(overridesFor(PHASE_10_COMMANDS));
  for (const command of PHASE_10_COMMANDS) {
    const args = [command];
    if (["target", "key"].includes(command)) {
      args.push("sample");
    }
    const result = await dispatchCommand(phase10Context(args, {
      permissionLevel: "adminBot",
      isAdminLevelHighest: false,
      isMainBotAdmin: false,
    }), registry);
    assert.equal(result.code, "PERMISSION_DENIED", command);
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

