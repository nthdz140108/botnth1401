# Dashboard Shared Backend Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared backend foundation for the deep Vietnamese bot management dashboard across standalone and admin web-server entry points.

**Architecture:** Add focused services under `src/dashboard/` and a single `registerDashboardApi(app, options)` route module. Mount that shared route module from both `dashboard/server.js` and `src/web-service/web-server.js`, while preserving existing legacy routes that are outside the dashboard contract.

**Tech Stack:** Node.js ES modules, Express, built-in `node:test`, filesystem JSON files, PM2 helper functions, existing dashboard service classes.

## Global Constraints

- Keep the response envelope `{ success, data, error?, requestId, restartRequired?, changedPaths?, backup? }` for all new canonical dashboard APIs.
- Credentials are masked except through `POST /api/bots/:id/credential/reveal`.
- Every write creates a backup, writes atomically, appends audit metadata, and returns `restartRequired: true`.
- Phase 1 is backend only; deep dashboard UI work starts in phase 2.
- Do not change unrelated bot core behavior.
- This workspace has no `.git` directory, so commit steps are skipped with a note instead of running `git commit`.

---

## File Structure

- Create `src/dashboard/api-response.js`: request ID middleware and success/error envelope helpers.
- Create `src/dashboard/audit-store.js`: append/read JSONL audit entries.
- Modify `src/dashboard/bot-registry.js`: discover bots from inventory, bot files, state files, PID, PM2, and port health.
- Modify `src/dashboard/config-store.js`: expose safe `readJson`, backup-aware atomic write, rollback result metadata.
- Create `src/dashboard/credential-service.js`: masked read, explicit reveal, validated update.
- Create `src/dashboard/command-service.js`: global commands and per-bot override operations.
- Create `src/dashboard/api-routes.js`: canonical dashboard route registration.
- Modify `dashboard/server.js`: mount shared API routes.
- Modify `src/web-service/web-server.js`: mount shared API routes and remove or bypass duplicate canonical handlers.
- Add `tests/dashboard/shared-api.test.js`: standalone contract tests against the shared route module.
- Add or extend `tests/dashboard/web-server.test.js`: parity assertions for admin web-server route behavior.

### Task 1: Response Envelope And Audit Store

**Files:**
- Create: `src/dashboard/api-response.js`
- Create: `src/dashboard/audit-store.js`
- Test: `tests/dashboard/shared-api.test.js`

**Interfaces:**
- Produces: `requestIdMiddleware(req, res, next)`.
- Produces: `sendSuccess(res, req, data, meta = {})`.
- Produces: `sendError(res, req, status, code, message, details = {})`.
- Produces: `class AuditStore { constructor({ root, file } = {}); append(entry); list({ limit } = {}) }`.

- [ ] **Step 1: Write failing tests for envelope and audit**

```js
test("shared dashboard API wraps success and errors with request IDs", async () => {
  const root = await makeDashboardFixture();
  const app = express();
  app.use(express.json());
  registerDashboardApi(app, { root, actions: fakeActions() });
  const server = await listen(app);
  try {
    const ok = await fetch(`${server.url}/api/bots`, { headers: { "X-Request-ID": "req-list" } }).then((res) => res.json());
    assert.equal(ok.success, true);
    assert.equal(ok.requestId, "req-list");
    assert.ok(Array.isArray(ok.data.bots));

    const missing = await fetch(`${server.url}/api/bots/missing/config/nope`, { headers: { "X-Request-ID": "req-missing" } });
    const body = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.requestId, "req-missing");
    assert.equal(body.error.code, "BOT_NOT_FOUND");
  } finally {
    await server.close();
  }
});

test("audit store appends dashboard write metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-audit-"));
  const audit = new AuditStore({ root });
  await audit.append({ requestId: "req-audit", action: "config.update", botId: "child", changedPaths: ["mybot/bots/child.json"] });
  const entries = await audit.list();
  assert.equal(entries[0].requestId, "req-audit");
  assert.equal(entries[0].action, "config.update");
  assert.equal(entries[0].actor, "dashboard-local");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/dashboard/shared-api.test.js`
