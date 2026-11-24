import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopMyBotFleetViaPM2 } from "../src/runtime/fleet-stop.js";
import { installWindowsConsoleSafety } from "../src/runtime/windows-console-guard.js";
import { ensureWin2012CanvasCompat } from "../src/runtime/win2012-canvas-compat.js";

installWindowsConsoleSafety();
import {
  CATALOG_PATH,
  PATH_ROLE,
  PROTECTED_AFTER_UPDATE_PATHS,
  applyPolicyAfterReset,
  buildUpdatePlan,
  clearIndexProtection,
  flaggedPolicyPaths,
  restorePolicyRollback,
  setSkipWorktree,
  verifyPolicyFilesUnchanged,
  writeFileAtomic,
} from "./update-data-policy.js";

export { applyPolicyAfterReset, restorePolicyRollback };

const moduleFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(moduleFile), "..");
const PERSISTENT_PATHS = [
  ".env",
  ".env.local",
  "assets/config.json",
  "assets/data",
  "assets/json-data",
  "mybot",
];

// Tracked files inside PERSISTENT_PATHS that the generic backup/restore may
// copy back over the freshly reset worktree. Runtime-tracked policy files
// (group settings, game data, database config, VIP flags) are restored by the
// policy layer instead — with atomic writes and index-flag re-protection.
const RESTORABLE_TRACKED_PATHS = new Set([
  ".env",
  ".env.local",
  "assets/config.json",
]);

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
}

