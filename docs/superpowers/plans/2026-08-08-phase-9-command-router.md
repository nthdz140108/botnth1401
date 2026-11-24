# Phase 9 Command Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and safely dispatch the 22 Phase 9 commands so the aggregate command registry reaches 182 canonical commands while preserving existing handler behavior.

**Architecture:** Extend the existing `command-registry.js` phase factory pattern with explicit metadata and lazy adapters. `command-dispatcher.js` and the existing group/private wrappers remain the execution boundary; legacy switch cases stay as fallback for unregistered commands. Tests inject lazy module loaders and handler overrides, so no live Zalo, filesystem, restart, or database side effects occur.

**Tech Stack:** Node.js ESM, `node:test`, existing command router/dispatcher, JSON command metadata.

## Global Constraints

- Keep Node.js ESM and the existing `zca-js@2.1.2` integration.
- Keep Phase 9 database-dependent commands contract-safe and return `DB_BLOCKED` when MySQL is unavailable.
- Preserve group/private scope and existing handler signatures from `src/commands/command.js`.
- Do not introduce credentials or live API calls in tests.
- Acceptance target: 182 canonical commands, no registry/alias collisions, structured permission/argument/dependency/error results.

---

### Task 1: Add failing Phase 9 contracts

**Files:**
- Create: `tests/phase-9-contract.test.js`
- Create: `tests/phase-9-dispatch.test.js`

**Interfaces:**
- Consume the existing `createPhase9Handlers(loadModule)`, `createPhase9Registry(overrides)`, `PHASE_9_COMMANDS`, and `createCommandRegistryForPhases(overrides)` APIs that the tests require.
- Assert lazy adapters load exact module/export names and pass context arguments in the same order as legacy cases.

- [x] **Step 1: Write tests** for all 22 canonical names, aliases, 22 lazy adapter signatures, aggregate length 182, scope/permission metadata, missing args, DB blocking, and handler error conversion.
- [x] **Step 2: Run `node --test tests/phase-9-contract.test.js tests/phase-9-dispatch.test.js`** and confirm failure because Phase 9 exports do not exist.

### Task 2: Implement Phase 9 registry adapters

**Files:**
- Modify: `src/commands/command-registry.js` after the Phase 8 factory and before aggregate registry creation.

**Interfaces:**
- Produce `PHASE_9_COMMANDS`, `createPhase9Handlers(loadModule)`, `createPhase9Registry(overrides, options)`, `phase9Registry`, and an aggregate `commandRegistry` containing Phases 1-9.
- Each handler receives the exact context keys asserted by Task 1.

- [x] **Step 1: Add the 22-command list and metadata** using command.json aliases/countdowns/types, legacy scopes, adminBot restrictions, `buff.requiresDb`, and minimum textual arguments for amount/link/action/resource operations.
- [x] **Step 2: Add lazy adapters** for group management, remote group actions, resource utilities, whitelist, recent-message deletion, restart, and alias handlers.
- [x] **Step 3: Include `createPhase9Registry(overrides)` in the aggregate factory.**
- [x] **Step 4: Run the Phase 9 tests and confirm green.**

### Task 3: Verify dispatcher integration and regression behavior

**Files:**
- Modify: `tests/phase-9-dispatch.test.js` only if a failing contract exposes a real mismatch.

**Interfaces:**
- `dispatchCommand` must resolve canonical names and aliases case-insensitively, enforce scope/permission/dependency/argument gates before invoking handlers, and convert thrown errors to `HANDLER_ERROR`.

- [x] **Step 1: Run Phase 1-9 command contract and dispatch tests.**
- [x] **Step 2: Run `npm test` from the project root.**
- [x] **Step 3: Run syntax checks for changed JavaScript files and verify the aggregate registry reports 182 definitions.**
- [x] **Step 4: Audit the pasted acceptance list against source, tests, and command output before claiming completion.**
