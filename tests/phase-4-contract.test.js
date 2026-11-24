import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { createCommandRegistryForPhases, createPhase4Registry } from "../src/commands/command-registry.js";

const registryWith = (name, handler = async () => "ok") => createPhase4Registry({ [name]: handler });

test("group-only phase 4 commands reject private dispatch", async () => {
  const result = await dispatchCommand({
    commandParts: ["prservice", "hello"],
    scope: "private",
    permissionLevel: "adminBox",
    dbReady: true,
  }, registryWith("prservice"));

  assert.equal(result.code, "SCOPE_DENIED");
  assert.equal(result.definition.name, "prservice");
});

test("phase 4 commands report missing arguments before invoking a handler", async () => {
  let invoked = false;
  const result = await dispatchCommand({
    commandParts: ["tiktok"],
    scope: "group",
    permissionLevel: "all",
    config: { HOANGDEV_API_KEY: "test-key" },
  }, registryWith("tiktok", async () => {
    invoked = true;
  }));

  assert.equal(result.code, "MISSING_ARGUMENT");
  assert.equal(invoked, false);
});

test("phase 4 permission metadata is enforced by the common router", async () => {
  const result = await dispatchCommand({
    commandParts: ["prservice"],
    scope: "group",
    permissionLevel: "all",
  }, registryWith("prservice"));

  assert.equal(result.code, "PERMISSION_DENIED");
});

test("phase 4 handler failures become structured errors", async () => {
  const result = await dispatchCommand({
    commandParts: ["getlink"],
    scope: "group",
    permissionLevel: "all",
    dependencies: { zaloSession: true },
  }, registryWith("getlink", async () => {
    throw new Error("provider failed");
  }));

  assert.equal(result.code, "HANDLER_ERROR");
  assert.match(result.error.message, /provider failed/);
});

test("phase 4 maps legacy aliases to the canonical registry", () => {
  const registry = createCommandRegistryForPhases();
  const aliasPairs = [
    ["myaccount", "name"],
    ["mysetting", "name"],
    ["setaccount", "name"],
    ["setavatar-account", "name"],
    ["create-group", "group"],
    ["invite-box", "group"],
    ["auto-join", "autojoin"],
  ];

  for (const [alias, canonical] of aliasPairs) {
    const resolved = registry.lookup.get(alias);
    assert.equal(Array.isArray(resolved), true, alias);
    assert.equal(resolved.length, 1, alias);
    assert.equal(resolved[0].name, canonical, alias);
  }
});
