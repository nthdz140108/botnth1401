# Admin Recovery PM2-Visible Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make admin QR recovery visible and scannable when the admin bot runs in background under PM2, without relying on a GUI process being created in the RDP desktop.

**Architecture:** `qr-login-admin.js` publishes an ephemeral QR manifest/image through a small filesystem channel. The authenticated dashboard renders that channel in an automatic modal, while a foreground CLI provides an RDP-terminal fallback; direct non-PM2 runs may still open a browser.

**Tech Stack:** Node.js 20 ESM, PM2 7.x, Windows Server 2012/RDP, Express, React 19/Vite, built-in `node:test`, filesystem JSON/PNG artifacts.

**Spec:** `docs/superpowers/specs/2026-08-31-admin-recovery-pm2-visible-channel-design.md`

## Global Constraints

- Do not modify runtime behavior while writing this plan; implementation begins only after explicit approval.
- Keep the Dashboard a control plane: no Zalo login, listener creation, recovery start, or import path to `src/index.js`.
- Keep `admin-recovery.lock` as the single owner of the recovery child PID.
- Never persist or expose cookie, IMEI, credentials, tokens, or scan results in the recovery artifact/API.
- Protect the QR API with existing dashboard authentication and `Cache-Control: no-store`.
- Preserve `.env.local`, `mybot/`, logs, credentials, and unrelated worktree changes.
- Keep focused automated tests under five minutes; report Windows/PM2/RDP and live-Zalo evidence separately.
- Do not use `pm2 kill`, global PM2 assumptions, force-push, `git add .`, reset, or clean.

---

### Task 1: Add an atomic admin-recovery artifact channel

**Files:**
- Create: `src/runtime/admin-recovery-channel.js`
- Test: `tests/admin-recovery-channel.test.js`

**Interfaces:**
- Produces: `createAdminRecoveryChannel({ projectRoot, now, randomId })`.
- Produces methods `publishQr({ imageBuffer, expiresAt, ownerPid })`, `transition(sessionId, state, detail?)`, `readActive()`, `readQr(sessionId)`, and `cleanup(sessionId, finalState)`.
- Returns only manifest fields defined by schema version 1; `readQr()` returns a copied `Buffer` or `null`.

- [ ] **Step 1: Write the failing publish/read test**

```js
const channel = createAdminRecoveryChannel({
  projectRoot: root,
  now: () => Date.parse("2026-08-31T00:00:00.000Z"),
  randomId: () => "session-a",
});
const published = await channel.publishQr({
  imageBuffer: Buffer.from("png-bytes"),
  expiresAt: "2026-08-31T00:01:30.000Z",
  ownerPid: 1234,
});
assert.equal(published.sessionId, "session-a");
assert.equal(published.state, "waiting_scan");
assert.deepEqual(await channel.readQr("session-a"), Buffer.from("png-bytes"));
```

- [ ] **Step 2: Add security and lifecycle tests**

Test that `readQr("../outside")` returns null, a replaced session deletes the prior image, an expired manifest is inactive, cleanup is idempotent, and serialized JSON contains none of `cookie`, `imei`, `token`, `credentials`, or `resultData`.

- [ ] **Step 3: Run tests and verify the missing module failure**

Run: `node --test --test-force-exit --test-concurrency=1 tests/admin-recovery-channel.test.js`

Expected: FAIL because `src/runtime/admin-recovery-channel.js` does not exist.

- [ ] **Step 4: Implement atomic persistence**

Write PNG and manifest to session-scoped temporary files, rename them atomically, validate `sessionId` as an opaque generated value, resolve `qrFile` under the channel root, and remove stale session directories only after the new manifest is durable.

- [ ] **Step 5: Implement terminal transitions and cleanup**

Allow only the documented state transitions. `success`, `failed`, `cancelled`, and `expired` remove the PNG and clear `active.json` only when its `sessionId` still owns the active record, so an old callback cannot delete a replacement session.

- [ ] **Step 6: Run focused channel tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/admin-recovery-channel.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the channel**

```powershell
git add src/runtime/admin-recovery-channel.js tests/admin-recovery-channel.test.js
git commit -m "feat(recovery): add atomic admin QR channel"
```