Expected: FAIL because `api-response.js`, `audit-store.js`, and `api-routes.js` do not exist.

- [ ] **Step 3: Implement response and audit modules**

Implement `api-response.js` with generated fallback IDs and JSON helpers. Implement `audit-store.js` as JSONL under `logs/dashboard-audit.jsonl`, newest entries first when listed.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/dashboard/shared-api.test.js`
Expected: PASS for envelope and audit tests.

### Task 2: Bot Registry Discovery And Runtime

**Files:**
- Modify: `src/dashboard/bot-registry.js`
- Test: `tests/dashboard/shared-api.test.js`

**Interfaces:**
- Produces: `new BotRegistry({ root, pm2, portProbe }).list()`.
- Produces: `new BotRegistry({ root, pm2, portProbe }).describe(id)`.
- Produces: `new BotRegistry({ root, pm2, portProbe }).runtime(id)`.

- [ ] **Step 1: Write failing discovery/runtime tests**

```js
test("bot registry discovers inventory, bot files, state files, pid, pm2, and port health", async () => {
  const root = await makeDashboardFixture();
  await fs.writeFile(path.join(root, "mybot", "bots", "fileonly.json"), JSON.stringify({ displayName: "File Only", webPort: 3201 }));
  await fs.writeFile(path.join(root, "mybot", "state", "stateonly.json"), JSON.stringify({ pid: process.pid, webPort: 3202, status: "running" }));
  const registry = new BotRegistry({
    root,
    pm2: { status: async (id) => id === "pm2bot" ? { status: "online", pid: 1234 } : null },
    portProbe: async (port) => Number(port) === 3201,
  });
  const bots = await registry.list();
  const ids = bots.map((bot) => bot.id);
  assert.ok(ids.includes("admin"));
  assert.ok(ids.includes("child"));
  assert.ok(ids.includes("fileonly"));
  assert.ok(ids.includes("stateonly"));
  assert.equal(bots.find((bot) => bot.id === "fileonly").portOpen, true);
  assert.equal(bots.find((bot) => bot.id === "stateonly").processAlive, true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/dashboard/shared-api.test.js`
Expected: FAIL because state-file discovery and injectable PM2/port probes are missing.

- [ ] **Step 3: Implement registry expansion**

Use `fs.readdir` for `mybot/bots` and `mybot/state`, merge inventory/config/state, and normalize runtime state. Keep sensitive config redaction.

- [ ] **Step 4: Run tests**

Run: `node --test tests/dashboard/shared-api.test.js tests/dashboard/app-api.test.js`
Expected: PASS.

### Task 3: Config And Credential APIs

**Files:**
- Modify: `src/dashboard/config-store.js`
- Create: `src/dashboard/credential-service.js`
- Create/Modify: `src/dashboard/api-routes.js`
- Test: `tests/dashboard/shared-api.test.js`

**Interfaces:**
- Produces: `ConfigStore.writeJson(file, value, meta) -> { value, backup, changedPaths, restartRequired }`.
- Produces: `CredentialService.read(botId)`, `CredentialService.reveal(botId)`, `CredentialService.update(botId, patch)`.
- Consumes: `BotRegistry.describe(id)` and `AuditStore.append(entry)`.

- [ ] **Step 1: Write failing config and credential contract tests**

```js
test("config update writes backup, audit, changed paths, and rollback restores", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const update = await putJson(`${server.url}/api/bots/child/config/WEB_CONFIG_PATH`, { prefix: "#" }, "req-config");
    assert.equal(update.success, true);
    assert.equal(update.restartRequired, true);
    assert.equal(update.changedPaths.length, 1);
    assert.ok(update.backup.file);

    const saved = JSON.parse(await fs.readFile(path.join(root, "mybot", "web-config-child.json"), "utf8"));
    assert.equal(saved.prefix, "#");

    const rollback = await postJson(`${server.url}/api/bots/child/config/rollback`, { pathKey: "WEB_CONFIG_PATH", backup: update.backup.file }, "req-rollback");
    assert.equal(rollback.success, true);
    const restored = JSON.parse(await fs.readFile(path.join(root, "mybot", "web-config-child.json"), "utf8"));
    assert.equal(restored.prefix, "!");
  } finally {
    await server.close();
  }
});

test("credential read is masked, reveal is explicit, and update writes allowed credential fields", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const masked = await fetchJson(`${server.url}/api/bots/admin/credential`);
    assert.equal(masked.data.cookie, "[masked]");
    const revealed = await postJson(`${server.url}/api/bots/admin/credential/reveal`, {}, "req-reveal");
    assert.equal(revealed.data.cookie.token, "secret");
    const update = await putJson(`${server.url}/api/bots/admin/credential`, { imei: "imei-1", userAgent: "ua-1", active: true }, "req-cred");
    assert.equal(update.restartRequired, true);
    const saved = JSON.parse(await fs.readFile(path.join(root, "mybot", "bots", "admin-credential.json"), "utf8"));
    assert.equal(saved.imei, "imei-1");
    assert.equal(saved.userAgent, "ua-1");
    assert.equal(saved.active, true);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/dashboard/shared-api.test.js`
Expected: FAIL because APIs are incomplete.

- [ ] **Step 3: Implement config and credential services/routes**

Resolve `pathKey` through `bot.paths` or direct known bot config fields. Reject unresolved paths with `PATH_NOT_FOUND`. Mask `cookie`, `rawCookies`, `imei`, `userAgent`, token, password, and secret fields by default.

- [ ] **Step 4: Run tests**

Run: `node --test tests/dashboard/shared-api.test.js tests/dashboard/web-server.test.js`
Expected: PASS.

### Task 4: Command Service And APIs

**Files:**
- Modify: `src/dashboard/command-scanner.js`
- Create: `src/dashboard/command-service.js`
- Modify: `src/dashboard/api-routes.js`
- Test: `tests/dashboard/shared-api.test.js`
- Test: `tests/command-scanner.test.js`

**Interfaces:**
- Produces: `CommandService.list()`, `scan()`, `updateGlobal(name, patch)`, `createGlobal(command)`, `deleteGlobal(name)`.
- Produces: `CommandService.listForBot(botId)`, `updateOverride(botId, name, patch)`, `deleteOverride(botId, name)`, `copyFromAdmin(botId)`, `applyAll(patch)`.

- [ ] **Step 1: Write failing command API tests**

```js
test("command APIs update global commands and validate bad fields", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const update = await putJson(`${server.url}/api/commands/ping`, { alias: ["p"], permission: "all", countdown: 1 }, "req-command");
    assert.equal(update.success, true);
    assert.equal(update.restartRequired, true);

    const bad = await putRaw(`${server.url}/api/commands/ping`, { alias: [""], permission: "owner", countdown: -1 }, "req-bad");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.success, false);
    assert.equal(bad.body.error.code, "COMMAND_VALIDATION_FAILED");
  } finally {
    await server.close();
  }
});

