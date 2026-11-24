# React Countdown State Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every reaction countdown visibly change from `N` to `N-1` each second instead of staying at the initial count, while preserving expiry, cancellation, QR recall, and command routing.

**Architecture:** Keep `CLOCK` as the standard Zalo reaction and keep the current `addReaction` transport contract. Add one shared reaction-state renderer that replaces the whole visible count (`UNDO` the current frame, then add the next frame), because sending `UNDO` for only one duplicate target does not produce a visible decrement. Route normal interaction countdowns, command cooldowns, and QR countdowns through that renderer; derive the displayed number from an absolute deadline so slow API calls skip stale numbers rather than extending the timeout.

**Tech Stack:** Node.js ES modules, `node:test`, the repository's Zalo `addReaction` API, fake schedulers for deterministic tests, Windows/PowerShell runtime verification.

**Spec:** Bounded bug report from 2026-08-22: a 90-second reaction count is visible as `90`, but never changes to `89`, `88`, and so on.

## Global Constraints

- Work only in the nested Git repository `HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main`.
- Preserve `.env.local`, `.bot.pid`, `logs/bot-stdout.log`, `.cache/`, and all unrelated user changes.
- Keep `CLOCK` mapped to `rType: 55` and `source: 6`; do not reintroduce numeric custom reactions.
- Keep `MAX_REACTION_BATCH_SIZE = 50`; a 90-second frame must be transported as `50 + 40` targets.
- The absolute deadline remains authoritative. Reaction rendering failures must not extend QR expiry, game turns, media selection, or command cooldowns.
- Stop, success, claim, replacement, and expiry must leave no bot-owned countdown reaction behind.
- Cap every automated test command at five minutes and report partial/failing suites exactly.

---

## Bối cảnh và nguyên nhân gốc

1. `src/utils/interaction-countdown.js:682-748` implements `showCooldownClock()` as a static frame: it sends `CLOCK x remainingSeconds` once and schedules only one cleanup at `remainingMs`. There is no one-second tick, so command cooldowns can only show `90` until they disappear.
2. `src/utils/interaction-countdown.js:571-605` does tick for interaction sessions, but it changes `confirmedReactions` by sending only the arithmetic difference, normally `UNDO x1`. That mutates an internal counter; it does not replace the visible Zalo reaction frame with `89`.
3. `src/utils/qr-login-countdown.js:217-261` repeats the same `confirmedReactions > remaining => UNDO(diff)` assumption for QR login.
4. The current mocks in `tests/interaction-countdown.test.js:21-62` and `tests/qr-login-countdown.test.js` only record request counts. Assertions such as “`UNDO x1` means two reactions remain” never model what the client actually renders, so the tests pass while the device stays at `90`.
5. The working reference loop clears the entire current frame before sending the next smaller frame. The fix must encode this request sequence explicitly rather than treating a successful HTTP response as proof that the mobile counter decremented.

## Suy luận lại logic

For a three-second session, the transport and visible-state contract is:

```text
t=0: CLOCK x3             -> visible 3
t=1: UNDO x3; CLOCK x2    -> visible 2
t=2: UNDO x2; CLOCK x1    -> visible 1
t=3: UNDO x1; expire      -> visible 0 / no countdown reaction
```

For a 90-second session, the same contract begins with `CLOCK 50 + 40`, then `UNDO 50 + 40`, then `CLOCK 50 + 39`. A tick calculates `next = ceil((expiresAt - now()) / 1000)`; it never decrements a stale local value blindly.

---

### Task 1: Lock the visible-frame contract with failing tests

**Files:**
- Modify: `tests/interaction-countdown.test.js`
- Modify: `tests/cooldown-reaction.test.js`
- Modify: `tests/qr-login-countdown.test.js`

**Interfaces:**
- Consumes: existing `startInteractionCountdown`, `showCooldownClock`, and `startQrLoginCountdown` public APIs.
- Produces: failing assertions for the exact `UNDO oldCount -> CLOCK newCount` request sequence and deadline behavior.

- [ ] **Step 1: Replace arithmetic-only assertions for a three-second interaction countdown.**

