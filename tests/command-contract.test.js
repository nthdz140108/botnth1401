import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE_1_COMMANDS,
  createPhase1Registry,
  phase1Registry,
} from "../src/commands/command-registry.js";
import { resolveCommand } from "../src/commands/command-router.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("phase 1 registry has exactly the required canonical commands", () => {
  assert.deepEqual([...phase1Registry.canonicalNames].sort(), [...PHASE_1_COMMANDS].sort());
  assert.equal(phase1Registry.definitions.length, 18);
  for (const definition of phase1Registry.definitions) {
    assert.equal(typeof definition.handler, "function", definition.name);
  }
});

test("phase 1 aliases resolve case-insensitively without collisions", () => {
  const registry = createPhase1Registry();
  const aliases = registry.definitions.flatMap((definition) => definition.aliases);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const name of PHASE_1_COMMANDS) {
    const result = resolveCommand(name.toUpperCase().split(" "), registry);
    assert.equal(result.code, "RESOLVED", name);
    assert.equal(result.definition.name, name);
  }
  for (const alias of aliases) {
    assert.equal(resolveCommand([alias.toUpperCase()], registry).code, "RESOLVED", alias);
  }
  assert.equal(registry.lookup.get("menu")[0].name, "help");
  assert.equal(registry.lookup.get("gem")[0].name, "gemini");
  assert.equal(registry.lookup.get("vdgai")[0].name, "vdgirl");
});

test("gemini make uses a dedicated image adapter", () => {
  const gemini = phase1Registry.lookup.get("gemini")[0];
  const image = phase1Registry.lookup.get("gemini make")[0];

  assert.notEqual(gemini.handler, image.handler);
  assert.equal(image.permission, "adminLevelHigh");
});


test("simsimi preserves its current private-only scope", () => {
  assert.equal(phase1Registry.lookup.get("simsimi")[0].scope, "private");
});

test("Gemini image generation reads credentials from environment", () => {
  const source = readFileSync(
    path.join(projectRoot, "src/service-debug/api-crawl/assistant-ai/genai.js"),
    "utf8"
  );
  assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(source), false);
  assert.equal(source.includes("GEMINI_API_KEYS"), true);
});
