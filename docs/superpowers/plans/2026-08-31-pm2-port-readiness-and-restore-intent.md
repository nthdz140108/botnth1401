# PM2 Port Readiness and Restore Intent Implementation Plan

> **SUPERSEDED POLICY NOTE (2026-09-01).** The `desiredStatus` registry field
> in this plan was NOT implemented and is intentionally dropped. The approved
> replacement auto-start policy is "mọi bot hợp lệ còn hạn": `run.bat`
> reconcile starts EVERY valid, non-expired child bot regardless of previous
> `status` (including `stopped`); disabled/rejected/deleted, expired or
> malformed expiry, cookie-dead, identity-pending, trial pending/activating,
> missing credentials, invalid port, and admin are excluded fail-closed.
> Implemented in `src/commands/mybot/System/mybot-auto-restore.js` and
> `src/runtime/reconcile-and-monitor.js` (see tests
> `tests/bot-auto-restore-policy.test.js`, `tests/reconcile-auto-start.test.js`).
> The listener-bridge and readiness portions of this plan ARE implemented via
> `src/runtime/listener-state.js`, `tests/listener-readiness.test.js`, and
> `tests/startup-deadline.test.js`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each bot runtime bridge available through transient Zalo listener failures and preserve previously-running child intent across PM2 updater stops.

**Architecture:** Make the HTTP runtime bridge process-scoped and independent from the retrying Zalo listener, while exposing listener connectivity as an explicit readiness field. ~~Add a durable `desiredStatus` registry field~~ (superseded: validity-based auto-start policy above) and keep live PM2/runtime observations separate.

**Tech Stack:** Node.js 20 ESM, PM2 7.x/local Windows shim, Express/Socket.IO, built-in `node:test`, JSON registry/state files.

**Spec:** `docs/superpowers/specs/2026-08-31-pm2-port-readiness-and-restore-intent-design.md`

## Global Constraints

- Work in the nested Git root and preserve `.env.local`, `mybot/`, logs, credentials, state, and unrelated dirty changes.
- Use the repo-local `node_modules\.bin\pm2.cmd`; do not depend on a global PM2 command.
- `update.bat` remains update-only and must not automatically start bots.
- QR provisioning remains `status: "stopped"`, `trialStatus: "pending"`, and `desiredStatus: "stopped"`.
- Restore only desired-running children that are enabled, unexpired, and not cookie-dead.
- The terminal monitor remains read-only.
- Stage only named source/test/doc files; never use `git add .`, reset/clean, force-push, or expose credentials.
- Keep focused automated verification under five minutes and report process, HTTP, VPS, and live-Zalo evidence separately.

---

### Task 1: Bound admin authentication and QR recovery startup

**Files:**
- Create: `src/core/startup-deadline.js`
- Modify: `src/utils/admin-startup-recovery.js:52-116`
- Modify: `src/index.js:468-493, 628-711, 716-750`
- Test: `tests/admin-startup-recovery.test.js`
- Test: `tests/startup-deadline.test.js`

**Interfaces:**
- Produces: `withStartupDeadline(operation, { timeoutMs, code, message, onTimeout }) -> Promise<T>`.
- Produces admin startup state fields `startupPid`, `startupPhase`, `startupStartedAt`, `startupLastError`, and `startupUpdatedAt`.
- Consumes the existing coordinator `login`, `recoverWithQr`, `reloadCredentials`, and injected sleep contracts.

- [ ] **Step 1: Write a failing deadline test**

```js
await assert.rejects(
  withStartupDeadline(new Promise(() => {}), {
    timeoutMs: 5,
    code: "ADMIN_LOGIN_TIMEOUT",
    message: "Admin login exceeded 5ms",
  }),
  { code: "ADMIN_LOGIN_TIMEOUT" },
);
```

- [ ] **Step 2: Write coordinator coverage for a never-settling login**

Inject a login Promise that never settles, a 5 ms login deadline, and zero-delay sleep. Assert the coordinator reaches the bounded retry/failure result rather than leaving `start()` pending indefinitely. Add a recovery-child timeout case that calls the injected child termination hook exactly once and returns `qr-timeout`.

- [ ] **Step 3: Run the tests and verify the old unbounded behavior**

Run: `node --test --test-force-exit --test-concurrency=1 tests/startup-deadline.test.js tests/admin-startup-recovery.test.js`

Expected: FAIL because no general startup deadline exists and the coordinator does not bound a pending login.

- [ ] **Step 4: Implement the deadline helper**

