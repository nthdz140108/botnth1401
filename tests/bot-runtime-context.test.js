import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBotRuntimeContext,
  seedRuntimeFiles,
} from "../src/utils/bot-runtime-context.js";
import * as runtimeContext from "../src/utils/bot-runtime-context.js";
import { resetCache as resetEnvCache } from "../src/utils/env.js";

function makeRuntimeContext(root, uid) {
  const workspaceRoot = path.join(root, "mybot", "instances", uid);
  const dataDir = path.join(workspaceRoot, "data");
  return {
    uid,
    projectRoot: root,
    workspaceRoot,
    instanceRoot: workspaceRoot,
    dataDir,
    logsDir: path.join(workspaceRoot, "logs"),
    tempDir: path.join(workspaceRoot, "temp"),
    resourcesDir: path.join(workspaceRoot, "resources"),
    generatedDir: path.join(workspaceRoot, "generated"),
    stateDir: path.join(workspaceRoot, "state"),
    commandConfigPath: path.join(dataDir, "command.json"),
    groupSettingsPath: path.join(dataDir, "group-settings.json"),
  };
}

test("uses the bot config name when uid is omitted", () => {
  const context = createBotRuntimeContext({ name: "child-1" });

  assert.equal(context.uid, "child-1");
  assert.match(context.commandConfigPath, /mybot[\\/]instances[\\/]child-1[\\/]data[\\/]command\.json$/);
});

test("resolves legacy relative runtime paths against the project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-runtime-paths-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    const context = createBotRuntimeContext({
      uid: "admin",
      tempDir: "assets/temp/admin",
      logDir: "logs/admin",
    });

    assert.equal(context.tempDir, path.join(root, "assets", "temp", "admin"));
    assert.equal(context.logDir, path.join(root, "logs", "admin"));
    assert.equal(path.isAbsolute(context.tempDir), true);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
  }
});

test("seeds a bot runtime command file from that bot's command config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-runtime-context-"));
  const context = makeRuntimeContext(root, "child-1");
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "json-data"), { recursive: true });
  await fs.writeFile(
    path.join(root, "assets", "json-data", "command.json"),
    JSON.stringify({ prefix: "admin" }),
  );
  await fs.writeFile(
    path.join(root, "mybot", "json-data", "command-child-1.json"),
    JSON.stringify({ prefix: "child" }),
  );

  seedRuntimeFiles(context);

  assert.equal(
    JSON.parse(await fs.readFile(context.commandConfigPath, "utf8")).prefix,
    "child",
  );
});

test("writes a new prefix to the runtime command config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-prefix-config-"));
  const commandPath = path.join(root, "command.json");
  await fs.writeFile(commandPath, JSON.stringify({ prefix: "!", commands: [] }));

  assert.equal(typeof runtimeContext.updateCommandPrefixFile, "function");
  runtimeContext.updateCommandPrefixFile(commandPath, "?");

  assert.equal(JSON.parse(await fs.readFile(commandPath, "utf8")).prefix, "?");
});
