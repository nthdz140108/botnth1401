import test from "node:test";
import assert from "node:assert/strict";
import { diffConfig, validateConfig } from "../../src/dashboard/config-adapter.js";

test("reports config diffs and validates feature flags", () => {
  const diff = diffConfig(
    { prefix: "!", features: { privateMode: true, autoReply: false } },
    { prefix: ".", features: { privateMode: false, autoReply: true, game: true } },
  );

  assert.deepEqual(diff.changed.sort(), ["features.autoReply", "features.privateMode", "prefix"]);
  assert.deepEqual(diff.added, ["features.game"]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(validateConfig({ prefix: "!", alias: ["help"], features: { privateMode: true, autoReply: false } }), []);
  assert.match(validateConfig({ prefix: "", alias: ["", 1], features: { privateMode: "yes" } })[0], /prefix/i);
});
