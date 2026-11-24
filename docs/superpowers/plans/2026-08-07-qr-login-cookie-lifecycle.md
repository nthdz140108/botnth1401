# QR Login Cookie Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cookie-based QR login lifecycle with bootstrap identity discovery, duplicate bot hot reload, admin UID protection, and startup cleanup for dead child cookies.

**Architecture:** Add small JSON state modules for atomic writes, identity handshakes, and reload requests. Refactor QR login to discover UID through a bootstrap process before registry reconciliation. Refactor runtime startup so `src/index.js` can run bootstrap-only and hot reload credentials in-process.

**Tech Stack:** Node.js ESM, `node --test`, filesystem JSON state, existing Zalo SDK wrapper, existing PM2/direct launcher helpers.

## Global Constraints

- Do not use QR session `getUserInfo(session)` to decide UID.
- Do not reject QR before confirmation solely because `requesterUid` already has a bot.
- Do not write bootstrap UID into `mybot/mybots.json`.
- Running duplicate child bots must stay alive while new credentials are validated.
- Hot reload may briefly drop websocket but should finish within 5 seconds.
- Admin QR recovery must preserve the current admin UID and reject UID mismatch.
- Child cookie-dead cleanup removes registry and descriptor only; credential, log, and state remain.
- Use atomic JSON writes for registry and credential/reload/handshake state.

---

## File Structure

- Create `src/commands/mybot/System/json-state.js`: atomic JSON helper functions.
- Create `src/commands/mybot/System/identity-handshake.js`: handshake path/schema helpers.
- Create `src/commands/mybot/System/reload-request.js`: reload request path/schema helpers.
- Modify `src/commands/mybot/System/mybots-registry.js`: use atomic JSON writes.
- Modify `src/commands/mybot/System/pm2-manager.js`: add launcher options, credential-only writes, reload request creation, handshake polling.
- Modify `src/commands/mybot/Manager/qr-login-command.js`: bootstrap identity and reconcile real UID.
- Modify `src/index.js`: bootstrap-only mode, bind listener helper, reload loop.
- Modify `bot.js`: cleanup cookie-dead child bots before spawn.
- Add tests under `tests/qr-login-cookie-lifecycle.test.js`.

## Task 1: Atomic State Helpers

**Files:**
- Create: `src/commands/mybot/System/json-state.js`
- Test: `tests/qr-login-cookie-lifecycle.test.js`

**Interfaces:**
- Produces: `readJsonFile(filePath, fallback = {})`, `writeJsonAtomic(filePath, data)`, `updateJsonAtomic(filePath, updater, fallback = {})`, `nowIso()`

- [ ] **Step 1: Write failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { readJsonFile, writeJsonAtomic, updateJsonAtomic } from "../src/commands/mybot/System/json-state.js";

test("writeJsonAtomic writes formatted JSON and removes temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qr-state-"));
  const file = path.join(dir, "state.json");
  writeJsonAtomic(file, { status: "ready", uid: "123" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { status: "ready", uid: "123" });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});

