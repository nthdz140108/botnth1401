import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function readNormalized(filePath) {
  return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

test("safe updater force-syncs source while preserving VPS runtime data", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-update-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");

  run("git", ["init", "--bare", remote], fixtureRoot);
  mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Safe Update Test"], seed);
  write(seed, "app.txt", "version-1\n");
  write(seed, ".env.local", "TOKEN=remote-v1\n");
  write(seed, "assets/data/group_settings.json", "{\"remote\":1}\n");
  write(seed, "assets/data/list_admin_high.json", "[\"high-v1\"]\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);

  write(deploy, ".env.local", "TOKEN=vps-secret\n");
  write(deploy, "assets/data/group_settings.json", "{\"vps\":true}\n");
  write(deploy, "assets/data/list_admin_high.json", "[\"stale-vps-admin\"]\n");
  write(deploy, "mybot/state/admin-recovery.lock", "{\"pid\":123}\n");

  write(seed, "app.txt", "version-2\n");
  write(seed, ".env.local", "TOKEN=remote-v2\n");
  write(seed, "assets/data/group_settings.json", "{\"remote\":2}\n");
  write(seed, "assets/data/list_admin_high.json", "[\"high-v2\"]\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2"], seed);
  run("git", ["push", "origin", "master"], seed);

  const updater = path.resolve(import.meta.dirname, "..", "scripts", "safe-update.js");
  const result = spawnSync(process.execPath, [
    updater,
    "--root", deploy,
    "--skip-process-stop",
    "--skip-install",
    "--skip-restart",
  ], { encoding: "utf8", timeout: 30000 });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readNormalized(path.join(deploy, "app.txt")), "version-2\n");
  assert.equal(readNormalized(path.join(deploy, ".env.local")), "TOKEN=vps-secret\n");
  assert.equal(readNormalized(path.join(deploy, "assets/data/group_settings.json")), "{\"vps\":true}\n");
  assert.equal(readNormalized(path.join(deploy, "assets/data/list_admin_high.json")), "[\"high-v2\"]\n");
  assert.equal(existsSync(path.join(deploy, "mybot/state/admin-recovery.lock")), false);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), run("git", ["rev-parse", "origin/master"], deploy));
  assert.match(result.stdout, /UPDATE VERIFIED/);
  const backupLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("Backup: "));
  assert.ok(backupLine);
  const resolvedBackup = path.resolve(backupLine.slice("Backup: ".length));
  assert.equal(resolvedBackup.startsWith(`${path.resolve(deploy, ".runtime", "backups")}${path.sep}`), true);
});

test("safe updater rolls source back when the fetched revision fails verification", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-rollback-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");

  run("git", ["init", "--bare", remote], fixtureRoot);
  mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Safe Update Test"], seed);
  write(seed, "bot.js", "console.log('v1');\n");
  write(seed, ".env.local", "TOKEN=remote\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);
  write(deploy, ".env.local", "TOKEN=vps-secret\n");

  write(seed, "bot.js", "this is invalid javascript {{{\n");
  run("git", ["add", "bot.js"], seed);
  run("git", ["commit", "-m", "broken"], seed);
  run("git", ["push", "origin", "master"], seed);

  const updater = path.resolve(import.meta.dirname, "..", "scripts", "safe-update.js");
  const result = spawnSync(process.execPath, [
    updater,
    "--root", deploy,
    "--skip-process-stop",
    "--skip-install",
    "--skip-restart",
  ], { encoding: "utf8", timeout: 30000 });

  assert.notEqual(result.status, 0);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead);
  assert.equal(readNormalized(path.join(deploy, ".env.local")), "TOKEN=vps-secret\n");
  assert.match(result.stderr, /ROLLBACK COMPLETE/);
});

test("runtime restart verification requires a live PID, matching fingerprint, and dashboard health", async () => {
  const { verifyRuntimeRestart } = await import("../scripts/safe-update.js");
  const root = mkdtempSync(path.join(os.tmpdir(), "mybot-restart-verify-"));
  write(root, ".bot.pid", `${process.pid}\n`);
  write(root, "logs/bot-stdout.log", `[RUNTIME FINGERPRINT] root="${root}" | entry="src/bootstrap.js" | bot="admin" | pid=${process.pid} | commit="abc1234"\n`);

  const result = await verifyRuntimeRestart({
    root,
    expectedCommit: "abc1234",
    timeoutMs: 100,
    pollMs: 1,
    isProcessAlive: (pid) => pid === process.pid,
    dashboardProbe: async () => true,
  });

  assert.equal(result.pid, process.pid);
});