export function parseArgs(argv) {
  const options = {
    root: defaultRoot,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: true,
    restart: true,
    rollback: false,
    backupDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = path.resolve(argv[++index]);
    else if (arg === "--remote") options.remote = argv[++index];
    else if (arg === "--branch") options.branch = argv[++index];
    else if (arg === "--skip-process-stop") options.stopProcesses = false;
    else if (arg === "--skip-fleet-stop") options.stopProcesses = false;
    else if (arg === "--skip-install") options.install = false;
    else if (arg === "--skip-restart" || arg === "--no-restart") options.restart = false;
    else if (arg === "--rollback") {
      options.rollback = true;
      const nextArg = argv[index + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        options.backupDir = path.resolve(argv[++index]);
      }
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args, { cwd } = {}) {
  const isWindows = process.platform === "win32";
  const executable = isWindows && command === "npm" ? "npm.cmd" : command;
  const useShell = isWindows && (command === "npm" || String(command).endsWith(".cmd") || String(command).endsWith(".bat"));
  const result = spawnSync(executable, args, {
    cwd,
    env: {
      ...process.env,
      NODE_SKIP_PLATFORM_CHECK: "1",
      YOUTUBE_DL_SKIP_PYTHON_CHECK: "1",
      YOUTUBE_DL_SKIP_DOWNLOAD: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: useShell,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function copyPersistentData(root, backupRoot) {
  const runtimeBackup = path.join(backupRoot, "runtime");
  const mybotLogsDir = path.resolve(root, "mybot", "logs");
  for (const relativePath of PERSISTENT_PATHS) {
    const source = path.join(root, relativePath);
    if (!existsSync(source)) continue;
    const destination = path.join(runtimeBackup, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      force: true,
      filter: (src) => {
        const resolved = path.resolve(src);
        return resolved !== mybotLogsDir && !resolved.startsWith(`${mybotLogsDir}${path.sep}`);
      },
    });
  }
}

function pruneOldUpdateBackups(backupParent, keepBackupRoot) {
  try {
    if (!existsSync(backupParent)) return;
    const keepName = path.basename(keepBackupRoot);
    for (const entry of readdirSync(backupParent)) {
      if (!entry.startsWith("safe-update_") || entry === keepName) continue;
      rmSync(path.join(backupParent, entry), { recursive: true, force: true });
    }
  } catch {
    // Best-effort snapshot pruning
  }
}

function restorePersistentData(root, backupRoot) {
  const runtimeBackup = path.join(backupRoot, "runtime");
  const tracked = new Set(run("git", ["ls-files", "-z"], { cwd: root })
    .split("\0").filter(Boolean).map((entry) => entry.replaceAll("\\", "/")));

  const restoreTree = (source, destination, relativePath) => {
    if (!existsSync(source)) return;
    if (statSync(source).isDirectory()) {
      for (const entry of readdirSync(source)) {
        restoreTree(path.join(source, entry), path.join(destination, entry), path.join(relativePath, entry));
      }
      return;
    }
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (tracked.has(normalizedPath) && !RESTORABLE_TRACKED_PATHS.has(normalizedPath)) return;
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { force: true });
  };

  for (const relativePath of PERSISTENT_PATHS) {
    restoreTree(path.join(runtimeBackup, relativePath), path.join(root, relativePath), relativePath);
  }
}

function writeRecoveryEvidence(root, backupRoot, previousHead) {
  writeFileSync(path.join(backupRoot, "local-changes.patch"), run("git", ["diff", "--binary", "HEAD"], { cwd: root }), "utf8");
  writeFileSync(path.join(backupRoot, "git-status.txt"), run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root }), "utf8");
  writeFileSync(path.join(backupRoot, "previous-head.txt"), `${previousHead}\n`, "utf8");
}

function writeIndexFlagsEvidence(backupRoot, flags) {
  const lines = [...flags.entries()]
    .map(([relativePath, flagChar]) => `${flagChar}\t${relativePath}`)
    .join("\n");
  writeFileSync(path.join(backupRoot, "index-flags.txt"), `${lines}\n`, "utf8");
}

function writeMergeReport(backupRoot, report) {
  writeFileSync(path.join(backupRoot, "merge-report.json"), JSON.stringify(report, null, 2), "utf8");
}


function isProcessAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readEnvPort(filePath, key) {
  if (!existsSync(filePath)) return 0;
  const line = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim() && !entry.trim().startsWith("#") && entry.split("=", 1)[0].trim() === key);
  if (!line) return 0;
  const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function resolveDashboardPort(root) {
  const environmentPort = Number(process.env.DASHBOARD_PORT);
  if (Number.isInteger(environmentPort) && environmentPort > 0 && environmentPort <= 65535) {
    return environmentPort;
  }
  return readEnvPort(path.join(root, ".env.local"), "DASHBOARD_PORT")
    || readEnvPort(path.join(root, ".env"), "DASHBOARD_PORT")
    || 4173;
}

async function dashboardProbeDefault(root) {
  try {
    const port = resolveDashboardPort(root);
    const response = await fetch(`http://127.0.0.1:${port}/api/system/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBoundedLog(logPath, offset, maxBytes = 100000) {
  if (!existsSync(logPath)) return "";
  const size = statSync(logPath).size;
  const start = size < offset ? 0 : offset;
  const length = Math.min(Math.max(0, size - start), maxBytes);
  if (length === 0) return "";
  const descriptor = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function hasMatchingFingerprint(text, { root, pid, commit }) {
  return text.split(/\r?\n/).some((line) => {
    if (!line.startsWith("[RUNTIME FINGERPRINT]")) return false;
    const rootMatch = line.match(/(?:^|\s)root="([^"]*)"/);
    const pidMatch = line.match(/(?:^|\s)pid=(\d+)(?:\s*\||$)/);
    const commitMatch = line.match(/(?:^|\s)commit="([^"]*)"/);
    return rootMatch?.[1] === root
      && Number(pidMatch?.[1]) === Number(pid)
      && commitMatch?.[1] === commit;
  });
}

/**
 * Legacy PID/fingerprint verification kept for tests and manual diagnosis.
 * The default restart path no longer uses it: restart goes through PM2
 * reconcile so `.bot.pid`-based liveness never gates the update flow
 * (a stored PID must never prove a bot is running).
 */
export async function verifyRuntimeRestart({
  root,
  expectedCommit,
  logOffset = 0,
  timeoutMs = 45000,
  pollMs = 500,
  isProcessAlive = isProcessAliveDefault,
  dashboardProbe = dashboardProbeDefault,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const pidPath = path.join(root, ".bot.pid");
  const logPath = path.join(root, "logs", "bot-stdout.log");
  while (Date.now() <= deadline) {
    const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : 0;
    const fingerprint = readBoundedLog(logPath, logOffset);
    const matchesRuntime = hasMatchingFingerprint(fingerprint, {
      root,
      pid,
      commit: expectedCommit,
    });
    if (pid > 0 && isProcessAlive(pid) && matchesRuntime && await dashboardProbe(root)) {
      return { pid };
    }
    await delay(pollMs);
  }
  throw new Error(`Runtime verification timed out for commit ${expectedCommit}`);
}

/**
 * Restart the MyBot fleet from CURRENT source via PM2 reconcile.
 *
 * Used only when the updater is invoked WITHOUT --skip-restart by an operator
 * who explicitly wants the fleet back up. Delegates to
 * src/runtime/reconcile-and-monitor.js --reconcile-only so the exact same
 * start-or-adopt + fleet-verification path as run.bat executes (no interactive
 * monitor window, no .bot.pid dependency).
 */
async function restartFleetViaPM2(root, commit) {
  console.log(`[restart] Restarting MyBot fleet via PM2 reconcile (commit ${commit.slice(0, 7)})...`);
  run(process.execPath, [path.join(root, "src", "runtime", "reconcile-and-monitor.js"), "--reconcile-only"], { cwd: root });
}

export async function runSafeUpdate(options, dependencies = {}) {
  const root = path.resolve(options.root);
  const remoteRef = `${options.remote}/${options.branch}`;
  if (!existsSync(path.join(root, ".git"))) throw new Error(`Not a Git repository: ${root}`);

  const previousHead = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  let backupRoot = null;
  let processesStopped = false;
  let resetApplied = false;
  let plan = null;
  // stopFleetViaPM2 is the PM2-native contract (returns a quiescence result).
  // stopProcesses remains the legacy injectable key used by existing tests —
  // it is wrapped so its side effects always yield a failure-shaped result
  // unless it returns a structured one.
  const stopFleet = dependencies.stopFleetViaPM2
    || ((fleetRoot) => stopMyBotFleetViaPM2({ projectRoot: fleetRoot }));
  const stopRuntime = dependencies.stopProcesses || null;
  const startRuntime = dependencies.restartAndVerify || restartFleetViaPM2;

  if (options.rollback) {
    const backupParent = path.join(root, ".runtime", "backups");
    let targetBackup = options.backupDir;
    if (!targetBackup && existsSync(backupParent)) {
      const candidates = readdirSync(backupParent)
        .filter((entry) => entry.startsWith("safe-update_"))
        .sort()
        .reverse();
      if (candidates.length > 0) targetBackup = path.join(backupParent, candidates[0]);
    }
    if (!targetBackup || !existsSync(targetBackup)) {
      throw new Error("No safe-update backup snapshot found in .runtime/backups for --rollback");
    }
    if (options.stopProcesses) {
      await stopFleet(root);
      if (stopRuntime) await stopRuntime(root);
    }
    const prevHeadFile = path.join(targetBackup, "previous-head.txt");
    const targetHead = existsSync(prevHeadFile)
      ? readFileSync(prevHeadFile, "utf8").trim()
      : previousHead;
    if (targetHead) {
      run("git", ["reset", "--hard", targetHead], { cwd: root });
    }
    restorePersistentData(root, targetBackup);
    rmSync(path.join(root, "mybot", "state", "admin-recovery.lock"), { force: true });
    if (options.restart) await startRuntime(root, targetHead || previousHead);
    console.log(`ROLLBACK COMPLETE: ${(targetHead || previousHead).slice(0, 7)}`);
    return { head: targetHead || previousHead, backupRoot: targetBackup, rolledBack: true };
  }
  try {
    console.log(`[1/8] Fetching ${remoteRef}...`);
    run("git", ["fetch", options.remote, options.branch], { cwd: root });
    run("git", ["rev-parse", "--verify", remoteRef], { cwd: root });

    console.log("[1/8] Preflight: planning tracked-data policy (merge/flags)...");
    plan = buildUpdatePlan({ root, previousHead, remoteRef });
    const flaggedPaths = flaggedPolicyPaths(plan);
    if (flaggedPaths.length) {
      console.log(`[1/8] skip-worktree/assume-unchanged flags detected on: ${flaggedPaths.join(", ")}`);
    }
    const missingRuntime = [];
    for (const [relativePath, snapshot] of plan.files) {
      if (snapshot.role === PATH_ROLE.RUNTIME_TRACKED && !snapshot.vpsExists) {
        missingRuntime.push(relativePath);
      }
    }
    if (missingRuntime.length) {
      for (const missingPath of missingRuntime) {
        console.log(`[1/8] Preserved missing runtime file: ${missingPath}`);
      }
    }

    console.log("[2/8] Stopping MyBot PM2 fleet...");
    if (options.stopProcesses) {
      processesStopped = true;
      const stopResult = await stopFleet(root);
      if (stopRuntime) {
        // Legacy injectable stop: keep its exception-based contract.
        await stopRuntime(root);
      } else if (!stopResult || stopResult.success !== true) {
        const detail = stopResult?.failed?.map((f) => `${f.name}: ${f.reason}`).join("; ")
          || (Array.isArray(stopResult?.stillRunning) && stopResult.stillRunning.length
            ? stopResult.stillRunning.join(", ")
            : "unknown");
        throw new Error(
          `PM2 fleet did not quiesce before update (still running: ${detail}). `
          + "Aborting BEFORE git reset — source unchanged. Stop the fleet with `pm2 stop <name>` "
          + "(or fix the PM2 daemon), then rerun update.bat.",
        );
      }
      if (stopResult?.success === true) {
        console.log(`[2/8] PM2 fleet stopped: ${stopResult.stopped.join(", ") || "(none were running)"}`);
        if (stopResult.daemonAvailable === false) {
          console.log("[2/8] PM2 daemon down — no supervised process can autorestart old code.");
        }
      }
    }

    const backupParent = path.join(root, ".runtime", "backups");
    backupRoot = path.join(backupParent, `safe-update_${timestamp()}_${process.pid}`);
    mkdirSync(backupRoot, { recursive: true });
    console.log(`[3/8] Backing up VPS data to ${backupRoot}`);
    copyPersistentData(root, backupRoot);
    writeRecoveryEvidence(root, backupRoot, previousHead);
    writeIndexFlagsEvidence(backupRoot, plan.flags);

    console.log("[4/8] Verifying planned files are unchanged...");
    verifyPolicyFilesUnchanged(root, plan);

    console.log(`[4/8] Clearing index protection flags for policy files...`);
    for (const [relativePath, snapshot] of plan.files) {
      if (snapshot.flagged && snapshot.tracked) clearIndexProtection(root, relativePath);
    }

    console.log(`[4/8] Force-syncing tracked source to ${remoteRef}...`);
    run("git", ["reset", "--hard", remoteRef], { cwd: root });
    resetApplied = true;

    console.log("[5/8] Restoring VPS runtime data + applying catalog merge...");
    restorePersistentData(root, backupRoot);
    const applied = applyPolicyAfterReset(root, plan);
    if (plan.catalog.mergeNeeded && plan.catalog.report) {
      writeMergeReport(backupRoot, plan.catalog.report);
      console.log(`[5/8] Catalog merge report: ${path.join(backupRoot, "merge-report.json")}`);
    }
    if (applied.restored.length) {
      console.log(`[5/8] Restored VPS runtime data: ${applied.restored.join(", ")}`);
    }
    if (applied.preservedMissing?.length) {
      for (const missingPath of applied.preservedMissing) {
        console.log(`[5/8] Preserved missing runtime file: ${missingPath}`);
      }
    }
    if (applied.reprotected.length) {
      console.log(`[5/8] Re-protected with skip-worktree: ${applied.reprotected.join(", ")}`);
    }

    if (options.install) {
      console.log("[6/8] Installing dependencies...");
      run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root });
      const runtimeYtDlp = path.join(root, ".runtime", "bin", "yt-dlp.exe");
      const ytExecBinDir = path.join(root, "node_modules", "youtube-dl-exec", "bin");
      if (existsSync(runtimeYtDlp)) {
        try {
          mkdirSync(ytExecBinDir, { recursive: true });
          cpSync(runtimeYtDlp, path.join(ytExecBinDir, "yt-dlp.exe"), { force: true });
        } catch {}
      }
      await ensureWin2012CanvasCompat({ projectRoot: root });
      if (!existsSync(path.join(root, "dashboard", "dist", "index.html"))
        && existsSync(path.join(root, "dashboard", "vite.config.js"))
        && existsSync(path.join(root, "node_modules", "vite"))) {
        console.log("[6/8] Building Web Dashboard...");
        run("npm", ["run", "dashboard:build"], { cwd: root });
      }
    } else {
      console.log("[6/8] Dependency install skipped.");
    }

    console.log("[7/8] Verifying source and commit...");
    if (existsSync(path.join(root, "bot.js"))) run(process.execPath, ["--check", "bot.js"], { cwd: root });
    const head = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
    const expected = run("git", ["rev-parse", remoteRef], { cwd: root }).trim();
    if (head !== expected) throw new Error(`HEAD mismatch: ${head} != ${expected}`);

    rmSync(path.join(root, "mybot", "state", "admin-recovery.lock"), { force: true });
    if (options.restart) await startRuntime(root, head);
    pruneOldUpdateBackups(backupParent, backupRoot);
    console.log(`[8/8] UPDATE VERIFIED: ${head.slice(0, 7)}`);
    console.log(`Backup: ${backupRoot}`);
    return { head, backupRoot };
  } catch (error) {
    const rollbackErrors = [];
    let runtimeQuiesced = true;
    if (processesStopped) {
      // Re-quiesce before rollback: PM2 fleet stop is idempotent (stopping a
      // stopped fleet is a no-op success), the legacy injectable may throw.
      try {
        const reStop = await stopFleet(root);
        if (stopRuntime) await stopRuntime(root);
        if (reStop?.success !== true) {
          const detail = reStop?.failed?.map((f) => `${f.name}: ${f.reason}`).join("; ")
            || (Array.isArray(reStop?.stillRunning) && reStop.stillRunning.length
              ? reStop.stillRunning.join(", ")
              : "unknown");
          throw new Error(`PM2 fleet still running during rollback: ${detail}`);
        }
      } catch (stopError) {
        runtimeQuiesced = false;
        rollbackErrors.push(stopError.message);
      }
    }
    if (resetApplied && runtimeQuiesced) {
      try {
        run("git", ["reset", "--hard", previousHead], { cwd: root });
        if (backupRoot) restorePersistentData(root, backupRoot);
        restorePolicyRollback(root, plan);
        if (options.install) run("npm", ["install", "--no-audit"], { cwd: root });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    if (runtimeQuiesced) {
      rmSync(path.join(root, "mybot", "state", "admin-recovery.lock"), { force: true });
    }
    if (processesStopped && options.restart && runtimeQuiesced && rollbackErrors.length === 0) {
      try {
        await startRuntime(root, previousHead);
      } catch (restartError) {
        rollbackErrors.push(restartError.message);
      }
    }
    if (resetApplied && rollbackErrors.length === 0) console.error(`ROLLBACK COMPLETE: ${previousHead.slice(0, 7)}`);
    const suffix = rollbackErrors.length ? `\nRollback errors:\n${rollbackErrors.join("\n")}` : "";
    throw new Error(`${error.message}${suffix}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === moduleFile;
if (isMain) {
  try {
    await runSafeUpdate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`UPDATE FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
