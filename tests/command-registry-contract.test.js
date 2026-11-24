import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand } from "../src/commands/command-router.js";
import { commandRegistry } from "../src/commands/command-registry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "assets", "json-data", "command.json"), "utf8"));
const manifestCommands = Array.isArray(manifest.commands) ? manifest.commands : [];

const requiredMetadataKeys = [
  "permission",
  "scope",
  "type",
  "minArgs",
  "countdown",
  "risk",
  "requiredConfig",
  "requiredDependencies",
];

test("aggregate registry matches the manifest canonical command set", () => {
  const manifestNames = manifestCommands.map((command) => command.name);
  const registryNames = commandRegistry.definitions.map((definition) => definition.name);

  assert.equal(commandRegistry.definitions.length, manifestCommands.length);
  assert.deepEqual([...new Set(manifestNames)].sort(), [...registryNames].sort());
  assert.equal(registryNames.includes("antigif"), true);
  assert.equal(registryNames.includes("cotuong"), false);
});

test("every manifest canonical command resolves to a concrete handler definition", () => {
  for (const command of manifestCommands) {
    const result = resolveCommand(command.name.toUpperCase().split(" "), commandRegistry);
    assert.equal(result.code, "RESOLVED", command.name);
    assert.equal(result.definition.name, command.name);
    assert.equal(typeof result.definition.handler, "function", command.name);
  }
});

test("every manifest alias resolves back to its canonical command", () => {
  for (const command of manifestCommands) {
    for (const alias of command.alias ?? []) {
      const result = resolveCommand(alias.toUpperCase().split(/\s+/), commandRegistry);
      assert.equal(result.code, "RESOLVED", alias);
      assert.equal(result.definition.name, command.name, alias);
    }
  }
});

test("registry definitions expose the normalized contract metadata", () => {
  for (const definition of commandRegistry.definitions) {
    for (const key of requiredMetadataKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(definition, key), `${definition.name}:${key}`);
    }
    assert.ok(Array.isArray(definition.requiredConfig), definition.name);
    assert.ok(Array.isArray(definition.requiredDependencies), definition.name);
    assert.equal(typeof definition.permission, "string", definition.name);
    assert.equal(typeof definition.type, "number", definition.name);
    assert.equal(typeof definition.countdown, "number", definition.name);
    assert.equal(typeof definition.risk, "string", definition.name);
    assert.equal(typeof definition.minArgs, "number", definition.name);
    assert.equal(typeof definition.scope, "string", definition.name);
    assert.equal(typeof definition.handler, "function", definition.name);
  }
});