### Task 2: Publish recovery QR and avoid GUI assumptions under PM2

**Files:**
- Modify: `qr-login-admin.js:220-302, 303-400`
- Modify: `src/index.js:628-711`
- Modify: `src/platform/index.js:76-95`
- Test: `tests/qr-login-admin-recovery.test.js`

**Interfaces:**
- Consumes Task 1 channel methods.
- Produces: `isInteractiveRecoveryLaunch({ env, stdout, platform }) -> boolean`.
- Produces: `presentAdminRecoveryQr({ filePath, base64Image, channel, managed, openWindow }) -> { sessionId, presentation }`.

- [ ] **Step 1: Write the PM2 presentation regression test**

```js
const calls = [];
const result = await presentAdminRecoveryQr({
  filePath: qrPath,
  base64Image,
  managed: true,
  channel: { publishQr: async () => ({ sessionId: "session-a" }) },
  openWindow: async () => { calls.push("open"); },
});
assert.equal(result.sessionId, "session-a");
assert.equal(result.presentation, "channel");
assert.deepEqual(calls, []);
```

- [ ] **Step 2: Preserve direct interactive behavior**

Add a test with `managed: false` and TTY stdout that publishes first and then calls `openWindow` once. A popup failure must leave the channel active and must not fail the authentication session.

- [ ] **Step 3: Run the QR recovery test and verify failure**

Run: `node --test --test-force-exit --test-concurrency=1 tests/qr-login-admin-recovery.test.js`

Expected: FAIL because managed presentation is not separated from `openManagedQrWindow()`.

- [ ] **Step 4: Publish before any optional UI attempt**

Decode/copy the generated QR image into the channel in `onQrReady`, record the returned session ID, print one log line containing only session ID, expiry, dashboard URL, and CLI command, then attempt a GUI only when `BOT_MANAGED !== "true"` and the process is interactive.

- [ ] **Step 5: Wire state transitions to authentication events**

Move the channel to `waiting_confirm` after scan, and call cleanup with `success`, `failed`, `cancelled`, or `expired` from the exact owning session's terminal path. Keep the existing recovery lock and UID-mismatch checks unchanged.

- [ ] **Step 6: Correct default-app visibility semantics**

Add an explicit `windowsHide` option to `openPathInDefaultApp()` defaulting to the existing safe hidden behavior. The foreground CLI/direct recovery passes `false`; PM2 code never calls it. Do not infer interactivity from `windowsHide:false` alone.

