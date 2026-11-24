# QR Login Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop chat-command and dashboard/API QR login sessions as soon as their QR deadline expires, without writing late credentials.

**Architecture:** Add a small shared expiry contract for the timeout value, abort reason, and explicit expired-response detection. Pass an abort signal and deadline through the command polling functions, and make `QrSessionManager` race each wait against the remaining deadline while guarding credential writes with the terminal state.

**Tech Stack:** Node.js ES modules, `node:test`, `AbortController`, existing `QrSessionManager` dependency injection.

## Global Constraints

- Keep existing success, cancellation, and public state behavior unchanged except for the explicit `expired` terminal state.
- Expired or cancelled sessions must never write credentials.
- Use the existing 120-second dashboard timeout as the default QR login timeout.
- Preserve the existing polling response shapes for callers that do not need expiry metadata.
- Run focused tests after each RED/GREEN cycle, then run the full `npm test` suite.

### Task 1: Shared Expiry Contract

**Files:**
- Create: `src/utils/qr-login-expiry.js`
- Create: `tests/qr-login-expiry.test.js`

**Interfaces:**
- Produces `QR_LOGIN_TIMEOUT_MS`, `QR_LOGIN_EXPIRY_REASON`, `isQrLoginExpiredResponse(payload)`, and `isQrLoginExpiredSignal(signal)` for the command and dashboard flows.

- [ ] **Step 1: Write the failing tests**

Add tests that assert the shared default is `120000`, an explicit response containing `QR code expired` is detected, an unrelated response is not detected, and an `AbortController` using `QR_LOGIN_EXPIRY_REASON` is recognized as expiry.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/qr-login-expiry.test.js`

Expected: FAIL because `src/utils/qr-login-expiry.js` does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement the constants and pure predicates. Normalize JSON/text input to lowercase, checking only expiry/timeout wording associated with QR rather than classifying every authentication error as QR expiry.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/qr-login-expiry.test.js`

Expected: PASS with all shared-contract assertions green.

### Task 2: Dashboard/API Session Deadline

**Files:**
- Modify: `src/dashboard/qr-session.js`
- Modify: `tests/qr-session.test.js`

**Interfaces:**
- Consumes the shared expiry contract from Task 1.
- `QrSessionManager` stores `controller` and `expiresAt` on private entries, passes `(signal, { expiresAt })` to wait dependencies, and exposes the existing public state fields.

- [ ] **Step 1: Write the failing tests**

Add a test with a `waitScan` promise that never resolves until released. Start a manager with a short `timeoutMs`, wait beyond the deadline, and assert the state is `expired`, the abort signal was triggered, and `writeCredential` was never called. Release the pending promise afterward and assert the state and write count remain unchanged.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/qr-session.test.js`

Expected: FAIL because the current manager waits forever and leaves the session in `waiting_scan`.

- [ ] **Step 3: Write the minimal implementation**

Create an `AbortController` per entry. Add a deadline race around `waitScan` and `waitConfirm` using the remaining milliseconds, abort and mark the entry `expired` from the timeout callback, and clear each timer in `finally`. Pass the signal/deadline into the wait dependencies. Make `cancel()` abort the controller, and guard the confirmation result and credential write against `cancelled`/`expired` states and an elapsed deadline.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test tests/qr-session.test.js tests/qr-login-expiry.test.js`

Expected: PASS for successful configuration, cancellation, late-result protection, and deadline expiry.

### Task 3: Chat Command QR Polling

**Files:**
- Modify: `src/commands/mybot/Credentials/qr-login.js`
- Modify: `src/commands/mybot/Manager/qr-login-command.js`
- Modify: `tests/qr-login-expiry.test.js`

**Interfaces:**
- `waitingScan(code, session, signal, { expiresAt, onExpired } = {})` keeps returning a boolean for compatibility and invokes `onExpired` when the deadline or explicit QR-expired response is observed.
- `waitingConfirm(code, session, { signal, prefix, onStatus, expiresAt, onExpired } = {})` keeps returning `[resultData, rawCookies, meta]` and adds `meta.expired` for expiry.

- [ ] **Step 1: Write the failing tests**

Extend the focused test with fake sessions whose polling response contains `QR code expired`, asserting `waitingScan` returns `false` and calls `onExpired`, and `waitingConfirm` returns null credentials with `{ expired: true }`. Add a deadline-past case that does not issue a network request.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/qr-login-expiry.test.js`

Expected: FAIL because the current polling functions do not accept deadline options or classify QR expiry.

- [ ] **Step 3: Write the minimal implementation**

Import the shared predicates. Check abort/deadline before each request, after each response, and before each five-second delay. Call `onExpired` for explicit QR expiry and return the existing failure shapes with expiry metadata. In `handleQrLogin`, create one controller and deadline for the generated QR, abort it on expiry, pass it into both waits, send an expiry-specific message, and clear the timer in the existing `finally`. Update `authenticateZalo` to report `expired` rather than `cancelled` when the shared expiry abort reason is used.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test tests/qr-login-expiry.test.js tests/qr-session.test.js`

Expected: PASS with command expiry detection, dashboard expiry, cancellation, and successful credential write behavior.

### Task 4: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: Exit code 0 with no failed tests.

- [ ] **Step 2: Run a syntax/import check for changed modules**

Run: `node --check src/dashboard/qr-session.js; node --check src/commands/mybot/Credentials/qr-login.js; node --check src/commands/mybot/Manager/qr-login-command.js; node --check src/utils/qr-login-expiry.js`

Expected: Exit code 0 for every changed JavaScript module.

- [ ] **Step 3: Review the final diff**

Run: `git diff -- src/dashboard/qr-session.js src/commands/mybot/Credentials/qr-login.js src/commands/mybot/Manager/qr-login-command.js src/utils/qr-login-expiry.js tests/qr-session.test.js tests/qr-login-expiry.test.js`

Expected: Review is unavailable because this workspace is not a Git repository; inspect the changed files directly and confirm no credential-writing path runs after expiry.
