import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bot launcher starts the listener with process.execPath instead of cmd.exe", () => {
  const source = readFileSync(new URL("../bot.js", import.meta.url), "utf8");

  assert.match(source, /spawn\(process\.execPath, \[bootstrapPath\]/);
  assert.doesNotMatch(source, /cmdPath/);
  assert.doesNotMatch(source, /\/c', 'node'/);
});
