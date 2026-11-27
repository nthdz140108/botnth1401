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
  createPhase6Registry,
} from "../src/commands/command-registry.js";

const EXPECTED_PHASE_6_COMMANDS = [
  "lich", "manager", "listmute",
  "settinggroup", "changelink", "listadmin", "add", "remove", "setcmd",
  "bot", "autodownload", "mute", "unmute", "prefix", "sendtext",
];

const mockDependencies = {
  zaloSession: true,
  python: true,
  ffmpeg: true,
  ffprobe: true,
};

const overridesFor = (names) => Object.fromEntries(
  names.map((name) => [name, async ({ aliasCommand }) => ({ command: aliasCommand })]),
);

const contextFor = (commandParts) => ({
  commandParts,
  scope: "group",
  permissionLevel: "adminLevelHigh",
  isMainBotAdmin: true,
  config: {},
  dbReady: true,
  api: {},
  message: {},
  dependencies: mockDependencies,
});

test("Phase 6 exposes exactly 15 canonical definitions", () => {
  assert.deepEqual(PHASE_6_COMMANDS, EXPECTED_PHASE_6_COMMANDS);
  const registry = createPhase6Registry(overridesFor(EXPECTED_PHASE_6_COMMANDS));
  assert.deepEqual(registry.definitions.map(({ name }) => name), EXPECTED_PHASE_6_COMMANDS);
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("Phase 6 mock handlers dispatch without live side effects", async () => {
  const registry = createPhase6Registry(overridesFor(EXPECTED_PHASE_6_COMMANDS));
  for (const command of EXPECTED_PHASE_6_COMMANDS) {
    const result = await dispatchCommand(
      contextFor([...command.split(" "), "sample", "extra"]),
      registry,
    );
    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.equal(result.value.command, command);
  }
});

test("the aggregate registry appends Phases 7 through 9 after the first six phases", () => {
  const expected = [
    ...PHASE_1_COMMANDS,
    ...PHASE_2_COMMANDS,
    ...PHASE_3_COMMANDS,
    ...PHASE_4_COMMANDS,
    ...PHASE_5_COMMANDS,
    ...EXPECTED_PHASE_6_COMMANDS,
    ...PHASE_7_COMMANDS,
    ...PHASE_8_COMMANDS,
    ...PHASE_9_COMMANDS,
    ...PHASE_10_COMMANDS,
    ...PHASE_11_COMMANDS,
  ];
  const registry = createCommandRegistryForPhases(overridesFor(expected));

  assert.deepEqual(registry.definitions.map(({ name }) => name), expected);
  assert.equal(registry.definitions.length, 220);
  assert.equal(registry.lookup.size, new Set(registry.lookup.keys()).size);
});

test("Phase 6 aliases resolve case-insensitively", async () => {
  const registry = createPhase6Registry(overridesFor(EXPECTED_PHASE_6_COMMANDS));
  const aliases = {
    AMLICH: "lich",
    CALENDAR: "lich",
    STG: "settinggroup",
    STGR: "settinggroup",
    CMDSET: "setcmd",
    ATD: "autodownload",
  };

  for (const [alias, canonical] of Object.entries(aliases)) {
    const result = await dispatchCommand(
      contextFor([alias, "sample", "extra"]),
      registry,
    );
    assert.equal(result.definition.name, canonical, alias);
    assert.equal(result.code, "HANDLED", alias);
  }
});
