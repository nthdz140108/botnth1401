# Phase 7 Command Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and verify all 20 Phase 7 group-management and anti-feature commands through the shared command router while preserving legacy wrappers.

**Architecture:** Extend `command-registry.js` with an ordered Phase 7 definition list, metadata, lazy positional adapters, and aggregate registry composition. Keep `command-dispatcher.js` and the existing wrapper signatures unchanged; registered commands return structured router results before the legacy switch, while unregistered commands retain legacy fallback behavior.

**Tech Stack:** Node.js ESM, Node built-in test runner, existing Zalo positional handlers, JSON command configuration.

## Global Constraints

- Phase 7 contains exactly 20 canonical commands in the order from the Phase 7 specification.
- Every Phase 7 command is group-only, type 3, and has a one-second countdown.
- `sendstk` and `sendtask` remain disabled; all other active states and aliases mirror `assets/json-data/command.json`.
- All Phase 7 handlers are lazy-loaded and tests must inject fake modules or handlers; no live Zalo/API/network side effects are allowed.
- No Phase 7 command may require MySQL or an environment API key.
- Existing `handleCommand` and `handleCommandPrivate` signatures and legacy switch fallback remain compatible.

---

### Task 1: Add the Phase 7 dispatch contract tests

**Files:**
- Create: `tests/phase-7-dispatch.test.js`
- Create: `tests/phase-7-contract.test.js`

**Interfaces:**
- Consumes: `createPhase7Registry`, `createPhase7Handlers`, `createCommandRegistryForPhases`, `dispatchCommand`.
- Produces: executable expectations for the 20 canonical names, all aliases, aggregate size 140, adapter argument order, scope/permission/disabled/error behavior, and no `DB_BLOCKED` result with a ready database.

- [ ] **Step 1: Write the failing canonical/aggregate tests**

Create `tests/phase-7-dispatch.test.js` with the exact list:

```js
const EXPECTED_PHASE_7_COMMANDS = [
  "sendstk", "sendtask", "welcome", "bye", "updategroup",
  "antibadword", "antisetup", "antibot", "antiblockall", "antisdt",
  "antilink", "autojoin", "antijoin", "antiforward", "antitag",
  "antistickerlag", "antisticker", "antispam", "antinude", "antiundo",
];
```

Assert that `PHASE_7_COMMANDS` and `createPhase7Registry()` contain exactly
these definitions, injected handlers dispatch all active commands as
`HANDLED`, disabled commands as `COMMAND_DISABLED`, and the aggregate registry
contains the first 120 commands followed by Phase 7 for a total of 140.

- [ ] **Step 2: Run the dispatch tests and verify the expected RED state**

Run: `node --test tests/phase-7-dispatch.test.js`

Expected: FAIL because `PHASE_7_COMMANDS` and `createPhase7Registry` do not
exist yet.

- [ ] **Step 3: Write the failing lazy-adapter and alias tests**

In `tests/phase-7-contract.test.js`, inject a fake `loadModule` proxy and assert
the following mappings and positional arguments:

```js
[
  ["sendstk", "./lenh-debug/send-all/sendsticker.js", "handleSendStickerCommand"],
  ["sendtask", "./bot-manager/utilities.js", "handleSendTaskCommand"],
  ["welcome", "./bot-manager/welcome-bye.js", "handleWelcomeBye"],
  ["bye", "./bot-manager/welcome-bye.js", "handleWelcomeBye"],
  ["updategroup", "./bot-manager/welcome-bye.js", "handleWelcomeBye"],
  ["antibadword", "../service-debug/anti-service/anti-badword.js", "handleAntiBadWordCommand"],
  ["antisetup", "../service-debug/anti-service/setup-anti.js", "handleSetupAntiCommand"],
  ["antibot", "../service-debug/anti-service/anti-bot.js", "handleAntiBotCommand"],
  ["antiblockall", "../service-debug/anti-service/anti-kick-all.js", "handleAntiKickBlockCommand"],
  ["antisdt", "../service-debug/anti-service/anti-phone-number.js", "handleAntiPhoneNumberCommand"],
  ["antilink", "../service-debug/anti-service/anti-link.js", "handleAntiLinkCommand"],
  ["autojoin", "../service-debug/anti-service/auto-join.js", "handleAutoJoinCommand"],
  ["antijoin", "../service-debug/anti-service/anti-join-leave.js", "handleAntiJoinLeaveCommand"],
  ["antiforward", "../service-debug/anti-service/anti-forward.js", "handleAntiForwardCommand"],
  ["antitag", "../service-debug/anti-service/anti-tag.js", "handleAntiTagCommand"],
  ["antistickerlag", "../service-debug/anti-service/anti-stickerlag.js", "handleAntiEffectStickerCommand"],
  ["antisticker", "../service-debug/anti-service/anti-sticker.js", "handleAntiAllEffectStickerCommand"],
  ["antispam", "../service-debug/anti-service/anti-spam.js", "handleAntiSpamCommand"],
  ["antinude", "../service-debug/anti-service/anti-nude/anti-nude.js", "handleAntiNudeCommand"],
  ["antiundo", "../service-debug/anti-service/anti-undo.js", "handleAntiUndoCommand"],
]
```

