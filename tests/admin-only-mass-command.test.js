import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeCommandPolicy, isAdminOnlyMassCommand } from "../src/commands/command-policy-loader.js";

const commands = [
  { name: "spamjoin", permission: "all" },
  { name: "spamgroup", permission: "all" },
  { name: "sendresourcesvideo", permission: "all" },
  { name: "autojoin", permission: "all" },
];

test("mass commands are forced to high-level admin at runtime", () => {
  for (const command of commands) {
    const policy = resolveRuntimeCommandPolicy(command, { commands, overrides: {} });
    assert.equal(policy.permission, "adminLevelHigh", command.name);
    assert.equal(isAdminOnlyMassCommand(command), true);
  }
});

test("ordinary commands keep their configured permission", () => {
  const policy = resolveRuntimeCommandPolicy({ name: "help", permission: "all" }, {
    commands: [{ name: "help", permission: "all" }],
    overrides: {},
  });
  assert.equal(policy.permission, "all");
  assert.equal(isAdminOnlyMassCommand("help"), false);
});
