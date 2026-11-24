# Phase 2 Command Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and dispatch all 20 Phase 2 commands through the existing command router while preserving legacy fallback behavior.

**Architecture:** Extend `src/commands/command-registry.js` with Phase 2 metadata and lazy handler adapters. Generalize `src/commands/command-dispatcher.js` to accept a registry while retaining `dispatchPhase1Command` as a compatibility wrapper. Update `command.js` to resolve and dispatch against the combined registry before its existing fallback switches.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing Zalo handlers, `speedtest-net`, JSON command metadata.

## Global Constraints

- Giữ nguyên Node.js ESM và `zca-js@2.1.2`.
- Command phụ thuộc MySQL chỉ được kiểm thử contract và trả `DB_BLOCKED` khi database chưa sẵn sàng.
- Mock toàn bộ API ngoài và dependency lỗi trong test.
- API lỗi không được làm crash dispatcher hoặc bot process.
- Mỗi Phase phải có test resolver, permission, missing argument và handler error.
- Acceptance: 182/182 command có canonical mapping hoặc dependency status rõ ràng.

---

### Task 1: Phase 2 Registry Contract Tests

**Files:**
- Modify: `tests/command-contract.test.js`
- Modify: `tests/command-dependency.test.js`
- Create: `tests/phase-2-dispatch.test.js`

**Interfaces:**
- Consumes: `createPhase2Registry`, `phase2Registry`, `dispatchCommand`.
- Produces: executable assertions for all 20 Phase 2 definitions, mappings,
  aliases, scopes, argument guards, DB guard, and handler errors.

- [ ] **Step 1: Write the failing test**

```js
import { PHASE_2_COMMANDS, createPhase2Registry } from "../src/commands/command-registry.js";

test("Phase 2 exposes exactly 20 canonical command definitions", () => {
  const registry = createPhase2Registry({
    all: async () => "ok",
  });
  assert.deepEqual([...registry.canonicalNames].sort(), [...PHASE_2_COMMANDS].sort());
  assert.equal(registry.definitions.length, 20);
  for (const command of PHASE_2_COMMANDS) {
    assert.equal(typeof registry.lookup.get(command)[0].handler, "function", command);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase-2-dispatch.test.js`

Expected: FAIL because `PHASE_2_COMMANDS` and `createPhase2Registry` are not
exported yet.

- [ ] **Step 3: Add behavior tests for the real router boundary**

Assert literal expected outcomes for uppercase canonical names, aliases
(`spt`, `spdt`, `i4`, `obj`, `gr`, `uptime`, `dâm`), `MISSING_ARGUMENT` for
`ff`/`quocgia`, `DB_BLOCKED` for `rank`, and `HANDLER_ERROR` when an override
handler throws. Do not call external providers.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/command-router.test.js tests/command-contract.test.js tests/command-dependency.test.js tests/phase-2-dispatch.test.js`

Expected: new Phase 2 assertions fail while existing Phase 1 assertions remain
diagnostic.

### Task 2: Phase 2 Lazy Handler Registry

**Files:**
- Modify: `src/commands/command-registry.js`

**Interfaces:**
- Consumes: existing named exports from `command.js` and the handler modules
  listed in `2026-08-08-phase-2-command-router-design.md`.
- Produces: `PHASE_2_COMMANDS`, `createPhase2Registry(overrides)`,
  `phase2Registry`, and `commandRegistry` containing Phase 1 + Phase 2.

- [ ] **Step 1: Implement normalized Phase 2 metadata and adapters**

Use the existing `lazy(modulePath, exportName, invoke)` helper. Each adapter
must pass the existing handler signature and set `aliasCommand` from the
dispatcher context. Use `minArgs: 1` for `ff` and `quocgia`, `scope: "group"`
for `ghepdoi`, `group`, and `topchat`, and `requiresDb: true` for `rank`.

- [ ] **Step 2: Add explicit mapping tests and run them**

Run: `node --test tests/phase-2-dispatch.test.js tests/command-contract.test.js`

Expected: PASS with all 20 definitions and no registry collisions.

### Task 3: Generic Registered Dispatcher

**Files:**
- Modify: `src/commands/command-dispatcher.js`
- Modify: `tests/phase-1-dispatch.test.js`
- Modify: `tests/phase-2-dispatch.test.js`

**Interfaces:**
- Consumes: any command registry and `context.commandParts`.
- Produces: `dispatchCommand(context, registry)`, plus the unchanged
  `dispatchPhase1Command(context, registry)` wrapper.

- [ ] **Step 1: Write the failing generic-dispatch test**

Assert that a Phase 2 override receives `args`, canonical `aliasCommand`, and
the original context, and that an unknown Phase 2 name returns `null`.

- [ ] **Step 2: Implement generic dispatch**

Move the current body to `dispatchCommand`; have `dispatchPhase1Command` call
it with `phase1Registry`. Return `{ ...result, definition, resolved }` for a
resolved command and `{ ...resolved, definition: null }` for non-resolved
matches.

- [ ] **Step 3: Run focused dispatcher tests**

Run: `node --test tests/phase-1-dispatch.test.js tests/phase-2-dispatch.test.js`

Expected: PASS.

### Task 4: Wrapper Integration and Parser Compatibility

**Files:**
- Modify: `src/commands/command.js`
- Modify: `src/commands/command-parser.js`
- Modify: `tests/command-parser.test.js`

**Interfaces:**
- Consumes: combined `commandRegistry`, `dispatchCommand`, and existing
  `parseCommandContent` output.
- Produces: group/private wrappers that route Phase 1/2 commands centrally,
  then preserve their legacy switches for unknown commands.

- [ ] **Step 1: Write parser and wrapper characterization tests**

Assert `!GEMINI   MAKE cat` yields command parts `gemini`, `make`, `cat`, and
that a Phase 2 command is handled before the legacy switch. Keep special
underscore commands unchanged.

- [ ] **Step 2: Update parser normalization**

Normalize prefix comparison case-insensitively, trim repeated whitespace, and
return a stable `commandParts` array. Preserve the special command branch.

- [ ] **Step 3: Integrate combined registry into both wrappers**

Resolve against `commandRegistry`, dispatch any resolved Phase 1/2 command,
send router errors through `sendPhase1Result`, and continue legacy handling only
when the generic dispatcher returns `null`.

- [ ] **Step 4: Run focused wrapper and parser tests**

Run: `node --test tests/command-parser.test.js tests/phase-1-dispatch.test.js tests/phase-2-dispatch.test.js`

Expected: PASS with special command tests unchanged.

### Task 5: Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-phase-2-command-router-design.md`
- Modify: `docs/superpowers/plans/2026-08-08-phase-2-command-router.md`

- [ ] **Step 1: Run the Phase 2 contract suite**

Run: `node --test tests/command-router.test.js tests/command-contract.test.js tests/command-dependency.test.js tests/phase-2-dispatch.test.js`

- [ ] **Step 2: Run the complete regression suite**

Run: `npm test`

- [ ] **Step 3: Run syntax validation**

Run: `node --check src/commands/command-router.js; node --check src/commands/command-registry.js; node --check src/commands/command-dispatcher.js; node --check src/commands/command-parser.js; node --check src/commands/command.js`

- [ ] **Step 4: Audit all acceptance criteria**

Verify the 20 Phase 2 canonical definitions, alias uniqueness, exact adapter
mapping, scope/permission/dependency behavior, and that no external provider
was invoked by the tests. Report any missing live credentials or bot-session
smoke test as an environment limitation rather than claiming live success.
