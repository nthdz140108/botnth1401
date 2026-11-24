import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_RESULT_CODES, createCommandRegistry, executeCommand, resolveCommand } from "../src/commands/command-router.js";
import { commandRegistry } from "../src/commands/command-registry.js";

function makeRegistry() {
  const calls = [];
  const registry = createCommandRegistry([
    {
      name: "mainonly",
      aliases: ["monly"],
      permission: "all",
      type: 1,
      instanceScope: "main",
      handler: async (context) => {
        calls.push({ kind: context.instanceKind ?? "default" });
        return { ok: true };
      },
    },
    {
      name: "shared",
      aliases: ["sh"],
      permission: "all",
      type: 1,
      handler: async (context) => {
        calls.push({ kind: context.instanceKind ?? "default", name: "shared" });
        return { ok: true };
      },
    },
  ]);
  return { registry, calls };
}

test("INSTANCE_DENIED is part of the dispatcher result contract", () => {
  assert.equal(COMMAND_RESULT_CODES.includes("INSTANCE_DENIED"), true);
});

test("every registry definition exposes a normalized instanceScope", () => {
  for (const definition of commandRegistry.definitions) {
    assert.ok(
      definition.instanceScope === "any" || definition.instanceScope === "main",
      `${definition.name} has instanceScope ${definition.instanceScope}`,
    );
  }
});

test("mybot family is main-only while restart and admin stay usable on child bots", () => {
  for (const key of ["mybot", "mebot", "clean"]) {
    const result = resolveCommand([key], commandRegistry);
    assert.equal(result.code, "RESOLVED", key);
    assert.equal(result.definition.instanceScope, "main", key);
  }

  for (const key of ["restart", "rs", "admin"]) {
    const result = resolveCommand([key], commandRegistry);
    assert.equal(result.code, "RESOLVED", key);
    assert.notEqual(result.definition.instanceScope, "main", key);
  }
});

test("child instances are denied main-only commands before the handler runs", async () => {
  const { registry, calls } = makeRegistry();
  const { definition } = resolveCommand(["mainonly"], registry);

  const denied = await executeCommand({ instanceKind: "child", permissionLevel: "adminLevelHigh" }, definition);
  assert.equal(denied.code, "INSTANCE_DENIED");
  assert.equal(denied.command, "mainonly");
  assert.equal(calls.length, 0);

  const deniedAlias = resolveCommand(["MONLY"], registry);
  assert.equal(deniedAlias.definition, definition);
});

test("main instances and legacy contexts keep running main-only commands", async () => {
  const { registry, calls } = makeRegistry();
  const { definition } = resolveCommand(["mainonly"], registry);
  const deps = { dependencies: { zaloSession: true } };

  const mainResult = await executeCommand({ instanceKind: "main", ...deps }, definition);
  assert.equal(mainResult.code, "HANDLED");
  assert.deepEqual(calls.at(-1), { kind: "main" });

  const legacyResult = await executeCommand({ ...deps }, definition);
  assert.equal(legacyResult.code, "HANDLED");
  assert.deepEqual(calls.at(-1), { kind: "default" });
});

test("child instances still execute commands with default instance scope", async () => {
  const { registry, calls } = makeRegistry();
  const { definition } = resolveCommand(["shared"], registry);

  const result = await executeCommand(
    { instanceKind: "child", dependencies: { zaloSession: true } },
    definition,
  );
  assert.equal(result.code, "HANDLED");
  assert.deepEqual(calls.at(-1), { kind: "child", name: "shared" });
});
