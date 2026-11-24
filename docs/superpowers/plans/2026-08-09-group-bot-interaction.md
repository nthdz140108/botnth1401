# Group Bot Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce per-group `bot on/off` interaction state while preserving bot-admin access and existing group config persistence.

**Architecture:** Add a pure group interaction policy helper and call it from the group command entrypoint before command execution. Keep `activeBot` in the existing `groupSettings[threadId]` object and retain `writeGroupSettings` as the persistence boundary.

**Tech Stack:** Node.js ESM, built-in `node:test`, JavaScript.

## Global Constraints

- Only group command interaction is gated; private messages are unchanged.
- Only bot/global admins bypass a disabled group. Group membership admin status is not used for this bypass.
- State is scoped by `threadId` and persisted through the existing group settings JSON path.
- No new runtime dependency is needed.

---

### Task 1: Add Testable Group Interaction Policy

**Files:**
- Create: `src/commands/group-interaction-policy.js`
- Test: `tests/group-interaction-policy.test.js`

**Interfaces:**
- Produces `canInteractWithGroup({ activeBot, isAdminBot }) -> boolean`.

- [x] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { canInteractWithGroup } from "../src/commands/group-interaction-policy.js";

test("allows normal members when the current group is on", () => {
  assert.equal(canInteractWithGroup({ activeBot: true, isAdminBot: false }), true);
});

test("denies normal members when the current group is off", () => {
  assert.equal(canInteractWithGroup({ activeBot: false, isAdminBot: false }), false);
});

test("allows bot admins when the current group is off", () => {
  assert.equal(canInteractWithGroup({ activeBot: false, isAdminBot: true }), true);
});

test("keeps group state independent because the policy only reads the current state", () => {
  const groupA = { activeBot: false };
  const groupB = { activeBot: true };
  assert.equal(canInteractWithGroup({ ...groupA, isAdminBot: false }), false);
  assert.equal(canInteractWithGroup({ ...groupB, isAdminBot: false }), true);
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/group-interaction-policy.test.js`

Expected: FAIL because `src/commands/group-interaction-policy.js` does not exist.

- [x] **Step 3: Implement the minimal policy**

```js
export function canInteractWithGroup({ activeBot, isAdminBot }) {
  return activeBot === true || isAdminBot === true;
}
```

- [x] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/group-interaction-policy.test.js`

Expected: PASS with 4 tests passing.

### Task 2: Gate Group Command Execution

**Files:**
- Modify: `src/commands/command.js` near `handleCommand`
- Test: `tests/group-interaction-policy.test.js`

**Interfaces:**
- Consumes `canInteractWithGroup({ activeBot, isAdminBot })` from Task 1.
- Preserves the existing `groupSettings[threadId].activeBot` mutation and `writeGroupSettings(groupSettings)` call.

- [x] **Step 1: Add a regression assertion for missing/false state**

Keep the focused policy tests as the executable regression contract: a false `activeBot` must deny only non-admin users, while `isAdminBot` must remain allowed.

- [x] **Step 2: Run the focused test before the integration edit**

Run: `node --test tests/group-interaction-policy.test.js`

Expected: PASS before wiring the helper into production flow.

- [x] **Step 3: Wire the guard into `handleCommand`**

Import the helper and, after `parsedCommand` resolves the canonical command, return before cooldown/permission/dispatch when the current group is off and the sender is not a bot admin. Keep the gate inside `handleCommand`, which is the group-only entrypoint.

- [x] **Step 4: Run focused and command contract tests**

Run: `node --test tests/group-interaction-policy.test.js tests/command-contract.test.js tests/command-runtime-scope.test.js tests/phase-6-dispatch.test.js`

Expected: PASS with no failures.

- [x] **Step 5: Run the full test suite**

Run: `npm test`

Expected: exit code 0 and no failed tests.