test("runtime restart verification rejects stale or mismatched fingerprints", async () => {
  const { verifyRuntimeRestart } = await import("../scripts/safe-update.js");
  const root = mkdtempSync(path.join(os.tmpdir(), "mybot-restart-stale-"));
  write(root, ".bot.pid", `${process.pid}\n`);
  const stale = `[RUNTIME FINGERPRINT] root="${root}" | pid=999999 | commit="abc1234"\n`;
  write(root, "logs/bot-stdout.log", stale);

  await assert.rejects(() => verifyRuntimeRestart({
    root,
    expectedCommit: "abc1234",
    logOffset: Buffer.byteLength(stale),
    timeoutMs: 10,
    pollMs: 1,
    isProcessAlive: () => true,
    dashboardProbe: async () => true,
  }), /timed out/);

  const overlappingPid = `[RUNTIME FINGERPRINT] root="${root}" | pid=${process.pid}0 | commit="abc1234"\n`;
  write(root, "logs/bot-stdout.log", overlappingPid);
  await assert.rejects(() => verifyRuntimeRestart({
    root,
    expectedCommit: "abc1234",
    timeoutMs: 10,
    pollMs: 1,
    isProcessAlive: () => true,
    dashboardProbe: async () => true,
  }), /timed out/);
});

test("failed process quiescence preserves the active QR recovery lock", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-stop-failure-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const deploy = path.join(fixtureRoot, "deploy");
  run("git", ["init", "--bare", remote], fixtureRoot);
  mkdirSync(deploy);
  run("git", ["init", "-b", "master"], deploy);
  run("git", ["config", "user.email", "test@example.com"], deploy);
  run("git", ["config", "user.name", "Safe Update Test"], deploy);
  write(deploy, "bot.js", "console.log('running');\n");
  write(deploy, "mybot/state/admin-recovery.lock", "{\"pid\":123}\n");
  run("git", ["add", "."], deploy);
  run("git", ["commit", "-m", "initial"], deploy);
  run("git", ["remote", "add", "origin", remote], deploy);
  run("git", ["push", "-u", "origin", "master"], deploy);

  let stopCalls = 0;
  await assert.rejects(() => runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: false,
    restart: true,
  }, {
    stopProcesses: () => {
      stopCalls += 1;
      throw new Error("cannot stop runtime");
    },
    restartAndVerify: async () => {
      throw new Error("must not restart");
    },
  }), /cannot stop runtime/);

  assert.equal(stopCalls, 2);
  assert.equal(existsSync(path.join(deploy, "mybot/state/admin-recovery.lock")), true);
});

test("failed new-runtime verification stops it before rollback and restarts once", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-runtime-rollback-"));
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
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);
  write(seed, "bot.js", "console.log('v2');\n");
  run("git", ["add", "bot.js"], seed);
  run("git", ["commit", "-m", "v2"], seed);
  run("git", ["push", "origin", "master"], seed);

  const events = [];
  let restartCount = 0;
  await assert.rejects(() => runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: false,
    restart: true,
  }, {
    stopProcesses: () => events.push("stop"),
    restartAndVerify: async () => {
      restartCount += 1;
      events.push(restartCount === 1 ? "restart-new" : "restart-old");
      if (restartCount === 1) throw new Error("new runtime failed verification");
    },
  }), /new runtime failed verification/);

  assert.deepEqual(events, ["stop", "restart-new", "stop", "restart-old"]);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead);
});

