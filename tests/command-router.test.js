import test from "node:test";
import assert from "node:assert/strict";
import {
  createCommandDefinition,
  createCommandRegistry,
  executeCommand,
  resolveCommand,
} from "../src/commands/command-router.js";

const definition = (name, aliases = [], handler = async () => "ok", options = {}) =>
  createCommandDefinition({ name, aliases, handler, ...options });

test("resolves gemini make before gemini and normalizes case", () => {
  const registry = createCommandRegistry([
    definition("gemini"),
    definition("gemini make"),
  ]);

  const result = resolveCommand(["  GEMINI  ", "MAKE", "a", "cat"], registry);

  assert.equal(result.code, "RESOLVED");
  assert.equal(result.definition.name, "gemini make");
  assert.deepEqual(result.args, ["a", "cat"]);
  assert.deepEqual(result.matchedParts, ["gemini", "make"]);
});

test("resolves aliases case-insensitively", () => {
  const registry = createCommandRegistry([definition("help", ["menu"]) ]);

  const result = resolveCommand(["MeNu", "2"], registry);

  assert.equal(result.code, "RESOLVED");
  assert.equal(result.definition.name, "help");
  assert.deepEqual(result.args, ["2"]);
});

test("returns unknown command without throwing", () => {
  const registry = createCommandRegistry([definition("help")]);

  assert.deepEqual(resolveCommand(["missing"], registry), {
    code: "UNKNOWN_COMMAND",
    commandParts: ["missing"],
  });
});

test("rejects canonical and alias collisions", () => {
  assert.throws(
    () => createCommandRegistry([
      definition("help", ["menu"]),
      definition("menu"),
    ]),
    (error) => error.code === "COMMAND_REGISTRY_COLLISION"
  );
});

test("rejects ambiguous definitions instead of selecting by insertion order", () => {
  const registry = {
    definitions: [
      definition("alpha beta"),
      definition("alpha beta"),
    ],
    lookup: new Map([
      ["alpha beta", [definition("alpha beta"), definition("alpha beta")]],
    ]),
  };

  const result = resolveCommand(["alpha", "beta"], registry);

  assert.equal(result.code, "AMBIGUOUS_COMMAND");
});

test("executes only when scope and dependencies pass", async () => {
  let called = false;
  const command = definition("demo", [], async () => {
    called = true;
    return "ok";
  }, { scope: "group", permission: "all", requiredConfig: ["DEMO_KEY"] });

  const denied = await executeCommand({ scope: "private", config: {} }, command);
  assert.equal(denied.code, "SCOPE_DENIED");
  assert.equal(called, false);

  const missing = await executeCommand({ scope: "group", config: {} }, command);
  assert.equal(missing.code, "MISSING_DEPENDENCY");
  assert.deepEqual(missing.missing, ["DEMO_KEY"]);
  assert.equal(missing.missingDetails[0].kind, "config");
  assert.equal(called, false);

  const result = await executeCommand({ scope: "group", config: { DEMO_KEY: "configured" } }, command);
  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "ok");
  assert.equal(called, true);
});

test("allows group, private, and both command scopes", async () => {
  for (const [scope, chatScope] of [["group", "group"], ["private", "private"], ["both", "group"], ["both", "private"]]) {
    const result = await executeCommand({ scope: chatScope }, definition(`demo-${scope}`, [], async () => scope, { scope, permission: "all" }));
    assert.equal(result.code, "HANDLED");
  }
});

test("scopeOverride replaces the definition scope", async () => {
  let calls = 0;
  const result = await executeCommand(
    { scope: "private", scopeOverride: "private" },
    definition("demo", [], async () => { calls += 1; }, { scope: "group", permission: "all" })
  );

  assert.equal(result.code, "HANDLED");
  assert.equal(calls, 1);
});

test("does not call a handler when the effective scope is denied", async () => {
  let calls = 0;
  const result = await executeCommand(
    { scope: "private", scopeOverride: "group" },
    definition("demo", [], async () => { calls += 1; }, { scope: "both", permission: "all" })
  );

  assert.equal(result.code, "SCOPE_DENIED");
  assert.equal(calls, 0);
});