Also assert aliases resolve case-insensitively, group-only commands deny
private dispatch before invoking an override, restricted commands deny an
`all` user, disabled commands do not invoke handlers, an optional toggle with
no argument is accepted, and thrown errors become `HANDLER_ERROR`.

- [ ] **Step 4: Run the contract tests and verify the expected RED state**

Run: `node --test tests/phase-7-contract.test.js`

Expected: FAIL because the Phase 7 handler factory and registry are missing.

### Task 2: Implement Phase 7 registry metadata and lazy adapters

**Files:**
- Modify: `src/commands/command-registry.js` after the Phase 6 registry definitions.

**Interfaces:**
- Consumes: the existing `lazy`, `createCommandDefinition`, and `createCommandRegistry` helpers.
- Produces: `PHASE_7_COMMANDS`, `createPhase7Handlers(loadModule)`, `createPhase7Registry(overrides, options)`, `phase7Registry`, and aggregate registry support.

- [ ] **Step 1: Add the ordered canonical list and metadata**

Declare the 20 names in the exact specification order. Give every definition
`scope: "group"`, `type: 3`, `countdown: 1`, and the config-derived aliases and
permissions. Set `active: false` only for `sendstk` and `sendtask`.

- [ ] **Step 2: Add lazy adapters with explicit positional mappings**

Implement `createPhase7Handlers(loadModule = defaultLoader)` using the exact
module paths and export names listed in Task 1. Pass
`(api, message, groupSettings)` to every adapter; pass a fourth canonical name
only to the three `handleWelcomeBye` adapters.

- [ ] **Step 3: Build the phase registry and append it to the aggregate**

Implement `createPhase7Registry(overrides = {}, options = {})`, expose
`phase7Registry`, and append `...createPhase7Registry(overrides).definitions`
after Phase 6 in `createCommandRegistryForPhases`. Keep the function's existing
override behavior intact for all earlier phases.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/phase-7-dispatch.test.js tests/phase-7-contract.test.js`

Expected: PASS for all Phase 7 tests with no network or credential access.

### Task 3: Preserve canonical behavior for welcome aliases

**Files:**
- Modify: `src/commands/bot-manager/welcome-bye.js`
- Modify: `tests/phase-7-contract.test.js`

**Interfaces:**
- Consumes: the optional fourth `commandName` argument supplied by the Phase 7 adapter.
- Produces: canonical setting selection for `welcome`, `bye`, and `updategroup`, including `wl` and `wlc` aliases, without changing legacy three-argument callers.

- [ ] **Step 1: Add a failing behavior test**

Use a message whose content starts with `!wl on` and call `handleWelcomeBye`
with the optional canonical command name `welcome`. Assert the `welcomeGroup`
setting changes and the `byeGroup`/`updateGroup` settings do not.

- [ ] **Step 2: Run the focused test and verify it fails for the alias**

Run: `node --test tests/phase-7-contract.test.js --test-name-pattern="welcome alias"`

Expected: FAIL because the existing handler maps only the raw prefixed command
text and does not know that `wl` is the canonical `welcome` command.

- [ ] **Step 3: Normalize the optional canonical command in the handler**

Use the fourth argument when supplied, otherwise normalize the first message
token. Map the normalized name to `welcomeGroup`, `byeGroup`, or `updateGroup`.
Keep the existing three-argument signature valid and preserve the current
toggle/on/off response behavior.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/phase-7-contract.test.js --test-name-pattern="welcome alias"`

Expected: PASS.

### Task 4: Run phase-wide and repository-wide verification

**Files:**
- No production files added in this task.

- [ ] **Step 1: Run all Phase 7 tests**

Run: `node --test tests/phase-7-dispatch.test.js tests/phase-7-contract.test.js`

Expected: all Phase 7 tests pass.

- [ ] **Step 2: Run the existing command-router regression suite**

Run: `node --test tests/command-router.test.js tests/command-parser.test.js tests/phase-1-dispatch.test.js tests/phase-2-dispatch.test.js tests/phase-3-dispatch.test.js tests/phase-4-dispatch.test.js tests/phase-4-contract.test.js tests/phase-5-dispatch.test.js tests/phase-5-contract.test.js tests/phase-6-dispatch.test.js tests/phase-6-contract.test.js`

Expected: all command routing tests pass, including the updated aggregate size
expectations where the tests intentionally cover the aggregate registry.

- [ ] **Step 3: Run the full regression suite**

Run: `npm test`

Expected: exit code 0 with no test failures.

- [ ] **Step 4: Run syntax and mock smoke checks**

Run: `node --check src/commands/command-registry.js; node --check src/commands/bot-manager/welcome-bye.js; node --check src/commands/command-router.js; node --test tests/phase-7-dispatch.test.js --test-name-pattern="ready database"`

Expected: syntax checks exit 0 and the smoke test dispatches all active Phase 7
commands without `DB_BLOCKED` or external calls.
