import test from "node:test";
import assert from "node:assert/strict";
import {
  createPhase1Registry,
  createPhase2Registry,
  createPhase4Registry,
  phase1Registry,
  phase2Registry,
  phase4Registry,
} from "../src/commands/command-registry.js";
import { dispatchPhase1Command, dispatchCommand } from "../src/commands/command-dispatcher.js";

function findDefinition(registry, name) {
  const def = registry.lookup.get(name);
  return Array.isArray(def) ? def[0] : def;
}

test("gpt command requires KIRA_API_KEY via requiredConfig", () => {
  const def = findDefinition(phase1Registry, "gpt");
  assert.ok(def, "gpt definition should exist");
  assert.deepEqual(def.requiredConfig, ["KIRA_API_KEY"]);
});

test("deepseek command requires KIRA_API_KEY via requiredConfig", () => {
  const def = findDefinition(phase2Registry, "deepseek");
  assert.ok(def, "deepseek definition should exist");
  assert.deepEqual(def.requiredConfig, ["KIRA_API_KEY"]);
});

test("dich command requires KIRA_API_KEY via requiredConfig", () => {
  const def = findDefinition(phase4Registry, "dich");
  assert.ok(def, "dich definition should exist");
  assert.deepEqual(def.requiredConfig, ["KIRA_API_KEY"]);
});

test("gpt dispatcher returns MISSING_DEPENDENCY without invoking the handler", async () => {
  let called = false;
  const registry = createPhase1Registry({
    gpt: async () => {
      called = true;
    },
  });

  const result = await dispatchPhase1Command({
    commandParts: ["gpt", "xin chao"],
    scope: "private",
    config: {},
    dependencies: { zaloSession: true },
  }, registry);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["KIRA_API_KEY"]);
  assert.equal(result.missingDetails[0].kind, "config");
  assert.equal(called, false, "handler must not be invoked when KIRA_API_KEY is missing");
});

test("deepseek dispatcher returns MISSING_DEPENDENCY without invoking the handler", async () => {
  let called = false;
  const registry = createPhase2Registry({
    deepseek: async () => {
      called = true;
    },
  });

  const result = await dispatchCommand({
    commandParts: ["deepseek", "hello"],
    scope: "private",
    config: {},
    dependencies: { zaloSession: true },
  }, registry);

  assert.equal(result?.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["KIRA_API_KEY"]);
  assert.equal(called, false);
});

test("gpt dispatcher proceeds past dependency gate when KIRA_API_KEY is configured", async () => {
  let called = false;
  const registry = createPhase1Registry({
    gpt: async () => {
      called = true;
      return "ok";
    },
  });

  const result = await dispatchPhase1Command({
    commandParts: ["gpt", "xin chao"],
    scope: "private",
    config: { KIRA_API_KEY: "present" },
    dependencies: { zaloSession: true },
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(called, true);
});

test("dich dispatcher returns MISSING_DEPENDENCY without invoking the handler", async () => {
  let called = false;
  const registry = createPhase4Registry({
    dich: async () => {
      called = true;
    },
  });

  const result = await dispatchCommand({
    commandParts: ["dich", "hello&&vietnamese"],
    scope: "private",
    config: {},
    dependencies: { zaloSession: true },
  }, registry);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["KIRA_API_KEY"]);
  assert.equal(called, false);
});