# Bot Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make main-launcher and dashboard child-bot restarts single-flight, ordered, process-owner aware, and observable.

**Architecture:** Add a dependency-injected restart coordinator for the main launcher. It serializes stop, optional backoff delay, and start, and shares one Promise for concurrent requests. Update dashboard actions with a per-bot lock and live runtime ownership detection so direct spawned processes use kill/start while actual PM2 processes use PM2 restart.

**Tech Stack:** Node.js ESM, `node:test`, `child_process`, existing PM2 and spawned-process adapters.

## Global Constraints

- Preserve the existing `{ botId, action: "restart", status: "restarting" }` success response.
- Preserve existing crash backoff, failure limit, cookie-dead handling, and CTRL+C handling.
- Do not log credentials or cookie contents.
- Do not introduce a dependency or move all bots to PM2.
- Follow RED-GREEN-REFACTOR: each production behavior is preceded by a failing focused test.

### Task 1: Add the Restart Coordinator

**Files:**
- Create: `src/utils/restart-coordinator.js`
- Create: `tests/restart-coordinator.test.js`

**Interfaces:**
- Consumes: `stop(context)`, `start(context)`, optional numeric/function `delayMs`, optional `onStateChange`.
- Produces: `createRestartCoordinator({ stop, start, delayMs, onStateChange })`, with `restart(reason, context)` and `getState()`.

- [ ] **Step 1: Write failing tests for ordering and single-flight behavior**

```js
test("shares one restart promise and starts only after stop", async () => {
  const events = [];
  let releaseStop;
  const stop = () => new Promise((resolve) => {
    events.push("stop");
    releaseStop = resolve;
  });
  const start = () => {
    events.push("start");
    return "new-process";
  };
  const coordinator = createRestartCoordinator({ stop, start, delayMs: 0 });

  const first = coordinator.restart("manual", { pid: 10 });
  const second = coordinator.restart("manual", { pid: 10 });
  assert.strictEqual(first, second);
  assert.deepEqual(events, ["stop"]);

  releaseStop();
  assert.equal(await first, "new-process");
  assert.deepEqual(events, ["stop", "start"]);
});

test("returns to idle and propagates a start failure", async () => {
  const coordinator = createRestartCoordinator({
    stop: async () => {},
    start: async () => { throw new Error("start failed"); },
    delayMs: 0,
  });

  await assert.rejects(coordinator.restart(), /start failed/);
  assert.equal(coordinator.getState().phase, "idle");
  assert.equal(coordinator.getState().inFlight, false);
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing module**

Run: `node --test tests/restart-coordinator.test.js`

Expected: FAIL because `src/utils/restart-coordinator.js` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Implement a non-`async` `restart()` so concurrent calls return the exact same Promise. Store the current phase, generation, and in-flight Promise. Resolve `delayMs` as either a number or `delayMs({ reason, context })`; call `stop(context)` before waiting and `start(context)` after waiting; on rejection set phase to `idle`, clear the Promise in `finally`, and rethrow.

- [ ] **Step 4: Add tests for delay callback, state transitions, and independent later restarts**

Assert that `onStateChange` observes `stopping` then `starting` then `running`, that the callback receives the reason/context, and that a second restart after the first settles runs a new stop/start cycle.

- [ ] **Step 5: Run focused tests and refactor only with green tests**

Run: `node --test tests/restart-coordinator.test.js`

Expected: all coordinator tests pass with no unhandled rejection or warning.

- [ ] **Step 6: Commit**

Git commit is unavailable because this checkout has no `.git` directory. Preserve the completed files and record the limitation in the handoff.

### Task 2: Integrate the Main Launcher

**Files:**
- Modify: `bot.js:1-80, 422-458, 600-715, 780-820`
- Test: `tests/restart-coordinator.test.js`

**Interfaces:**
- Consumes: coordinator from Task 1.
- Produces: one restart path for manual, signal, explicit action, and crash-triggered restarts.

- [ ] **Step 1: Extend focused tests for stale process context and delay selection**

Add a fake process context to the coordinator tests. Verify stop receives the original process context, the start callback receives the same restart reason, and a delay callback can return `0` for manual and `250` for crash without overlapping calls.

- [ ] **Step 2: Run the test and verify the new assertions fail**

Run: `node --test tests/restart-coordinator.test.js`

Expected: FAIL until the coordinator passes context and reason consistently.

- [ ] **Step 3: Wire `bot.js` through the coordinator**

Import the coordinator and create one launcher coordinator. Make `stopBot(processHandle)` return a Promise: resolve when the target is already dead or when Windows `taskkill` closes successfully; reject on spawn/error/timeout after attempting to terminate the taskkill helper. Replace the fixed-delay body of `restartBot()` with coordinator `restart(reason, { processHandle })` and log success/failure from the returned Promise.

- [ ] **Step 4: Remove competing direct starts and protect process identity**

Change `attachBotEvents` to capture a `processHandle`. Ignore `error`/`exit` events unless `processHandle === botProcess`. Route explicit restart and crash recovery to the coordinator. Keep terminal stop, cookie-dead, and CTRL+C branches. Retain only one scheduled crash retry per coordinator cycle.

- [ ] **Step 5: Invalidate delayed child startup from obsolete cycles**

Store the five-second startup timer returned by `setTimeout`. Clear it when a restart begins and guard its callback with the launcher generation/current process identity before calling `fixCredentialPaths()` and `startChildBots()`.

- [ ] **Step 6: Run syntax and focused tests**

Run: `node --check bot.js; node --test tests/restart-coordinator.test.js`

Expected: both commands exit `0`; the coordinator tests prove stop-before-start and no duplicate starts.

### Task 3: Make Child-Bot Restart Owner-Aware and Single-Flight

**Files:**
- Modify: `src/dashboard/bot-action-service.js:17-75, 178-194`
- Modify: `tests/dashboard/bot-actions.test.js`

**Interfaces:**
- Consumes: existing `pm2Adapter.status/restart/start/stop` and `processAdapter.status/kill` contracts.
- Produces: per-bot serialized `restart(botId)` and live-owner-aware stop/start behavior.

- [ ] **Step 1: Add failing dashboard tests for direct and PM2 runtimes**

Add tests using the existing fixture and adapters:

```js
test("restarts a directly spawned bot by killing then starting it", async () => {
  const root = await fixture();
  const { calls, service } = serviceFor(root, {
    pm2Adapter: { status: async () => ({ running: false, status: "not_found" }) },
    processAdapter: { status: async () => ({ running: true }) },
  });

  const result = await service.restart("child");
  assert.deepEqual(result, { botId: "child", action: "restart", status: "restarting" });
  assert.deepEqual(calls, [["kill", "child"], ["start", "child"]]);
});

