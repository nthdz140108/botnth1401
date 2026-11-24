import test from "node:test";
import assert from "node:assert/strict";
import * as registryModule from "../src/commands/command-registry.js";
import * as dispatcherModule from "../src/commands/command-dispatcher.js";

const PHASE_2 = [
  "deepseek", "analysis-image", "create-image", "google-search-ai",
  "vdsexy", "vdsex", "vdcos", "vdanime", "vdboy", "ff", "mail10p",
  "les", "quocgia", "gay", "dam", "info", "object", "card",
  "group", "detail", "speedtest", "topchat",
];

const mockDependencies = {
  zaloSession: true,
  python: true,
  ffmpeg: true,
  ffprobe: true,
};

test("Phase 2 exposes the expanded canonical command definitions", () => {
  assert.equal(typeof registryModule.createPhase2Registry, "function");
  assert.deepEqual(registryModule.PHASE_2_COMMANDS, PHASE_2);

  const registry = registryModule.createPhase2Registry();
  assert.deepEqual([...registry.canonicalNames].sort(), [...PHASE_2].sort());
  assert.equal(registry.definitions.length, 22);
  for (const command of PHASE_2) {
    assert.equal(typeof registry.lookup.get(command)[0].handler, "function", command);
  }
});

test("Phase 2 aliases resolve case-insensitively without collisions", () => {
  const registry = registryModule.createPhase2Registry();
  const expectedAliases = new Map([
    ["deepchat", "deepseek"],
    ["analysis", "analysis-image"],
    ["createimg", "create-image"],
    ["aisearch", "google-search-ai"],
    ["spt", "speedtest"],
    ["spdt", "speedtest"],
    ["i4", "info"],
    ["obj", "object"],
    ["gr", "group"],
    ["uptime", "detail"],
    ["dâm", "dam"],
  ]);

  const aliases = registry.definitions.flatMap((definition) => definition.aliases);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const [alias, canonical] of expectedAliases) {
    const entries = registry.lookup.get(alias);
    assert.equal(entries?.[0]?.name, canonical, alias);
  }
});

test("Phase 2 dispatch passes canonical command and parsed arguments to the adapter", async () => {
  assert.equal(typeof dispatcherModule.dispatchCommand, "function");
  const calls = [];
  const registry = registryModule.createPhase2Registry({
    "analysis-image": async (context) => {
      calls.push(context);
      return "image";
    },
  });

  const result = await dispatcherModule.dispatchCommand({
    commandParts: ["ANALYSIS-IMAGE", "ignored"],
    scope: "group",
    config: { GEMINI_API_KEYS: "test-key" },
    dbReady: true,
    api: {},
    message: {},
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.definition.name, "analysis-image");
  assert.deepEqual(result.resolved.args, ["ignored"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].aliasCommand, "analysis-image");
  assert.deepEqual(calls[0].args, ["ignored"]);
});

test("Phase 2 argument guards run before handlers", async () => {
  let called = false;
  const registry = registryModule.createPhase2Registry({
    ff: async () => { called = true; },
    quocgia: async () => { called = true; },
  });

  const missingFf = await dispatcherModule.dispatchCommand({
    commandParts: ["ff"],
    scope: "group",
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);
  assert.equal(missingFf.code, "MISSING_ARGUMENT");
  assert.equal(called, false);

  const missingCountry = await dispatcherModule.dispatchCommand({
    commandParts: ["quocgia"],
    scope: "group",
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);
  assert.equal(missingCountry.code, "MISSING_ARGUMENT");
  assert.equal(called, false);
});

test("Phase 2 handler failures become HANDLER_ERROR", async () => {
  const registry = registryModule.createPhase2Registry({
    dam: async () => { throw new Error("provider failed"); },
  });

  const result = await dispatcherModule.dispatchCommand({
    commandParts: ["dam"],
    scope: "private",
    dbReady: true,
    dependencies: mockDependencies,
  }, registry);

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.error.message, "provider failed");
});

test("unknown command remains available to the legacy dispatcher", async () => {
  const registry = registryModule.createPhase2Registry();
  assert.equal(await dispatcherModule.dispatchCommand({ commandParts: ["kick"] }, registry), null);
});
