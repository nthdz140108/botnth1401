import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the audio resource handler declares its filesystem dependency", () => {
  const source = readFileSync("src/commands/lenh-debug/send-all/send-resources-audio.js", "utf8");
  assert.match(source, /import fs from [\"']node:fs[\"']/);
});
