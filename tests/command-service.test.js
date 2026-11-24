import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandScanner } from "../src/dashboard/command-scanner.js";
import { CommandService } from "../src/dashboard/command-service.js";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-service-"));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "command-overrides"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    prefix: "!",
    commands: [{ name: "ping", alias: ["p"], permission: "all", active: true }],
  }));
  return root;
}

function createService(root, scanner = { scan: async () => ({}) }) {
  return new CommandService({
    root,
    registry: { list: async () => [] },
    scanner,
    configStore: {
      async writeJson(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value));
        return { value, changedPaths: [] };
      },
    },
  });
}

test("global command updates resolve aliases case-insensitively", async () => {
  const root = await makeRoot();
  const service = createService(root);

  const result = await service.updateGlobal("  P  ", { description: "updated" });

  assert.equal(result.value.commands[0].description, "updated");
});

test("bot command overrides resolve aliases and persist under the canonical name", async () => {
  const root = await makeRoot();
  const service = createService(root);

  await service.updateOverride("child", "P", { active: false });
  const listed = await service.listForBot("child");

  assert.deepEqual(listed.commands[0].override, { active: false });
});

test("dashboard command validation accepts the highest runtime permission level", async () => {
  const root = await makeRoot();
  const service = createService(root);

  const result = await service.updateGlobal("ping", { permission: "adminLevelHigh" });

  assert.equal(result.value.commands[0].permission, "adminLevelHigh");
});

test("command scope resolves global, bot override, and reset precedence", async () => {
  const root = await makeRoot();
  const service = createService(root);

  await service.updateGlobal("ping", { scope: "group" });
  let listed = await service.listForBot("child");
  assert.equal(listed.commands[0].scope, "group");
  assert.equal(listed.commands[0].effectiveScope, "group");
  assert.equal(listed.commands[0].override, null);

  await service.updateOverride("child", "ping", { scope: "private" });
  listed = await service.listForBot("child");
  assert.equal(listed.commands[0].override.scope, "private");
  assert.equal(listed.commands[0].effectiveScope, "private");

  await service.deleteOverride("child", "ping");
  listed = await service.listForBot("child");
  assert.equal(listed.commands[0].effectiveScope, "group");
  assert.equal(listed.commands[0].override, null);
});

test("command scope validation rejects unsupported values", async () => {
  const root = await makeRoot();
  const service = createService(root);

  await assert.rejects(() => service.updateGlobal("ping", { scope: "direct" }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "COMMAND_VALIDATION_FAILED");
    return true;
  });
  await assert.rejects(() => service.updateOverride("child", "ping", { scope: "direct" }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "COMMAND_VALIDATION_FAILED");
    return true;
  });
});

test("global command writes preserve registry active state while exposing runtime enablement", async () => {
  const root = await makeRoot();
  const scanner = new CommandScanner({
    root,
    registry: {
      lookup: new Map([
        ["ping", [{
          name: "ping",
          handler: () => "ok",
          active: true,
          requiredConfig: [],
          requiredDependencies: [],
        }]],
      ]),
    },
    env: {},
    dependencyChecker: async () => true,
  });
  const service = createService(root, scanner);

  const before = await service.list();
  assert.equal(before.commands[0].enabled, true);
  assert.equal(before.commands[0].active, true);

  const result = await service.updateGlobal("ping", { active: false, description: "updated" });

  assert.equal(result.value.commands[0].active, true);
  const persisted = JSON.parse(await fs.readFile(path.join(root, "assets", "json-data", "command.json"), "utf8"));
  assert.equal(persisted.commands[0].active, true);

  const after = await service.list();
  assert.equal(after.commands[0].enabled, true);
  assert.equal(after.commands[0].handlerAvailable, true);
  assert.equal(after.commands[0].active, true);
});
