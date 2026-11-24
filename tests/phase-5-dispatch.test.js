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
  createPhase5Registry,
} from "../src/commands/command-registry.js";

const EXPECTED_PHASE_5_COMMANDS = [
  "spamjoin", "ketban", "kb", "soundcloud", "zingmp3",
  "zingchart", "nhaccuatui", "voice", "truyencuoi", "tarrot",
  "poststatus", "createqr", "scanqr", "scanapi", "sendresourcesfile",
  "sendsrc", "sendresourcesvideo", "sendresourcesimage", "sendresourcesaudio",
];

const overridesFor = (names) => Object.fromEntries(
  names.map((name) => [name, async ({ aliasCommand }) => ({ command: aliasCommand })]),
);

const mockContext = {
  scope: "group",
  permissionLevel: "adminLevelHigh",
  isMainBotAdmin: true,
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

test("phase 5 exposes the exact canonical commands in definition order", () => {
  assert.deepEqual(PHASE_5_COMMANDS, EXPECTED_PHASE_5_COMMANDS);

  const registry = createPhase5Registry(overridesFor(EXPECTED_PHASE_5_COMMANDS));
  assert.deepEqual(
    registry.definitions.map(({ name }) => name),
    EXPECTED_PHASE_5_COMMANDS,
  );
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("phase 5 commands dispatch through injected handlers without live operations", async () => {
  const registry = createPhase5Registry(overridesFor(EXPECTED_PHASE_5_COMMANDS));

  for (const command of EXPECTED_PHASE_5_COMMANDS) {
    const result = await dispatchCommand({
      ...mockContext,
      commandParts: [command, "sample", "extra"],
    }, registry);

    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.equal(result.value.command, command);
  }
});

test("the aggregate registry appends phases 7 through 9 after phases 1 through 6", () => {
  const expected = [
    ...PHASE_1_COMMANDS,
    ...PHASE_2_COMMANDS,
    ...PHASE_3_COMMANDS,
    ...PHASE_4_COMMANDS,
    ...EXPECTED_PHASE_5_COMMANDS,
    ...PHASE_6_COMMANDS,
    ...PHASE_7_COMMANDS,
    ...PHASE_8_COMMANDS,
    ...PHASE_9_COMMANDS,
    ...PHASE_10_COMMANDS,
    ...PHASE_11_COMMANDS,
  ];
  const registry = createCommandRegistryForPhases(overridesFor(expected));

  assert.deepEqual(registry.definitions.map(({ name }) => name), expected);
});

test("sendsrc resolves the sharesrc compatibility alias case-insensitively", async () => {
  const registry = createPhase5Registry({
    sendsrc: async ({ aliasCommand }) => aliasCommand,
  });

  const result = await dispatchCommand({
    ...mockContext,
    commandParts: ["SHARESRC", "sample", "extra"],
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.definition.name, "sendsrc");
  assert.equal(result.value, "sharesrc");
});
