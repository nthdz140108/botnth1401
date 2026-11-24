import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandScanner, validateCommandOverrides } from "../src/dashboard/command-scanner.js";
import { createCommandDefinition, createCommandRegistry } from "../src/commands/command-router.js";

test("command scanner reports duplicate aliases and missing handlers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-scan-"));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "commands", "alpha"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "!", commands: [
    { name: "alpha", alias: ["SAME"], permission: "all", active: true },
    { name: "missing", alias: ["same"], permission: "bad", active: true, scope: "direct" }
  ] }));
  await fs.writeFile(path.join(root, "src", "commands", "alpha", "alpha.js"), "// missing is mentioned in source text\nexport function alpha() {};");
  const registry = createCommandRegistry([
    createCommandDefinition({ name: "alpha", handler: () => "ok", aliases: ["same"] }),
  ]);
  const result = await new CommandScanner({ root, registry }).scan();
  assert.equal(result.commands.length, 2);
  assert.ok(result.diagnostics.some((item) => item.type === "duplicate_alias"));
  assert.ok(result.diagnostics.some((item) => item.type === "missing_handler"));
  assert.ok(result.diagnostics.some((item) => item.type === "invalid_permission"));
  assert.ok(result.diagnostics.some((item) => item.type === "invalid_scope"));
});

test("command scanner exposes runtime enablement, handler availability, and dependency metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-scan-runtime-"));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "!", commands: [
    { name: "alpha", alias: ["a"], permission: "all", active: false },
    { name: "beta", alias: [], permission: "all", active: true },
    { name: "gamma", alias: [], permission: "all", active: true },
  ] }));

  const registry = {
    lookup: new Map([
      ["alpha", [{ name: "alpha", handler: () => "alpha", active: true, requiredConfig: ["ALPHA_TOKEN"], requiredDependencies: ["node"] }]],
      ["beta", [{ name: "beta", active: true }]],
      ["gamma", [{ name: "gamma", handler: () => "gamma", active: true, requiredConfig: ["GAMMA_TOKEN"], requiredDependencies: ["ffmpeg"] }]],
    ]),
  };

  const result = await new CommandScanner({
    root,
    registry,
    env: { ALPHA_TOKEN: "set" },
    dependencyChecker: async (name) => name === "node",
  }).scan();

  const alpha = result.commands.find((command) => command.name === "alpha");
  const beta = result.commands.find((command) => command.name === "beta");
  const gamma = result.commands.find((command) => command.name === "gamma");

  assert.equal(alpha.active, false);
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.handlerAvailable, true);
  assert.deepEqual(alpha.requiredConfig, ["ALPHA_TOKEN"]);
  assert.deepEqual(alpha.requiredDependencies, ["node"]);
  assert.deepEqual(alpha.missingConfig, []);
  assert.deepEqual(alpha.missingDependencies, []);

  assert.equal(beta.handlerAvailable, false);
  assert.equal(beta.enabled, false);

  assert.equal(gamma.enabled, false);
  assert.deepEqual(gamma.missingConfig, ["GAMMA_TOKEN"]);
  assert.deepEqual(gamma.missingDependencies, ["ffmpeg"]);

  assert.ok(result.diagnostics.some((item) => item.type === "missing_handler" && item.command === "beta"));
  assert.ok(result.diagnostics.some((item) => item.type === "missing_config" && item.command === "gamma"));
  assert.ok(result.diagnostics.some((item) => item.type === "missing_dependency" && item.command === "gamma"));
  assert.ok(result.diagnostics.some((item) => item.type === "active_mismatch" && item.command === "alpha"));
});

test("command scanner exposes a default effective scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-scan-scope-"));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    commands: [{ name: "ping", alias: [], permission: "all" }],
  }));

  const result = await new CommandScanner({ root, registry: createCommandRegistry([
    createCommandDefinition({ name: "ping", handler: () => "ok" }),
  ]) }).scan();

  assert.equal(result.commands[0].scope, "both");
  assert.equal(result.commands[0].effectiveScope, "both");
});

test("command scanner reports an unavailable handler registry instead of trusting source text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-scan-no-registry-"));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "commands"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    commands: [{ name: "missing", alias: [], permission: "all" }],
  }));
  await fs.writeFile(path.join(root, "src", "commands", "notes.js"), "// missing handler is documented here");

  const result = await new CommandScanner({ root }).scan();

  assert.ok(result.diagnostics.some((item) => item.type === "handler_registry_unavailable"));
  assert.ok(result.diagnostics.some((item) => item.type === "missing_handler"));
});

test("command overrides reject invalid fields and permissions", () => {
  assert.throws(() => validateCommandOverrides({ alpha: { countdown: -1 } }), /countdown/);
  assert.throws(() => validateCommandOverrides({ alpha: { permission: "root" } }), /permission/);
  assert.deepEqual(validateCommandOverrides({ alpha: { alias: ["a"], active: false, countdown: 2 } }), { alpha: { alias: ["a"], active: false, countdown: 2 } });
});
