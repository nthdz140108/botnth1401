# Phase 8 Command Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and verify the 20 Phase 8 commands through the central command router while preserving their existing legacy handlers.

**Architecture:** Extend `src/commands/command-registry.js` with Phase 8 metadata and lazy adapters, then append the phase to the existing aggregate registry. Keep `src/commands/command.js` unchanged as a compatibility dispatcher, with only focused defensive fixes in Phase 8 handlers that are proven by tests.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, existing lazy dynamic-import adapters, and PowerShell verification commands.

## Global Constraints

- Register exactly the 20 canonical Phase 8 commands in the order specified by the phase requirements.
- Preserve existing Phase 1-7 order and behavior.
- Do not add dependencies, live provider calls, MySQL requirements, or SMS/spam expansion.
- Resolve aliases case-insensitively and reject canonical/alias collisions.
- Return structured `SCOPE_DENIED`, `PERMISSION_DENIED`, `MISSING_ARGUMENT`, and `HANDLER_ERROR` results through the existing dispatcher/router.
- Production code is written only after a failing test is observed.

### Task 1: Add Phase 8 Contract Tests

**Files:**
- Create: `tests/phase-8-dispatch.test.js`
- Create: `tests/phase-8-contract.test.js`
- Reference: `tests/phase-7-dispatch.test.js`, `tests/phase-7-contract.test.js`

**Interfaces:**
- Tests consume `PHASE_8_COMMANDS`, `createPhase8Registry`, `createPhase8Handlers`, `createCommandRegistryForPhases`, and `dispatchCommand`.
- Tests require the registry to expose 20 definitions and the aggregate registry to expose 160 definitions.

- [ ] **Step 1: Write the failing dispatch test**