- [ ] **Step 7: Run QR and coordinator tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/qr-login-admin-recovery.test.js tests/qr-login-admin-readiness.test.js`

Expected: PASS; import isolation still produces no second `BOT LISTENER`.

- [ ] **Step 8: Commit producer integration**

```powershell
git add qr-login-admin.js src/index.js src/platform/index.js tests/qr-login-admin-recovery.test.js
git commit -m "fix(recovery): publish QR when admin runs under PM2"
```

### Task 3: Expose the active QR through authenticated dashboard API

**Files:**
- Create: `src/dashboard/admin-recovery-service.js`
- Modify: `src/dashboard/api-routes.js:50-80, 240-280`
- Modify: `dashboard/server.js:60-75, 400-410`
- Test: `tests/dashboard/admin-recovery-api.test.js`

**Interfaces:**
- Consumes Task 1 channel `readActive()` and `readQr(sessionId)`.
- Produces: `createAdminRecoveryService({ projectRoot, channel })` with `getStatus()`.
- Produces authenticated `GET /api/system/admin-recovery` response `{ state, sessionId, createdAt, expiresAt, qrImage }`.

- [ ] **Step 1: Write API authentication and response tests**

Test unauthenticated status 401, idle authenticated response without `qrImage`, active response with `data:image/png;base64,`, and headers `Cache-Control: no-store` plus `Referrer-Policy: no-referrer`.

- [ ] **Step 2: Add stale and path-security tests**

An expired manifest returns `state: "expired"` without image. A manifest whose path escapes the recovery root returns a sanitized failed state and never reads the outside file.

- [ ] **Step 3: Run the API test and verify route absence**

Run: `node --test --test-force-exit --test-concurrency=1 tests/dashboard/admin-recovery-api.test.js`

Expected: FAIL with 404 or missing service.

- [ ] **Step 4: Implement the read-only service and route**

Construct the channel/service in `dashboard/server.js` and inject it into `registerDashboardApi`. The service never imports QR authentication, bot bootstrap, command handlers, or `src/index.js`; it reads only the artifact contract.

- [ ] **Step 5: Run API and import-isolation checks**

Run: `node --test --test-force-exit --test-concurrency=1 tests/dashboard/admin-recovery-api.test.js tests/dashboard/shared-api.test.js tests/dashboard/web-server.test.js`

Run: `npm run audit:imports`

Expected: focused tests PASS. Import audit must add zero new dashboard-to-runtime paths; report any pre-existing baseline separately.

- [ ] **Step 6: Commit the dashboard API**

```powershell
git add src/dashboard/admin-recovery-service.js src/dashboard/api-routes.js dashboard/server.js tests/dashboard/admin-recovery-api.test.js
git commit -m "feat(dashboard): expose authenticated admin recovery QR"
```

### Task 4: Auto-open a secure dashboard recovery modal

**Files:**
- Create: `dashboard/src/components/admin-recovery-modal.jsx`
- Create: `dashboard/src/components/admin-recovery-client.js`
- Modify: `dashboard/src/main.jsx:60-110, 220-270`
- Modify: `dashboard/src/styles.css`
- Test: `tests/dashboard/admin-recovery-client.test.js`
- Test: `tests/dashboard/admin-recovery-ui.test.js`

**Interfaces:**
- Consumes Task 3 GET endpoint through existing authenticated `apiRequest`.
- Produces: `createAdminRecoveryPoller({ request, intervalMs, onChange })` with `start()` and `stop()`.
- Produces modal props `{ recovery, onDismiss }` keyed by `sessionId`.

- [ ] **Step 1: Write poller state tests**

Test idle-to-active detection, no duplicate notification for the same session ID, notification for a replacement ID, two-second scheduling, and timer cleanup at logout/unmount.

- [ ] **Step 2: Write modal rendering tests**

Assert that active recovery renders QR, Bangkok-local expiry/countdown, warning text, dashboard-only security copy, and accessible dialog semantics. Terminal states remove the QR and close the modal.

- [ ] **Step 3: Run tests and verify missing modules**

Run: `node --test --test-force-exit --test-concurrency=1 tests/dashboard/admin-recovery-client.test.js tests/dashboard/admin-recovery-ui.test.js`

Expected: FAIL because the poller and modal do not exist.

- [ ] **Step 4: Implement authenticated polling and session deduplication**

Start only after dashboard authentication, poll every 2,000 ms, stop on logout/unmount, and retain the last dismissed session ID in component memory only. A new session ID always reopens the modal.

- [ ] **Step 5: Implement the modal without persisting the QR**

Render the API data URL directly, never place it in localStorage/sessionStorage, disable browser caching through the API, and show explicit states for waiting scan, waiting confirm, expired, failed, and success.

- [ ] **Step 6: Run UI tests and build**

Run: `node --test --test-force-exit --test-concurrency=1 tests/dashboard/admin-recovery-client.test.js tests/dashboard/admin-recovery-ui.test.js tests/dashboard/browser-smoke.test.js`

Run: `npm run dashboard:build`

Expected: tests and build PASS within the five-minute cap.

- [ ] **Step 7: Commit the dashboard modal**

```powershell
git add dashboard/src/components/admin-recovery-modal.jsx dashboard/src/components/admin-recovery-client.js dashboard/src/main.jsx dashboard/src/styles.css tests/dashboard/admin-recovery-client.test.js tests/dashboard/admin-recovery-ui.test.js dashboard/dist
git commit -m "feat(dashboard): show admin recovery QR modal"
```

### Task 5: Add an interactive RDP terminal fallback

**Files:**
- Create: `scripts/show-admin-recovery-qr.js`
- Modify: `package.json`
- Modify: `DEPLOY-WINDOWS.md`
- Test: `tests/show-admin-recovery-qr.test.js`

**Interfaces:**
- Consumes Task 1 channel reads.
- Produces command `npm run admin:recovery:show` and optional `--open` flag.

- [ ] **Step 1: Write CLI tests**

With injected stdout/open function, assert idle exit code 2 with a clear message, active session prints decodable ASCII QR and expiry, `--open` invokes the default app exactly once, and expired/missing PNG never opens anything.

- [ ] **Step 2: Run the CLI test and verify missing script**

Run: `node --test --test-force-exit --test-concurrency=1 tests/show-admin-recovery-qr.test.js`

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement foreground-only display**

Read the active channel, decode the PNG with existing Sharp/jsQR/QRCode dependencies, print ASCII, and use `openPathInDefaultApp(..., { windowsHide: false })` only when `--open` is passed by the interactive operator.

- [ ] **Step 4: Document VPS recovery commands**

Document dashboard URL, `npm run admin:recovery:show`, `npm run admin:recovery:show -- --open`, correct PM2 log paths under `$env:USERPROFILE\.pm2\logs`, and the rule that `pm2 restart admin` does not itself display a GUI.

- [ ] **Step 5: Run CLI and existing QR tests**

Run: `node --test --test-force-exit --test-concurrency=1 tests/show-admin-recovery-qr.test.js tests/qr-login-admin-recovery.test.js`

Expected: PASS.

- [ ] **Step 6: Commit fallback and documentation**

```powershell
git add scripts/show-admin-recovery-qr.js package.json DEPLOY-WINDOWS.md tests/show-admin-recovery-qr.test.js
git commit -m "feat(recovery): add interactive admin QR viewer"
```

### Task 6: Focused verification and Windows VPS acceptance

**Files:**
- No source changes unless a focused test exposes a scoped regression.

**Interfaces:**
- Consumes all prior tasks.
- Produces separate source/test, PM2/background, dashboard/browser, and live-Zalo evidence.

- [ ] **Step 1: Run the complete focused suite**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/admin-recovery-channel.test.js tests/qr-login-admin-recovery.test.js tests/qr-login-admin-readiness.test.js tests/dashboard/admin-recovery-api.test.js tests/dashboard/admin-recovery-client.test.js tests/dashboard/admin-recovery-ui.test.js tests/show-admin-recovery-qr.test.js
```

