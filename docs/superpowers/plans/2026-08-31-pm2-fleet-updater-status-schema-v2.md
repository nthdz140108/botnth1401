# PM2 Fleet-Aware Updater + Status Schema v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dashboard `N/A` status after background updates by making the updater stop the whole MyBot fleet **through PM2** (so `autorestart` cannot resurrect stale code mid-update), and by standardizing bot status through one schema-versioned resolver response the frontend can trust or reject with a clear "backend cũ" message.

**Architecture:** `scripts/safe-update.js` swaps its PID-file/cmdline `Stop-Process` kill for a PM2 fleet stop (fixed infra names `mybot-dashboard`, `mybot-guardian`, `admin` + env-marker/registry child bots — never `pm2 kill`, never foreign PM2 apps) with verified-quiescence before `git reset`. `run.bat`'s reconcile gains a stale-runtime fingerprint guard: an `online` PM2 app whose `[RUNTIME FINGERPRINT]` commit predates HEAD is restarted from current source. The dashboard API stamps every bot status with `statusSchemaVersion: 2` + `supervisor` + `readiness` + `reason`; the React overview renders a "Backend cũ — cần restart mybot-dashboard" banner instead of `N/A` when the schema is missing.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, PM2 7.x (local `node_modules/.bin/pm2.cmd`, ecosystem `.config.cjs`), React 19 + Vite dashboard.

**Spec:** user request "Sửa trạng thái bot `N/A` khi chạy nền bằng PM2" (2026-08-31) — root cause: updater used `Stop-Process` while PM2 `autorestart` resurrected old-code processes before `git reset` finished; new frontend then talked to old backend RAM state without `supervisor/readiness` fields → `N/A`.

## Global Constraints

- PM2 remains the ONLY supervisor. The updater must NOT use `pm2 kill`, must NOT `Stop-Process` any node process, must not touch PM2 apps outside the MyBot fleet.
- `update.bat` keeps `--skip-restart` semantics: it updates source only and never starts bots. `run.bat` is the sole fleet starter.
- PM2 invocations must use the absolute local path `node_modules\.bin\pm2.cmd` (or the programmatic ecosystem path) — never a bare `pm2` from PATH.
- Registry `running/stopped` values for child bots must be preserved (not mutated) by the updater so `getAutoRestoreCandidates` restores the same set on next `run.bat`.
- Before any `git reset --hard`, every fleet target must be verified `stopped`; otherwise abort the update BEFORE touching source.
- Do not delete: PM2 process definitions, daemon, credentials, `.env.local`, `mybot/` registry, `.runtime/` data.
- Existing tests must keep passing: `tests/safe-update.test.js` (its `stopProcesses`/`restartAndVerify` dependency-injection contract is preserved), `tests/runtime-pm2/*`, `tests/dashboard/*`.
- Never let a stored PID (`.bot.pid`, registry JSON, state JSON) upgrade a bot to `running`.
- Keep the failure ladder: `disabled/expired` unchanged → `stopped/process-missing` (no PM2 entry) → `stopped` (PM2 stopped) → `unknown/pm2-unavailable` (daemon down) → `error` (errored / port closed after grace) → `identity-mismatch` → `starting` → `running` (all probes pass).
- Do not wait on full `npm test` suites that exceed ~3 minutes; run focused test files.

---

### Task 1: Extract PM2 fleet-stop module `src/runtime/fleet-stop.js`

**Files:**
- Create: `src/runtime/fleet-stop.js`
- Test: `tests/runtime-pm2/fleet-stop.test.js`

