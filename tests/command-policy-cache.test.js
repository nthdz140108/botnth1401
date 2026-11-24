import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandSource = fs.readFileSync(path.join(root, "src", "commands", "command.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces in ${signature}`);
}

test("command.js exports invalidateRuntimePolicyCache that clears cache entries", () => {
  const fnSource = extractFunction(commandSource, "export function invalidateRuntimePolicyCache");
  assert.match(fnSource, /botId\s*=\s*null/);
  assert.ok(fnSource.includes(".clear()") || fnSource.includes(".delete("), "must delete a key or clear the map");
});

test("index.js imports invalidateRuntimePolicyCache from commands/command.js", () => {
  assert.match(
    indexSource,
    /import\s*\{\s*[^}]*invalidateRuntimePolicyCache[^}]*\}\s*from\s*"\.\/commands\/command\.js"/
  );
});

test("reloadCommandConfig calls invalidateRuntimePolicyCache AFTER reloading config", () => {
  const reloadFn = extractFunction(indexSource, "export function reloadCommandConfig");
  assert.ok(reloadFn.includes("invalidateRuntimePolicyCache()"), "reload must invalidate the runtime policy cache");
  const configReloadAt = reloadFn.indexOf("readCommandConfig()");
  const invalidateAt = reloadFn.indexOf("invalidateRuntimePolicyCache()");
  assert.ok(configReloadAt !== -1, "reloadCommandConfig must read fresh command.json");
  assert.ok(invalidateAt > configReloadAt, "invalidation must happen after the config reload");
});
