import test from "node:test";
import assert from "node:assert/strict";
import { diffConfig, validateConfig } from "../src/dashboard/config-adapter.js";

test("config adapter reports nested changes and rejects invalid feature values", () => {
  const diff = diffConfig({ prefix: "!", features: { antiLink: false } }, { prefix: ".", features: { antiLink: true } });
  assert.deepEqual(diff.changed, ["prefix", "features.antiLink"]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(validateConfig({ prefix: "", features: { antiLink: "yes" } }), ["prefix must be a non-empty string", "antiLink must be boolean"]);
  assert.deepEqual(validateConfig({ prefix: ".", features: { antiLink: true } }), []);
});
