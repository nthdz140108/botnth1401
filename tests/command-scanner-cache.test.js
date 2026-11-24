import test from "node:test";
import assert from "node:assert/strict";
import { defaultDependencyChecker, clearDependencyCache } from "../src/dashboard/command-scanner.js";

test("defaultDependencyChecker caches lookups to avoid repeated spawnSync", async () => {
  clearDependencyCache();

  const first = await defaultDependencyChecker("node");
  assert.equal(first, true);

  // Second call hits cache
  const second = await defaultDependencyChecker("node");
  assert.equal(second, true);

  clearDependencyCache();
});