**Interfaces:**
- Consumes: `PM2Adapter` (`listManagedProcesses({botKeys})`, `stopBot(name)`, `getProcessStatus(name)`, `isAvailable()`) from `src/runtime/pm2-adapter.js`; registry reader from `mybot/mybots.json`.
- Produces: `async function stopMyBotFleetViaPM2({ projectRoot, adapter = null, timeoutMs = 60_000, pollMs = 500 })` → `{ success: boolean, stopped: string[], alreadyStopped: string[], missing: string[], failed: Array<{name, reason}>, daemonAvailable: boolean }`. Also exports `INFRA_NAMES = ['mybot-dashboard', 'mybot-guardian', 'admin']` and `async function verifyFleetStopped(adapter, names, { timeoutMs, pollMs })` → `{ allStopped: boolean, stillRunning: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/runtime-pm2/fleet-stop.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { stopMyBotFleetViaPM2, verifyFleetStopped, INFRA_NAMES } from "../../src/runtime/fleet-stop.js";

function makeAdapter({ procs, failStop = [], daemonUp = true }) {
  const calls = [];
  return {
    calls,
    async isAvailable() { return { available: daemonUp }; },
    async listManagedProcesses({ botKeys = [] } = {}) {
      // Simulate: after stop, processes disappear from "running" inventory
      return procs.filter((p) => !calls.some((c) => c.op === "stop" && c.name === p.name));
    },
    async stopBot(name) {
      calls.push({ op: "stop", name });
      if (failStop.includes(name)) return { success: false, pm2Name: name, reason: "pm2_stop_failed" };
      return { success: true, pm2Name: name, reason: "stopped" };
    },
  };
}

test("fleet-stop stops infra names plus registry child bots", async () => {
  const adapter = makeAdapter({ procs: [
    { name: "mybot-dashboard", status: "online" },
    { name: "mybot-guardian", status: "online" },
    { name: "admin", status: "online" },
    { name: "user-123", status: "online" },
    { name: "foreign-app", status: "online" },
  ] });
  const result = await stopMyBotFleetViaPM2({ projectRoot: "C:\\tmp\\does-not-matter", adapter });
  assert.equal(result.success, true);
  assert.deepEqual([...result.stopped].sort(), ["admin", "mybot-dashboard", "mybot-guardian", "user-123"]);
  assert.ok(!result.stopped.includes("foreign-app"), "must not touch non-MyBot PM2 apps");
});

test("fleet-stop verifies quiescence and reports still-running targets", async () => {
  const adapter = makeAdapter({ procs: [{ name: "admin", status: "online" }], failStop: ["admin"] });
  const result = await stopMyBotFleetViaPM2({ projectRoot: "x", adapter, timeoutMs: 200, pollMs: 20 });
  assert.equal(result.success, false);
  assert.deepEqual(result.failed, [{ name: "admin", reason: "pm2_stop_failed" }]);
  assert.deepEqual(result.stillRunning, ["admin"]);
});

test("fleet-stop is a no-op success when daemon is down (nothing to resurrect)", async () => {
  const adapter = makeAdapter({ procs: [], daemonUp: false });
  const result = await stopMyBotFleetViaPM2({ projectRoot: "x", adapter });
  assert.equal(result.success, true);
  assert.equal(result.daemonAvailable, false);
  assert.deepEqual(result.stopped, []);
});

test("verifyFleetStopped polls until processes leave online state", async () => {
  let attempts = 0;
  const adapter = {
    async listProcesses() {
      attempts += 1;
      return attempts < 3 ? [{ name: "admin", status: "online" }] : [{ name: "admin", status: "stopped" }];
    },
  };
  const result = await verifyFleetStopped(adapter, ["admin"], { timeoutMs: 2000, pollMs: 10 });
  assert.equal(result.allStopped, true);
});
```

Note: `INFRA_NAMES` is asserted implicitly via Task 1 Step 3 usage; add one explicit assertion if desired. `stopMyBotFleetViaPM2` must treat `listManagedProcesses` daemon-down (throw) as the `daemonUp:false` path — wrap it in try/catch, do not let the throw escape.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/runtime-pm2/fleet-stop.test.js`
Expected: FAIL with "Cannot find module ... fleet-stop.js"

- [ ] **Step 3: Write minimal implementation**

```js
// src/runtime/fleet-stop.js
/**
 * Fleet-wide PM2 stop for the MyBot updater.
 *
 * Scope: only fixed infra names (mybot-dashboard, mybot-guardian, admin) and
 * MyBot child bots identified by env markers or registry keys via
 * PM2Adapter.listManagedProcesses(). NEVER touches foreign PM2 apps and never
 * calls `pm2 kill`.
 *
 * Quiescence contract: returns success only when every target has left the
 * `online/launching/stopping` transient states (or the daemon itself is down,
 * which equally guarantees nothing can resurrect old code).
 */

import fs from "node:fs";
import path from "node:path";
import { PM2Adapter } from "./pm2-adapter.js";

export const INFRA_NAMES = ["mybot-dashboard", "mybot-guardian", "admin"];

const ACTIVE_STATES = new Set(["online", "launching", "stopping", "restarting"]);

