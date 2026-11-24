import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("command runtime operates cleanly without MySQL database dependencies", () => {
  const source = readFileSync(path.join(projectRoot, "src/commands/command.js"), "utf8");

  assert.doesNotMatch(source, /databaseConnection|mysql2/);
  assert.match(source, /isDatabaseReady/);
});
