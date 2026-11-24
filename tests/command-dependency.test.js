import test from "node:test";
import assert from "node:assert/strict";
import { commandRegistry, createPhase1Registry, createPhase3Registry, createPhase5Registry } from "../src/commands/command-registry.js";
import { dispatchCommand, dispatchPhase1Command } from "../src/commands/command-dispatcher.js";

test("gemini returns MISSING_DEPENDENCY without invoking its handler", async () => {
  let called = false;
  const registry = createPhase1Registry({
    gemini: async () => {
      called = true;
    },
  });

  const result = await dispatchPhase1Command({
    commandParts: ["gemini", "hello"],
    scope: "private",
    config: {},
    dependencies: { zaloSession: true },
  }, registry);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["GEMINI_API_KEYS"]);
  assert.equal(result.missingDetails[0].kind, "config");
  assert.equal(called, false);
});

test("editvideo returns MISSING_DEPENDENCY without invoking its handler when ffmpeg is missing", async () => {
  let called = false;
  const registry = createPhase3Registry({
    editvideo: async () => {
      called = true;
    },
  });

  const result = await dispatchCommand({
    commandParts: ["editvideo", "cut"],
    scope: "group",
    permissionLevel: "adminBox",
    config: {},
    dependencies: { zaloSession: true, ffmpeg: false, ffprobe: true },
  }, registry);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.equal(result.missingDetails[0].kind, "runtime");
  assert.equal(called, false);
});

test("spamjoin retains a critical-risk registry guard without provider retries", () => {
  const definition = createPhase5Registry().lookup.get("spamjoin")[0];

  assert.equal(definition.risk, "critical");
  assert.equal(definition.timeoutMs, 0);
  assert.deepEqual(definition.requiredConfig, []);
  assert.equal(definition.minArgs, 2);
});

test("the aggregate runtime registry requires a live Zalo session", () => {
  assert.equal(commandRegistry.definitions.every((definition) => definition.requiredDependencies.includes("zaloSession")), true);
});
