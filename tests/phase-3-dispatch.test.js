import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE_3_COMMANDS,
  PHASE_6_COMMANDS,
  PHASE_7_COMMANDS,
  PHASE_8_COMMANDS,
  PHASE_9_COMMANDS,
  commandRegistry,
  createPhase3Registry,
} from "../src/commands/command-registry.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { resolveCommand } from "../src/commands/command-router.js";

const PHASE_3 = [
  "lamnet", "sticker", "stkmeme", "gifmeme", "giftxt", "editvideo",
  "gifvd", "giftext", "stickercustom", "phatnguoi", "gif",
];

const mockDependencies = {
  zaloSession: true,
  python: true,
  ffmpeg: true,
  ffprobe: true,
};

test("Phase 3 exposes exactly 11 canonical command definitions", () => {
  assert.deepEqual(PHASE_3_COMMANDS, PHASE_3);

  const registry = createPhase3Registry();
  assert.deepEqual([...registry.canonicalNames].sort(), [...PHASE_3].sort());
  assert.equal(registry.definitions.length, 11);
  for (const command of PHASE_3) {
    assert.equal(typeof registry.lookup.get(command)?.[0]?.handler, "function", command);
  }
});

test("Phase 3 aliases resolve case-insensitively without collisions", () => {
  const registry = createPhase3Registry();
  const expectedAliases = new Map([
    ["stk", "sticker"],
    ["stkc", "stickercustom"],
    ["phng", "phatnguoi"],
  ]);

  const aliases = registry.definitions.flatMap(({ aliases: values }) => values);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const [alias, canonical] of expectedAliases) {
    assert.equal(resolveCommand([alias.toUpperCase()], registry).definition.name, canonical, alias);
  }
  assert.equal(registry.lookup.get("stk")[0].name, "sticker");
});

test("Phase 3 adapter receives parsed arguments and canonical alias metadata", async () => {
  const calls = [];
  const registry = createPhase3Registry({
    giftxt: async (context) => {
      calls.push(context);
      return "gif";
    },
  });

  const result = await dispatchCommand({
    commandParts: ["GIFTXT", "hello", "world"],
    scope: "group",
    config: {},
    dbReady: true,
    api: {},
    message: {},
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.definition.name, "giftxt");
  assert.deepEqual(result.resolved.args, ["hello", "world"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].aliasCommand, "giftxt");
  assert.deepEqual(calls[0].args, ["hello", "world"]);
});

test("binary-backed Phase 3 commands are blocked before invoking handlers", async () => {
  let called = false;
  const registry = createPhase3Registry({
    editvideo: async () => { called = true; },
  });

  const result = await dispatchCommand({
    commandParts: ["editvideo", "cut"],
    scope: "group",
    config: {},
    dependencies: { ...mockDependencies, ffmpeg: false },
  }, registry);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.equal(result.missingDetails[0].kind, "runtime");
  assert.equal(called, false);
});

test("provider-dependent Phase 3 commands report missing configuration before invoking handlers", async () => {
  let called = false;
  const registry = createPhase3Registry({
    gifmeme: async () => { called = true; },
  });

  const result = await dispatchCommand({
    commandParts: ["gifmeme", "funny"],
    scope: "group",
    config: {},
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["TENOR_API_KEY"]);
  assert.equal(called, false);
});

test("configured Tenor reaches the Phase 3 provider handler", async () => {
  let called = false;
  const registry = createPhase3Registry({
    gifmeme: async () => {
      called = true;
      return "gif";
    },
  });

  const result = await dispatchCommand({
    commandParts: ["gifmeme", "funny"],
    scope: "group",
    config: { TENOR_API_KEY: "configured" },
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "gif");
  assert.equal(called, true);
});

test("Phase 3 argument guards run before invoking media handlers", async () => {
  let called = false;
  const registry = createPhase3Registry({
    stkmeme: async () => { called = true; },
  });

  const result = await dispatchCommand({
    commandParts: ["stkmeme"],
    scope: "group",
    config: { TENOR_API_KEY: "configured" },
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "MISSING_ARGUMENT");
  assert.equal(called, false);
});

test("Phase 3 handler failures become HANDLER_ERROR", async () => {
  const registry = createPhase3Registry({
    phatnguoi: async () => { throw new Error("provider failed"); },
  });

  const result = await dispatchCommand({
    commandParts: ["phng", "car"],
    scope: "private",
    config: {},
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.error.message, "provider failed");
});

test("the combined registry includes Phases 6 through 9", async () => {
  assert.equal(commandRegistry.definitions.length, 219);
  for (const command of [...PHASE_6_COMMANDS, ...PHASE_7_COMMANDS, ...PHASE_8_COMMANDS, ...PHASE_9_COMMANDS]) {
    assert.equal(commandRegistry.lookup.get(command)[0].name, command);
  }
  assert.equal(commandRegistry.lookup.get("sticker")[0].name, "sticker");

  const result = await dispatchCommand({ commandParts: ["kick"] }, commandRegistry);
  assert.equal(result.code, "SCOPE_DENIED");
});

test("the default dispatcher resolves Phase 3 through the combined registry", async () => {
  const result = await dispatchCommand({
    commandParts: ["editvideo", "cut"],
    scope: "group",
    dependencies: { ...mockDependencies, ffmpeg: false },
  });

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.equal(result.definition.name, "editvideo");
});
