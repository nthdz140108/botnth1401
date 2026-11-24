import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import {
  PHASE_1_COMMANDS,
  PHASE_2_COMMANDS,
  PHASE_3_COMMANDS,
  PHASE_5_COMMANDS,
  PHASE_4_COMMANDS,
  PHASE_6_COMMANDS,
  PHASE_7_COMMANDS,
  PHASE_8_COMMANDS,
  PHASE_9_COMMANDS,
  PHASE_10_COMMANDS,
  PHASE_11_COMMANDS,
  commandRegistry,
  createCommandRegistryForPhases,
  createPhase4Registry,
} from "../src/commands/command-registry.js";

const EXPECTED_PHASE_4_COMMANDS = [
  "tiktok",
  "spotify",
  "youtube",
  "capcut",
  "download",
  "dich",
  "qrbank",
  "getlink",
  "getvoice",
  "checkip",
  "checkdomain",
  "cpus",
  "thoitiet",
  "prservice",
];

const overridesFor = (names) => Object.fromEntries(
  names.map((name) => [name, async ({ aliasCommand }) => ({ command: aliasCommand })]),
);

const COMMANDS_WITH_ARGUMENTS = new Set([
  "tiktok", "spotify", "youtube", "capcut", "download", "dich", "qrbank",
  "checkip", "checkdomain", "thoitiet", "prservice",
]);

test("phase 4 exposes the exact 14 canonical commands", () => {
  assert.deepEqual(PHASE_4_COMMANDS, EXPECTED_PHASE_4_COMMANDS);

  const registry = createPhase4Registry(overridesFor(EXPECTED_PHASE_4_COMMANDS));
  assert.deepEqual(
    registry.definitions.map(({ name }) => name),
    EXPECTED_PHASE_4_COMMANDS,
  );
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("phase 4 commands resolve and dispatch through their registry", async () => {
  const registry = createPhase4Registry(overridesFor(EXPECTED_PHASE_4_COMMANDS));

  for (const command of EXPECTED_PHASE_4_COMMANDS) {
    const result = await dispatchCommand({
      commandParts: [
        ...command.split(" "),
        ...(COMMANDS_WITH_ARGUMENTS.has(command) ? ["sample"] : []),
      ],
      scope: "group",
      permissionLevel: "adminLevelHigh",
      dbReady: true,
      dependencies: { zaloSession: true },
      config: {
        HOANGDEV_API_KEY: "test-hoangdev",
        KIRA_API_KEY: "test-kira",
        TIKTOK_SEARCH_API_URL: "https://tiktok.example.test/search",
        TIKTOK_SEARCH_API_KEY: "test-tiktok",
        SPOTIFY_CLIENT_ID: "test-client",
        SPOTIFY_CLIENT_SECRET: "test-secret",
        SPOTIFY_DOWNLOADER_SECRET: "test-downloader-secret",
        SPOTIFY_DOWNLOADER_PASSPHRASE: "test-downloader-passphrase",
        OPENWEATHER_API_KEY: "test-weather",
      },
    }, registry);

    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.deepEqual(result.value, { command });
  }
});

test("the aggregate registry contains phases 1 through 11 exactly once", () => {
  const expected = [
    ...PHASE_1_COMMANDS,
    ...PHASE_2_COMMANDS,
    ...PHASE_3_COMMANDS,
    ...EXPECTED_PHASE_4_COMMANDS,
    ...PHASE_5_COMMANDS,
    ...PHASE_6_COMMANDS,
    ...PHASE_7_COMMANDS,
    ...PHASE_8_COMMANDS,
    ...PHASE_9_COMMANDS,
    ...PHASE_10_COMMANDS,
    ...PHASE_11_COMMANDS,
  ];
  const registry = createCommandRegistryForPhases(overridesFor(expected));

  assert.deepEqual(registry.definitions.map(({ name }) => name), expected);
  assert.equal(commandRegistry.definitions.length, expected.length);
  assert.equal(new Set(commandRegistry.definitions.map(({ name }) => name)).size, expected.length);
});
