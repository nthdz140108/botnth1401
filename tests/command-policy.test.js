import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCOPE,
  normalizeScope,
  resolveCommandPolicy,
  scopeAllows,
} from "../src/commands/command-policy.js";

test("missing scope resolves to both", () => {
  const result = resolveCommandPolicy({ command: { name: "ping" } });

  assert.equal(DEFAULT_SCOPE, "both");
  assert.equal(result.scope, "both");
  assert.equal(result.effectiveScope, "both");
});

test("global scope is used when present", () => {
  const result = resolveCommandPolicy({ command: { name: "ping", scope: "group" } });

  assert.equal(result.scope, "group");
  assert.equal(result.effectiveScope, "group");
});

test("bot override wins over global scope", () => {
  const result = resolveCommandPolicy({
    command: { name: "ping", scope: "group" },
    override: { scope: "private" },
  });

  assert.equal(result.effectiveScope, "private");
  assert.deepEqual(result.override, { scope: "private" });
});

test("resetting the override falls back to the global scope", () => {
  const result = resolveCommandPolicy({ command: { name: "ping", scope: "group" }, override: null });

  assert.equal(result.effectiveScope, "group");
  assert.equal(result.override, null);
});

test("scope matching accepts both and rejects the other scope", () => {
  assert.equal(normalizeScope(undefined), "both");
  assert.equal(scopeAllows("both", "group"), true);
  assert.equal(scopeAllows("both", "private"), true);
  assert.equal(scopeAllows("group", "private"), false);
});