Expected: exit 0 within five minutes, with no relevant skips.

- [ ] **Step 2: Run syntax, build, and import checks**

```powershell
node --check qr-login-admin.js
node --check src/runtime/admin-recovery-channel.js
node --check src/dashboard/admin-recovery-service.js
node --check scripts/show-admin-recovery-qr.js
npm run dashboard:build
npm run audit:imports
```

Expected: syntax/build PASS and zero new forbidden dashboard runtime imports.

- [ ] **Step 3: Smoke the channel without real credentials**

Using a temporary project root and synthetic QR image, start the dashboard in test configuration, publish a recovery session, authenticate, verify the endpoint/modal, run the CLI, expire the session, and prove the image is no longer available. Do not use production `mybot/` or credentials for this smoke.

- [ ] **Step 4: Verify the real PM2/RDP boundary on VPS**

Run admin under the repo-local PM2 shim with `BOT_MANAGED=true`, trigger one controlled recovery, and verify no GUI launch is required. Open the authenticated dashboard from RDP and confirm the modal appears within three seconds; separately verify the foreground CLI displays the same session ID/QR.

- [ ] **Step 5: Complete one live Zalo recovery**

Scan the displayed QR, confirm the artifact is cleaned, `admin-recovery.lock` is removed, PM2 contains one online `admin`, port 2000 answers the correct identity, and one inbound Zalo command receives a response from Main. Report HTTP/PM2 and live-Zalo evidence separately.

- [ ] **Step 6: Push only after explicit approval**

Stage named source/test/docs/dist files only, commit normally, push non-force to `origin/master`, fetch, and compare local HEAD with `origin/master`. Do not claim VPS deployment merely from the push.

## Self-review

- Coverage: PM2 invisibility, secure artifact publication, dashboard modal, interactive fallback, cleanup, import isolation, and VPS/live acceptance each have an implementation and test task.
- Completeness: no unresolved markers or deferred implementation steps remain.
- Interface consistency: channel methods and manifest fields match across producer, API, UI, CLI, and acceptance tasks.