Assert the complete call frames, not only the number of calls:

```js
assert.deepEqual(
  api.reactionCalls.map(({ icon, count }) => ({ icon, count })),
  [
    { icon: "CLOCK", count: 3 },
    { icon: "UNDO", count: 3 },
    { icon: "CLOCK", count: 2 },
    { icon: "UNDO", count: 2 },
    { icon: "CLOCK", count: 1 },
    { icon: "UNDO", count: 1 },
  ]
);
```

- [ ] **Step 2: Add a command-cooldown test that proves `showCooldownClock()` has real one-second ticks.**

Use the fake scheduler with `remainingMs: 3000`. After starting, stepping one second, and stepping a second time, assert visible frames `3`, `2`, `1`; after the deadline assert the final `UNDO x1` and no new timer.

- [ ] **Step 3: Replace the QR test's `UNDO x1` expectations with full-frame replacement.**

For `seconds: 3`, assert:

```js
[
  ["CLOCK", 3],
  ["UNDO", 3], ["CLOCK", 2],
  ["UNDO", 2], ["CLOCK", 1],
  ["UNDO", 1],
]
```

Also retain the existing assertions that expiry runs once, cleanup runs once, and the QR message is recalled once.

- [ ] **Step 4: Add a delayed-tick test.**

Advance the fake clock by 2500 ms between callbacks in a five-second countdown. Assert the next rendered frame is `3`, not `4`, and assert expiry still occurs at the original `expiresAt`.

- [ ] **Step 5: Add a 90-second batching transition test.**

Assert the first three frames are transported as:

```js
[
  ["CLOCK", 50], ["CLOCK", 40],
  ["UNDO", 50], ["UNDO", 40],
  ["CLOCK", 50], ["CLOCK", 39],
]
```

- [ ] **Step 6: Run the new tests and verify they fail for the current reason.**

Run:

```powershell
node --test --test-force-exit --test-concurrency=1 tests/cooldown-reaction.test.js tests/interaction-countdown.test.js tests/qr-login-countdown.test.js
```

Expected: the new frame-sequence assertions fail because current code emits either no tick (`showCooldownClock`) or only `UNDO x1`. Record the two pre-existing QR polling/classification failures separately; they are not evidence about reaction rendering.

- [ ] **Step 7: Commit the regression tests.**

```powershell
git add -- tests/interaction-countdown.test.js tests/cooldown-reaction.test.js tests/qr-login-countdown.test.js
git commit -m "test(countdown): model visible reaction frame replacement"
```

---

### Task 2: Add one shared reaction-frame renderer

**Files:**
- Modify: `src/utils/interaction-countdown.js`
- Test: `tests/interaction-countdown.test.js`

**Interfaces:**
- Consumes: `applyReactionBatch({ api, icon, messageRef, count, maxBatchSize })` and `undoReactionBatch({ api, messageRef, count, maxBatchSize })`.
- Produces: `replaceCountdownReactionFrame({ api, messageRef, renderedCount, nextCount, maxBatchSize }): Promise<number>`; the returned number is the successfully rendered new frame size.

- [ ] **Step 1: Add direct failing tests for `replaceCountdownReactionFrame()`.**

Cover these exact cases:

```js
// 3 -> 2
await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 3, nextCount: 2 });
assert.deepEqual(calls, [["UNDO", 3], ["CLOCK", 2]]);

// 0 -> 3
assert.deepEqual(calls, [["CLOCK", 3]]);

// 1 -> 0
assert.deepEqual(calls, [["UNDO", 1]]);

// 2 -> 2
assert.deepEqual(calls, []);
```

- [ ] **Step 2: Implement the renderer with strict ordering.**

The implementation must:

```js
export async function replaceCountdownReactionFrame({
  api,
  messageRef,
  renderedCount = 0,
  nextCount = 0,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  const current = Math.max(0, Math.floor(Number(renderedCount) || 0));
  const next = Math.max(0, Math.floor(Number(nextCount) || 0));
  if (current === next) return current;

  if (current > 0) {
    const undone = await undoReactionBatch({ api, messageRef, count: current, maxBatchSize });
    if (undone !== current) return Math.max(0, current - undone);
  }

  if (next === 0) return 0;
  return await applyReactionBatch({ api, icon: "CLOCK", messageRef, count: next, maxBatchSize });
}
```

