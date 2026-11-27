import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import * as registryModule from "../src/commands/command-registry.js";

const EXPECTED_PHASE_7_COMMANDS = [
  "sendstk", "sendtask", "welcome", "bye", "updategroup",
  "antibadword", "antisetup", "antibot", "antiblockall", "antisdt",
  "antilink", "autojoin", "antijoin", "antiforward", "antitag",
  "antistickerlag", "antisticker", "antigif", "antispam", "antinude", "antiundo",
];

const overridesFor = (names) => Object.fromEntries(
  names.map((name) => [name, async ({ aliasCommand }) => ({ command: aliasCommand })]),
);

const contextFor = (commandParts) => ({
  commandParts,
  scope: "group",
  permissionLevel: "adminLevelHigh",
  config: {},
  dbReady: true,
  api: {},
  message: {},
  dependencies: {
    zaloSession: true,
    python: true,
    ffmpeg: true,
    ffprobe: true,
  },
});

test("Phase 7 exposes exactly 20 canonical definitions", () => {
  assert.deepEqual(registryModule.PHASE_7_COMMANDS, EXPECTED_PHASE_7_COMMANDS);
  assert.equal(typeof registryModule.createPhase7Registry, "function");

  const registry = registryModule.createPhase7Registry(overridesFor(EXPECTED_PHASE_7_COMMANDS));
  assert.deepEqual(registry.definitions.map(({ name }) => name), EXPECTED_PHASE_7_COMMANDS);
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("Phase 7 mock handlers dispatch without live side effects or DB blocking", async () => {
  const registry = registryModule.createPhase7Registry(overridesFor(EXPECTED_PHASE_7_COMMANDS));
  for (const command of EXPECTED_PHASE_7_COMMANDS) {
    const result = await dispatchCommand(
      contextFor([command, "sample", "extra"]),
      registry,
    );

    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.equal(result.value.command, command);
  }
});

test("the aggregate registry appends Phases 7 through 9 after Phases 1 through 6", () => {
  const expected = [
    ...registryModule.PHASE_1_COMMANDS,
    ...registryModule.PHASE_2_COMMANDS,
    ...registryModule.PHASE_3_COMMANDS,
    ...registryModule.PHASE_4_COMMANDS,
    ...registryModule.PHASE_5_COMMANDS,
    ...registryModule.PHASE_6_COMMANDS,
    ...EXPECTED_PHASE_7_COMMANDS,
    ...registryModule.PHASE_8_COMMANDS,
    ...registryModule.PHASE_9_COMMANDS,
    ...registryModule.PHASE_10_COMMANDS,
    ...registryModule.PHASE_11_COMMANDS,
  ];
  const registry = registryModule.createCommandRegistryForPhases(overridesFor(expected));

  assert.deepEqual(registry.definitions.map(({ name }) => name), expected);
  assert.equal(registry.definitions.length, 220);
  assert.equal(registry.lookup.size, new Set(registry.lookup.keys()).size);
});

test("Phase 7 aliases resolve case-insensitively to their canonical commands", async () => {
  const aliases = {
    AUTOSEND: "sendtask",
    WL: "welcome",
    WLC: "welcome",
    ATBW: "antibadword",
    LOCTU: "antibadword",
    LOCTUKHOA: "antibadword",
    LOCTK: "antibadword",
    BADWORD: "antibadword",
    BW: "antibadword",
    XOALINK: "antilink",
    LOCLINK: "antilink",
    ANTISTKLAG: "antistickerlag",
    ANTISTK: "antisticker",
    CHONGSPAM: "antispam",
    CHONGNUDE: "antinude",
    CHONGUNDO: "antiundo",
  };
  const registry = registryModule.createPhase7Registry(overridesFor(EXPECTED_PHASE_7_COMMANDS));

  for (const [alias, canonical] of Object.entries(aliases)) {
    const result = await dispatchCommand(contextFor([alias, "sample"]), registry);
    assert.equal(result.definition.name, canonical, alias);
    assert.equal(result.code, "HANDLED", alias);
  }
});
