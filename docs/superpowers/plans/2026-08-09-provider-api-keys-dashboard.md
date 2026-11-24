# Provider API Keys And Dashboard Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provider commands load configured API keys reliably from `.env.local`/`.env`, and administrators can update those keys safely from the dashboard without exposing raw secrets.

**Architecture:** Add `src/bootstrap.js` as the only runtime entrypoint that loads provider environment files before dynamically importing `src/index.js`; all direct, supervisor, and PM2 child launches will point to that bootstrap. Add a focused provider-config service under `src/dashboard/` that owns the whitelist, masked reads, line-preserving `.env.local` updates, atomic writes, and backups; expose it through the existing shared dashboard API and render it inside the existing System workspace alongside health and backup controls.

**Tech Stack:** Node.js ESM, `dotenv` 17 already present in `package.json`, Express, React 19, Vite, and `node:test`.

## Global Constraints

- Only manage provider keys declared in `.env.example`.
- Never hard-code or return raw API keys through an API/dashboard response.
- Resolution priority is current process environment, then `.env.local`, then `.env`.
- Write `.env.local` atomically; create a backup under `logs/dashboard-backups` before changing it.
- An empty submitted value removes that key from `.env.local`.
- Preserve unrelated `.env.local` entries and comments when provider keys are changed.
- Provider key changes take effect only after a bot restart; dashboard responses must include `restartRequired: true`.
- Do not load `.env.example` at runtime.
- Preserve `BOT_NAME`, `CONFIG_PATH`, and `PROJECT_ROOT` when spawning a child bot.
- The current workspace has no `.git` directory, so use focused test/build checkpoints instead of commit steps.

---

### Task 1: Runtime Environment Bootstrap

**Files:**
- Create: `src/bootstrap.js`
- Modify: `package.json`
- Modify: `index.js`
- Modify: `bot.js`
- Modify: `src/commands/mybot/System/pm2-manager.js`
- Test: `tests/bootstrap.test.js`
- Test: `tests/run-bat-launch-order.test.js` only if its launch assertions need updating

**Interfaces:**
- Produces `loadProviderEnvironment({ root })`, which loads `.env.local` and `.env` into `process.env` while preserving existing process values.
- `src/bootstrap.js` loads the environment and then performs `await import("./index.js")`.
- Existing `startDirect(bootstrapPath, uid)` remains callable, but callers pass the bootstrap path and preserve the existing bot identity environment.

- [ ] **Step 1: Add failing bootstrap tests**