Do not send the new frame until all batches of the old frame have been acknowledged. This avoids `CLOCK` and `UNDO` calls racing each other.

- [ ] **Step 3: Add failure-path tests.**

Verify that a failed clear does not add the new frame, a partial add returns only the acknowledged count, and a later call first clears the tracked partial frame before retrying the deadline-derived target.

- [ ] **Step 4: Run the focused helper tests.**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/interaction-countdown.test.js
```

Expected: helper tests pass; the existing lifecycle frame tests still fail until Task 3.

- [ ] **Step 5: Commit the shared renderer.**

```powershell
git add -- src/utils/interaction-countdown.js tests/interaction-countdown.test.js
git commit -m "fix(countdown): replace complete reaction frames"
```

---

### Task 3: Route all countdown lifecycles through the renderer

**Files:**
- Modify: `src/utils/interaction-countdown.js:423-748`
- Modify: `src/utils/qr-login-countdown.js:40-264`
- Modify: `tests/interaction-countdown.test.js`
- Modify: `tests/cooldown-reaction.test.js`
- Modify: `tests/qr-login-countdown.test.js`

**Interfaces:**
- Consumes: `replaceCountdownReactionFrame()` from Task 2.
- Produces: deadline-driven interaction, cooldown, and QR frames with the existing cancellation/expiry public APIs.

- [ ] **Step 1: Replace `confirmedReactions` arithmetic in `startInteractionCountdown()`.**

Rename the state to `renderedCount`. On each tick calculate:

```js
const nextCount = Math.max(0, Math.ceil((session.expiresAt - session.now()) / 1000));
session.renderedCount = await replaceCountdownReactionFrame({
  api: session.api,
  messageRef: session.messageRef,
  renderedCount: session.renderedCount,
  nextCount,
  maxBatchSize: session.maxBatchSize,
});
```

At `nextCount === 0`, clear the last frame before calling `onExpire()` and before recalling a bot-owned prompt. Keep only one in-flight render promise per session.

- [ ] **Step 2: Make cancellation await the final clear.**

Return the promise from the cancel closure:

```js
return () => cancelInteractionCountdown(session.key ? session.key : session);
```

`completeInteractionCountdown()` must cancel the scheduled tick, await the in-flight render, clear `renderedCount`, remove the session map entry, and prevent late `onExpire()`.

- [ ] **Step 3: Convert `showCooldownClock()` from a static frame to the shared lifecycle.**

Add optional `timeoutMs` support to `startInteractionCountdown()`. `showCooldownClock()` should delegate with:

```js
return startInteractionCountdown({
  api,
  message,
  messageContext,
  seconds: Math.max(1, Math.ceil(remainingMs / 1000)),
  timeoutMs: remainingMs,
  schedule,
  cancelSchedule,
  maxBatchSize,
});
```

This preserves the exact cooldown deadline while producing one visible frame per second. Do not change `sendReactionWaitingCountdown()` or command routing; they already call this helper.

- [ ] **Step 4: Replace QR `confirmedReactions` arithmetic with the same renderer.**

Use `expiresAt` and `now()` for every QR frame instead of `remaining -= 1`. Preserve the QR-specific abort signal, success/cancel guards, message recall, `onExpire`, `onSuccess`, and `onCleanup` ordering.

- [ ] **Step 5: Ensure session replacement is serialized.**

Keep the public starter synchronous. When a new countdown reuses an existing key, chain the new initial render behind cleanup of the old session:

```js
const previousCleanup = normalizedKey && activeCountdownSessions.has(normalizedKey)
  ? cancelInteractionCountdown(normalizedKey)
  : Promise.resolve(false);

session.renderPromise = Promise.resolve(previousCleanup)
  .then(() => {
    if (session.stopped) return 0;
    return replaceCountdownReactionFrame({
      api: session.api,
      messageRef: session.messageRef,
      renderedCount: 0,
      nextCount: session.remaining,
      maxBatchSize: session.maxBatchSize,
    });
  });