test("updateJsonAtomic updates existing JSON with fallback for missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qr-state-"));
  const file = path.join(dir, "state.json");
  const result = updateJsonAtomic(file, (current) => ({ count: current.count + 1 }), { count: 1 });
  assert.deepEqual(result, { count: 2 });
  assert.deepEqual(readJsonFile(file), { count: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: FAIL because `json-state.js` does not exist.

- [ ] **Step 3: Implement helper**

```js
import fs from "fs";
import path from "path";

export function nowIso() {
  return new Date().toISOString();
}

export function readJsonFile(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

export function updateJsonAtomic(filePath, updater, fallback = {}) {
  const next = updater(readJsonFile(filePath, fallback));
  writeJsonAtomic(filePath, next);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: PASS.

## Task 2: Handshake and Reload State Modules

**Files:**
- Create: `src/commands/mybot/System/identity-handshake.js`
- Create: `src/commands/mybot/System/reload-request.js`
- Modify: `tests/qr-login-cookie-lifecycle.test.js`

**Interfaces:**
- Consumes: `writeJsonAtomic`, `readJsonFile`, `nowIso`
- Produces: `getHandshakePath(sessionId)`, `writeIdentityHandshake(sessionId, patch)`, `readIdentityHandshake(sessionId)`, `getReloadRequestPath(uid)`, `writeReloadRequest(uid, request)`, `readReloadRequest(uid)`

- [ ] **Step 1: Write failing tests**

```js
import { writeIdentityHandshake, readIdentityHandshake } from "../src/commands/mybot/System/identity-handshake.js";
import { writeReloadRequest, readReloadRequest } from "../src/commands/mybot/System/reload-request.js";

test("identity handshake defaults status and timestamps", () => {
  const sessionId = `test-${Date.now()}`;
  const data = writeIdentityHandshake(sessionId, { status: "ready", uid: "777" });
  assert.equal(data.sessionId, sessionId);
  assert.equal(data.status, "ready");
  assert.equal(data.uid, "777");
  assert.match(data.updatedAt, /^\d{4}-/);
  assert.equal(readIdentityHandshake(sessionId).uid, "777");
});

test("reload request stores request metadata by uid", () => {
  const uid = `uid-${Date.now()}`;
  const data = writeReloadRequest(uid, { requestId: "r1", credentialPath: "assets/config.json" });
  assert.equal(data.uid, uid);
  assert.equal(data.status, "requested");
  assert.equal(readReloadRequest(uid).requestId, "r1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement modules**

Use project root `path.resolve(__dirname, "../../../..")`. Handshake files live in `mybot/state/qr-bootstrap`. Reload files live in `mybot/state/reload`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: PASS.

## Task 3: PM2 Manager Lifecycle Helpers

**Files:**
- Modify: `src/commands/mybot/System/pm2-manager.js`
- Modify: `tests/qr-login-cookie-lifecycle.test.js`

**Interfaces:**
- Consumes: handshake and reload modules.
- Produces: `startBotWithLauncher(uid, options = {})`, `writeCredentialOnly(uid, credentialsData)`, `requestCredentialReload(uid, request)`, `waitForIdentityHandshake(sessionId, timeoutMs)`

- [ ] **Step 1: Write failing tests**

```js
import { waitForIdentityHandshake, requestCredentialReload } from "../src/commands/mybot/System/pm2-manager.js";
import { writeIdentityHandshake } from "../src/commands/mybot/System/identity-handshake.js";

test("waitForIdentityHandshake resolves when handshake becomes ready", async () => {
  const sessionId = `wait-${Date.now()}`;
  setTimeout(() => writeIdentityHandshake(sessionId, { status: "ready", uid: "abc" }), 20);
  const result = await waitForIdentityHandshake(sessionId, 500);
  assert.equal(result.status, "ready");
  assert.equal(result.uid, "abc");
});

test("requestCredentialReload writes requested state", async () => {
  const uid = `reload-${Date.now()}`;
  const result = await requestCredentialReload(uid, { credentialPath: "mybot/credentials/x.json" });
  assert.equal(result.status, "requested");
  assert.equal(result.uid, uid);
  assert.ok(result.requestId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: FAIL because exports are missing.

- [ ] **Step 3: Implement minimal helper exports**

Extend `startBotWithLauncher` signature to accept env/config overrides while preserving existing callers. Implement polling with a 100ms interval and return timeout state on expiry.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: PASS.

## Task 4: Registry Atomic Write

**Files:**
- Modify: `src/commands/mybot/System/mybots-registry.js`
- Modify: `tests/qr-login-cookie-lifecycle.test.js`

**Interfaces:**
- Consumes: `writeJsonAtomic`
- Produces: unchanged public registry API.

- [ ] **Step 1: Write failing test**

```js
import { saveMyBotsRegistry, loadMyBotsRegistry } from "../src/commands/mybot/System/mybots-registry.js";

test("saveMyBotsRegistry writes atomically to a provided registry path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  const file = path.join(dir, "mybots.json");
  saveMyBotsRegistry({ admin: { status: "running" } }, file);
  assert.deepEqual(loadMyBotsRegistry(file), { admin: { status: "running" } });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});
```

- [ ] **Step 2: Run test**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: The test passes functionally before implementation but inspection shows direct writes; update anyway because requirement is implementation-level.

- [ ] **Step 3: Replace direct write with `writeJsonAtomic`**

Change internal `writeRegistry` to call `writeJsonAtomic(filePath, myBots)`.

- [ ] **Step 4: Run test**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: PASS.

## Task 5: Runtime Bootstrap and Hot Reload

**Files:**
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `QR_BOOTSTRAP_SESSION`, `QR_BOOTSTRAP_ONLY`, `readReloadRequest`, `writeReloadRequest`, `writeIdentityHandshake`
- Produces: `bindBotEventHandlers(apiInstance)`, `performCredentialReload(currentRuntime, request)`, bootstrap-only exit.

- [ ] **Step 1: Add tests if importable boundaries allow it**

If `src/index.js` top-level side effects make direct tests unsafe, keep this task manually verified by running a bootstrap process with a fake invalid config and checking handshake `auth_failed`.

- [ ] **Step 2: Refactor listener binding**

Move existing `api.listener.on("message"...)`, `group_event`, `undo`, `reaction`, and `typing` registrations into `bindBotEventHandlers(apiInstance)`.

- [ ] **Step 3: Add bootstrap branch after `Zalo.login()`**

When `QR_BOOTSTRAP_ONLY=true`, write `starting`, then on successful login write `ready`, then close websocket if opened and `process.exit(0)`. On auth failure write `auth_failed` and exit non-zero.

- [ ] **Step 4: Add reload polling**

Poll `mybot/state/reload/<botName>.json` every 500ms. On `requested`, mark `reloading`, login new credential, close old websocket, assign new API/session, bind handlers, health-check, and mark `ready`. On failure mark `failed`.

## Task 6: QR Command Reconciliation

**Files:**
- Modify: `src/commands/mybot/Manager/qr-login-command.js`

**Interfaces:**
- Consumes: PM2 manager helpers.
- Produces: QR flow that reconciles real bootstrap UID.

- [ ] **Step 1: Remove pre-confirm requester UID duplicate rejection**

Keep active-session guard and admin readiness guard. Remove `checkPM2Status(uidFrom)` and `checkExistingBot(uidFrom)` rejection before QR.

- [ ] **Step 2: Replace session `getUserInfo` identity**

After `waitingConfirm`, save temporary bootstrap credential/config and start launcher with bootstrap env.

- [ ] **Step 3: Reconcile identity**

Use handshake UID for admin duplicate, running child duplicate, stopped child duplicate, and new UID. Snapshot registry/credential before writes and rollback on failures.

## Task 7: Startup Cleanup

**Files:**
- Modify: `bot.js`

**Interfaces:**
- Consumes: existing state files and registry.
- Produces: child cookie-dead cleanup before spawn.

- [ ] **Step 1: Add helper**

Create `cleanupDeadChildBot(uid, botInfo, reason)` that deletes `mybot/mybots.json[uid]`, deletes `mybot/bots/<uid>.json`, keeps credentials/log/state, and writes dead-cookie notification.

- [ ] **Step 2: Call before spawn**

In `startChildBots`, before descriptor checks, read `mybot/state/<uid>.json`; if `cookieDead=true`, call cleanup and skip.

## Task 8: Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/qr-login-cookie-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 2: Run existing QR and process tests**

Run: `node --test tests/qr-session.test.js tests/qr-login-admin-readiness.test.js tests/process-guard.test.js tests/run-bat-launch-order.test.js`
Expected: PASS.

- [ ] **Step 3: Run full test suite if focused tests pass**

Run: `npm test`
Expected: PASS or report exact unrelated failures.
