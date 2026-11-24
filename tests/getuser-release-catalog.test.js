import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadRuntimeCommandPolicy } from "../src/commands/command-policy-loader.js";
import { CommandScanner } from "../src/dashboard/command-scanner.js";
import { CommandService } from "../src/dashboard/command-service.js";
import { commandRegistry } from "../src/commands/command-registry.js";

function oldCatalog(t, commands = [{ name: "help", permission: "all", active: false }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "getuser-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "assets", "json-data", "command.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify({ prefix: "$", commands });
  fs.writeFileSync(file, bytes);
  return { root, file, bytes };
}

function releaseEnv(t) {
  const previous = process.env.MYBOT_CODE_COMMIT;
  process.env.MYBOT_CODE_COMMIT = "a".repeat(40);
  t.after(() => {
    if (previous === undefined) delete process.env.MYBOT_CODE_COMMIT;
    else process.env.MYBOT_CODE_COMMIT = previous;
  });
}

test("a versioned release supplies getuser to the bot without overwriting the shared catalog", (t) => {
  releaseEnv(t);
  const { root, file, bytes } = oldCatalog(t);
  const policy = loadRuntimeCommandPolicy({ root });
  assert.equal(policy.commands.find((command) => command.name === "getuser")?.scope, "group");
  const script = `import {readCommandConfig} from ${JSON.stringify(new URL("../src/utils/io-json.js", import.meta.url).href)}; console.log('CATALOG=' + JSON.stringify(readCommandConfig()));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, PROJECT_ROOT: root, SKIP_ENV_VALIDATION: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime = JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith("CATALOG=")).slice(8));
  assert.equal(runtime.prefix, "$");
  assert.equal(runtime.commands.find((command) => command.name === "help").active, false);
  assert.ok(runtime.commands.find((command) => command.name === "getuser")?.active);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("release dashboard scanning and per-bot listings include getuser with the shared catalog left intact", async (t) => {
  releaseEnv(t);
  const { root, file, bytes } = oldCatalog(t);
  const scanner = new CommandScanner({ root, registry: commandRegistry, dependencyChecker: async () => true });
  const scan = await scanner.scan();
  assert.equal(scan.commands.find((command) => command.name === "getuser")?.handlerAvailable, true);
  const service = new CommandService({ root, registry: { async list() { return []; } }, scanner });
  const bot = await service.listForBot("child");
  assert.ok(bot.commands.find((command) => command.name === "getuser"));
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("existing getuser settings take precedence over release defaults", (t) => {
  releaseEnv(t);
  const { root } = oldCatalog(t, [{ name: "getuser", active: false, countdown: 123, permission: "adminBot" }]);
  const policy = loadRuntimeCommandPolicy({ root });
  assert.equal(policy.commands.filter((command) => command.name === "getuser").length, 1);
  assert.equal(policy.commands[0].active, false);
  assert.equal(policy.commands[0].countdown, 123);
  assert.equal(policy.commands[0].permission, "adminBot");
});

test("editing another command does not persist implicit release defaults into shared storage", async (t) => {
  releaseEnv(t);
  const { root, file } = oldCatalog(t);
  const service = new CommandService({ root });
  await service.updateGlobal("help", { countdown: 2 });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.commands.map((command) => command.name), ["help"]);
  assert.equal(saved.commands[0].countdown, 2);
  assert.equal(saved.prefix, "$");
});

test("a release command cannot report successful deletion and then silently reappear", async (t) => {
  releaseEnv(t);
  const { root, file, bytes } = oldCatalog(t);
  const service = new CommandService({ root });
  await assert.rejects(service.deleteGlobal("getuser"), /release|active/i);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("an intentional getuser setting change persists and survives later reads", async (t) => {
  releaseEnv(t);
  const { root, file } = oldCatalog(t);
  const service = new CommandService({ root });
  await service.updateGlobal("getuser", { countdown: 321 });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.commands.find((command) => command.name === "getuser").countdown, 321);
  assert.equal(loadRuntimeCommandPolicy({ root }).commands.find((command) => command.name === "getuser").countdown, 321);
});

test("global edits cannot collide with a release-only command name or alias", async (t) => {
  releaseEnv(t);
  const { root, file, bytes } = oldCatalog(t);
  const service = new CommandService({ root });
  await assert.rejects(service.updateGlobal("help", { alias: ["getuser"] }), /duplicate alias/i);
  await assert.rejects(service.createGlobal({ name: "custom", alias: ["getuser"], permission: "all" }), /duplicate alias/i);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("a persisted release command cannot be deleted via its custom alias", async (t) => {
  releaseEnv(t);
  const { root, file, bytes } = oldCatalog(t, [{ name: "getuser", alias: ["people"], active: false }]);
  const service = new CommandService({ root });
  await assert.rejects(service.deleteGlobal("people"), /release|active/i);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});
