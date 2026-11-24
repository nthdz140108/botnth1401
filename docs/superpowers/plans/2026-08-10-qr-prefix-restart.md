# QR Prefix Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure setting a QR-created bot prefix starts the bot even when its previous child process is already stopped or its PID is stale.

**Architecture:** Add a dependency-injected restart helper beside the existing prefix workflow. It checks process status before killing, retries the status check after a reported kill failure, and only invokes the launcher when no live process remains. Wire that helper into the QR reply handler without changing the shared process-kill function.

**Tech Stack:** Node.js ES modules, `node:test`, `node:assert/strict`, existing `pm2-manager.js` process helpers.

## Global Constraints

- Do not change the return contract or behavior of `killSpawnedProcess()` for other callers.
- Production code must be preceded by a failing regression test.
- Do not start a real Zalo bot during unit tests.
- Preserve prefix file writing and credential reload behavior.

---

### Task 1: Add the failing restart decision tests

**Files:**
- Modify: `tests/qr-login-prefix-state.test.js`
- Modify: `src/utils/qr-login-prefix-workflow.js`

**Interfaces:**
- Add a helper with signature `restartBotAfterStop({ botUid, checkStatus, killBot, startBot })` returning `Promise<boolean>`.
- The helper receives functions so tests can model process state without mocks of Node process APIs.

- [ ] **Step 1: Write the failing tests**

Add these cases to `tests/qr-login-prefix-state.test.js`:

```js
test("starts a bot that is already stopped", async () => {
  const calls = [];
  const result = await restartBotAfterStop({
    botUid: "bot-stopped",
    checkStatus: async () => ({ running: false }),
    killBot: async () => {
      calls.push("kill");
      return false;
    },
    startBot: async (botUid) => {
      calls.push(["start", botUid]);
      return true;
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [["start", "bot-stopped"]]);
});

test("does not start a second bot when kill fails and the process remains alive", async () => {
  const calls = [];
  const result = await restartBotAfterStop({
    botUid: "bot-alive",
    checkStatus: async () => ({ running: true }),
    killBot: async (botUid) => {
      calls.push(["kill", botUid]);
      return false;
    },
    startBot: async () => {
      calls.push("start");
      return true;
    },
  });

  assert.equal(result, false);
  assert.deepEqual(calls, [["kill", "bot-alive"]]);
});
```

Import `restartBotAfterStop` from the workflow module before running the test.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/qr-login-prefix-state.test.js`

Expected: FAIL because `restartBotAfterStop` is not exported yet. Existing prefix state tests should still load.

### Task 2: Implement and wire the idempotent restart helper

**Files:**
- Modify: `src/utils/qr-login-prefix-workflow.js`
- Modify: `src/automations/event-send-msg.js`
- Modify: `tests/qr-login-prefix-state.test.js`

**Interfaces:**
- `restartBotAfterStop` returns `false` only when a live process remains after a failed kill; otherwise it returns the launcher result.
- `restartQrLoginBot(botUid)` uses `checkSpawnedProcessStatus`, `killSpawnedProcess`, and `startBotWithLauncher`.

- [ ] **Step 1: Implement the minimal helper**

Implement:

```js
export async function restartBotAfterStop({ botUid, checkStatus, killBot, startBot }) {
  const status = await checkStatus(botUid);
  if (status?.running) {
    const stopped = await killBot(botUid);
    if (!stopped && (await checkStatus(botUid))?.running) return false;
  }
  return Boolean(await startBot(botUid));
}
```

- [ ] **Step 2: Wire the helper into the event adapter**

Import `checkSpawnedProcessStatus` and replace the direct kill/start sequence with:

```js
return restartBotAfterStop({
  botUid,
  checkStatus: checkSpawnedProcessStatus,
  killBot: killSpawnedProcess,
  startBot: startBotWithLauncher,
});
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `node --test tests/qr-login-prefix-state.test.js`

Expected: all tests in the file pass, including both new restart decision cases and the existing apply-then-restart case.

### Task 3: Verify the full change

**Files:**
- Inspect: `src/utils/qr-login-prefix-workflow.js`
- Inspect: `src/automations/event-send-msg.js`
- Inspect: `tests/qr-login-prefix-state.test.js`

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 with no failed tests.

- [ ] **Step 2: Run syntax checks for changed modules**

Run: `node --check src/utils/qr-login-prefix-workflow.js; node --check src/automations/event-send-msg.js`

Expected: both commands exit 0.

- [ ] **Step 3: Review the diff and runtime state**

Confirm only the two production modules and the focused test contain behavior changes. Confirm the shared `killSpawnedProcess()` implementation was not modified and no bot process was started by the tests.
