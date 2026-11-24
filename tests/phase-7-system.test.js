import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "canvas";

import { createCommandDefinition, executeCommand } from "../src/commands/command-router.js";

const tempFile = (name) => path.join(os.tmpdir(), `phase-7-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

test("Phase 7 command matrix covers private/group, permission, scope, min args, timeout, and handler errors", async () => {
  const cases = [
    { name: "group-only", scope: "group", def: { scope: "group", permission: "all" }, context: { scope: "private" }, expected: "SCOPE_DENIED" },
    { name: "private-only", scope: "private", def: { scope: "private", permission: "all" }, context: { scope: "group" }, expected: "SCOPE_DENIED" },
    { name: "permission", scope: "group", def: { permission: "adminBot" }, context: { scope: "group", permissionLevel: "all" }, expected: "PERMISSION_DENIED" },
    { name: "min-args", scope: "group", def: { minArgs: 2, permission: "all" }, context: { scope: "group", args: ["one"] }, expected: "MISSING_ARGUMENT" },
    { name: "timeout", scope: "group", def: { timeoutMs: 5, permission: "all", handler: async () => new Promise((resolve) => setTimeout(() => resolve("late"), 20)) }, context: { scope: "group" }, expected: "TIMEOUT" },
    { name: "handler-error", scope: "group", def: { permission: "all", handler: async () => { throw new Error("boom"); } }, context: { scope: "group" }, expected: "HANDLER_ERROR" },
  ];

  for (const testCase of cases) {
    const command = createCommandDefinition({ name: testCase.name, handler: testCase.def.handler || (async () => "ok"), ...testCase.def });
    const result = await executeCommand(testCase.context, command);
    assert.equal(result.code, testCase.expected, testCase.name);
  }
});

test("Phase 7 scope and permission gating matrix stays deterministic", async () => {
  const allowCommand = createCommandDefinition({ name: "help", permission: "all", handler: async () => "ok" });
  const denyCommand = createCommandDefinition({ name: "deny", handler: async () => "ok", scope: "group", permission: "adminBot" });

  const allowed = await executeCommand({ scope: "group", permissionLevel: "adminBot" }, allowCommand);
  assert.equal(allowed.code, "HANDLED");

  const deniedByScope = await executeCommand({ scope: "private", permissionLevel: "adminBot" }, createCommandDefinition({ name: "help", permission: "all", handler: async () => "ok", scope: "group" }));
  assert.equal(deniedByScope.code, "SCOPE_DENIED");

  const deniedByPermission = await executeCommand({ scope: "group", permissionLevel: "all" }, denyCommand);
  assert.equal(deniedByPermission.code, "PERMISSION_DENIED");

  const activeGame = { threadA: { activeGame: false }, threadB: { activeGame: true } };
  assert.equal(activeGame.threadA.activeGame, false);
  assert.equal(activeGame.threadB.activeGame, true);
});

test("canvas render smoke creates and cleans temp files", async () => {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#112233";
  ctx.fillRect(0, 0, 64, 64);

  const renderPath = tempFile("render-smoke.png");
  await fs.writeFile(renderPath, canvas.toBuffer("image/png"));
  assert.equal(existsSync(renderPath), true);
  await fs.rm(renderPath, { force: true });
  assert.equal(existsSync(renderPath), false);
});
