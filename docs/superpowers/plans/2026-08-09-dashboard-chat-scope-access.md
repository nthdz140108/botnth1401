# Dashboard Chat Scope & Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared command-scope policy resolution, per-bot chat access controls, runtime enforcement, dashboard controls, and regression coverage.

**Architecture:** Keep policy resolution pure in `src/commands/command-policy.js`; dashboard services own persistence and normalized API views; runtime loads global and bot-specific policy into command dispatch and the message gate. The React dashboard consumes the existing API envelope and renders a reusable `ChatPolicyPanel` in both a dedicated workspace and each bot workspace.

**Tech Stack:** Node.js ESM, `node:test`, Express, React 19, Vite, existing `ConfigStore`, `AuditStore`, and `BotRegistry`.

## Global Constraints

- Command scope values are exactly `group`, `private`, and `both`; missing scope defaults to `both`.
- Scope precedence is exactly bot override, then global command scope, then `both`.
- Chat access is per bot and has independent boolean fields `groupEnabled` and `privateEnabled`, defaulting to `true` when absent.
- Preserve command name, aliases, permission, cooldown/countdown, active state, and unrelated fields when changing scope.
- Chat-access writes must merge existing web-config keys, create a backup, append an audit entry, and return `restartRequired`.
- Global admins bypass disabled chat access; bot/group admins bypass disabled group chat access; command scope checks still apply after bypass.
- Do not add group- or user-specific command/chat policy.
- The current workspace has no `.git` directory, so use test/build checkpoints instead of attempting commits.

---

### Task 1: Shared Command Policy Resolver

**Files:**
- Create: `src/commands/command-policy.js`
- Test: `tests/command-policy.test.js`

**Interfaces:**
- Produces `DEFAULT_SCOPE`, `VALID_SCOPES`, `normalizeScope(value)`, `resolveCommandPolicy({ command, override })`, and `scopeAllows(scope, chatScope)`.
- `resolveCommandPolicy` returns the original command fields plus `scope`, `effectiveScope`, and `override`; it never mutates inputs.

- [ ] **Step 1: Write the failing tests**

```js
test("missing scope resolves to both", () => {
  assert.equal(resolveCommandPolicy({ command: { name: "ping" } }).effectiveScope, "both");
});

test("global scope is used when present", () => {
  const result = resolveCommandPolicy({ command: { name: "ping", scope: "group" } });
  assert.equal(result.scope, "group");
  assert.equal(result.effectiveScope, "group");
});

test("bot override wins over global scope", () => {
  const result = resolveCommandPolicy({
    command: { name: "ping", scope: "group" },
    override: { scope: "private" },
  });
  assert.equal(result.effectiveScope, "private");
  assert.deepEqual(result.override, { scope: "private" });
});

test("scope matching accepts both and rejects the other scope", () => {
  assert.equal(scopeAllows("both", "group"), true);
  assert.equal(scopeAllows("both", "private"), true);
  assert.equal(scopeAllows("group", "private"), false);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/command-policy.test.js`

Expected: FAIL because `src/commands/command-policy.js` does not exist.

- [ ] **Step 3: Implement the minimal pure resolver**

Use a frozen set of valid values. Treat only valid string scopes as configured; invalid values must be rejected by callers that validate persisted data, while resolver fallback remains `both` for missing values. Return a shallow copy of the command and a shallow copy of the override when present.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test tests/command-policy.test.js`

Expected: PASS with all resolver cases green.

---

### Task 2: Router Scope Enforcement

**Files:**
- Modify: `src/commands/command-router.js`
- Test: `tests/command-router.test.js`

**Interfaces:**
- `executeCommand(context, definition)` reads `context.scope` and optional `context.scopeOverride`.
- `createCommandDefinition` validates `scope` using the shared resolver rules.

- [ ] **Step 1: Add failing router tests**

```js
test("allows group, private, and both command scopes", async () => {
  for (const [scope, chatScope] of [["group", "group"], ["private", "private"], ["both", "group"], ["both", "private"]]) {
    const result = await executeCommand({ scope: chatScope }, definition(`demo-${scope}`, [], async () => scope, { scope }));
    assert.equal(result.code, "HANDLED");
  }
});

