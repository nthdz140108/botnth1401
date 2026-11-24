# Phase 3 Command Registry Implementation Plan

> **For agentic workers:** Execute this plan inline with TDD checkpoints.

**Goal:** Register all 20 Phase 3 commands with correct aliases, handler adapters, and dependency metadata.

**Architecture:** Extend the established Phase 1/2 registry pattern in `src/commands/command-registry.js`. Reuse `command-dispatcher.js` and the existing message result renderer; leave later-phase legacy switches available through the current `null` fallback.

**Tech Stack:** Node.js ESM, `node:test`, existing JavaScript handlers.

## Global Constraints

- Preserve the existing Zalo handler signatures and `zca-js@2.1.2`.
- Database-dependent commands return `DB_BLOCKED` when `dbReady` is false.
- Missing provider configuration returns `MISSING_DEPENDENCY` before the handler runs.
- No credentials are added to source or tests.

### Task 1: Phase 3 Contract Tests

**Files:**
- Create: `tests/phase-3-dispatch.test.js`
- Read: `src/commands/command-registry.js`, `src/commands/command-dispatcher.js`

**Interfaces:**
- Consume `createPhase3Registry`, `PHASE_3_COMMANDS`, and `dispatchCommand`.
- Assert exact canonical names, aliases, adapter context, guards, handler errors, and `null` for commands outside Phase 3.

- [ ] Write a failing test for the exact 20-command registry, aliases, and adapter invocation.
- [ ] Run `node --test tests/phase-3-dispatch.test.js`; expect failure because Phase 3 exports do not exist.
- [ ] Add guard tests proving `login` returns `DB_BLOCKED`, `gifmeme` returns `MISSING_DEPENDENCY`, and a throwing override returns `HANDLER_ERROR` without changing dispatcher behavior.
- [ ] Re-run the focused test and confirm it remains RED for missing Phase 3 implementation.

### Task 2: Registry and Dispatcher Integration

**Files:**
- Modify: `src/commands/command-registry.js`
- Test: `tests/phase-3-dispatch.test.js`

**Interfaces:**
- Produce `PHASE_3_COMMANDS`, `createPhase3Registry(overrides = {})`, `phase3Registry`, and a `commandRegistry` containing Phases 1-3.
- Each registry handler accepts one context object and calls the existing handler with `(api, message, [aliasCommand|groupSettings])` as required.

- [ ] Add Phase 3 metadata and lazy adapters for all 20 commands, including `stk`, `stkc`, `phng`, `dk`, and `ntr`.
- [ ] Include `phase3Registry.definitions` in `createCommandRegistryForPhases`.
- [ ] Run the focused Phase 3 tests and confirm GREEN.
- [ ] Run existing router, parser, dependency, contract, Phase 1, and Phase 2 tests.

### Task 3: Full Verification

**Files:**
- Inspect: `assets/json-data/command.json`, `src/commands/command.js`, `tests/*`

- [ ] Run `npm test` from the project root and record the exit code and failures.
- [ ] Run syntax checks for changed JavaScript files.
- [ ] Verify the registry has 60 commands across Phases 1-3 and no alias collisions.
- [ ] Report any live smoke-test limitation caused by missing Zalo/MySQL/provider credentials instead of inventing secrets.