test("rejects a command when the supplied permission level is too low", async () => {
  let called = false;
  const command = definition("admin-only", [], async () => {
    called = true;
  }, { permission: "adminBot" });

  const result = await executeCommand({ permissionLevel: "all" }, command);

  assert.equal(result.code, "PERMISSION_DENIED");
  assert.equal(called, false);
});

test("rejects unsupported permission metadata instead of treating it as public", () => {
  assert.throws(
    () => definition("broken", [], async () => {}, { permission: "owner" }),
    /Invalid command permission/
  );
});

test("rejects malformed metadata contracts instead of normalizing them silently", () => {
  assert.throws(
    () => createCommandDefinition({ name: "broken-required-config", handler: async () => {}, requiredConfig: "DEMO_KEY" }),
    /requiredConfig/
  );
  assert.throws(
    () => createCommandDefinition({ name: "broken-dependencies", handler: async () => {}, requiredDependencies: ["", "ffmpeg"] }),
    /dependency/
  );
  assert.throws(
    () => createCommandDefinition({ name: "broken-risk", handler: async () => {}, risk: "medium" }),
    /risk/
  );
});

test("does not invoke a disabled command", async () => {
  let called = false;
  const command = definition("disabled", [], async () => {
    called = true;
  }, { active: false });

  const result = await executeCommand({}, command);

  assert.equal(result.code, "COMMAND_DISABLED");
  assert.equal(result.command, "disabled");
  assert.equal(called, false);
});

test("returns missing argument before invoking the handler", async () => {
  let called = false;
  const command = definition("lookup", [], async () => {
    called = true;
  }, { minArgs: 1, permission: "all" });

  const result = await executeCommand({ args: [] }, command);

  assert.equal(result.code, "MISSING_ARGUMENT");
  assert.equal(called, false);
});

test("returns MISSING_DEPENDENCY before invoking a database handler", async () => {
  let called = false;
  const command = definition("game", [], async () => {
    called = true;
  }, { requiresDb: true, permission: "all" });

  const result = await executeCommand({ dbReady: false }, command);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.equal(result.missingDetails[0].kind, "database");
  assert.equal(called, false);
});

test("blocks a handler when an explicitly required runtime dependency is unavailable", async () => {
  let called = false;
  const command = definition("media", [], async () => {
    called = true;
  }, { requiredDependencies: ["ffmpeg"], permission: "all" });

  const result = await executeCommand({ dependencies: { ffmpeg: false } }, command);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["ffmpeg"]);
  assert.equal(result.missingDetails[0].kind, "runtime");
  assert.equal(called, false);
});

test("reports missing runtime dependencies before high-risk feature flag blocking", async () => {
  let called = false;
  const command = definition("spamjoin", [], async () => {
    called = true;
  }, { permission: "adminLevelHigh", risk: "critical", requiredDependencies: ["python"] });

  const result = await executeCommand({
    scope: "group",
    permissionLevel: "adminLevelHigh",
    allowlist: ["admin"],
    featureFlags: { "vip.highRisk": false },
    dryRun: true,
    dependencies: { python: false },
  }, command);

  assert.equal(result.code, "MISSING_DEPENDENCY");
  assert.deepEqual(result.missing, ["python"]);
  assert.equal(result.missingDetails[0].kind, "runtime");
  assert.equal(called, false);
});

test("converts handler failures to HANDLER_ERROR", async () => {
  const result = await executeCommand({ commandParts: ["demo"] }, definition("demo", [], async () => {
    throw new Error("provider failed");
  }, { permission: "all" }));

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.error.message, "provider failed");
});

test("returns TIMEOUT when a handler exceeds its deadline", async () => {
  const result = await executeCommand({ commandParts: ["slow"] }, definition("slow", [], async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "late";
  }, { timeoutMs: 5, permission: "all" }));

  assert.equal(result.code, "TIMEOUT");
});
