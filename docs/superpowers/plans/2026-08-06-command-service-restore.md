# Command/Service Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore `main2` command/service behavior in `main` without changing protected integrations or operational data.

**Architecture:** Keep the current API and runtime boundaries. Restore behavior at dispatcher and service-function boundaries, with one response helper and context-based filesystem resolution.

**Tech Stack:** Node.js ES modules, built-in `node:test`, PowerShell SHA-256 tooling.

## Global Constraints

- Never modify `src/api-zalo/**` or its `zca-js 2.1.2` compatibility changes.
- Never modify QR login, multi-bot, runtime context, dashboard, launcher, credentials, registry, or operational JSON.
- Do not add runtime dependencies or connect to Zalo during tests.

### Task 1: Reaction contract and dispatcher gates

**Files:** `src/commands/command-response.js`, `src/commands/command.js`, `tests/fixes.test.js`

- [x] Write and run failing tests for `/-thanks`, type filtering, one-call dedupe, canonical aliases, and swallowed reaction errors.
- [x] Implement the single boolean helper and import/re-export it from `command.js`.
- [ ] Add group/private dispatcher tests proving gates run before reaction.
- [ ] Run the focused regression and full existing suite.

### Task 2: Restore command/service functions

**Files:** the 154 common-different files reported by source hash comparison, excluding protected boundaries and data files.

- [ ] Generate a function-level diff inventory against `main2` and classify each file as protected, restore-from-original, or integration adapter.
- [ ] For each restore candidate, add a mock-API regression test first.
- [ ] Restore only the divergent function bodies and preserve current imports/interfaces where needed.
- [ ] Run the related tests after each command/service cluster: permission/cooldown, anti-service, game, and service handlers.

### Task 3: Asset resolver and temp directories

**Files:** asset-using command/service modules, shared path utility, regression tests.

- [ ] Add failing tests for project-root resolution, removal of `/root/ndq` and Desktop literals, existing asset checks, and automatic temp-directory creation.
- [ ] Implement one resolver from runtime/project context and use it at write sites.
- [ ] Validate image decode/font registration without changing binary assets.

### Task 4: Offline verification command

**Files:** `package.json`, offline test scripts, validation tests.

- [ ] Add `npm run test:offline` without dependencies or network login.
- [ ] Include regression, asset validation, syntax/import smoke, and current tests.
- [ ] Recompute the operational manifest and fail on any hash change.
- [ ] Run the full command and report exact pass/fail counts and residual risk.
