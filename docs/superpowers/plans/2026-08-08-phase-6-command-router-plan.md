# Phase 6 Command Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and safely dispatch all 20 Phase 6 commands while adding local Caro and calendar handlers.

**Architecture:** Extend `src/commands/command-registry.js` with Phase 6 metadata and lazy adapters. Add focused local modules for Caro and calendar, then route active Caro turns through the existing mini-game service. Keep legacy wrappers and fallback switches intact.

**Tech Stack:** Node.js ESM, `node:test`, existing command router/dispatcher, `lunar-calendar`, module-level Maps for in-memory game state.

## Global Constraints

- Preserve Node.js ESM and the current `handleCommand`/`handleCommandPrivate` signatures.
- Phase 6 must contain exactly the 20 canonical names from the approved spec.
- Existing phases 1 through 5 and their tests must remain green.
- Tests must inject command handlers and must not call live Zalo, database, or provider operations.
- Caro state is in-memory and keyed by `threadId`; it is not persisted to MySQL or JSON.
- Command active flags and aliases mirror `assets/json-data/command.json`.

---

### Task 1: Add Phase 6 registry contract tests

**Files:**
- Create: `tests/phase-6-dispatch.test.js`
- Create: `tests/phase-6-contract.test.js`
- Reference: `src/commands/command-router.js`, `src/commands/command-dispatcher.js`

**Interfaces:**
- Consumes: `PHASE_6_COMMANDS`, `createPhase6Handlers`, `createPhase6Registry`, `createCommandRegistryForPhases`, `dispatchCommand`.
- Produces: failing assertions for exact names, aliases, aggregate size, injected dispatch, scope, permission, disabled state, missing arguments, and handler errors.

- [ ] **Step 1: Write the failing dispatch test**

```js
const EXPECTED_PHASE_6_COMMANDS = [
  "doanso", "noitu", "doantu", "caro", "lich", "manager", "listmute",
  "settinggroup", "changelink", "listadmin", "add", "remove", "setcmd",
  "bot", "gameactive", "autodownload", "mute", "unmute", "prefix", "sendtext",
];

test("Phase 6 exposes exactly 20 canonical definitions", () => {
  assert.deepEqual(PHASE_6_COMMANDS, EXPECTED_PHASE_6_COMMANDS);
  const registry = createPhase6Registry(overridesFor(EXPECTED_PHASE_6_COMMANDS));
  assert.deepEqual(registry.definitions.map(({ name }) => name), EXPECTED_PHASE_6_COMMANDS);
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("Phase 6 mock handlers dispatch without live side effects", async () => {
  const registry = createPhase6Registry(overridesFor(EXPECTED_PHASE_6_COMMANDS));
  for (const command of EXPECTED_PHASE_6_COMMANDS) {
    const result = await dispatchCommand({
      commandParts: [...command.split(" "), "sample", "extra"],
      scope: "group",
      permissionLevel: "adminLevelHigh",
      config: {},
      dbReady: true,
    }, registry);
    const disabled = ["noitu", "doantu", "sendtext"].includes(command);
    assert.equal(result.code, disabled ? "COMMAND_DISABLED" : "HANDLED", command);
    assert.equal(result.definition.name, command);
  }
});
```

- [ ] **Step 2: Run the focused tests to verify the expected RED failure**

Run: `node --test tests/phase-6-dispatch.test.js tests/phase-6-contract.test.js`

Expected: FAIL because Phase 6 exports and definitions do not exist yet.

- [ ] **Step 3: Commit**

Commit is unavailable in this extracted workspace because no `.git` directory exists; retain the tests as the RED checkpoint.

### Task 2: Add local Caro and calendar behavior

**Files:**
- Create: `src/service-debug/game-service/mini-game/caro.js`
- Create: `src/commands/lich-command.js`
- Create: `tests/caro-game.test.js`
- Create: `tests/calendar-command.test.js`

**Interfaces:**
- Produces: `handleCaroCommand`, `handleCaroMessage`, `getCaroGames`, `resetCaroGames`, and `handleCalendarCommand`.
- Consumes: `api.sendMessage`, message `threadId`/`data`, and the installed `lunar-calendar` package.

