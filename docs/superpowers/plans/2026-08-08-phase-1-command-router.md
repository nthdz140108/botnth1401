# Phase 1 Command Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for inline work) to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Route the 20 Phase 1 commands through a validated registry while preserving legacy dispatch for all later phases.

**Architecture:** Keep `handleCommand` and `handleCommandPrivate` as compatibility wrappers. Normalize command input in `command-parser.js`, resolve Phase 1 names through a pure router and a focused registry, execute adapters with a shared context, and fall back to the existing switch for commands not yet migrated.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, existing Zalo handlers and JSON command configuration.

## Global Constraints

- Keep Node.js ESM and `zca-js@2.1.2`.
- Preserve the public signatures of `handleCommand` and `handleCommandPrivate`.
- Keep MySQL-dependent commands registered and return `DB_BLOCKED` when unavailable.
- Do not expand SMS/OTP sending; preserve guard, rate-limit, audit, and safe status behavior.
- Never log API keys, cookies, credentials, or full message content.
- A provider failure must become a command result and must not crash the dispatcher process.
- Run the focused test red before each production change, then run the full regression suite after green.

## File Map

- Create `src/commands/command-router.js`: pure definition validation, longest-match resolution, scope/dependency gates, timeout, and error conversion.
- Create `src/commands/command-registry.js`: Phase 1 metadata, aliases, and adapters to existing exported handlers.
- Modify `src/commands/command-parser.js`: whitespace/case normalization while retaining special underscore parsing and the old return shape.
- Modify `src/commands/command.js`: import the Phase 1 registry/router, build command context in both wrappers, route registry hits, and preserve the legacy switch fallback.
- Create `tests/command-router.test.js`: isolated router behavior tests.
- Create `tests/command-contract.test.js`: 20-entry registry and export contract tests.
- Create `tests/command-dependency.test.js`: missing configuration and DB-blocked behavior.
- Create `tests/api-config.test.js`: Phase 1 configuration and credential-source checks.
- Create `tests/phase-1-dispatch.test.js`: wrapper compatibility and legacy fallback tests using injected/stubbed registry handlers.

### Task 1: Define Router Contracts With Failing Tests

**Files:**
- Create: `tests/command-router.test.js`
- Create: `src/commands/command-router.js`

**Interfaces:**
- `createCommandDefinition(input)` returns a frozen definition with `name`, `aliases`, `handler`, `scope`, `requiresDb`, `requiredConfig`, `risk`, `timeoutMs`, and `minArgs`.
- `createCommandRegistry(definitions)` returns a frozen lookup object and throws `COMMAND_REGISTRY_COLLISION` for duplicate normalized canonical names or aliases.
- `resolveCommand(commandParts, registry)` returns `{ code: "RESOLVED", definition, args, matchedParts }` or a result with `UNKNOWN_COMMAND`/`AMBIGUOUS_COMMAND`.
- `executeCommand(context, definition)` returns `{ code: "HANDLED", value }` or a stable error result.

- [ ] **Step 1: Write failing tests for normalization and longest match**

```js
test("resolves gemini make before gemini and normalizes case", () => {
  const registry = createCommandRegistry([
    definition("gemini", []),
    definition("gemini make", []),
  ]);
  const result = resolveCommand(["  GEMINI  ", "MAKE", "a", "cat"], registry);
  assert.equal(result.code, "RESOLVED");
  assert.equal(result.definition.name, "gemini make");
  assert.deepEqual(result.args, ["a", "cat"]);
});
```

- [ ] **Step 2: Run the focused test and verify the expected missing-module failure**

Run: `node --test tests/command-router.test.js`

Expected: FAIL because `src/commands/command-router.js` and its exported contract do not exist yet.

- [ ] **Step 3: Write failing tests for aliases, collisions, scope, dependency, timeout, and handler errors**

```js
test("executes only when scope and dependencies pass", async () => {
  let called = false;
  const command = definition("demo", [], async () => {
    called = true;
    return "ok";
  }, { scope: "group", requiredConfig: ["DEMO_KEY"] });
  const denied = await executeCommand({ scope: "private", config: {} }, command);
  assert.equal(denied.code, "SCOPE_DENIED");
  assert.equal(called, false);
  const missing = await executeCommand({ scope: "group", config: {} }, command);
  assert.equal(missing.code, "MISSING_DEPENDENCY");
});
```

Also assert `AMBIGUOUS_COMMAND`, `COMMAND_REGISTRY_COLLISION`, `MISSING_ARGUMENT`,
`TIMEOUT`, and `HANDLER_ERROR` with real functions and a short timeout.

