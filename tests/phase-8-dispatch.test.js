import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { resolveHighRiskPolicy } from "../src/commands/high-risk-policy.js";
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
  createPhase8Registry,
} from "../src/commands/command-registry.js";
import { resolveCommand } from "../src/commands/command-router.js";

const EXPECTED_PHASE_8_COMMANDS = [
  "antiall", "antitext", "antifile", "antiphoto", "antivoice",
  "onlytext", "ban", "unban", "tagall", "spamgroup", "scold",
  "approve", "learn", "learnnow", "unlearn", "reply", "autoreply",
  "undo", "todo", "sendp",
];

const overridesFor = (names) => Object.fromEntries(
  names.map((name) => [name, async ({ aliasCommand }) => ({ command: aliasCommand })]),
);

const contextFor = (commandParts, overrides = {}) => ({
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
  ...overrides,
});

test("Phase 8 exposes exactly the required 20 canonical definitions", () => {
  assert.deepEqual(PHASE_8_COMMANDS, EXPECTED_PHASE_8_COMMANDS);

  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));

  assert.deepEqual(registry.definitions.map(({ name }) => name), EXPECTED_PHASE_8_COMMANDS);
  assert.equal(registry.definitions.length, 20);
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("Phase 8 mock handlers dispatch without live side effects or DB blocking", async () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));

  for (const command of EXPECTED_PHASE_8_COMMANDS) {
    const result = await dispatchCommand(
      contextFor([command, "sample", "extra"], {
        isMainBotAdmin: true,
      }),
      registry,
    );

    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.equal(result.value.command, command);
  }
});

test("the aggregate registry appends Phase 9 after the first eight phases", () => {
  const expected = [
    ...PHASE_1_COMMANDS,
    ...PHASE_2_COMMANDS,
    ...PHASE_3_COMMANDS,
    ...PHASE_4_COMMANDS,
    ...PHASE_5_COMMANDS,
    ...PHASE_6_COMMANDS,
    ...PHASE_7_COMMANDS,
    ...EXPECTED_PHASE_8_COMMANDS,
    ...PHASE_9_COMMANDS,
    ...PHASE_10_COMMANDS,
    ...PHASE_11_COMMANDS,
  ];

  const registry = createCommandRegistryForPhases(overridesFor(expected));

  assert.deepEqual(registry.definitions.map(({ name }) => name), expected);
  assert.equal(registry.definitions.length, 219);
  assert.equal(registry.lookup.size, new Set(registry.lookup.keys()).size);
});

test("Phase 8 aliases resolve case-insensitively without shadowing todo", () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));
  const aliases = {
    VANBAN: "onlytext",
    ALL: "tagall",
    SPAMGR: "spamgroup",
    REO: "scold",
    VAR: "scold",
    CHUI: "scold",
    DUYETMEM: "approve",
    UN: "undo",
  };

  for (const [alias, canonical] of Object.entries(aliases)) {
    const result = resolveCommand([alias], registry);
    assert.equal(result.code, "RESOLVED", alias);
    assert.equal(result.definition.name, canonical, alias);
  }

  assert.equal(resolveCommand(["TODO"], registry).definition.name, "todo");
  assert.equal(registry.lookup.get("todo").length, 1);
  assert.equal(registry.lookup.get("sendp").length, 1);
});

test("the persisted command configuration has no canonical or alias collisions", () => {
  const config = JSON.parse(readFileSync(path.resolve("assets/json-data/command.json"), "utf8"));
  const seen = new Map();
  const collisions = [];

  for (const command of config.commands) {
    for (const name of [command.name, ...(command.alias || [])]) {
      const key = name.trim().toLowerCase();
      if (seen.has(key)) collisions.push([key, seen.get(key), command.name]);
      else seen.set(key, command.name);
    }
  }

  assert.deepEqual(collisions, []);
});