- [ ] **Step 1: Write failing Caro tests**

Assert that sessions are isolated by `threadId`, a valid move changes the turn, occupied or malformed coordinates are rejected, five moves in a row end the game, and `cancel` removes only the selected thread's game.

- [ ] **Step 2: Run the Caro tests and confirm RED**

Run: `node --test tests/caro-game.test.js`

Expected: FAIL because `caro.js` does not exist.

- [ ] **Step 3: Implement the minimal Caro state machine**

Use a module-level `Map`, a fixed 15x15 board, normalized coordinates, four directional win checks, and injected message sending. Keep all state operations scoped by `threadId`.

- [ ] **Step 4: Run Caro tests and confirm GREEN**

Run: `node --test tests/caro-game.test.js`

Expected: PASS.

- [ ] **Step 5: Write failing calendar tests**

Assert that a supplied date formatter returns Gregorian and lunar fields and that an invalid `month` argument sends a safe usage response without throwing.

- [ ] **Step 6: Run calendar tests and confirm RED**

Run: `node --test tests/calendar-command.test.js`

Expected: FAIL because `lich-command.js` does not exist.

- [ ] **Step 7: Implement the local calendar adapter**

Use `LunarCalendar.solarToLunar` for today or a validated date, and `LunarCalendar.calendar` for an optional month view. Keep formatting inside the module and use `api.sendMessage` with the current message context.

- [ ] **Step 8: Run calendar tests and confirm GREEN**

Run: `node --test tests/calendar-command.test.js`

Expected: PASS.

### Task 3: Add Phase 6 metadata and lazy handlers

**Files:**
- Modify: `src/commands/command-registry.js`
- Modify: `src/service-debug/game-service/mini-game/index.js`

**Interfaces:**
- Consumes: the local Caro/calendar exports and existing handler exports.
- Produces: `PHASE_6_COMMANDS`, `createPhase6Handlers`, `createPhase6Registry`, `phase6Registry`, and the 120-definition aggregate registry.

- [ ] **Step 1: Add the exact Phase 6 list and metadata**

Use the canonical list and metadata table from the spec, including aliases `ds`, `amlich`, `stg`, `stgr`, `cmdset`, `atd`, `cam`, `sua`, and `rai`, plus disabled state for `noitu`, `doantu`, and `sendtext`.

- [ ] **Step 2: Add lazy adapters with established positional signatures**

Map each context to the existing handler signature. `add` and `remove` share `handleAdminHighLevelCommands`; Caro uses the new command handler; `setcmd` requires at least two arguments; `prefix` passes `isAdminLevelHighest`.

- [ ] **Step 3: Append Phase 6 to `createCommandRegistryForPhases`**

Append `...createPhase6Registry(overrides).definitions` after Phase 5 and export `phase6Registry`.

- [ ] **Step 4: Route active Caro turns in the mini-game service**

Import `handleCaroMessage` and add a `caro` branch next to the existing active game types. Leave existing game branches unchanged.

- [ ] **Step 5: Run focused contract tests and confirm GREEN**

Run: `node --test tests/phase-6-dispatch.test.js tests/phase-6-contract.test.js tests/caro-game.test.js tests/calendar-command.test.js`

Expected: PASS.

### Task 4: Integrate and verify regression behavior

**Files:**
- Modify: `src/commands/command.js` only if focused integration evidence requires it.
- Modify: Phase 6 tests if a contract gap is found.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all existing and Phase 6 tests pass.

- [ ] **Step 2: Run syntax and mock smoke checks**

Run: `node --test tests/offline-validation.test.js tests/phase-6-dispatch.test.js tests/phase-6-contract.test.js`

Expected: JavaScript syntax scan and mock dispatch pass without network/database startup.

- [ ] **Step 3: Audit Phase 6 acceptance evidence**

Verify exactly 120 aggregate definitions, unique lookup keys, all 20 canonical handlers, correct disabled statuses, no live calls in tests, and Caro message routing by thread.
