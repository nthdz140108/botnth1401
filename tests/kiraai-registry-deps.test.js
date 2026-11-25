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

test("gpt command accepts KIRA_API_KEY or OPENAI_API_KEY via requiredConfig", () => {
  const def = findDefinition(phase1Registry, "gpt");
  assert.ok(def, "gpt definition should exist");
  assert.deepEqual(def.requiredConfig, [["KIRA_API_KEY", "OPENAI_API_KEY"]]);
});

test("deepseek command accepts DEEPSEEK_API_KEY or KIRA_API_KEY via requiredConfig", () => {
  const def = findDefinition(phase2Registry, "deepseek");
  assert.ok(def, "deepseek definition should exist");
  assert.deepEqual(def.requiredConfig, [["DEEPSEEK_API_KEY", "KIRA_API_KEY"]]);
});

test("dich command works out of the box without hard requiredConfig", () => {
  const def = findDefinition(phase4Registry, "dich");
  assert.ok(def, "dich definition should exist");
  assert.deepEqual(def.requiredConfig, []);
});

test("gpt dispatcher returns MISSING_DEPENDENCY without invoking the handler when both keys missing", async () => {
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
  assert.equal(result.missingDetails[0].kind, "config");
  assert.equal(called, false, "handler must not be invoked when keys are missing");
});

test("deepseek dispatcher returns MISSING_DEPENDENCY without invoking the handler when both keys missing", async () => {
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
  assert.equal(called, false);
});

test("gpt dispatcher proceeds past dependency gate when KIRA_API_KEY or OPENAI_API_KEY is configured", async () => {
  let called = 0;
  const registry = createPhase1Registry({
    gpt: async () => {
      called += 1;
      return "ok";
    },
  });

  const resultKira = await dispatchPhase1Command({
    commandParts: ["gpt", "xin chao"],
    scope: "private",
    config: { KIRA_API_KEY: "present" },
    dependencies: { zaloSession: true },
  }, registry);
  assert.equal(resultKira.code, "HANDLED");

  const resultOpenAi = await dispatchPhase1Command({
    commandParts: ["gpt", "xin chao"],
    scope: "private",
    config: { OPENAI_API_KEY: "present" },
    dependencies: { zaloSession: true },
  }, registry);
  assert.equal(resultOpenAi.code, "HANDLED");
  assert.equal(called, 2);
});

test("dich dispatcher proceeds without API keys via free fallback", async () => {
  let called = false;
  const registry = createPhase4Registry({
    dich: async () => {
      called = true;
      return "translated";
    },
  });

  const result = await dispatchCommand({
    commandParts: ["dich", "hello&&vietnamese"],
    scope: "private",
    config: {},
    dependencies: { zaloSession: true },
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(called, true);
});