Create a temporary root with `.env.local` and `.env`, invoke the loader with a controlled environment, and assert the precedence and file behavior:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("provider environment uses process, local, then fallback precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-bootstrap-"));
  await fs.writeFile(path.join(root, ".env.local"), "LOCAL_ONLY=local\nSHARED=local\n");
  await fs.writeFile(path.join(root, ".env"), "FALLBACK_ONLY=fallback\nSHARED=env\n");
  const previous = { ...process.env };
  delete process.env.LOCAL_ONLY;
  delete process.env.FALLBACK_ONLY;
  process.env.SHARED = "process";

  try {
    const { loadProviderEnvironment } = await import("../src/bootstrap.js");
    loadProviderEnvironment({ root });
    assert.equal(process.env.LOCAL_ONLY, "local");
    assert.equal(process.env.FALLBACK_ONLY, "fallback");
    assert.equal(process.env.SHARED, "process");
  } finally {
    for (const key of ["LOCAL_ONLY", "FALLBACK_ONLY", "SHARED"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("bootstrap source dynamically imports the bot only after loading env", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "bootstrap.js"), "utf8");
  assert.match(source, /loadProviderEnvironment/);
  assert.match(source, /await import\(["']\.\/index\.js["']\)/);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/bootstrap.test.js`

Expected: FAIL because `src/bootstrap.js` is not present and the launch contract still points directly to `src/index.js`.

- [ ] **Step 3: Implement the loader and bootstrap entrypoint**

Use `dotenv.config({ path, override: false })` in this order: `.env.local`, then `.env`. Because existing values are never overridden, the first two files naturally implement local-over-env fallback while process values keep priority. Ignore `ENOENT` for either optional file, but surface malformed dotenv errors. Guard the executable part so importing the module in a test does not start the bot; only a direct `node src/bootstrap.js` invocation calls the loader and dynamic import. Export the loader for isolated tests, and keep the executable path small:

```js
// src/bootstrap.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const rootFromModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadProviderEnvironment({ root = process.env.PROJECT_ROOT || rootFromModule } = {}) {
  const resolvedRoot = path.resolve(root);
  for (const file of [".env.local", ".env"]) {
    dotenv.config({ path: path.join(resolvedRoot, file), override: false, quiet: true });
  }
  return process.env;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadProviderEnvironment();
  await import("./index.js");
}
```

If the installed `dotenv` version does not support `quiet`, omit only that option; do not set `override: true` and do not add `.env.example` to the file list.

- [ ] **Step 4: Redirect every bot runtime launch to the bootstrap**

Change the root `package.json` start script to `node src/bootstrap.js`. In `index.js`, rename the validated runtime path to `src/bootstrap.js` and keep the existing child environment fields:

```js
const bootstrapPath = path.join(projectRoot, "src", "bootstrap.js");

export function startDirect(bootstrapPath, uid = botName) {
  return spawn(process.execPath, [bootstrapPath, uid], {
    // keep the existing detached/stdin/stdout/cwd settings
    env: {
      ...process.env,
      BOT_NAME: uid,
      CONFIG_PATH: path.join(projectRoot, "mybot", "bots", `${uid}.json`),
      PROJECT_ROOT: projectRoot,
      BOT_MANAGED: "true",
    },
  });
}
```

Update `bot.js` recovery, main child spawn, and separate-window spawn paths from `src/index.js` to `src/bootstrap.js`. Update `src/commands/mybot/System/pm2-manager.js` so its child path points to `src/bootstrap.js`; keep `launcherPath` pointing to the root `index.js` when the launcher is intentionally responsible for argument/config setup. Ensure the direct child env still spreads `process.env` and explicitly sets `BOT_NAME`, `CONFIG_PATH`, and `PROJECT_ROOT`.

- [ ] **Step 5: Run launch-contract and bootstrap tests**

Run: `node --test tests/bootstrap.test.js tests/run-bat-launch-order.test.js tests/process-guard.test.js`

Expected: PASS, with no assertion or source check referring to a runtime child path that bypasses `src/bootstrap.js`.

---

### Task 2: Provider Configuration Service

**Files:**
- Create: `src/dashboard/provider-config-service.js`
- Modify: `src/dashboard/config-store.js` only if a shared atomic-file helper is needed; keep its JSON API unchanged
- Modify: `.env.example` only to add comments/grouping for the already-declared managed provider keys
- Test: `tests/provider-config.test.js`

**Interfaces:**
- `PROVIDER_CONFIG_KEYS`: frozen whitelist of the provider variables declared in `.env.example`.
- `readProviderConfig(root) -> { keys: [{ name, configured, masked }] }`.
- `updateProviderConfig(root, values) -> { keys, changedKeys, backup, restartRequired: true }`.
- `ProviderConfigService({ root }).read()` and `.update(values)` delegate to the two root-based functions for route injection.
- Unknown keys and non-string values fail with an error carrying `code = "PROVIDER_CONFIG_INVALID"` and `status = 400`.

- [ ] **Step 1: Add failing service tests**

Create tests around a temporary root and never put a real-looking secret in an assertion that could be returned by an API. Cover configured/missing states, whitelist rejection, empty-value removal, preservation, backup, and atomic output:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProviderConfig, updateProviderConfig } from "../src/dashboard/provider-config-service.js";

async function fixture({ local = "", env = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-config-"));
  if (local) await fs.writeFile(path.join(root, ".env.local"), local);
  if (env) await fs.writeFile(path.join(root, ".env"), env);
  return root;
}

test("reads masked provider state without returning raw values", async () => {
  const root = await fixture({
    local: "GEMINI_API_KEYS=gemini-secret\nCUSTOM_FLAG=keep\n",
    env: "TENOR_API_KEY=tenor-fallback\n",
  });
  const result = await readProviderConfig(root);
  assert.deepEqual(result.keys.find((item) => item.name === "GEMINI_API_KEYS"), {
    name: "GEMINI_API_KEYS", configured: true, masked: "********",
  });
  assert.equal(JSON.stringify(result).includes("gemini-secret"), false);
});

test("updates only whitelisted keys, removes empty keys, and preserves other entries", async () => {
  const root = await fixture({ local: "# keep\nCUSTOM_FLAG=keep\nTENOR_API_KEY=old\n" });
  const result = await updateProviderConfig(root, {
    TENOR_API_KEY: "new-tenor",
    GEMINI_API_KEYS: "",
  });
  const saved = await fs.readFile(path.join(root, ".env.local"), "utf8");
  assert.match(saved, /CUSTOM_FLAG=keep/);
  assert.match(saved, /TENOR_API_KEY=new-tenor/);
  assert.doesNotMatch(saved, /GEMINI_API_KEYS=/);
  assert.deepEqual(result.changedKeys.sort(), ["GEMINI_API_KEYS", "TENOR_API_KEY"]);
  assert.equal(result.restartRequired, true);
  assert.ok(result.backup?.file);
});

test("rejects unknown keys and non-string values before writing", async () => {
  const root = await fixture({ local: "CUSTOM_FLAG=keep\n" });
  await assert.rejects(
    () => updateProviderConfig(root, { NOT_A_PROVIDER: "x" }),
    (error) => error.code === "PROVIDER_CONFIG_INVALID" && error.status === 400,
  );
  await assert.rejects(
    () => updateProviderConfig(root, { TENOR_API_KEY: 42 }),
    (error) => error.code === "PROVIDER_CONFIG_INVALID" && error.status === 400,
  );
  assert.equal(await fs.readFile(path.join(root, ".env.local"), "utf8"), "CUSTOM_FLAG=keep\n");
});
```

- [ ] **Step 2: Run the focused service tests and verify they fail**

Run: `node --test tests/provider-config.test.js`

Expected: FAIL because `src/dashboard/provider-config-service.js` does not exist.

- [ ] **Step 3: Implement the whitelist and masked effective read**

Define the whitelist from the runtime provider variables in `.env.example`: `GEMINI_API_KEYS`, `SIMSIMI_API_KEY`, `OPENWEATHER_API_KEY`, `WEATHERAPI_KEY`, `TOMORROW_API_KEY`, `HOANGDEV_API_KEY`, `TIKTOK_COOKIE`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_DOWNLOADER_SECRET`, `SPOTIFY_DOWNLOADER_PASSPHRASE`, `TENOR_API_KEY`, `REMOVE_BG_API_KEY`, `ZINGMP3_API_KEY`, and `ZINGMP3_SECRET_KEY`. Parse `.env.local` before `.env` with `dotenv.parse`, then overlay `process.env` last. Export the root-based functions and this thin class:

```js
export class ProviderConfigService {
  constructor({ root }) { this.root = path.resolve(root); }
  read() { return readProviderConfig(this.root); }
  update(values) { return updateProviderConfig(this.root, values); }
}
```

For every whitelist item, return only:

```js
{ name: key, configured: Boolean(String(effective[key] ?? "").trim()), masked: "********" }
```

Use `masked: ""` for missing keys. Do not include the source filename, effective raw value, or a raw value in thrown errors.

- [ ] **Step 4: Implement line-preserving atomic `.env.local` updates**

Validate `values` as a plain object whose keys are all in `PROVIDER_CONFIG_KEYS` and whose values are strings. Read the existing `.env.local` as UTF-8, copy it to `logs/dashboard-backups/provider-env-local-<timestamp>.bak` before mutation, and apply each update to assignment lines while preserving comments, blank lines, and non-whitelisted assignments. Empty trimmed values delete the matching provider assignment. Append new non-empty keys once at the end. Write to a temporary file in the same directory, rename it over `.env.local`, and remove the temporary directory/file in a `finally` block.

Return masked `keys`, sorted `changedKeys`, the backup metadata `{ file: backupPath }` (or `null` when there was no prior file), and `restartRequired: true`. Backup contents may contain the previous secret because they are an administrative recovery artifact, but the returned metadata must contain only its path and timestamps, never file contents or key values.

- [ ] **Step 5: Run service tests and the existing configuration regression tests**

Run: `node --test tests/provider-config.test.js tests/api-config.test.js tests/phase-4-credentials.test.js`

Expected: PASS, including the pre-existing assertions that provider modules contain no embedded credentials and `.env.example` documents the supported variables.

---

### Task 3: Shared Dashboard Provider-Config API

**Files:**
- Modify: `src/dashboard/api-routes.js`
- Modify: `tests/dashboard/shared-api.test.js`
- Modify: `tests/dashboard/web-server.test.js` to assert the mounted provider route through the bot web-server

**Interfaces:**
- `GET /api/provider-config` returns `{ success: true, data: { keys } }`, where each item is `{ name, configured, masked }`.
- `PUT /api/provider-config` accepts `{ values: { KEY: "value" } }` and returns masked state plus `backup`, `changedKeys`, and `restartRequired: true` at the envelope level.
- Both routes use the existing `requestIdMiddleware`, `sendSuccess`, `sendError`, and `wrap` behavior.

- [ ] **Step 1: Add failing shared API tests**

Extend the existing temporary dashboard fixture with `.env.local` and `.env`, then add this contract test:

```js
test("provider config API reads masked state and saves only changed keys", async () => {
  const root = await makeDashboardFixture();
  await fs.writeFile(path.join(root, ".env.local"), "GEMINI_API_KEYS=gemini-secret\nCUSTOM_FLAG=keep\n");
  await fs.writeFile(path.join(root, ".env"), "TENOR_API_KEY=tenor-fallback\n");
  const server = await startSharedApi(root);
  try {
    const read = await fetchJson(`${server.url}/api/provider-config`, {
      headers: { "X-Request-ID": "req-provider-read" },
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.requestId, "req-provider-read");
    assert.equal(read.body.data.keys.find((item) => item.name === "GEMINI_API_KEYS").masked, "********");
    assert.equal(JSON.stringify(read.body).includes("gemini-secret"), false);

    const update = await putJson(`${server.url}/api/provider-config`, {
      values: { TENOR_API_KEY: "new-tenor", GEMINI_API_KEYS: "" },
    }, "req-provider-update");
    assert.equal(update.success, true);
    assert.equal(update.restartRequired, true);
    assert.deepEqual(update.changedKeys.sort(), ["GEMINI_API_KEYS", "TENOR_API_KEY"]);
    assert.ok(update.backup?.file);
    assert.equal(JSON.stringify(update).includes("new-tenor"), false);

    const audit = await fs.readFile(path.join(root, "logs", "dashboard-audit.jsonl"), "utf8");
    assert.match(audit, /provider-config\.update/);
    assert.match(audit, /TENOR_API_KEY/);
    assert.doesNotMatch(audit, /new-tenor|gemini-secret/);
  } finally {
    await server.close();
  }
});

test("provider config API rejects malformed payloads and unknown keys", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    for (const values of [null, [], { NOT_A_PROVIDER: "x" }, { TENOR_API_KEY: 123 }]) {
      const response = await fetch(`${server.url}/api/provider-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "PROVIDER_CONFIG_INVALID");
    }
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the focused shared API tests and verify the new cases fail**

Run: `node --test tests/dashboard/shared-api.test.js`

Expected: FAIL with `404` for `GET /api/provider-config` until the route is registered.

- [ ] **Step 3: Register the GET and PUT routes**

Import `ProviderConfigService` from `./provider-config-service.js`, instantiate it once in `registerDashboardApi` (allow an injected `options.providerConfigService` for tests), and add the routes near the existing root-level command routes:

```js
import { ProviderConfigService } from "./provider-config-service.js";

const providerConfigService = options.providerConfigService || new ProviderConfigService({ root });

app.get("/api/provider-config", wrap(async (req, res) => {
  return sendSuccess(res, req, await providerConfigService.read());
}));

app.put("/api/provider-config", wrap(async (req, res) => {
  if (!req.body || !req.body.values || typeof req.body.values !== "object" || Array.isArray(req.body.values)) {
    const error = new Error("Provider config values must be an object");
    error.code = "PROVIDER_CONFIG_INVALID";
    error.status = 400;
    throw error;
  }
  const result = await providerConfigService.update(req.body.values);
  await auditStore.append({
    requestId: req.requestId,
    action: "provider-config.update",
    changedKeys: result.changedKeys,
  });
  return sendSuccess(res, req, { keys: result.keys }, {
    backup: result.backup,
    changedKeys: result.changedKeys,
    restartRequired: true,
  });
}));
```

The service may expose root-bound methods (`read()`/`update(values)`) even though its pure test-facing helpers are named `readProviderConfig(root)`/`updateProviderConfig(root, values)`. Keep all validation errors on the existing `wrap` path so the response has the standard request ID and error envelope.

- [ ] **Step 4: Verify both dashboard mounts expose the same route**

Run: `node --test tests/dashboard/shared-api.test.js tests/dashboard/web-server.test.js tests/dashboard/standalone-bots.test.js`

Expected: PASS. The route must work through `dashboard/server.js` and `src/web-service/web-server.js` because both mount `registerDashboardApi`; no second provider route is allowed in either server.

---

### Task 4: Provider Keys Dashboard UI

**Files:**
- Modify: `dashboard/src/components/system-workspace.jsx`
- Modify: `dashboard/src/styles.css`
- Modify: `dashboard/src/app/navigation.js` to set the existing System description to `Health, provider keys, and backup management`
- Test: `tests/dashboard/provider-config-ui.test.cjs` (create)

**Interfaces:**
- System workspace loads `/api/provider-config` without loading raw values.
- Each password input starts empty after refresh; the masked status comes from `configured`/`masked`, not from the input value.
- Save sends only dirty fields as `{ values }` and displays returned backup path plus restart-required state.
- Existing `/api/system/health`, backup, and restore controls remain available and functional.

- [ ] **Step 1: Add failing UI contract tests**

Use the repository's existing source-contract style to verify the component has the security-critical behavior before changing it:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../../dashboard/src/components/system-workspace.jsx", import.meta.url), "utf8");

test("system workspace uses the provider config contract without binding masked values to inputs", () => {
  assert.match(source, /\/api\/provider-config/);
  assert.match(source, /type=["']password["']/);
  assert.match(source, /restartRequired/);
  assert.match(source, /changedKeys|dirty/);
  assert.doesNotMatch(source, /value=\{[^}]*masked/);
});
```

- [ ] **Step 2: Run the focused UI test and verify it fails**

Run: `node --test tests/dashboard/provider-config-ui.test.cjs`

Expected: FAIL because the current `SystemWorkspace` only exposes health and backup controls.

- [ ] **Step 3: Add provider state, grouping, and dirty-field tracking**

Keep a static display map in the component for the seven requested groups:

```js
const PROVIDER_GROUPS = [
  { label: "Gemini", keys: ["GEMINI_API_KEYS", "SIMSIMI_API_KEY"] },
  { label: "HoangDev", keys: ["HOANGDEV_API_KEY"] },
  { label: "Tenor", keys: ["TENOR_API_KEY"] },
  { label: "Weather", keys: ["OPENWEATHER_API_KEY", "WEATHERAPI_KEY", "TOMORROW_API_KEY"] },
  { label: "Spotify", keys: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_DOWNLOADER_SECRET", "SPOTIFY_DOWNLOADER_PASSPHRASE"] },
  { label: "TikTok", keys: ["TIKTOK_COOKIE"] },
  { label: "ZingMP3", keys: ["ZINGMP3_API_KEY", "ZINGMP3_SECRET_KEY"] },
];
```

On load, fetch health and provider config in parallel. Store the API's key metadata separately from an initially empty `draftValues` object and a `dirtyKeys` set. For each password input, bind `value={draftValues[key] || ""}`; render `configured ? "Configured" : "Missing"` and `masked` as status text, never as an input value. On change, add the key to `dirtyKeys` and update only that draft value.

- [ ] **Step 4: Add save behavior and preserve existing health/backup controls**

Add a provider panel in the same `SystemWorkspace` section. Save with exactly the dirty fields:

```js
const values = Object.fromEntries([...dirtyKeys].map((key) => [key, draftValues[key] || ""]));
const result = await apiRequest("/api/provider-config", { method: "PUT", body: { values } });
const payload = result.data || result;
setBackupFile(result.backup?.file || payload.backup?.file || "");
setNotice(result.restartRequired ? "Provider keys saved. Restart the bot to apply changes." : "Provider keys saved.");
setDirtyKeys(new Set());
await loadProviderConfig();
```

Disable save while no fields are dirty or a request is running. Display the backup path as text after a successful update. Use the existing error/notice styles and keep health refresh, backup, and restore actions unchanged. Add compact responsive styles for provider groups, status text, and password rows; preserve stable input sizing and the existing dark dashboard palette.

- [ ] **Step 5: Run UI tests and build the dashboard**

Run: `node --test tests/dashboard/provider-config-ui.test.cjs tests/dashboard/navigation.test.js tests/dashboard/app-api.test.js`

Then run: `npm run dashboard:build`

Expected: PASS and a successful Vite build with no raw key literals introduced into the component or generated source.

---

### Task 5: Runtime Provider Regression Coverage

**Files:**
- Modify: `tests/provider-config.test.js` to add runtime/bootstrap cases after the service cases
- Modify: `tests/api-config.test.js`
- Modify: `tests/command-dependency.test.js`
- Modify: `tests/phase-3-dispatch.test.js`
- Modify: `tests/phase-4-dependency.test.js`
- Modify: `tests/phase-4-credentials.test.js` only if the bootstrap path contract needs an additional source assertion

**Interfaces:**
- Command dispatch continues to receive configuration through `context.config`/`process.env` and returns `MISSING_DEPENDENCY` before invoking a handler when required keys are absent.
- A child process started through `src/bootstrap.js` sees `.env.local` values before importing provider modules.
- Existing commands without provider requirements remain dispatchable with an empty config.

- [ ] **Step 1: Add failing runtime regression cases**

Add explicit cases for the provider matrix and bootstrap import order in `tests/provider-config.test.js`. The service test imports already provide `fs`, `os`, and `path`; add the command-dispatch and bootstrap imports once at the top, then use this self-contained setup:

```js
import { loadProviderEnvironment } from "../src/bootstrap.js";

test("configured .env.local values reach provider dispatch after bootstrap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-runtime-env-"));
  await fs.writeFile(path.join(root, ".env.local"), "TENOR_API_KEY=local-tenor\n");
  const previous = process.env.TENOR_API_KEY;
  delete process.env.TENOR_API_KEY;
  try {
    loadProviderEnvironment({ root });
    const result = await dispatchCommand({
      commandParts: ["gifmeme", "sample"],
      scope: "group",
      config: process.env,
      dbReady: true,
    }, createPhase3Registry({ gifmeme: async () => "ok" }));
    assert.equal(result.code, "HANDLED");
  } finally {
    if (previous === undefined) delete process.env.TENOR_API_KEY;
    else process.env.TENOR_API_KEY = previous;
  }
});

test("provider-independent commands still dispatch with an empty config", async () => {
  const result = await dispatchCommand({ commandParts: ["ping"], config: {}, dbReady: true }, createPhase3Registry({ ping: async () => "ok" }));
  assert.equal(result.code, "HANDLED");
});
```

Keep the existing `tests/phase-4-dependency.test.js` weather case as the explicit `WEATHERAPI_KEY` alternative check; add the `OPENWEATHER_API_KEY` alternative beside it if that case is not already present.

Use a child process or a cache-busting dynamic import for bootstrap tests so top-level provider constants from earlier tests cannot leak into the assertion. Add/retain negative cases proving Gemini, Tenor, HoangDev, Spotify, and weather report the exact missing key(s) and do not invoke the injected handler. Add one no-provider command case to prove unrelated commands still run with `{}`.

- [ ] **Step 2: Run the focused runtime tests and verify the new cases fail**

Run: `node --test tests/provider-config.test.js tests/api-config.test.js tests/command-dependency.test.js tests/phase-3-dispatch.test.js tests/phase-4-dependency.test.js`

Expected: the new `.env.local` bootstrap case fails until the bootstrap launcher and provider service are integrated, while existing dependency tests continue to describe the current behavior.

- [ ] **Step 3: Align provider dependency assertions with the loaded environment**

Keep command registry metadata unchanged unless a test exposes drift. Verify the following required configuration contract exactly:

```js
assert.deepEqual(createPhase3Registry().lookup.get("gifmeme")[0].requiredConfig, ["TENOR_API_KEY"]);
assert.deepEqual(createPhase3Registry().lookup.get("lamnet")[0].requiredConfig, ["HOANGDEV_API_KEY"]);
assert.deepEqual(createPhase4Registry().lookup.get("thoitiet")[0].requiredConfig, [["OPENWEATHER_API_KEY", "WEATHERAPI_KEY"]]);
```

If the runtime provider handler captures environment at module evaluation, do not hot-reload `process.env`; ensure its production import occurs only from `src/bootstrap.js`. Keep provider API clients and child process lifecycles restart-bound as specified.

- [ ] **Step 4: Verify secrets are absent from all externally visible artifacts**

After an API update, assert that the HTTP response, audit JSONL entry, and backup metadata contain no submitted raw value. It is acceptable for the backup file itself to contain the previous `.env.local` contents because it is the recovery artifact; never return that content or include it in an audit entry. Also assert empty values remove the entry and non-whitelist entries survive.

- [ ] **Step 5: Run the complete regression suite**

Run: `npm test`

Expected: PASS for all existing and new tests. If a browser test requires a built dashboard, run `npm run dashboard:build` first and then rerun the affected dashboard test.

---

### Task 6: Final Verification And Handoff

**Files:**
- No product files unless a failed verification identifies a concrete issue in Tasks 1-5.
- Verify: `src/bootstrap.js`, `index.js`, `bot.js`, `src/commands/mybot/System/pm2-manager.js`, `src/dashboard/provider-config-service.js`, `src/dashboard/api-routes.js`, `dashboard/src/components/system-workspace.jsx`, `.env.example`

- [ ] **Step 1: Scan the changed source for secret exposure**

Run: `rg -n "AIza|sk-[A-Za-z0-9]|gemini-secret|tenor-secret|new-tenor|process\.env\." src/bootstrap.js src/dashboard/provider-config-service.js src/dashboard/api-routes.js dashboard/src/components/system-workspace.jsx tests .env.example`

Expected: only environment-variable names and test fixture placeholders appear; no real credential or raw update value is committed to source or tests.

- [ ] **Step 2: Verify launch paths are bootstrap-first**

Run: `rg -n "src/index\.js|src/bootstrap\.js|node src/" package.json index.js bot.js src/commands/mybot/System/pm2-manager.js run.bat tests`

Expected: every runtime child launch uses `src/bootstrap.js`; imports of `src/index.js` remain only internal module references/tests that do not serve as executable launchers.

- [ ] **Step 3: Verify the dashboard build and full test result**

Run: `npm run dashboard:build; npm test`

Expected: both commands exit with code 0. Record any environment-specific native-module warning separately from test failures; do not claim completion until the exit codes are successful.

## Spec Coverage Review

- Task 1 covers `.env.local`/`.env` loading order, process-env preservation, bootstrap-before-provider imports, npm/direct/supervisor/PM2 launch paths, and child identity environment propagation.
- Task 2 covers the `.env.example` whitelist, masked reads, invalid-key rejection, empty-value deletion, preservation of unrelated entries, atomic writes, backups, and secret-safe metadata.
- Task 3 covers both dashboard API endpoints, validation, request IDs, standard response envelopes, restart metadata, and audit entries containing only changed key names.
- Task 4 covers all requested provider groups, password inputs, no auto-filled raw values, dirty-field-only saves, backup path/restart notice, and preservation of existing health/backup controls.
- Task 5 covers missing/configured provider dispatch, weather alternatives, provider import timing, secret non-disclosure, deletion/backup behavior, and unrelated command regressions.
- Task 6 provides final source, launch, build, and full-regression verification.

Plan complete and saved to `docs/superpowers/plans/2026-08-09-provider-api-keys-dashboard.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, and iterate quickly.
2. **Inline Execution** - execute the tasks in this session with `superpowers:executing-plans` checkpoints.