- [ ] **Step 4: Run the focused test and verify each failure is behavioral**

Run: `node --test tests/command-router.test.js`

Expected: FAIL on the missing router behaviors, not on syntax or test setup errors.

- [ ] **Step 5: Implement the minimal pure router**

Use normalized lower-case keys. `resolveCommand` sorts registered token arrays by
descending length and returns the first exact prefix match. `executeCommand`
checks scope, `minArgs`, DB readiness, and required config before calling the
handler. Use `Promise.race` with a timer only when `timeoutMs` is positive, and
always clear the timer in `finally`.

- [ ] **Step 6: Run the focused test and refactor only while green**

Run: `node --test tests/command-router.test.js`

Expected: PASS with no warnings. Remove duplicated normalization or result-shape
logic only after all focused assertions are green.

### Task 2: Make Parser Compatibility Explicit

**Files:**
- Modify: `src/commands/command-parser.js`
- Create: `tests/command-parser.test.js`

**Interfaces:**
- Preserve `parseCommandContent(content, prefix)` and its `{ command, commandParts } | null` result.
- Normal input collapses repeated whitespace and lowercases the command token.
- The existing special underscore commands retain their underscore tokenization.

- [ ] **Step 1: Add failing parser tests**

```js
test("normalizes command whitespace and preserves arguments", () => {
  assert.deepEqual(parseCommandContent("!  GeMiNi   MaKe  cat", "!"), {
    command: "gemini",
    commandParts: ["gemini", "make", "cat"],
  });
});
```

Add tests for a missing prefix, case-insensitive aliases at router level, and the
special underscore command currently listed in `SPECIAL_COMMANDS`.

- [ ] **Step 2: Run parser tests to verify red**

Run: `node --test tests/command-parser.test.js`

Expected: FAIL because repeated whitespace currently leaves an empty command
argument and the parser does not normalize all command input consistently.

- [ ] **Step 3: Implement the smallest parser change**

Trim the content after the prefix before splitting, use `/\\s+/`, lowercase only
the command token, and leave special-command detection/tokenization untouched.

- [ ] **Step 4: Run parser and router tests**

Run: `node --test tests/command-parser.test.js tests/command-router.test.js`

Expected: PASS.

### Task 3: Build the Phase 1 Registry and Adapters

**Files:**
- Create: `src/commands/command-registry.js`
- Create: `src/commands/gemini-make-command.js`
- Create: `tests/command-contract.test.js`

**Interfaces:**
- `phase1Registry` is the default registry export containing exactly 20 canonical command definitions.
- `createPhase1Registry(overrides = {})` returns a registry with the same definitions and allows tests to replace handlers without changing metadata.
- Each adapter accepts `CommandContext` and invokes the current handler with the current group/private argument order.
- `handleGeminiMakeCommand(context)` uses the Gemini image-generation path and is separate from `askGeminiCommand`.

- [ ] **Step 1: Add failing contract tests**

```js
test("phase 1 registry has exactly the required canonical commands", () => {
  assert.deepEqual([...phase1Registry.canonicalNames].sort(), [...PHASE_1_COMMANDS].sort());
  for (const definition of phase1Registry.definitions) {
    assert.equal(typeof definition.handler, "function", definition.name);
  }
});
```

Assert the aliases from `command.json` resolve case-insensitively and that
`gemini make` has a distinct handler from `gemini`.

- [ ] **Step 2: Run the contract test to verify red**

Run: `node --test tests/command-contract.test.js`

Expected: FAIL because the Phase 1 registry and image adapter do not exist.

- [ ] **Step 3: Implement definitions and adapters**

Import the existing exports from `command.js`'s current dependencies into the
registry module, or move only the Phase 1 imports into that module when this
avoids a cycle. Keep adapters explicit for `sendImage` and
`handleVideoCommand`, passing their mode strings. Use metadata from
`assets/json-data/command.json` for aliases, scope, active status, countdown,
and permission mapping. Set `requiredConfig` to the exact environment names
used by each provider.

- [ ] **Step 4: Implement the dedicated Gemini image adapter**

Reuse the existing Gemini configuration/key rotation utilities, but invoke the
image-generation request path and send the generated image response. A missing
`GEMINI_API_KEYS` value returns `MISSING_DEPENDENCY`; it must not call the text
chat handler.

- [ ] **Step 5: Run contract tests and syntax checks**

Run: `node --test tests/command-contract.test.js; node --check src/commands/command-registry.js; node --check src/commands/gemini-make-command.js`

Expected: PASS and exit code 0.