Use one timer with `unref()` where available, clear it in `finally`, preserve the original rejection when it wins, and emit a coded timeout error when the deadline wins. Do not mutate global `api` from a login Promise that resolves after its deadline; assign `api` only after the bounded local login result succeeds.

- [ ] **Step 5: Bound both startup boundaries**

Use `ADMIN_LOGIN_TIMEOUT_MS` default 30,000 ms per login attempt. Bound the spawned `qr-login-admin.js` child to 120,000 ms, terminate only that tracked child process tree on timeout, remove the matching recovery lock, and return `qr-timeout`. Keep the existing five retry schedule and authentication-error QR path.

- [ ] **Step 6: Persist current-run startup phase diagnostics**

Write the active PID and phase transitions `login`, `login-retry`, `qr-recovery`, `api-ready`, `listener-retrying`, and `ready` atomically to `mybot/state/admin.json`. On every new PM2 PID, replace stale startup PID/phase fields while retaining credential identity fields. Never infer current readiness from an older PID's `lastReadyAt`.

- [ ] **Step 7: Run focused startup tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/startup-deadline.test.js tests/admin-startup-recovery.test.js tests/qr-login-admin-recovery.test.js`

Expected: PASS; no never-settling test remains pending.

- [ ] **Step 8: Commit bounded startup**

```powershell
git add src/core/startup-deadline.js src/utils/admin-startup-recovery.js src/index.js tests/startup-deadline.test.js tests/admin-startup-recovery.test.js
git commit -m "fix(startup): bound admin login and QR recovery"
```

### Task 2: Make listener retry independent from the runtime bridge

**Files:**
- Create: `src/core/listener-startup.js`
- Modify: `src/index.js:1210-1226, 1285-1297, 1343-1363`
- Test: `tests/listener-startup.test.js`

**Interfaces:**
- Produces: `connectListenerWithRetry({ start, wait, retryDelayMs, signal, onAttemptFailed, onConnected }) -> Promise<{ attempts: number }>`.
- Consumes: synchronous or async `start()` and an abortable injected wait function.

- [ ] **Step 1: Write the failing retry regression test**

```js
test("listener retry succeeds without requesting runtime bridge shutdown", async () => {
  let attempts = 0;
  const states = [];
  const result = await connectListenerWithRetry({
    start: () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary websocket failure");
    },
    wait: async () => {},
    retryDelayMs: 1,
    onAttemptFailed: (event) => states.push(["failed", event.attempt]),
    onConnected: (event) => states.push(["connected", event.attempt]),
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(states, [["failed", 1], ["connected", 2]]);
});
```

- [ ] **Step 2: Add abort coverage**

```js
test("listener retry stops cleanly when runtime shutdown aborts it", async () => {
  const controller = new AbortController();
  await assert.rejects(
    connectListenerWithRetry({
      start: () => { controller.abort(); throw new Error("offline"); },
      wait: async () => {},
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});
```

- [ ] **Step 3: Run the test and verify the missing module failure**

Run: `node --test --test-force-exit --test-concurrency=1 tests/listener-startup.test.js`

Expected: FAIL because `src/core/listener-startup.js` does not exist.

- [ ] **Step 4: Implement the dependency-injected retry loop**

Implement `connectListenerWithRetry()` so it calls `start`, reports failures, waits, and retries until success or abort. It must not import or call `closeWebServer()`.

- [ ] **Step 5: Replace both local listener-start call paths**

In initial startup and credential reload, call `connectListenerWithRetry()` with `api.listener.start`, existing terminal/log callbacks, and one process-scoped `AbortController`. Remove `closeWebServer()` from the transient retry catch. Keep `closeWebServer()` in controlled shutdown and fatal bootstrap shutdown only.

- [ ] **Step 6: Run focused tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/listener-startup.test.js tests/listener-resilience.test.js tests/server-listener.test.js tests/runtime-bridge-isolation.test.js`

Expected: PASS; no transient listener test observes a bridge close.

- [ ] **Step 7: Commit the isolated listener lifecycle fix**

```powershell
git add src/core/listener-startup.js src/index.js tests/listener-startup.test.js
git commit -m "fix(runtime): keep bridge open while Zalo listener retries"
```

### Task 3: Add listener-aware readiness to bridge, dashboard, and terminal

**Files:**
- Create: `src/core/runtime-readiness-state.js`
- Modify: `src/index.js`
- Modify: `src/web-service/web-server.js:48-105`
- Modify: `src/dashboard/runtime-status-resolver.js:120-195`
- Modify: `src/runtime/terminal-monitor.js:121-145`
- Test: `tests/runtime-readiness-state.test.js`
- Test: `tests/dashboard/runtime-status-resolver.test.js`
- Test: `tests/runtime-pm2/terminal-readiness.test.js`

**Interfaces:**
- Produces: `setListenerReadiness(state, detail?)`, `getRuntimeReadiness()`, and test-only `resetRuntimeReadiness()`.
- Produces identity/health fields `listenerConnected: boolean`, `listenerState: "starting" | "connected" | "retrying" | "stopped"`, and `listenerLastError: string | null`.
- Consumes Task 2 retry callbacks.

- [ ] **Step 1: Write state transition tests**

```js
resetRuntimeReadiness();
setListenerReadiness("retrying", "temporary websocket failure");
assert.deepEqual(getRuntimeReadiness(), {
  listenerConnected: false,
  listenerState: "retrying",
  listenerLastError: "temporary websocket failure",
});
setListenerReadiness("connected");
assert.equal(getRuntimeReadiness().listenerConnected, true);
```

- [ ] **Step 2: Write resolver tests for open-port/disconnected-listener**

Add one case where PM2 is online, the port opens, identity matches, but `listenerConnected: false`; expect `status: "starting"` and reason `listener-disconnected`. Add the corresponding `listenerConnected: true` case expecting `running/ready`.

- [ ] **Step 3: Write terminal readiness parity tests**

Inject identity payloads with listener disconnected/connected and assert labels `listener-disconnected` and `ready`, respectively.

- [ ] **Step 4: Run the tests and verify they fail on the old contract**

Run: `node --test --test-force-exit --test-concurrency=1 tests/runtime-readiness-state.test.js tests/dashboard/runtime-status-resolver.test.js tests/runtime-pm2/terminal-readiness.test.js`

Expected: FAIL because listener readiness fields and the disconnected reason do not exist.

- [ ] **Step 5: Implement readiness state and wire retry callbacks**

Mark `starting` before the first listener attempt, `retrying` after each failure, `connected` after success, and `stopped` during controlled shutdown. Do not persist this ephemeral state to `mybots.json`.

- [ ] **Step 6: Include state in both internal endpoints**

Merge `getRuntimeReadiness()` into `/internal/runtime/identity` and `/internal/runtime/health`. Keep existing identity fields unchanged.

- [ ] **Step 7: Enforce the same readiness contract everywhere**

Dashboard resolver and terminal must require identity match plus `listenerConnected === true`. An older/missing field is `listener-unreported`, not ready; PM2 startup grace still controls `starting` versus `error` presentation.

- [ ] **Step 8: Run focused readiness tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/runtime-readiness-state.test.js tests/dashboard/runtime-status-resolver.test.js tests/runtime-pm2/terminal-readiness.test.js tests/runtime-bridge-isolation.test.js`

Expected: PASS.

- [ ] **Step 9: Commit readiness parity**

```powershell
git add src/core/runtime-readiness-state.js src/index.js src/web-service/web-server.js src/dashboard/runtime-status-resolver.js src/runtime/terminal-monitor.js tests/runtime-readiness-state.test.js tests/dashboard/runtime-status-resolver.test.js tests/runtime-pm2/terminal-readiness.test.js
git commit -m "fix(readiness): require a connected Zalo listener"
```

### Task 4: Separate durable desired state from observed runtime state

**Files:**
- Create: `src/commands/mybot/System/mybot-runtime-intent.js`
- Modify: `src/commands/mybot/System/mybot-auto-restore.js:4-22`
- Modify: `src/commands/mybot/System/pm2-manager.js:824-958, 990-1005`
- Modify: `src/commands/mybot/Check-time/start-period.js:89-156`
- Modify: `src/commands/mybot/myBotManager.js:1184-1226`
- Modify: `src/index.js:924-950`
- Test: `tests/runtime-pm2/desired-state.test.js`
- Test: `tests/runtime-pm2/pm2-restore-policy.test.js`

**Interfaces:**
- Produces: `getDesiredStatus(record) -> "running" | "stopped"` with legacy fallback.
- Produces: `withDesiredStatus(patch, desiredStatus)` and `runtimeExitPatch(now)`.
- Consumes existing atomic registry update functions and PM2 lifecycle adapters.

- [ ] **Step 1: Write legacy migration and exit-preservation tests**

```js
assert.equal(getDesiredStatus({ status: "running" }), "running");
assert.equal(getDesiredStatus({ status: "stopped" }), "stopped");

const before = { status: "running", desiredStatus: "running", expiryAt: "-1" };
const after = { ...before, ...runtimeExitPatch(1234) };
assert.equal(after.desiredStatus, "running");
assert.equal(after.runtimeStatus, "stopped");
assert.equal(after.status, "running");
```

- [ ] **Step 2: Write restore-policy regression coverage**

Add fixtures proving:

```js
"maintenance-stopped": { status: "running", desiredStatus: "running", runtimeStatus: "stopped", expiryAt: "-1" }
"manual-stopped": { status: "stopped", desiredStatus: "stopped", runtimeStatus: "stopped", expiryAt: "-1" }
```

Expect only `maintenance-stopped` to be restored. Existing disabled, expired, cookie-dead, pending, and main exclusions remain unchanged.

- [ ] **Step 3: Run tests and verify failure under status-only policy**

Run: `node --test --test-force-exit --test-concurrency=1 tests/runtime-pm2/desired-state.test.js tests/runtime-pm2/pm2-restore-policy.test.js tests/bot-auto-restore.test.js`

Expected: FAIL because `desiredStatus` is not modeled.

- [ ] **Step 4: Implement the pure intent helpers**

`getDesiredStatus()` accepts explicit `running/stopped`; otherwise it maps legacy `running/starting` to running and everything else to stopped. `runtimeExitPatch()` clears live PID fields and writes `runtimeStatus: "stopped"` plus timestamps without changing `status` or `desiredStatus`.

- [ ] **Step 5: Change auto-restore selection**

Use `getDesiredStatus(botInfo) === "running"` before the existing enabled, cookie, and expiry checks. Preserve deterministic sorting and the exclusion of `admin`.

- [ ] **Step 6: Wire lifecycle intent writes transactionally**

- Successful healthy `mybot start`: write `desiredStatus: "running"`, `runtimeStatus: "running"`, and legacy `status: "running"` together.
- Manual `mybot stop`: snapshot the prior record, set `desiredStatus: "stopped"` before PM2 stop, finalize runtime/legacy stopped on success, and restore the snapshot if the required stop fails.
- Restart: preserve `desiredStatus: "running"` and fail without converting it to stopped.
- Expiry/disable/delete: set desired stopped before terminating runtime.
- QR/bootstrap-only paths: explicitly retain desired stopped.

- [ ] **Step 7: Stop exit and periodic probes from overwriting intent**

The process exit handler and the once-per-minute PM2/port reconciliation update only `runtimeStatus`, PID, last-seen, and error diagnostics. They must not turn desired-running into stopped. The expiry branch may still set legacy `status: "expired"` and desired stopped because expiry is a policy decision, not an observation.

- [ ] **Step 8: Run lifecycle and restore tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/runtime-pm2/desired-state.test.js tests/runtime-pm2/pm2-restore-policy.test.js tests/bot-auto-restore.test.js tests/mybot-unified-lifecycle.test.js tests/mybot-canonical-runtime.test.js tests/mybot-activation-service.test.js`

Expected: PASS.

- [ ] **Step 9: Commit desired-state separation**

```powershell
git add src/commands/mybot/System/mybot-runtime-intent.js src/commands/mybot/System/mybot-auto-restore.js src/commands/mybot/System/pm2-manager.js src/commands/mybot/Check-time/start-period.js src/commands/mybot/myBotManager.js src/index.js tests/runtime-pm2/desired-state.test.js tests/runtime-pm2/pm2-restore-policy.test.js
git commit -m "fix(pm2): preserve child restore intent across maintenance stops"
```

### Task 5: Prove updater-to-run restore behavior without broadening updater authority

**Files:**
- Modify: `tests/runtime-pm2/fleet-stop.test.js`
- Modify: `tests/safe-update.test.js`
- Create: `tests/runtime-pm2/update-restore-intent.test.js`
- Modify: `DEPLOY-WINDOWS.md`

**Interfaces:**
- Consumes Task 4 `runtimeExitPatch()` and `getAutoRestoreCandidates()`.
- Produces an end-to-end test contract: maintenance stop preserves desired state; explicit reconcile restores the child later.

- [ ] **Step 1: Write the maintenance-stop integration test**

Create a temporary registry containing one permanent desired-running child and one permanent desired-stopped child. Apply the same exit patch a PM2 SIGTERM causes, run updater backup/restore through injected dependencies, then call `getAutoRestoreCandidates()`. Assert only the previously desired-running child is selected.

- [ ] **Step 2: Assert updater remains update-only**

Keep the existing `--skip-restart` test and add an assertion that updater success does not call reconcile/start. This prevents fixing restore intent by silently auto-starting production.

- [ ] **Step 3: Run updater/restore tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/runtime-pm2/update-restore-intent.test.js tests/runtime-pm2/fleet-stop.test.js tests/safe-update.test.js tests/run-bat-launch-order.test.js`

Expected: PASS; foreign PM2 processes remain untouched.

- [ ] **Step 4: Document exact operator behavior**

Document that `update.bat` stops and updates only; `run.bat` is explicit. State that `desiredStatus: "running"` restores eligible children, while lifetime expiry alone does not activate a manually stopped bot.

- [ ] **Step 5: Commit integration coverage and deployment contract**

```powershell
git add tests/runtime-pm2/update-restore-intent.test.js tests/runtime-pm2/fleet-stop.test.js tests/safe-update.test.js DEPLOY-WINDOWS.md
git commit -m "test(updater): cover desired child restore after PM2 stop"
```

### Task 6: Focused verification and VPS acceptance

**Files:**
- No source changes unless a test exposes a scoped regression.

**Interfaces:**
- Consumes all prior tasks.
- Produces separate source, automated-test, isolated-PM2, VPS-HTTP, and live-Zalo evidence.

- [ ] **Step 1: Run the focused suite under five minutes**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/startup-deadline.test.js tests/admin-startup-recovery.test.js tests/listener-startup.test.js tests/runtime-readiness-state.test.js tests/runtime-bridge-isolation.test.js tests/dashboard/runtime-status-resolver.test.js tests/runtime-pm2/terminal-readiness.test.js tests/runtime-pm2/desired-state.test.js tests/runtime-pm2/pm2-restore-policy.test.js tests/runtime-pm2/update-restore-intent.test.js tests/runtime-pm2/fleet-stop.test.js tests/safe-update.test.js
```

Expected: exit 0 with no skipped test relevant to listener retry, desired state, or update restore.

- [ ] **Step 2: Run syntax and PM2 descriptor checks**

```powershell
node --check src/index.js
node --check src/core/startup-deadline.js
node --check src/core/listener-startup.js
node --check src/core/runtime-readiness-state.js
node --check src/commands/mybot/System/mybot-runtime-intent.js
node --test --test-force-exit --test-concurrency=1 tests/runtime-pm2/pm2-integration.test.js tests/runtime-pm2/pm2-adapter.test.js
```

Expected: syntax passes; report isolated PM2 skips as incomplete rather than passing process proof.

- [ ] **Step 3: Deploy safely and confirm source identity**

After an explicitly requested non-force push, run `update.bat`, then run `run.bat` manually. Compare local `git rev-parse HEAD`, `origin/master`, and each PM2 process `MYBOT_CODE_COMMIT` marker before claiming deployment success.

- [ ] **Step 4: Capture correct PM2 logs and port evidence on VPS**

```powershell
node_modules\.bin\pm2.cmd describe admin
Get-Content "$env:USERPROFILE\.pm2\logs\admin-out.log" -Tail 160
Get-Content "$env:USERPROFILE\.pm2\logs\admin-error.log" -Tail 160
netstat -ano | findstr LISTENING | findstr ":2000"
Invoke-RestMethod http://127.0.0.1:2000/internal/runtime/identity | ConvertTo-Json -Depth 5
```

Expected: PM2 online; port 2000 owned by the described PID; identity is `kind=main`, `botKey=admin`, and `listenerConnected=true`. During a forced mock/transient listener failure, port remains open while listener readiness is false.

- [ ] **Step 5: Prove child restore intent across one update cycle**

Before update, record the target child's PM2 status, `desiredStatus`, `expiryAt`, and cookie state without exposing credentials. After `update.bat`, verify PM2 is stopped but `desiredStatus` remains running. After explicit `run.bat`, verify the same child is PM2 online, its configured port answers, and identity matches.

- [ ] **Step 6: Run a live Zalo acceptance separately**

Send one inbound command to Main and the restored child and verify each responds from the correct Zalo identity. PM2 online, an HTTP 200, or `api.sendMessage()` resolution alone is not live-Zalo proof.

- [ ] **Step 7: Report final evidence without conflating layers**

Report exact commit SHA, focused test command/result, isolated PM2 result, VPS process/port/identity result, child update/restore result, and live-Zalo result as separate entries.

## Self-review

- Spec coverage: bounded current-run startup, bridge lifetime, listener-aware readiness, durable desired state, legacy fallback, update-only semantics, child restore, and layered VPS/Zalo verification are each covered.
- Completeness scan: no unresolved markers or deferred implementation steps remain.
- Type consistency: `connectListenerWithRetry`, readiness fields, `getDesiredStatus`, and `runtimeExitPatch` are named consistently across producer and consumer tasks.