test("shares a concurrent PM2 restart for the same bot", async () => {
  const root = await fixture();
  let release;
  let started;
  const restartStarted = new Promise((resolve) => { started = resolve; });
  let restartCalls = 0;
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: true, status: "online" }),
      restart: async () => {
        restartCalls += 1;
        started();
        await new Promise((resolve) => { release = resolve; });
        return true;
      },
    },
  });

  const first = service.restart("child");
  const second = service.restart("child");
  assert.strictEqual(first, second);
  await restartStarted;
  release();
  await Promise.all([first, second]);
  assert.equal(restartCalls, 1);
});
```

Use a fresh `root` fixture in each test and retain the existing adapter call recorder.

- [ ] **Step 2: Run the dashboard test and verify it fails**

Run: `node --test tests/dashboard/bot-actions.test.js`

Expected: FAIL because current restart always calls the PM2 adapter and does not share a Promise.

- [ ] **Step 3: Implement per-bot restart locking**

Add a `Map` inside `createBotActionService`. Keep `restart(botId)` as a non-`async` function so it can return the exact existing Promise when present. Otherwise create the action Promise, store that same Promise before awaiting adapters, and delete it in `finally`.

- [ ] **Step 4: Fix live runtime ownership detection**

Change `stopRuntime` so registry/configured `status === "running"` does not imply PM2 ownership. Use only live PM2 status for `pm2Running`, and use live process status/state for `processRunning`. Preserve `STOP_FAILED` and adapter detail collection.

- [ ] **Step 5: Implement owner-aware restart**

In `restart(botId)`, read PM2 and spawned status once. If PM2 is live, call `pm2.restart`. Otherwise kill the live spawned process if present, then call the existing launcher adapter through `pm2.start`. Treat `false` or thrown adapter operations as `ACTION_FAILED`; keep the existing success response.

- [ ] **Step 6: Run focused dashboard tests and refactor with green tests**

Run: `node --test tests/dashboard/bot-actions.test.js`

Expected: all existing and new dashboard action tests pass, including disabled-bot rejection and stop failure behavior.

- [ ] **Step 7: Commit**

Git commit is unavailable because this checkout has no `.git` directory. Preserve the completed files and record the limitation in the handoff.

### Task 4: Full Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run all restart-focused tests**

Run: `node --test tests/restart-coordinator.test.js tests/dashboard/bot-actions.test.js`

Expected: all focused tests pass.

- [ ] **Step 2: Run the complete project test suite**

Run: `npm test`

Expected: exit code `0`, with no failed tests.

- [ ] **Step 3: Check changed files and syntax**

Run: `node --check bot.js; node --check src/utils/restart-coordinator.js; git status --short 2>&1; exit 0`

Expected: syntax checks pass; Git reports that the directory is not a repository, which is documented rather than treated as a code failure.