### Task 4: Integrate Router Dispatch With Compatibility Fallback

**Files:**
- Modify: `src/commands/command.js`
- Create: `tests/phase-1-dispatch.test.js`

**Interfaces:**
- `createCommandContext` is internal to `command.js` and contains `api`,
  `message`, `commandParts`, `scope`, `groupInfo`, `groupAdmins`,
  `groupSettings`, admin flags, command config, and dependency providers.
- `handleCommand` and `handleCommandPrivate` keep their current parameter lists
  and return conventions.

- [ ] **Step 1: Add failing dispatch tests**

Use a test registry override with handlers that record their context and return
`HANDLED`. Assert a Phase 1 command reaches the registry handler, while a
non-Phase-1 command still reaches the legacy switch. Assert a private-only or
group-only definition returns the existing insufficient-authority response.

- [ ] **Step 2: Run the dispatch tests to verify red**

Run: `node --test tests/phase-1-dispatch.test.js`

Expected: FAIL because the wrappers currently dispatch all commands through
their switch statements.

- [ ] **Step 3: Add the registry path after existing prefix/message guards**

Resolve the parsed parts against the Phase 1 registry after active-command and
permission checks. Set `message.commandName` to the canonical name and
`message.aliasCommand` to the matched input. Convert router result codes to the
existing reply helpers, returning the same success/error values as the wrapper
used before migration.

- [ ] **Step 4: Preserve the legacy path for all other commands**

Only return early for a resolved Phase 1 entry or a structured Phase 1 error.
Unknown names outside the Phase 1 registry must continue into the current
`switch`/`checkNotFindCommand` logic so later phases are not accidentally
disabled.

- [ ] **Step 5: Run dispatch, parser, router, and contract tests**

Run: `node --test tests/phase-1-dispatch.test.js tests/command-parser.test.js tests/command-router.test.js tests/command-contract.test.js`

Expected: PASS with no unhandled rejection or process-level error.

### Task 5: Add Dependency and Credential Contract Tests

**Files:**
- Create: `tests/command-dependency.test.js`
- Create: `tests/api-config.test.js`
- Modify: `src/commands/command-registry.js` only if metadata needs correction

**Interfaces:**
- Dependency checks are supplied to `executeCommand` through the context and do
  not perform live network calls during unit tests.
- Configuration names are exposed as metadata but values are read from the
  process environment/config provider at execution time.

- [ ] **Step 1: Write failing dependency tests**

Assert that a missing Gemini key returns `MISSING_DEPENDENCY`, an unavailable
MySQL provider returns `DB_BLOCKED`, and neither case calls the handler. Assert
that `spamsms` retains its rate-limit/guard metadata and does not receive a new
bulk-send retry loop.

- [ ] **Step 2: Run tests to verify red**

Run: `node --test tests/command-dependency.test.js tests/api-config.test.js`

Expected: FAIL until registry metadata and execution gates are connected.

- [ ] **Step 3: Implement metadata-driven dependency checks**

Use `requiredConfig` for provider keys and a `dbReady` boolean/provider for
database status. Return exact variable names in setup guidance, never values.

- [ ] **Step 4: Run dependency tests and source scans**

Run: `node --test tests/command-dependency.test.js tests/api-config.test.js; rg -n "AIza|sk-|GEMINI_API_KEYS|SIMSIMI_API_KEY" src/commands src/service-debug`

Expected: tests PASS; the scan may show environment variable names but no
literal credential values.

### Task 6: Regression, Syntax, and Smoke Verification

**Files:**
- Modify only files required by failing regression findings.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all existing and Phase 1 tests PASS. Any failure is investigated with
a focused reproducer before changing production code.

- [ ] **Step 2: Run the repository syntax validation**

Run: `node --test tests/offline-validation.test.js`

Expected: PASS, including `node --check` for every source JavaScript file.

- [ ] **Step 3: Run offline command smoke checks**

Invoke the pure parser/resolver with all 20 canonical names and every alias in
`command.json`; assert each result is `RESOLVED` and `gemini make` wins over
`gemini`.

- [ ] **Step 4: Run live smoke tests only for available dependencies**

With the user's local Zalo session and provider keys, exercise a non-DB command
such as `help` or `command`. Without those prerequisites, record the result as
dependency-blocked and verify that the process remains alive; do not claim a
live smoke pass without an available session/provider.

- [ ] **Step 5: Perform the completion audit**

Confirm the registry has 20/20 canonical entries, no collision, all required
tests pass, the legacy fallback remains present, and no credential literal is
introduced. Report the missing git commit separately because this workspace
has no `.git` directory.