Create `tests/phase-8-dispatch.test.js` with an expected 20-name array, injected handlers returning `{ command: aliasCommand }`, and assertions for canonical count, aggregate count, case-insensitive aliases, group/private scope, admin permission, required arguments, and handler failures. Use `dbReady: true`, empty config, and no live API.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
npm test -- tests/phase-8-dispatch.test.js
```

Expected: failure because `PHASE_8_COMMANDS` and `createPhase8Registry` are not exported and the aggregate currently contains only 140 definitions.

- [ ] **Step 3: Write the failing lazy-handler contract test**

Create `tests/phase-8-contract.test.js` with an injected `loadModule` proxy. Assert each command loads the exact module path/export name and receives the exact legacy argument list. Add a regression assertion that `resolveCommand(["todo"], createPhase8Registry())` resolves canonical `todo`, while `sendp` has no `todo` alias.

- [ ] **Step 4: Run the contract test to verify RED**

Run:

```powershell
npm test -- tests/phase-8-contract.test.js
```

Expected: failure because Phase 8 handler factories do not exist.

### Task 2: Implement Registry and Adapters

**Files:**
- Modify: `src/commands/command-registry.js` after the Phase 7 registry and in `createCommandRegistryForPhases`.
- Tests: `tests/phase-8-dispatch.test.js`, `tests/phase-8-contract.test.js`

**Interfaces:**
- Produce `PHASE_8_COMMANDS`, `createPhase8Handlers(loadModule = defaultLoader)`, `createPhase8Registry(overrides = {}, options = {})`, and `phase8Registry`.
- Each handler is a function accepting the existing router context object and calling the mapped legacy export.

- [ ] **Step 1: Add the minimal Phase 8 command list and metadata**

Define the 20 canonical names in required order. Set `permission: "adminBot"` for anti, ban/unban, tagall, approve, learn/learnnow/unlearn, reply, undo, todo, and sendp. Set `permission: "all"` for spamgroup, scold, and autoreply. Set `scope: "both"` only for todo and `scope: "group"` for the remaining commands. Add countdown 1, type 3, with type 2 for learn, learnnow, and unlearn. Use `minArgs` 1 for ban, unban, spamgroup, scold, unlearn, todo, sendp and 2 for learnnow.

- [ ] **Step 2: Add lazy adapters using the exact legacy mappings**

Use the existing `lazy` helper. The `learn`, `learnnow`, and `unlearn` adapters intentionally use `handleLearnCommand`, because that legacy handler dispatches subcommand behavior from the original message content. The `tagall` adapter supplies `groupInfo` and `aliasCommand`; `autoreply` supplies `aliasCommand`; all other mappings follow the spec table.

- [ ] **Step 3: Add the Phase 8 registry and aggregate entry**

Implement the same `options.loadModule` pattern as Phase 7. Append `...createPhase8Registry(overrides).definitions` after Phase 7 in `createCommandRegistryForPhases`. Do not register `todo` as a `sendp` alias.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```powershell
npm test -- tests/phase-8-dispatch.test.js tests/phase-8-contract.test.js
```

Expected: both files pass with no handler invocation for denied/disabled/argument-gated cases.

### Task 3: Harden Touched Phase 8 Handlers

**Files:**
- Modify: `src/service-debug/anti-service/anti-all.js`
- Modify: `src/service-debug/anti-service/anti-text.js`
- Modify: `src/service-debug/anti-service/anti-file.js`
- Modify: `src/service-debug/anti-service/anti-photo.js`
- Modify: `src/service-debug/anti-service/anti-voice.js`
- Modify: `src/service-debug/anti-service/anti-not-text.js`
- Modify: `src/commands/bot-manager/welcome-bye.js`
- Modify: `src/service-debug/chat-bot/bot-learning/dqt-bot.js`
- Tests: `tests/phase-8-dispatch.test.js`

**Interfaces:**
- Existing handler signatures and return values remain unchanged.
- Fresh group contexts must not throw while toggling settings or producing syntax feedback.

- [ ] **Step 1: Add a failing regression test for fresh group settings**

Import the toggle handlers with a stub API and a message containing `threadId`, `data`, and type. Call the handler with `{}` settings and assert it returns a boolean and creates `groupSettings[threadId]`. Cover one anti toggle, `onlytext`, `approve`, and the learning toggle.

- [ ] **Step 2: Run the regression test to verify RED**

Run:

```powershell
npm test -- tests/phase-8-dispatch.test.js
```

Expected: the test fails with a missing property or a syntax-branch reference error on the current legacy handlers.

- [ ] **Step 3: Apply the smallest defensive fixes**

Initialize the per-thread settings object at the start of handlers that read it. Import and use `getGlobalPrefix` only where a syntax-error branch references an undefined prefix. Leave enforcement logic, message copy, persistence, and external API calls unchanged.

- [ ] **Step 4: Run focused tests again**

Run:

```powershell
npm test -- tests/phase-8-dispatch.test.js tests/phase-8-contract.test.js
```

Expected: all Phase 8 tests pass.

### Task 4: Full Verification and Acceptance Audit

**Files:**
- Inspect: all changed files and `docs/superpowers/specs/2026-08-08-phase-8-design.md`.
- Tests: all repository tests.

- [ ] **Step 1: Run the full regression suite**

Run `npm test`. Expected: exit code 0 and zero failed tests.

- [ ] **Step 2: Run JavaScript syntax checks**

Run `Get-ChildItem` over the changed JavaScript paths and execute `node --check` for each file. Expected: exit code 0 for every changed source and test file.

- [ ] **Step 3: Run mock smoke dispatch for all Phase 8 commands**

Dispatch every canonical command using the Phase 8 registry with injected handlers, `scope: "group"`, `permissionLevel: "adminLevelHigh"`, and `dbReady: true`. Expected: each command resolves to its own canonical definition and returns `HANDLED`.

- [ ] **Step 4: Audit the requirements against evidence**

Confirm exactly 20 Phase 8 definitions, 160 aggregate definitions, no registry key collision, all mappings exported, scope/permission gates before invocation, and structured error results. Report any missing or unverified item instead of claiming completion.

- [ ] **Step 5: Preserve the no-Git limitation in the handoff**

The workspace has no `.git` metadata, so do not claim a commit. Report changed file paths and fresh verification output directly.