```

Assert that an old delayed `UNDO` completes before the replacement session adds its first frame and therefore cannot clear the new reaction.

- [ ] **Step 6: Run all reaction-focused tests.**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/cooldown-reaction.test.js tests/interaction-countdown.test.js tests/co-tuong-countdown.test.js tests/group-prompts-countdown.test.js tests/qr-login-prefix-state.test.js
```

Expected: all pass with exact full-frame replacement sequences.

- [ ] **Step 7: Run QR countdown tests and classify unrelated baseline failures.**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/qr-login-countdown.test.js
```

Expected for reaction cases: pass. If the existing `waitingConfirm` or `classifyQrScanResponse` cases still fail, report them separately and do not broaden this countdown patch into QR classifier work.

- [ ] **Step 8: Commit lifecycle integration.**

```powershell
git add -- src/utils/interaction-countdown.js src/utils/qr-login-countdown.js tests/interaction-countdown.test.js tests/cooldown-reaction.test.js tests/qr-login-countdown.test.js
git commit -m "fix(countdown): render decreasing reaction state each second"
```

---

### Task 4: Verify the real Zalo protocol and deployed runtime

**Files:**
- No source file changes unless the live probe disproves the tested transport contract.
- Inspect: `logs/bot-stdout.log`
- Inspect: `.bot.pid`

**Interfaces:**
- Consumes: built bot runtime, real group/direct message IDs, PC and mobile Zalo clients.
- Produces: evidence that the client renders decreasing counts and that the tested checkout/process is the deployed one.

- [ ] **Step 1: Establish the deployment identity before testing.**

Verify `git rev-parse HEAD`, the active PID/command line, and a fresh `[RUNTIME FINGERPRINT]` containing the same repository root, `src/bootstrap.js`, PID, and commit. A source commit or stale log line is not deployment proof.

- [ ] **Step 2: Run a three-second protocol probe in both a group and a direct chat.**

Observe `3 → 2 → 1 → removed`. Confirm logs contain no reaction endpoint error. If `UNDO x currentCount` does not clear the old frame, stop and capture the decrypted request/response status; do not stack another guessed transport change.

- [ ] **Step 3: Run a ten-second command-cooldown smoke test.**

Trigger a command twice and observe the rejected call's reaction count `10 → 9 → 8`. At the deadline, run the command again and confirm it is accepted and the countdown reaction is gone.

- [ ] **Step 4: Run the 90-second QR smoke test.**

Observe at minimum `90 → 89 → 88` on Zalo PC and one mobile client. Then verify both terminal branches:

- Expiry: the count reaches zero, polling aborts, and the QR message is recalled once.
- Success before expiry: the reaction is cleared, the QR message is recalled once, and normal credential/login continuation runs once.

- [ ] **Step 5: Check cancellation surfaces.**

Claim one media selection and complete or replace one game/prompt countdown. Confirm the timer stops immediately, no late tick clears a newer session, and no timeout callback fires after success.

- [ ] **Step 6: Enforce the five-minute automated-test limit.**

Run the focused suite from Task 3. Run a wider suite only with a 300-second cap; if it times out or retains the two known QR failures, report the exact partial result rather than calling the project green.

- [ ] **Step 7: Commit only evidence-related test adjustments, if any.**

Do not commit `.env.local`, `.bot.pid`, logs, caches, runtime JSON, or generated media. If no source/test adjustment is needed after the live probe, make no extra commit.

---

## Acceptance Criteria

- A 90-second reaction countdown visibly changes to `89` and `88` on a real Zalo client.
- Each transition clears the complete old frame before adding the new frame; it never assumes `UNDO x1` means `N-1`.
- Command cooldowns, normal interaction prompts, games, media selection, QR prefix, and QR login use the same reaction-frame contract.
- The deadline is not extended by slow network calls.
- Expiry, success, cancellation, claim, and keyed-session replacement remove all countdown reactions and execute their lifecycle callback at most once.
- Batches never exceed 50 targets.
- Focused tests pass within five minutes, and real group/direct plus PC/mobile evidence is recorded against the active runtime fingerprint.