test("group-only Phase 8 commands deny private dispatch before invocation", async () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));

  for (const command of EXPECTED_PHASE_8_COMMANDS.filter((name) => !["todo", "ban", "unban"].includes(name))) {
    const result = await dispatchCommand(
      contextFor([command, "sample"], { scope: "private", isMainBotAdmin: true }),
      registry,
    );

    assert.equal(result.code, "SCOPE_DENIED", command);
    assert.equal(result.definition.name, command);
  }
});

test("public Phase 8 commands are available to all users", async () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));

  // autoreply moved to adminBox per the 2026-08-25 permission plan:
  // no phase-8 command remains public.
  const publicCommands = [];
  for (const command of publicCommands) {
    const result = await dispatchCommand(
      contextFor([command, "sample"], { permissionLevel: "all" }),
      registry,
    );

    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
  }
});

test("admin-only Phase 8 commands deny all users before invocation", async () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));

  for (const command of EXPECTED_PHASE_8_COMMANDS) {
    const result = await dispatchCommand(
      contextFor([command, "sample"], { permissionLevel: "all", isMainBotAdmin: false }),
      registry,
    );

    assert.equal(result.code, "PERMISSION_DENIED", command);
    assert.equal(result.definition.name, command);
  }
});

test("scold command is allowed for adminBox, adminBot and adminLevelHigh but denied for all", async () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));

  // Denied for all
  const allResult = await dispatchCommand(
    contextFor(["scold", "@target"], { permissionLevel: "all", isMainBotAdmin: false }),
    registry,
  );
  assert.equal(allResult.code, "PERMISSION_DENIED");

  // Allowed for adminBox
  const adminBoxResult = await dispatchCommand(
    contextFor(["scold", "@target"], { permissionLevel: "adminBox", isMainBotAdmin: false }),
    registry,
  );
  assert.equal(adminBoxResult.code, "HANDLED");

  // Allowed for adminBot
  const adminBotResult = await dispatchCommand(
    contextFor(["scold", "@target"], { permissionLevel: "adminBot", isMainBotAdmin: false }),
    registry,
  );
  assert.equal(adminBotResult.code, "HANDLED");

  // Allowed for adminLevelHigh
  const adminHighResult = await dispatchCommand(
    contextFor(["scold", "@target"], { permissionLevel: "adminLevelHigh", isMainBotAdmin: true }),
    registry,
  );
  assert.equal(adminHighResult.code, "HANDLED");
});

test("commands with required arguments fail before invoking their handlers", async () => {
  const registry = createPhase8Registry(overridesFor(EXPECTED_PHASE_8_COMMANDS));
  const required = ["scold", "unlearn", "todo", "sendp"];

  for (const command of required) {
    const result = await dispatchCommand(contextFor([command]), registry);

    assert.equal(result.code, "MISSING_ARGUMENT", command);
    assert.equal(result.definition.name, command);
  }

  const learnNow = await dispatchCommand(contextFor(["learnnow", "question"]), registry);
  assert.equal(learnNow.code, "MISSING_ARGUMENT");
  assert.equal(learnNow.definition.name, "learnnow");
});

test("Phase 8 handler failures become structured errors", async () => {
  const registry = createPhase8Registry({
    antiall: async () => {
      throw new Error("phase 8 handler failed");
    },
  });

  const result = await dispatchCommand(contextFor(["antiall"]), registry);

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.definition.name, "antiall");
  assert.equal(result.error.message, "phase 8 handler failed");
});

test("high-risk commands require main bot admin privilege without dry-run", async () => {
  const noMainAdmin = resolveHighRiskPolicy({ name: "spamgroup", risk: "critical" }, {
    isMainBotAdmin: false,
    dryRun: true,
  });
  assert.equal(noMainAdmin.allowed, false);
  assert.equal(noMainAdmin.code, "PERMISSION_DENIED");

  const allowed = resolveHighRiskPolicy({ name: "spamgroup", risk: "critical" }, {
    isMainBotAdmin: true,
    dryRun: false,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, undefined);
});