export async function verifyFleetStopped(adapter, names, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stillRunning = [];
  while (Date.now() <= deadline) {
    let procs = [];
    try {
      procs = await adapter.listProcesses();
    } catch {
      // Daemon down mid-stop: nothing alive to resurrect.
      return { allStopped: true, stillRunning: [] };
    }
    stillRunning = names.filter((name) => {
      const proc = procs.find((p) => p.name === name);
      return proc && ACTIVE_STATES.has(proc.status);
    });
    if (stillRunning.length === 0) return { allStopped: true, stillRunning: [] };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { allStopped: false, stillRunning };
}

function readRegistryBotKeys(projectRoot) {
  const registryPath = path.join(projectRoot, "mybot", "mybots.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
    return Object.keys(parsed || {}).filter((key) => key && key !== "admin");
  } catch {
    return [];
  }
}

export async function stopMyBotFleetViaPM2({
  projectRoot,
  adapter = null,
  timeoutMs = 60_000,
  pollMs = 500,
} = {}) {
  const pm2 = adapter || new PM2Adapter({ projectRoot });
  const result = {
    success: false,
    daemonAvailable: true,
    stopped: [],
    alreadyStopped: [],
    missing: [],
    failed: [],
    stillRunning: [],
  };

  const health = await pm2.isAvailable().catch(() => ({ available: false }));
  if (!health.available) {
    // Daemon down = nothing under PM2 supervision; nothing can autorestart.
    result.success = true;
    result.daemonAvailable = false;
    return result;
  }

  let targets;
  try {
    const botKeys = readRegistryBotKeys(projectRoot);
    const procs = await pm2.listManagedProcesses({ botKeys });
    const seen = new Set();
    targets = procs
      .filter((proc) => isFleetTarget(proc) && !seen.has(proc.name) && seen.add(proc.name))
      .map((proc) => ({ name: proc.name, status: proc.status }));
  } catch (err) {
    result.failed.push({ name: "*", reason: `inventory_failed: ${err.message}` });
    return result;
  }

  for (const target of targets) {
    if (!ACTIVE_STATES.has(target.status)) {
      result.alreadyStopped.push(target.name);
      continue;
    }
    const stopResult = await pm2.stopBot(target.name);
    if (stopResult?.success) result.stopped.push(target.name);
    else result.failed.push({ name: target.name, reason: stopResult?.reason || "stop_failed" });
  }

  const verify = await verifyFleetStopped(pm2, targets.map((t) => t.name), { timeoutMs, pollMs });
  result.stillRunning = verify.stillRunning;
  result.success = verify.allStopped && result.failed.length === 0;
  return result;
}

function isFleetTarget(proc) {
  return INFRA_NAMES.includes(proc.name) || Boolean(proc.env?.BOT_MANAGED === "true" || proc.env?.BOT_MANAGED === true) || proc.name.startsWith("bot-");
}
```

Note: `listManagedProcesses` already applies `isMyBotProcess` + registry-key fallback, so `isFleetTarget` is a second belt-and-braces filter; keep it simple and defensive.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/runtime-pm2/fleet-stop.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/runtime/fleet-stop.js tests/runtime-pm2/fleet-stop.test.js
git commit -m "feat(updater): add PM2 fleet-stop module with quiescence verification"
```

---

### Task 2: Wire PM2 fleet stop into safe-update.js, abort before `git reset` if not quiesced

**Files:**
- Modify: `scripts/safe-update.js` (replace `stopMyBotProcesses` usage; keep export names used by tests)
- Modify: `update.ps1` only if it duplicates the Stop-Process logic (check; if it merely calls safe-update.js, no change)
- Test: `tests/safe-update.test.js` (extend)

**Interfaces:**
- Consumes: `stopMyBotFleetViaPM2` from Task 1.
- Produces: `runSafeUpdate(options, dependencies)` keeps signature; new injectable dependency `stopFleetViaPM2` (defaults to the Task 1 function). New `--skip-fleet-stop` flag parallels `--skip-process-stop` (both flags set `options.stopProcesses = false`; legacy flag retained for tests/compat). The old `stopMyBotProcesses` PowerShell killer is deleted from the default path (kept only if a test imports it — grep first; `tests/safe-update.test.js` does not import it directly, it injects `stopProcesses`).

- [ ] **Step 1: Write the failing test**

Append to `tests/safe-update.test.js`:

```js
test("safe updater stops the PM2 fleet and aborts before git reset when quiescence fails", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-pm2-stop-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const deploy = path.join(fixtureRoot, "deploy");
  run("git", ["init", "--bare", remote], fixtureRoot);
  mkdirSync(deploy);
  run("git", ["init", "-b", "master"], deploy);
  run("git", ["config", "user.email", "test@example.com"], deploy);
  run("git", ["config", "user.name", "Safe Update Test"], deploy);
  write(deploy, "bot.js", "console.log('v1');\n");
  run("git", ["add", "."], deploy);
  run("git", ["commit", "-m", "initial"], deploy);
  run("git", ["remote", "add", "origin", remote], deploy);
  run("git", ["push", "-u", "origin", "master"], deploy);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);

  // Seed remote with v2 so a reset WOULD change source if quiescence were ignored.
  write(deploy, "seed-marker.txt", "seed\n");
  run("git", ["add", "."], deploy);
  run("git", ["commit", "-m", "seed-marker"], deploy);
  run("git", ["push", "origin", "master:refs/heads/feature-seed"], deploy);
  // Make origin/master ahead: create v2 commit locally on a temp clone
  // Simpler: push a v2 from a second seed clone
  const seed = path.join(fixtureRoot, "seed2");
  run("git", ["clone", "-q", remote, seed], fixtureRoot);
  write(seed, "bot.js", "console.log('v2');\n");
  run("git", ["add", "bot.js"], seed);
  run("git", ["commit", "-m", "v2"], seed);
  run("git", ["push", "origin", "master"], seed);
  // Reset deploy back to v1 so the update is a real change
  run("git", ["reset", "--hard", previousHead], deploy);

  const gitCalls = [];
  const result = await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: false,
    restart: false,
  }, {
    stopFleetViaPM2: async () => ({
      success: false, daemonAvailable: true, stopped: [],
      alreadyStopped: [], missing: [], failed: [{ name: "admin", reason: "stop failed" }],
      stillRunning: ["admin"],
    }),
    _gitSpy: (args, cwd) => gitCalls.push({ args, cwd }),
  }).then(
    () => { throw new Error("expected rejection"); },
    (err) => err,
  );

  assert.match(result.message, /still running|quiesce/i);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead, "source must NOT change when quiescence fails");
});

test("safe updater proceeds when PM2 fleet stop succeeds", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-pm2-ok-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");
  run("git", ["init", "--bare", remote], fixtureRoot);
  mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Safe Update Test"], seed);
  write(seed, "bot.js", "console.log('v1');\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);
  write(seed, "bot.js", "console.log('v2');\n");
  run("git", ["add", "bot.js"], seed);
  run("git", ["commit", "-m", "v2"], seed);
  run("git", ["push", "origin", "master"], seed);

  const stopCalls = [];
  await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: false,
    restart: false,
  }, {
    stopFleetViaPM2: async ({ projectRoot }) => {
      stopCalls.push(projectRoot);
      return { success: true, daemonAvailable: true, stopped: ["admin"], alreadyStopped: [], missing: [], failed: [], stillRunning: [] };
    },
  });

  assert.equal(stopCalls.length, 1);
  assert.notEqual(run("git", ["rev-parse", "HEAD"], deploy), previousHead);
});
```

Note: the `_gitSpy` key in dependencies is illustrative — real injection uses the existing `stopProcesses`/`restartAndVerify` keys. The essential new key is `stopFleetViaPM2`. Do NOT assert on console output beyond status codes.

Also update the two existing tests that pass `stopProcesses: () => { ... }` dependencies (lines ~193 and ~240): the default stop path changes from the PowerShell killer to PM2 fleet stop, so the injected key remains `stopProcesses` (renamed below to keep the DI contract) — keep them passing by preserving the dependency name `stopProcesses` as the injected stop override. The implementation maps `dependencies.stopProcesses || stopMyBotFleetViaPM2WithRoot`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-force-exit tests/safe-update.test.js`
Expected: the two new tests FAIL (no `stopFleetViaPM2` support; update currently proceeds/kills via PowerShell), existing ones PASS.

- [ ] **Step 3: Implement**

Changes to `scripts/safe-update.js`:

1. Import the fleet-stop module:
```js
import { stopMyBotFleetViaPM2 } from "../src/runtime/fleet-stop.js";
```
2. Delete `stopMyBotProcesses()` (the whole PowerShell one-liner builder, lines 122-140) and its `--skip-process-stop`-only semantics stay: `--skip-process-stop` remains a valid flag alias. Add alias handling in `parseArgs`: both `--skip-process-stop` and `--skip-fleet-stop` set `options.stopProcesses = false`.
3. Replace the default stop dependency in `runSafeUpdate`:
```js
const stopRuntime = dependencies.stopProcesses || ((root) => stopMyBotFleetViaPM2({ projectRoot: root }));
```
4. Change the stop+verify step to treat quiescence failure as a hard abort BEFORE backup/reset:
```js
console.log("[2/8] Stopping MyBot PM2 fleet...");
if (options.stopProcesses) {
  processesStopped = true;
  const stopResult = await stopRuntime(root);
  if (!stopResult || stopResult.success !== true) {
    const detail = stopResult?.failed?.map((f) => `${f.name}: ${f.reason}`).join("; ")
      || stopResult?.stillRunning?.join(", ") || "unknown";
    throw new Error(
      `PM2 fleet did not quiesce before update (still running: ${detail}). ` +
      "Abort BEFORE git reset — source unchanged. Fix with `pm2 stop <name>` or restart the PM2 daemon, then rerun update.bat."
    );
  }
  console.log(`[2/8] PM2 fleet stopped: ${stopResult.stopped.join(", ") || "(none were running)"}`);
  if (stopResult.daemonAvailable === false) {
    console.log("[2/8] PM2 daemon down — no supervised process can autorestart old code.");
  }
}
```
5. Rollback path: keep the existing catch-block re-stop (`stopRuntime(root)` is now idempotent PM2 stop — safe), but the `restartAndVerify` restore path must ALSO use PM2 semantics: replace `restartMyBot` (spawn `cmd /c run.bat`) with a PM2-native restart of infra apps only, because spawning run.bat would open an interactive monitor window during an unattended update. New default `restartAndVerify`:
```js
async function restartFleetViaPM2(root, commit) {
  if (process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") return;
  // The updater never starts bots (update.bat contract). restart is only used
  // when invoked WITHOUT --skip-restart by an operator who wants the fleet back.
  // Implementation: delegate to reconcile in --reconcile-only mode so the same
  // start-or-adopt + fleet verification path runs as run.bat.
  const reconcilePath = path.join(root, "src", "runtime", "reconcile-and-monitor.js");
  run(process.execPath, [reconcilePath, "--reconcile-only"], { cwd: root });
}
```
   Keep `verifyRuntimeRestart` exported (tests import it) but it is no longer used by the default restart path — mark it `/** @deprecated legacy PID/fingerprint verification kept for tests */`.
6. Error message contract: any abort before reset must NOT print `ROLLBACK COMPLETE` (nothing to roll back) — the current catch block already guards with `resetApplied`, so this stays correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-force-exit tests/safe-update.test.js`
Expected: PASS (all, including pre-existing 7 tests).

- [ ] **Step 5: Verify update.bat contract unchanged**

Read `update.bat` — it already calls `node "%UPDATER%" --root "%CD%" --skip-restart`. No change needed. Grep `update.ps1` for `Stop-Process` to confirm it delegates to safe-update.js; if it duplicates the kill, replace with a note to call safe-update.js.

Run: `Select-String -Path update.ps1 -Pattern "Stop-Process"`
Expected: no matches, or the file delegates entirely.

- [ ] **Step 6: Commit**

```bash
git add scripts/safe-update.js tests/safe-update.test.js
git commit -m "fix(updater): stop MyBot fleet via PM2 and abort before git reset unless quiesced"
```

---

### Task 3: Reconcile must restart stale-commit `online` apps (runtime fingerprint guard)

**Files:**
- Modify: `src/runtime/reconcile-and-monitor.js` (`startDashboard`, `startGuardian`, `startMain`, `restoreChildBots`)
- Modify: `src/runtime/pm2-adapter.js` (add `restartIfStale` or extend `startBot` — choose: add standalone helper to keep `startBot` contract stable)
- Create: `src/runtime/runtime-fingerprint.js`
- Test: `tests/runtime-pm2/fingerprint-guard.test.js`

**Interfaces:**
- Consumes: `PM2Adapter.listProcesses()` normalized shape (`name`, `status`, `pid`); log file `logs/<pm2Name>/out.log` or PM2 `pm2 describe <name>` output — simplest reliable source: PM2's `~/.pm2/logs/<name>-out.log` is NOT project-scoped; instead read the per-bot runtime log under `<root>/logs/<botName>/` written by `getRuntimeLogger` AND `logs/bot-stdout.log` for main. Fallback: if no fingerprint line found for the process, treat as NOT stale (adopt) — never block startup on missing telemetry.
- Produces: `export function parseFingerprintCommit(text)` → last `commit="..."` value or `null`; `export async function isProcessStale({ root, pm2Name, currentCommit, pm2 })` → `{ stale: boolean, observedCommit: string|null }`; reconcile treats `stale === true` as "must restart from current source" (calls `adapter.restartBot(name)` instead of skipping an `online` app).

- [ ] **Step 1: Write the failing test**

```js
// tests/runtime-pm2/fingerprint-guard.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFingerprintCommit, isProcessStale } from "../../src/runtime/runtime-fingerprint.js";

test("parseFingerprintCommit extracts the last commit value", () => {
  const line = '[RUNTIME FINGERPRINT] root="C:/x" | entry="src/bootstrap.js" | bot="admin" | pid=42 | commit="abc1234"\n';
  assert.equal(parseFingerprintCommit(line), "abc1234");
  assert.equal(parseFingerprintCommit("no fingerprint here"), null);
});

test("isProcessStale: online app running an older commit is stale", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  mkdirSync(path.join(root, "logs", "admin"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "admin", "runtime.log"),
    '[RUNTIME FINGERPRINT] pid=1 | commit="oldcommit"\n',
    "utf8",
  );
  const result = await isProcessStale({
    root,
    pm2Name: "admin",
    currentCommit: "newcomm1",
    // Old commit observed in logs
    readLogDirs: () => ["admin"],
    readLogText: (rel) => (rel.includes("runtime.log") ? '[RUNTIME FINGERPRINT] pid=1 | commit="oldcommit"\n' : ""),
  });
  assert.equal(result.stale, true);
  assert.equal(result.observedCommit, "oldcommit");
});

test("isProcessStale: current commit or missing telemetry is not stale", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  const fresh = await isProcessStale({
    root, pm2Name: "admin", currentCommit: "abc1234",
    readLogDirs: () => ["admin"],
    readLogText: () => '[RUNTIME FINGERPRINT] commit="abc1234"\n',
  });
  assert.equal(fresh.stale, false);

  const noTelemetry = await isProcessStale({
    root, pm2Name: "ghost", currentCommit: "abc1234",
    readLogDirs: () => [],
    readLogText: () => "",
  });
  assert.equal(noTelemetry.stale, false, "missing telemetry must not block startup");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/runtime-pm2/fingerprint-guard.test.js`
Expected: FAIL "Cannot find module ... runtime-fingerprint.js"

- [ ] **Step 3: Implement `src/runtime/runtime-fingerprint.js`**

```js
/**
 * Runtime fingerprint guard: detect PM2 `online` apps still running code from
 * an older git commit. Reads the bot runtime logs for the most recent
 * [RUNTIME FINGERPRINT] line (written by src/bootstrap.js at boot).
 *
 * Missing telemetry is NEVER treated as stale: the reconcile path must not
 * block startup just because logs were rotated. Staleness is only asserted
 * on positive evidence of an older commit.
 */

import fs from "node:fs";
import path from "node:path";

const FINGERPRINT_RE = /\[RUNTIME FINGERPRINT\][^\n]*commit="([0-9a-fA-F]+)"/g;

export function parseFingerprintCommit(text) {
  if (!text) return null;
  let match = null;
  for (const m of text.matchAll(FINGERPRINT_RE)) match = m;
  return match ? match[1] : null;
}

/** Overridable IO for tests. */
function defaultReadLogDirs(root) {
  const logsDir = path.join(root, "logs");
  try {
    return fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}

function defaultReadLogText(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), "utf8").slice(-200_000);
  } catch { return ""; }
}

/**
 * @param {object} params
 * @param {string} params.root project root
 * @param {string} params.pm2Name PM2 app name (= botKey)
 * @param {string} params.currentCommit full or short SHA from git HEAD
 * @param {Function} [params.readLogDirs] test override
 * @param {Function} [params.readLogText] test override
 * @returns {Promise<{stale:boolean, observedCommit:string|null}>}
 */
export async function isProcessStale({
  root,
  pm2Name,
  currentCommit,
  readLogDirs = (r) => defaultReadLogDirs(r),
  readLogText = (r, rel) => defaultReadLogText(r, rel),
}) {
  const dirs = readLogDirs(root);
  const candidates = [pm2Name, "bot-stdout.log"];
  for (const dir of dirs) {
    if (!candidates.includes(dir)) continue;
    const commit = parseFingerprintCommit(readLogText(root, path.join("logs", dir, "runtime.log")));
    if (commit && currentCommit && !commit.startsWith(currentCommit.slice(0, 7))) {
      return { stale: true, observedCommit: commit };
    }
    if (commit) return { stale: false, observedCommit: commit };
  }
  // Main bot fallback: logs/bot-stdout.log fingerprint lines.
  const mainCommit = parseFingerprintCommit(readLogText(root, path.join("logs", "bot-stdout.log")));
  if (mainCommit && currentCommit && !mainCommit.startsWith(currentCommit.slice(0, 7))) {
    return { stale: true, observedCommit: mainCommit };
  }
  return { stale: false, observedCommit: mainCommit };
}
```

- [ ] **Step 4: Wire into reconcile**

In `src/runtime/reconcile-and-monitor.js`:

1. Import: `import { isProcessStale } from './runtime-fingerprint.js';` and `import { execSync } from 'node:child_process';` (or reuse a git helper — use `execFileSync` with `git rev-parse HEAD` in a small helper `currentCommitShort(root)` wrapped in try/catch returning `null` on failure; `null` disables the guard).
2. Add helper:
```js
function currentCommitShort() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim().slice(0, 7);
  } catch { return null; }
}
```
3. In `startDashboard`, `startGuardian`, `startMain`: when the app is found `online`, check staleness before skipping:
```js
if (main && main.status === 'online') {
  const commit = currentCommitShort();
  const staleInfo = commit ? await isProcessStale({ root: PROJECT_ROOT, pm2Name: 'admin', currentCommit: commit }) : { stale: false };
  if (!staleInfo.stale) {
    console.log('[reconcile] Main bot already online, skipping');
    return;
  }
  console.warn(`[reconcile] Main bot runs OLD code (commit ${staleInfo.observedCommit} != ${commit}) — restarting from current source`);
  const restartResult = await adapter.restartBot('admin');
  if (restartResult.success) return;
  console.warn(`[reconcile] Restart failed: ${restartResult.reason} — falling through to start-or-adopt`);
}
```
Apply the same pattern for `mybot-dashboard`, `mybot-guardian` (pm2Name = those names, log dir = 'dashboard'/'guardian' — if those log dirs don't exist, the guard no-ops safely), and inside `restoreChildBots` for each candidate (`pm2Name` = bot.botKey||bot.uid).
4. Do NOT check staleness when `currentCommitShort()` returns null (git unavailable) — log once: `[reconcile] git unavailable; fingerprint guard disabled`.

- [ ] **Step 5: Run tests**

Run: `node --test --test-force-exit tests/runtime-pm2/fingerprint-guard.test.js tests/runtime-pm2/pm2-adapter.test.js tests/runtime-pm2/terminal-monitor.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/runtime-fingerprint.js src/runtime/reconcile-and-monitor.js tests/runtime-pm2/fingerprint-guard.test.js
git commit -m "fix(reconcile): restart online PM2 apps running stale-commit code"
```

---

### Task 4: Status schema v2 on the API (`statusSchemaVersion`, `supervisor`, `readiness`, `reason`)

**Files:**
- Modify: `src/dashboard/api-routes.js` (line ~353 `/api/bots` route)
- Modify: `src/dashboard/bot-registry.js` (`list()` / `describe()` stamp schema)
- Modify: `dashboard/server.js` (`getDashboardBots()` used by `/api/dashboard/overview`)
- Test: `tests/dashboard/shared-api.test.js` (extend) + new `tests/dashboard/status-schema.test.js`

**Interfaces:**
- Consumes: resolver output shape `{ status, supervisor, readiness, reason }` (already exists).
- Produces: every bot object in `/api/bots`, `/api/bots/:id`, `/api/dashboard/overview` carries:
  - `statusSchemaVersion: 2`
  - `supervisor: { available, status, pid, pm2Id, uptime, restartCount, reason, code }` (already present via registry; ensure overview path too)
  - `readiness: { status, portOpen, identityVerified, reason, checkedAt }`
  - `statusReason: string` (promote resolver `reason` to a top-level field so the frontend doesn't dig into `readiness.reason`)
- Frontend contract: any bot object WITHOUT `statusSchemaVersion === 2` is "old backend" and must be flagged `backend-stale` instead of rendered as `N/A`.

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard/status-schema.test.js
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { BotRegistry } from "../../src/dashboard/bot-registry.js";

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "status-schema-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), "{}", "utf8");
  return root;
}

test("registry describe() stamps statusSchemaVersion 2 with supervisor/readiness/reason", async () => {
  const root = await tempRoot();
  const registry = new BotRegistry({
    root,
    pm2: { getProcessStatus: async () => ({ available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 }) },
  });
  const bot = await registry.describe("admin");
  assert.equal(bot.statusSchemaVersion, 2);
  assert.equal(bot.statusReason, "pm2-stopped");
  assert.equal(bot.supervisor.status, null);
  assert.ok(bot.readiness);
});

test("registry describe() degrades to schema v2 with unknown + pm2-unavailable when daemon is down", async () => {
  const root = await tempRoot();
  const registry = new BotRegistry({
    root,
    pm2: { getProcessStatus: async () => ({ available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: "daemon down", code: "daemon_unavailable" }) },
  });
  const bot = await registry.describe("admin");
  assert.equal(bot.statusSchemaVersion, 2);
  assert.equal(bot.status, "unknown");
  assert.equal(bot.statusReason, "daemon down" === bot.statusReason ? bot.statusReason : bot.statusReason);
  assert.equal(bot.supervisor.available, false);
});
```

Note: second test's `statusReason` assertion just pins presence; exact reason string comes from resolver (`pm2-unavailable` family).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/dashboard/status-schema.test.js`
Expected: FAIL (`statusSchemaVersion` undefined).

- [ ] **Step 3: Implement**

In `src/dashboard/bot-registry.js` `describe()` return object, add:
```js
statusSchemaVersion: 2,
statusReason: runtime.reason || runtime.readiness?.reason || null,
```
(`runtime.reason` comes from the resolver; the resolver-failure fallback in `runtime()` must also set `reason: "resolver-unavailable"` — it already does.)

In `dashboard/server.js` `getDashboardBots()`, add the same fields to the pushed object:
```js
statusSchemaVersion: 2,
statusReason: resolved.reason || resolved.readiness?.reason || null,
```
and ensure `supervisor`/`readiness` are always objects (they are, from the resolver).

No change needed in `api-routes.js` (it returns `registry.list()` verbatim, which now includes the new fields).

- [ ] **Step 4: Run tests**

Run: `node --test --test-force-exit tests/dashboard/status-schema.test.js tests/dashboard/bot-registry-consistency.test.js tests/dashboard/shared-api.test.js`
Expected: PASS (note: `shared-api.test.js` "command scan API exposes runtime enablement" is a KNOWN pre-existing failure on this Windows machine per project memory — if it fails identically before and after your change, it is not yours).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/bot-registry.js dashboard/server.js tests/dashboard/status-schema.test.js
git commit -m "feat(dashboard): stamp bot status schema v2 (statusSchemaVersion/supervisor/readiness/statusReason)"
```

---

### Task 5: Frontend overview renders backend-stale banner instead of `N/A`

**Files:**
- Modify: `dashboard/src/components/overview-panel.jsx`
- Modify: `dashboard/public/js/app.js` ONLY if the public legacy bundle also renders bot status (grep `n/a` there; the served asset root prefers `dist/`)
- Test: manual + `npm run dashboard:build` must succeed (no JS test harness for the React side; visual check via `dashboard-ui-verification/` convention)

**Interfaces:**
- Consumes: `statusSchemaVersion`, `statusReason` from Task 4.
- Produces: `function botStatusLabel(bot)` → `"backend-stale"` marker + banner text `"Backend cũ — cần restart mybot-dashboard"` when `bot.statusSchemaVersion !== 2`; `N/A` is never rendered as a bot status.

- [ ] **Step 1: Implement**

In `overview-panel.jsx`:

1. Add at top:
```jsx
const BACKEND_STALE = "Backend cũ — cần restart mybot-dashboard";

function isBackendStale(bot) {
  return bot && bot.statusSchemaVersion !== 2;
}
```
2. Replace `readinessLabel`'s `return status || "n/a";` with:
```jsx
if (isBackendStale(bot)) return "backend-stale";
return status || "unknown";
```
3. Replace `pm2Label`'s `return status || "n/a";` with:
```jsx
if (isBackendStale(bot)) return "backend-stale";
return status || "unknown";
```
4. In the bots table row, when `isBackendStale(bot)`, render the status cell as the banner text (add `title={BACKEND_STALE}` tooltip) and add one banner above the table when ANY visible bot is stale:
```jsx
{visibleBots.some(isBackendStale) ? (
  <div className="notice" role="alert">{BACKEND_STALE}</div>
) : null}
```
5. Keep colors: map `backend-stale` tone to `issue` in both label functions' className logic.

- [ ] **Step 2: Build the dashboard**

Run: `npm run dashboard:build`
Expected: build completes without errors; `dashboard/dist/assets/*.js` regenerated.

- [ ] **Step 3: Verify served bundle picks it up**

Grep the freshly built `dashboard/dist/assets/index-*.js` for `Backend cũ`:
Expected: 1+ match.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/overview-panel.jsx dashboard/dist
git commit -m "fix(dashboard-ui): show backend-stale banner instead of N/A for old schema responses"
```

---

### Task 6: `run.bat` restore preserves registry running/stopped state + full focused test sweep

**Files:**
- Verify (no code change expected): `src/commands/mybot/System/mybot-auto-restore.js`, `src/runtime/reconcile-and-monitor.js` from Task 3
- Test: existing suites

**Interfaces:**
- Consumes: Task 1-3 outputs.
- Produces: green focused suites proving (a) updater leaves registry untouched, (b) reconcile restores only `status === "running"` candidates, (c) resolver ladder is intact.

- [ ] **Step 1: Verify registry preservation**

The updater's `copyPersistentData`/`restorePersistentData` already treat `mybot/` as persistent (PERSISTENT_PATHS includes `mybot`) and the restore loop skips tracked paths unless in `RESTORABLE_TRACKED_PATHS`. Confirm `mybot/mybots.json` is NOT in `RESTORABLE_TRACKED_PATHS` (it is not) — registry survives update unchanged. Existing test `safe updater force-syncs source while preserving VPS runtime data` covers this. No code change.

Run: `node --test --test-force-exit tests/safe-update.test.js`
Expected: PASS.

- [ ] **Step 2: Run the full focused sweep (bounded, ~3-4 min)**

Run:
```
node --test --test-force-exit tests/safe-update.test.js tests/runtime-pm2 tests/dashboard/status-schema.test.js tests/dashboard/runtime-status-resolver.test.js tests/dashboard/bot-registry-consistency.test.js
```
Expected: PASS (except the documented pre-existing `shared-api.test.js` failure if it is in the selected set — it is not).

- [ ] **Step 3: Lint + import audit**

Run: `npm run lint` (bounded)
Run: `npm run audit:imports`
Expected: no NEW violations vs. baseline.

- [ ] **Step 4: Commit (if anything was touched) + prepare push**

```bash
git status
```
Expected: only intended files modified.

- [ ] **Step 5: Push to origin/master**

```bash
git push origin master
```
Expected: push succeeds; report the pushed SHA range.

---

## Acceptance mapping (spec → tasks)

| Spec item | Task |
|---|---|
| Updater stops whole fleet via PM2 (infra + env-marker/registry children) | 1, 2 |
| No `pm2 kill`, no foreign-app impact | 1 (scope filter), 2 |
| Verify all targets `stopped` before `git reset`, else abort | 2 |
| Registry running/stopped preserved | 6 Step 1 (already true, verified by test) |
| `run.bat` restarts PM2 `stopped` apps from current source | 3 (reconcile already restarts stopped; Task 3 adds stale-online guard) |
| No adopting `online` apps with old-commit fingerprint | 3 |
| Dashboard/guardian/main/children keep running after monitor closes | unchanged behavior; verified by design (monitor-only foreground) |
| `statusSchemaVersion: 2`, `supervisor`, `readiness`, `reason` | 4 |
| PM2 online ≠ running; running needs port+identity+live UID | existing resolver (regression-tested) |
| Stored PID never upgrades to running | existing resolver (regression-tested) |
| Old-schema response → "Backend cũ — cần restart mybot-dashboard", not `N/A` | 5 |
| `stopped/process-missing`, `unknown/pm2-unavailable`, `identity-mismatch` | existing resolver reasons (regression-tested) |
| Focused tests, build, lint, import audit | 6 |
| Push to GitHub master | 6 Step 5 |

## VPS acceptance (manual, not automatable here)

- `update.bat` then `run.bat`: local SHA == remote SHA, `pm_uptime` regenerated (fresh), runtime fingerprint log line carries the new SHA.
- Dashboard shows specific PM2 status per bot, never `N/A`.
- Main + each child reach `readiness=ready`.
- Real Zalo message via Main and one Child proves listeners.