test("scopeOverride replaces the definition scope", async () => {
  let calls = 0;
  const result = await executeCommand({ scope: "private", scopeOverride: "private" }, definition("demo", [], async () => { calls += 1; }, { scope: "group" }));
  assert.equal(result.code, "HANDLED");
  assert.equal(calls, 1);
});

test("does not call a handler when the effective scope is denied", async () => {
  let calls = 0;
  const result = await executeCommand({ scope: "private", scopeOverride: "group" }, definition("demo", [], async () => { calls += 1; }, { scope: "both" }));
  assert.equal(result.code, "SCOPE_DENIED");
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run the focused router test and verify the new cases fail**

Run: `node --test tests/command-router.test.js`

Expected: the new scope cases fail while unrelated router tests retain their existing behavior.

- [ ] **Step 3: Implement minimal scope resolution before dependencies/handler invocation**

Resolve `scopeOverride` over the definition scope, default missing scope to `both`, return the existing `SCOPE_DENIED` result shape, and leave permission, active, dependency, argument, timeout, and error ordering unchanged except that scope must be checked before invoking the handler.

- [ ] **Step 4: Run router tests**

Run: `node --test tests/command-router.test.js`

Expected: PASS.

---

### Task 3: Dashboard Command Validation and Normalized Views

**Files:**
- Modify: `src/dashboard/command-scanner.js`
- Modify: `src/dashboard/command-service.js`
- Modify: `tests/command-scanner.test.js`
- Modify: `tests/command-service.test.js`

**Interfaces:**
- Global scan output exposes normalized `scope` and `effectiveScope` for every command.
- Bot command output exposes `override` and `effectiveScope`; an absent override is `null`.
- `updateGlobal` and `updateOverride` reject invalid scope values with the existing `COMMAND_VALIDATION_FAILED` contract.

- [ ] **Step 1: Write failing service/scanner tests**

Add cases asserting that a command without scope is reported as `effectiveScope: "both"`, a global `scope: "group"` is preserved, a bot override reports `override.scope` and effective private scope, reset restores the global scope, and invalid `scope: "direct"` is rejected by both global and override updates.

- [ ] **Step 2: Run focused tests and verify the new cases fail**

Run: `node --test tests/command-service.test.js tests/command-scanner.test.js`

Expected: FAIL on missing normalized fields and invalid-scope validation.

- [ ] **Step 3: Implement validation and normalized output**

Use `resolveCommandPolicy` in scanner diagnostics, service validation, `list`, and `listForBot`. Keep persisted global commands and override JSON free of unrelated synthetic fields. Ensure `deleteOverride` removes the canonical command override entry and leaves other command overrides untouched.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/command-service.test.js tests/command-scanner.test.js`

Expected: PASS.

---

### Task 4: Runtime Policy Loading and Legacy Command Integration

**Files:**
- Modify: `src/commands/command-registry.js`
- Modify: `src/commands/command.js`
- Modify: `src/index.js` or the existing runtime command-config loader selected by the current call graph
- Test: `tests/command-runtime-scope.test.js`

**Interfaces:**
- Runtime command dispatch receives the current bot's global command config and override scope without changing handler signatures.
- Both `handleCommand()` and `handleCommandPrivate()` return/forward `SCOPE_DENIED` consistently for command-router and legacy branches.

- [ ] **Step 1: Write failing runtime tests**

Cover a new registered command and a legacy command with group-only, private-only, and both scopes. Assert the handler/switch branch runs only in its allowed scope and that a per-bot override changes the result without changing aliases, permission, active, or countdown metadata.

- [ ] **Step 2: Run the runtime scope test and verify it fails**

Run: `node --test tests/command-runtime-scope.test.js`

Expected: at least one command executes in a denied scope because the legacy branch and/or loader does not yet apply the override.

- [ ] **Step 3: Load policy at the runtime boundary**

Identify the bot runtime root using the existing runtime context, read global command configuration and `mybot/command-overrides/<botId>.json`, and pass only the matching command override scope to `dispatchCommand`/`executeCommand`. Avoid changing command definitions globally in a way that leaks one bot's override into another bot process.

- [ ] **Step 4: Gate legacy group/private branches before switch execution**

Resolve command metadata, compute effective scope, and return/send the existing scope-denied result before the corresponding legacy `switch` branch. Preserve existing permission, cooldown, active-state, and command-type behavior.

- [ ] **Step 5: Run runtime regression tests**

Run: `node --test tests/command-runtime-scope.test.js tests/command-router.test.js`

Expected: PASS.

---

### Task 5: Per-Bot Chat Policy Service and API

**Files:**
- Create: `src/dashboard/chat-policy-service.js`
- Modify: `src/dashboard/api-routes.js`
- Test: `tests/chat-policy-service.test.js`
- Test: `tests/dashboard-chat-policy.test.js`

**Interfaces:**
- `ChatPolicyService.read(botId)` returns `{ botId, groupEnabled, privateEnabled, path }` with missing flags defaulted to `true`.
- `ChatPolicyService.update(botId, patch)` returns the merged policy plus `backup`, `changedPaths`, and `restartRequired` from `ConfigStore`.
- API routes are `GET /api/bots/:id/chat-policy` and `PUT /api/bots/:id/chat-policy`.

- [ ] **Step 1: Write failing service/API tests**

Use temporary bot/config roots and injected `BotRegistry`, `ConfigStore`, and `AuditStore` doubles. Test bot-not-found, default enabled values, boolean validation, preservation of an unrelated web-config key, backup creation, audit action, and `restartRequired`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/chat-policy-service.test.js tests/dashboard-chat-policy.test.js`

Expected: FAIL because the service and routes are absent.

- [ ] **Step 3: Implement the service**

Resolve the bot before reading files. Support the existing bot path metadata and configured `WEB_CONFIG_PATH`; if no path exists, use the project web-config default used by runtime. Default both booleans to true, validate only supplied keys, merge the patch with the full JSON object, and write with `ConfigStore`.

- [ ] **Step 4: Register API routes and audit updates**

Use existing `wrap`, `sendSuccess`, `sendError`, request ID middleware, and `auditStore.append`. Return `BOT_NOT_FOUND` and `CHAT_POLICY_VALIDATION_FAILED` with status 404/400 respectively.

- [ ] **Step 5: Run focused API tests**

Run: `node --test tests/chat-policy-service.test.js tests/dashboard-chat-policy.test.js`

Expected: PASS, including backup and audit assertions.

---

### Task 6: Message Access Gate and Administrator Bypass

**Files:**
- Modify: `src/automations/event-send-msg.js`
- Test: `tests/message-chat-policy.test.js`

**Interfaces:**
- Message pipeline uses `readWebConfig()` for the current bot and preserves existing message type handling.
- Ordinary members are blocked for disabled private/group scopes; global admins bypass both; bot/group admins bypass disabled group scope.

- [ ] **Step 1: Write failing gate tests**

Test disabled private access blocks an ordinary direct message, disabled group access blocks an ordinary group member, global admin bypasses both, and group bot/group admin bypasses the group gate. Assert that command scope still denies a bypassed admin when the command is configured for the other scope.

- [ ] **Step 2: Run the gate tests and verify they fail**

Run: `node --test tests/message-chat-policy.test.js`

Expected: the current early gate blocks administrators or the test cannot observe the required branch behavior.

- [ ] **Step 3: Move group authorization before the group gate**

Keep private authorization after global-admin detection. For groups, fetch group info/admins and calculate `isAdminBot`/`isAdminBox` before applying `groupEnabled`. Return only for ordinary members when disabled. Do not bypass command scope checks.

- [ ] **Step 4: Run gate and runtime tests**

Run: `node --test tests/message-chat-policy.test.js tests/command-runtime-scope.test.js`

Expected: PASS.

---

### Task 7: Shared Dashboard Chat Policy UI and Navigation

**Files:**
- Create: `dashboard/src/components/chat-policy-panel.jsx`
- Create: `dashboard/src/components/chat-access-workspace.jsx`
- Modify: `dashboard/src/main.jsx`
- Modify: `dashboard/src/app/navigation.js`
- Modify: `dashboard/src/app/router.js`
- Modify: `dashboard/src/components/bot-workspace.jsx`
- Modify: `dashboard/src/styles.css`
- Test: `tests/dashboard-chat-policy-ui.test.cjs`
- Modify: `tests/dashboard-router.test.cjs`

**Interfaces:**
- `ChatPolicyPanel({ botId, compact = false, onSaved })` loads `GET`, renders two independent controlled toggles, saves `PUT`, and displays loading/error/saved/restart-required states.
- `ChatAccessWorkspace({ bots })` owns bot selection and renders the shared panel.

- [ ] **Step 1: Write failing UI/route tests**

Assert that navigation contains `chat-access`, the route resolves to the new workspace, the panel calls GET on bot selection, sends both booleans on save, handles API validation errors, and is rendered in the bot workspace.

- [ ] **Step 2: Run focused dashboard tests and verify they fail**

Run: `node --test tests/dashboard-chat-policy-ui.test.cjs tests/dashboard-router.test.cjs`

Expected: FAIL because the route/component does not exist.

- [ ] **Step 3: Implement the shared panel and workspace**

Use the existing `apiRequest` and dashboard visual conventions. Keep the two toggles independent, disable controls while loading/saving, and show the API's restart warning after a successful write. Add the selector to the dedicated workspace and pass the selected bot into the panel.

- [ ] **Step 4: Embed the panel in `BotWorkspace` and wire navigation**

Add a Chat access tab or section that uses the current bot ID, add the navigation item, route alias, `main.jsx` rendering branch, and responsive styles without changing existing workspaces.

- [ ] **Step 5: Run focused UI tests and dashboard build**

Run: `node --test tests/dashboard-chat-policy-ui.test.cjs tests/dashboard-router.test.cjs`

Then run: `npm run dashboard:build`

Expected: PASS and Vite exits with code 0.

---

### Task 8: Command Workspace Scope Controls

**Files:**
- Modify: `dashboard/src/components/command-workspace.jsx`
- Test: `tests/dashboard-command-scope-ui.test.cjs`

**Interfaces:**
- Global command editing sends `scope` in the existing command payload.
- Bot editing sends only override fields, including `scope`, and reset removes the override.
- Apply-all sends `{ commandName, patch: { scope, ...existingFields } }` and retains the existing restart notice.

- [ ] **Step 1: Write failing UI contract tests**

Assert the scope select has Group/Private/Both options, global and effective scope are visible, bot override scope is editable, reset invokes the existing DELETE endpoint, and apply-all includes the selected scope.

- [ ] **Step 2: Run the focused UI test and verify it fails**

Run: `node --test tests/dashboard-command-scope-ui.test.cjs`

Expected: FAIL because the current form has no scope control or effective-scope rendering.

- [ ] **Step 3: Add scope state without replacing raw JSON behavior**

Extend `emptyCommand`, draft hydration, search text, list-row metadata, and form controls. When a bot is selected, preserve inherited/global values for display but send only the editable override patch. Keep alias, permission, countdown, active, and raw editor behavior unchanged.

- [ ] **Step 4: Run focused UI tests and build**

Run: `node --test tests/dashboard-command-scope-ui.test.cjs`

Then run: `npm run dashboard:build`

Expected: PASS and build success.

---

### Task 9: Full Verification and Requirement Audit

**Files:**
- Modify only tests or implementation files if a failing verification exposes a defect.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 with no failing tests.

- [ ] **Step 2: Run the dashboard production build**

Run: `npm run dashboard:build`

Expected: exit code 0.

- [ ] **Step 3: Audit every requirement against evidence**

Check resolver fallback/precedence/reset, router denial/no-handler behavior, command service/scanner output, API validation/merge/backup/audit/restart response, runtime admin bypass, legacy/new command scope enforcement, UI refresh/save/reset/bot switching, and both chat-policy panel placements.

- [ ] **Step 4: Report only verified outcomes**

Include exact test/build commands and any residual limitation, especially the unavailable git commit metadata or lack of a live Zalo account for manual message testing.
