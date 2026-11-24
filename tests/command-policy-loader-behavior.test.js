import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeCommandPolicy, getCommandBehavior } from "../src/commands/command-policy-loader.js";

const policy = {
  commands: [
    { name: "help", scope: "both", behavior: { operation: { cooldownMode: "global", maxUsesPerHour: 5 } } },
    { name: "plain", scope: "both" },
  ],
  overrides: {
    help: { scope: "private", behavior: { operation: { maxUsesPerHour: 20 } } },
  },
};

test("resolves merged behavior with override winning leaves", () => {
  const resolved = resolveRuntimeCommandPolicy({ name: "help" }, policy);
  assert.equal(resolved.effectiveScope, "private");
  assert.equal(resolved.behavior.operation.maxUsesPerHour, 20);
  assert.equal(resolved.behavior.operation.cooldownMode, "global");
});

test("commands without behavior yield null behavior (full backward compat)", () => {
  const resolved = resolveRuntimeCommandPolicy({ name: "plain" }, policy);
  assert.equal(resolved.behavior, null);
  assert.equal(getCommandBehavior(policy, "unknown-cmd"), null);
});

test("getCommandBehavior resolves by alias too", () => {
  const policyWithAlias = {
    commands: [{ name: "kick", alias: ["duoi"], behavior: { operation: { killSwitch: true } } }],
    overrides: {},
  };
  const behavior = getCommandBehavior(policyWithAlias, "duoi");
  assert.equal(behavior?.operation.killSwitch, true);
});
