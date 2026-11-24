import test from "node:test";
import assert from "node:assert/strict";
import {
  createCommandDefinition,
  createCommandRegistry,
} from "../src/commands/command-router.js";
import { dispatchPhase1Command } from "../src/commands/command-dispatcher.js";

test("dispatches a longest-match Phase 1 command through its registry handler", async () => {
  const calls = [];
  const registry = createCommandRegistry([
    createCommandDefinition({ name: "gemini", handler: async () => "chat" }),
    createCommandDefinition({
      name: "gemini make",
      handler: async (context) => {
        calls.push(context);
        return "image";
      },
    }),
  ]);

  const result = await dispatchPhase1Command({
    commandParts: ["GEMINI", "MAKE", "cat"],
    scope: "group",
    config: {},
    dbReady: true,
    dependencies: {
      zaloSession: true,
      python: true,
      ffmpeg: true,
      ffprobe: true,
    },
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.definition.name, "gemini make");
  assert.deepEqual(result.resolved.args, ["cat"]);
  assert.equal(calls[0].aliasCommand, "gemini make");
});

test("returns null for commands outside Phase 1 so legacy dispatch can continue", async () => {
  const registry = createCommandRegistry([
    createCommandDefinition({ name: "help", handler: async () => "handled" }),
  ]);

  assert.equal(await dispatchPhase1Command({ commandParts: ["kick"] }, registry), null);
});

test("returns router errors for a Phase 1 scope violation", async () => {
  const registry = createCommandRegistry([
    createCommandDefinition({ name: "private-only", scope: "private", handler: async () => "no" }),
  ]);

  const result = await dispatchPhase1Command({ commandParts: ["private-only"], scope: "group" }, registry);

  assert.equal(result.code, "SCOPE_DENIED");
});