test("per-bot command override can be saved, copied from admin, reset, and applied to all", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const override = await putJson(`${server.url}/api/bots/child/commands/ping`, { active: false, alias: ["pc"] }, "req-override");
    assert.equal(override.success, true);
    const botCommands = await fetchJson(`${server.url}/api/bots/child/commands`);
    assert.equal(botCommands.data.commands.find((cmd) => cmd.name === "ping").override.active, false);

    const reset = await fetch(`${server.url}/api/bots/child/commands/ping/override`, { method: "DELETE", headers: { "X-Request-ID": "req-reset" } }).then((res) => res.json());
    assert.equal(reset.success, true);

    const apply = await postJson(`${server.url}/api/commands/apply-all`, { commandName: "ping", patch: { active: true } }, "req-apply-all");
    assert.equal(apply.success, true);
    assert.ok(apply.data.botIds.includes("child"));
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/dashboard/shared-api.test.js tests/command-scanner.test.js`
Expected: FAIL because `CommandService` is missing.

- [ ] **Step 3: Implement command service/routes**

Store bot overrides at `mybot/command-overrides/<botId>.json`. Validate global and override payloads with shared validation rules: aliases must be non-empty strings, permissions must be one of `all`, `adminBot`, `adminBox`, `adminBotOrGroup`, countdown must be an integer `>= 0`, and duplicate aliases are rejected across effective command sets.

- [ ] **Step 4: Run tests**

Run: `node --test tests/dashboard/shared-api.test.js tests/command-scanner.test.js`
Expected: PASS.

### Task 5: Bot Action APIs And Shared Mounting

**Files:**
- Modify: `src/dashboard/api-routes.js`
- Modify: `dashboard/server.js`
- Modify: `src/web-service/web-server.js`
- Test: `tests/dashboard/shared-api.test.js`
- Test: `tests/dashboard/web-server.test.js`
- Test: `tests/dashboard/app-api.test.js`

**Interfaces:**
- Consumes: `registerDashboardApi(app, { root, actions, observabilityService })`.
- Produces: canonical action routes and bulk action route.

- [ ] **Step 1: Write failing action and parity tests**

```js
test("bot action APIs call injected runtime actions and audit the result", async () => {
  const root = await makeDashboardFixture();
  const calls = [];
  const server = await startSharedApi(root, {
    actions: {
      start: async (id) => { calls.push(["start", id]); return { status: "starting" }; },
      stop: async (id) => { calls.push(["stop", id]); return { status: "stopping" }; },
      restart: async (id) => { calls.push(["restart", id]); return { status: "restarting" }; },
      delete: async (id) => { calls.push(["delete", id]); return { status: "deleted" }; },
    },
  });
  try {
    const start = await postJson(`${server.url}/api/bots/child/actions/start`, {}, "req-start");
    assert.equal(start.success, true);
    const bulk = await postJson(`${server.url}/api/bots/actions/bulk`, { action: "restart", botIds: ["child"] }, "req-bulk");
    assert.equal(bulk.success, true);
    assert.deepEqual(calls, [["start", "child"], ["restart", "child"]]);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/dashboard/shared-api.test.js tests/dashboard/web-server.test.js`
Expected: FAIL until shared routes are mounted in both hosts.

- [ ] **Step 3: Mount shared routes**

Import `registerDashboardApi` in both server entry points. In standalone, pass no-op action handlers that return `ACTION_UNAVAILABLE` for unsafe runtime actions unless an action adapter is injected. In admin web-server, pass adapters around `startBotWithLauncher`, `stopPM2Process`, `restartPM2Process`, and existing delete behavior where available.

- [ ] **Step 4: Run baseline verification**

Run: `node --test tests/dashboard/app-api.test.js tests/dashboard/web-server.test.js tests/dashboard/navigation.test.js tests/dashboard/router.test.js tests/dashboard/shared-api.test.js tests/command-scanner.test.js`
Expected: PASS.

### Task 6: Completion Verification For Phase 1

**Files:**
- Modify only files needed to fix failures discovered by verification.

**Interfaces:**
- Consumes all phase 1 APIs.
- Produces verified backend foundation ready for phase 2 UI work.

- [ ] **Step 1: Run focused backend tests**

Run: `node --test tests/dashboard/shared-api.test.js tests/dashboard/web-server.test.js tests/dashboard/app-api.test.js tests/command-scanner.test.js`
Expected: PASS.

- [ ] **Step 2: Run baseline from the user request**

Run: `node --test tests/dashboard/app-api.test.js tests/dashboard/web-server.test.js tests/dashboard/navigation.test.js tests/dashboard/router.test.js`
Expected: PASS.

- [ ] **Step 3: Run full test suite if focused tests are green**

Run: `node --test tests`
Expected: PASS or document unrelated pre-existing failures with exact failing test names.

- [ ] **Step 4: Record phase 1 result**

Update this plan checkboxes for completed tasks and add a short note in the final response listing implemented APIs, test evidence, and any remaining phase 2 work.
