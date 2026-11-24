# QR Prefix Reply Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make QR-created bot prefix replies work even when `sendMessage` does not return a message ID, then restart the bot after saving the prefix.

**Architecture:** Keep the existing message-ID match as the strongest correlation. When the prompt message ID is unavailable, register an awaiting session with an empty quoted ID and match only by allowed requester, thread, state, and five-minute expiry. After applying the prefix, restart the matched bot and report success only after restart succeeds.

**Tech Stack:** Node.js ES modules, `node:test`, existing PM2/spawn bot manager.

## Global Constraints

- Use a one-minute prefix timeout before the bot keeps its default prefix.
- Preserve requester/thread authorization checks.
- Use the existing spawned-process lifecycle: `killSpawnedProcess` followed by `startBotWithLauncher`.
- Add a regression test before production changes.

---

### Task 1: Add failing prefix-session regression tests

**Files:**
- Modify: `tests/qr-login-prefix-state.test.js`
- Modify: `src/utils/qr-login-prefix-state.js`

- [x] **Step 1: Write tests** for matching an awaiting prefix session without a quoted message ID, while rejecting an unauthorized requester or wrong thread.
- [x] **Step 2: Run** `node --test tests/qr-login-prefix-state.test.js` and confirm the fallback test fails before implementation.
- [x] **Step 3: Implement** the minimal fallback matcher.
- [x] **Step 4: Run** the focused test and confirm it passes.

### Task 2: Restart the bot after prefix application

**Files:**
- Modify: `src/automations/event-send-msg.js`
- Modify: `tests/qr-login-prefix-state.test.js`

- [x] **Step 1: Add** a testable reply workflow seam that verifies `applyPrefixToBot` is followed by `restartBot` for the matched bot.
- [x] **Step 2: Run** the focused test and confirm it fails because no restart occurs.
- [x] **Step 3: Import and call** `killSpawnedProcess` followed by `startBotWithLauncher(matchedBotUid)` after the prefix file is updated; throw a useful error when restart returns false.
- [x] **Step 4: Run** focused tests, then the full `npm test` suite; record the unrelated browser failure in the handoff.

### Task 3: Verify the complete change

**Files:**
- No additional files.

- [x] **Step 1: Run** `node --test tests/qr-login-prefix-state.test.js`.
- [x] **Step 2: Run** `npm test`.
- [x] **Step 3: Inspect** the final changed files and confirm only the intended QR-prefix files and plan/test documentation changed.