test("update.bat treats a negative Node exit code as failure", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-update-bat-"));
  const bin = path.join(fixtureRoot, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(fixtureRoot, ".git"));
  mkdirSync(path.join(fixtureRoot, "scripts"));
  write(fixtureRoot, "scripts/update-bootstrap.js", "process.exit(-1);\n");
  cpSync(path.resolve(import.meta.dirname, "..", "update.bat"), path.join(fixtureRoot, "update.bat"));
  write(bin, "git.cmd", "@if \"%1\"==\"show\" echo process.exit(-1);\r\n@exit /b 0\r\n");

  const result = spawnSync("cmd.exe", ["/d", "/c", "update.bat"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    input: "\n\n",
    timeout: 10000,
    env: { ...process.env, PATH: `${bin};${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /UPDATE FAILED/);
  assert.doesNotMatch(result.stdout, /UPDATE COMPLETE/);
});

test("update.bat delegates to the remote-bundle bootstrap with --root", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-update-bat-inplace-"));
  const bin = path.join(fixtureRoot, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(fixtureRoot, ".git"));
  mkdirSync(path.join(fixtureRoot, "scripts"));
  // Marker script: proves WHICH file node executed, that cwd is the repo root,
  // and that --root points at the repo.
  write(fixtureRoot, "scripts/update-bootstrap.js", [
    "if (process.argv[2] !== '--root') process.exit(3);",
    "console.log('BOOTSTRAP-INVOKED ' + process.cwd());",
    "console.log('SELF-PATH ' + import.meta.url.split('/').pop());",
    "process.exit(0);",
    "",
  ].join("\n"));
  cpSync(path.resolve(import.meta.dirname, "..", "update.bat"), path.join(fixtureRoot, "update.bat"));
  write(bin, "git.cmd", "@echo fetched\r\n@exit /b 0\r\n");

  const result = spawnSync("cmd.exe", ["/d", "/c", "update.bat"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    input: "\n\n",
    timeout: 15000,
    env: { ...process.env, PATH: `${bin};${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const invokedLine = result.stdout.split(/\r?\n/).find((l) => l.startsWith("BOOTSTRAP-INVOKED"));
  assert.ok(invokedLine, `bootstrap must run: ${result.stdout}`);
  assert.match(invokedLine, new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /SELF-PATH update-bootstrap\.js/);
  assert.match(result.stdout, /UPDATE COMPLETE/);
});

test("update.bat fails fast when scripts/update-bootstrap.js is missing", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-update-bat-noscript-"));
  const bin = path.join(fixtureRoot, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(fixtureRoot, ".git"));
  mkdirSync(path.join(fixtureRoot, "scripts")); // exists but WITHOUT the bootstrap
  cpSync(path.resolve(import.meta.dirname, "..", "update.bat"), path.join(fixtureRoot, "update.bat"));
  write(bin, "git.cmd", "@echo fetched\r\n@exit /b 0\r\n");

  const result = spawnSync("cmd.exe", ["/d", "/c", "update.bat"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    input: "\n\n",
    timeout: 15000,
    env: { ...process.env, PATH: `${bin};${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /update-bootstrap\.js not found/);
  assert.match(result.stdout, /UPDATE FAILED/);
  assert.doesNotMatch(result.stdout, /UPDATE COMPLETE/);
});

test("safe updater aborts before git reset when PM2 fleet quiescence fails", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-safe-pm2-quiesce-"));
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
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);
  write(seed, "bot.js", "console.log('v2');\n");
  run("git", ["add", "bot.js"], seed);
  run("git", ["commit", "-m", "v2"], seed);
  run("git", ["push", "origin", "master"], seed);

  const failure = await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: false,
    restart: false,
  }, {
    stopFleetViaPM2: async () => ({
      success: false,
      daemonAvailable: true,
      stopped: [],
      alreadyStopped: [],
      missing: [],
      failed: [{ name: "admin", reason: "pm2_stop_failed" }],
      stillRunning: ["admin"],
    }),
    restartAndVerify: async () => { throw new Error("must not restart"); },
  }).then(() => { throw new Error("expected rejection"); }, (err) => err);

  assert.match(failure.message, /still running|quiesce/i);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], deploy), previousHead,
    "source must NOT change when quiescence fails",
  );
});

test("safe updater proceeds through git reset when PM2 fleet stop succeeds", async () => {
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
  run("git", ["remote", "add", "origin", remote], seed);
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
      return {
        success: true,
        daemonAvailable: true,
        stopped: ["admin"],
        alreadyStopped: [],
        missing: [],
        failed: [],
        stillRunning: [],
      };
    },
  });

  assert.equal(stopCalls.length, 1);
  assert.notEqual(run("git", ["rev-parse", "HEAD"], deploy), previousHead);
});
