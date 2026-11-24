import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_STATE_KEYS,
  composeRuntimeCommandConfig,
  createCommandSeedStub,
  extractCommandState,
  toStateOnlyCommandConfig,
} from "../src/utils/command-runtime-state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const catalog = {
  prefix: "!",
  commands: [
    { name: "mybot", alias: ["mebot", "clean"], permission: "all", type: 1, countdown: 30 },
    { name: "help", alias: ["menu"], permission: "all", type: 1, countdown: 5 },
    { name: "brandnew", permission: "all", type: 1, countdown: 1 },
  ],
};

test("command state extraction keeps only per-bot state fields", () => {
  const staleSnapshot = [
    { name: "mybot", alias: ["custom-alias"], permission: "adminLevelHigh", countdown: 9, type: 99, description: "stale", active: false },
    { name: "help", alias: ["menu"], permission: "all", type: 1, active: true },
    { name: "ghost", permission: "all", active: true },
  ];

  const state = extractCommandState(staleSnapshot);

  assert.deepEqual([...state.keys()].sort(), ["ghost", "help", "mybot"]);
  assert.deepEqual(state.get("mybot"), { active: false, alias: ["custom-alias"], permission: "adminLevelHigh", countdown: 9 });
  assert.deepEqual(state.get("help"), { active: true, alias: ["menu"], permission: "all" });
  for (const key of Object.keys(state.get("mybot"))) {
    assert.equal(COMMAND_STATE_KEYS.includes(key), true);
  }
});

test("persisting collapses a config back to prefix plus per-bot state", () => {
  const composed = composeRuntimeCommandConfig({
    catalog,
    runtimeFile: { prefix: "?", commands: [{ name: "mybot", active: false }] },
  });

  const persisted = toStateOnlyCommandConfig(composed, { catalog });

  assert.equal(persisted.prefix, "?");
  assert.deepEqual(persisted.commands, [{ name: "mybot", active: false }]);
});

test("runtime composition layers shared catalog under per-bot state", () => {
  const runtimeFile = {
    prefix: "?",
    commands: [{ name: "mybot", active: false }],
  };

  const composed = composeRuntimeCommandConfig({ catalog, runtimeFile });

  assert.equal(composed.prefix, "?");
  const mybot = composed.commands.find((command) => command.name === "mybot");
  assert.deepEqual(mybot.alias, ["mebot", "clean"]);
  assert.equal(mybot.permission, "all");
  assert.equal(mybot.type, 1);
  assert.equal(mybot.active, false);

  const help = composed.commands.find((command) => command.name === "help");
  assert.equal(help.countdown, 5);
  assert.equal(help.active, true);
});

test("new catalog commands appear for every bot without reseeding", () => {
  const runtimeFile = createCommandSeedStub("!");
  const first = composeRuntimeCommandConfig({ catalog, runtimeFile });
  assert.equal(first.commands.some((command) => command.name === "brandnew"), true);

  const extendedCatalog = {
    prefix: "!",
    commands: [...catalog.commands, { name: "added-later", permission: "all" }],
  };
  const second = composeRuntimeCommandConfig({ catalog: extendedCatalog, runtimeFile });
  assert.equal(second.commands.some((command) => command.name === "added-later"), true);
});

test("per-bot composition is independent between bots and does not mutate the catalog", () => {
  const botA = { prefix: "!", commands: [{ name: "help", active: false }] };
  const botB = { prefix: "#", commands: [] };

  const composedA = composeRuntimeCommandConfig({ catalog, runtimeFile: botA });
  const composedB = composeRuntimeCommandConfig({ catalog, runtimeFile: botB });

  assert.equal(composedA.prefix, "!");
  assert.equal(composedB.prefix, "#");
  assert.equal(composedA.commands.find((command) => command.name === "help").active, false);
  assert.equal(composedB.commands.find((command) => command.name === "help").active, true);
  assert.equal(catalog.commands.find((command) => command.name === "help").active, undefined);
  assert.equal(catalog.prefix, "!");
});

test("legacy full-copy snapshots stop leaking non-state metadata drift", () => {
  const legacyCopy = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "assets", "json-data", "command.json"), "utf8"),
  );
  legacyCopy.prefix = "~";
  for (const entry of legacyCopy.commands) {
    entry.description = `stale description for ${entry.name}`;
    entry.syntax = "drifted-syntax";
  }

  const composed = composeRuntimeCommandConfig({ catalog, runtimeFile: legacyCopy });
  const persisted = toStateOnlyCommandConfig(composed, { catalog });

  assert.equal(persisted.prefix, "~");
  for (const command of composed.commands) {
    const catalogEntry = catalog.commands.find((c) => c.name === command.name);
    assert.ok(catalogEntry, command.name);
    if (catalogEntry.alias) {
      assert.deepEqual(command.alias, catalogEntry.alias);
    }
    assert.equal(command.description, catalogEntry.description);
  }
  for (const entry of persisted.commands) {
    for (const key of Object.keys(entry)) {
      if (key === "name") continue;
      assert.equal(COMMAND_STATE_KEYS.includes(key), true, `${entry.name}:${key}`);
    }
  }
});

test("child creation flows no longer copy defaultCommand.json into independent catalogs", () => {
  const pm2Source = fs.readFileSync(path.join(projectRoot, "src", "commands", "mybot", "System", "pm2-manager.js"), "utf8");
  const qrLoginSource = fs.readFileSync(path.join(projectRoot, "src", "commands", "mybot", "Manager", "qr-login-command.js"), "utf8");

  assert.doesNotMatch(pm2Source, /copyFile\(defaultCmdSource/);
  assert.match(pm2Source, /createCommandSeedStub\(\)/);
  assert.doesNotMatch(qrLoginSource, /copyFile\(defaultCmdSource/);
  assert.match(qrLoginSource, /createCommandSeedStub\(\)/);
});
