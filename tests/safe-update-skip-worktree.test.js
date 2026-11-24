import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Regression fixtures for the exact VPS failure that blocked safe updates:
 * lock-data.bat flagged tracked data files with skip-worktree, the worktree
 * copies differed from the index, and the new revision changed the same
 * files — so `git reset --hard origin/master` died with
 * "Entry '...' not uptodate. Cannot merge." (exit 128) and HEAD stayed on the
 * old revision.
 */

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

function readNormalized(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function assertNoTempFiles(root) {
  const dirs = ["assets/json-data", "assets/data", "mybot", "mybot/configs"];
  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      assert.doesNotMatch(entry, /\.tmp-update-/, `temp file left behind in ${dir}: ${entry}`);
    }
  }
}

function indexFlags(root) {
  const flags = new Map();
  for (const line of run("git", ["ls-files", "-v"], root).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z])\s(.+)$/);
    if (match) flags.set(match[2].replaceAll("\\", "/"), match[1]);
  }
  return flags;
}

function buildFixture(fixtureRoot, { seedFiles }) {
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");
  run("git", ["init", "--bare", remote], fixtureRoot);
  mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Skip Worktree Test"], seed);
  const allSeedFiles = {
    ".gitignore": ".runtime/\n",
    ...seedFiles,
  };
  for (const [relativePath, content] of Object.entries(allSeedFiles)) write(seed, relativePath, content);
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);
  return { remote, seed, deploy };
}

function catalogJson(commands) {
  return `${JSON.stringify({ prefix: "!", commands }, null, 2)}\n`;
}

const BASE_COMMANDS = [
  { name: "help", description: "base help", countdown: 5, active: true, alias: ["menu"] },
  { name: "game", description: "base game", countdown: 5, active: true, alias: [] },
];

test("mergeCatalogFiles combines remote additions with VPS dashboard edits", async () => {
  const { mergeCatalogFiles } = await import("../scripts/update-data-policy.js");
  const base = { prefix: "!", commands: structuredClone(BASE_COMMANDS) };
  const vps = {
    prefix: "!",
    commands: [
      { ...BASE_COMMANDS[0] },
      { ...BASE_COMMANDS[1], countdown: 7 },
      { name: "dashboardcustom", description: "made on the VPS", countdown: 1, active: true, alias: [] },
    ],
  };
  const remote = {
    prefix: "!",
    commands: [
      { ...BASE_COMMANDS[0], description: "remote help text" },
      { ...BASE_COMMANDS[1] },
      { name: "cmdadd", description: "Tạo lệnh phản hồi động dùng chung", countdown: 30, active: true, alias: [] },
    ],
  };

  const result = mergeCatalogFiles({ base, vps, remote });
  assert.equal(result.ok, true, JSON.stringify(result.report, null, 2));
  const names = result.merged.commands.map((entry) => entry.name);
  assert.ok(names.includes("cmdadd"), "remote-new command must be kept");
  assert.ok(names.includes("dashboardcustom"), "VPS-only created command must be kept");
  assert.equal(result.merged.commands.find((entry) => entry.name === "help").description, "remote help text");
  assert.equal(result.merged.commands.find((entry) => entry.name === "game").countdown, 7, "VPS-only field edit must win");
  assert.ok(result.report.remoteNew.includes("cmdadd"));
  assert.ok(result.report.keptVpsOnly.includes("dashboardcustom"));
});

test("mergeCatalogFiles keeps local deletions and reports divergent edits as conflicts", async () => {
  const { mergeCatalogFiles } = await import("../scripts/update-data-policy.js");
  const base = { prefix: "!", commands: [
    ...structuredClone(BASE_COMMANDS),
    { name: "oldcmd", description: "to delete", countdown: 1, active: true, alias: [] },
    { name: "editedcmd", description: "edited on remote", countdown: 2, active: true, alias: [] },
  ] };
  // VPS deleted oldcmd (remote untouched -> deletion preserved) and also
  // deleted editedcmd while the remote rewrote it -> real conflict.
  const vps = { prefix: "!", commands: structuredClone(BASE_COMMANDS) };
  const remote = { prefix: "!", commands: [
    { ...BASE_COMMANDS[0], countdown: 9 },
    { ...BASE_COMMANDS[1] },
    { name: "editedcmd", description: "remote rewrite", countdown: 4, active: true, alias: [] },
  ] };

  const result = mergeCatalogFiles({ base, vps, remote });
  assert.equal(result.ok, false, "local-delete + remote-edit must be a conflict");
  assert.ok(result.conflicts.some((conflict) => conflict.name === "editedcmd" && conflict.kind === "deleted-locally-modified-remotely"));
});

test("mergeCatalogFiles detects divergent same-field edits and duplicate names", async () => {
  const { mergeCatalogFiles } = await import("../scripts/update-data-policy.js");
  const base = { prefix: "!", commands: structuredClone(BASE_COMMANDS) };
  const vps = { prefix: "!", commands: [{ ...BASE_COMMANDS[0], countdown: 6 }, BASE_COMMANDS[1]] };
  const remote = { prefix: "!", commands: [{ ...BASE_COMMANDS[0], countdown: 9 }, BASE_COMMANDS[1]] };
  const conflict = mergeCatalogFiles({ base, vps, remote });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.conflicts.some((entry) => entry.name === "help" && entry.field === "countdown"));

  const duplicate = mergeCatalogFiles({
    base: { prefix: "!", commands: [] },
    vps: { prefix: "!", commands: [] },
    remote: { prefix: "!", commands: [
      { name: "twice", countdown: 1, active: true, alias: [] },
      { name: "Twice", countdown: 2, active: true, alias: ["menu"] },
      { name: "help", countdown: 1, active: true, alias: ["menudup"] },
    ] },
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.validationErrors.some((message) => /duplicate command name "twice"/i.test(message)));

  const aliasCollision = mergeCatalogFiles({
    base: { prefix: "!", commands: [] },
    vps: { prefix: "!", commands: [] },
    remote: { prefix: "!", commands: [
      { name: "first", countdown: 1, active: true, alias: ["menu"] },
      { name: "second", countdown: 1, active: true, alias: ["menu"] },
    ] },
  });
  assert.equal(aliasCollision.ok, false);
  assert.ok(aliasCollision.validationErrors.some((message) => /alias "menu"/i.test(message)));
});

test("REGRESSION: skip-worktree locked data files no longer block safe update", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-skip-worktree-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
      "assets/data/group_settings.json": "{\"remote\":1}\n",
      "assets/json-data/data-game.json": "{\"coins\":0}\n",
      "mybot/configs/vip-feature-flags.json": "{\"media\":false}\n",
    },
  });

  // lock-data.bat legacy behavior: flag tracked data files, then let the
  // dashboard/runtime dirty them in the worktree.
  run("git", ["update-index", "--skip-worktree",
    "mybot/defaultCommand.json",
    "assets/json-data/command.json",
    "assets/data/group_settings.json",
    "assets/json-data/data-game.json",
    "mybot/configs/vip-feature-flags.json"], deploy);
  write(deploy, "mybot/defaultCommand.json", catalogJson([...BASE_COMMANDS, { name: "localcmd", description: "stale", countdown: 1, active: true, alias: [] }]));
  write(deploy, "assets/json-data/command.json", catalogJson([
    { ...BASE_COMMANDS[0] },
    { ...BASE_COMMANDS[1], countdown: 7 },
    { name: "dashboardcustom", description: "made on the VPS", countdown: 1, active: true, alias: [] },
  ]));
  write(deploy, "assets/data/group_settings.json", "{\"vps\":true}\n");
  write(deploy, "assets/json-data/data-game.json", "{\"coins\":999}\n");
  write(deploy, "mybot/configs/vip-feature-flags.json", "{\"media\":true}\n");

  // Remote v2 registers cmdadd in both catalogs and bumps runtime files.
  write(seed, "bot.js", "console.log('v2');\n");
  write(seed, "mybot/defaultCommand.json", catalogJson([...BASE_COMMANDS, { name: "cmdadd", description: "Tạo lệnh phản hồi động dùng chung", countdown: 30, active: true, alias: [] }]));
  write(seed, "assets/json-data/command.json", catalogJson([
    { ...BASE_COMMANDS[0], description: "remote help text" },
    { ...BASE_COMMANDS[1] },
    { name: "cmdadd", description: "Tạo lệnh phản hồi động dùng chung", countdown: 30, active: true, alias: [] },
  ]));
  write(seed, "assets/data/group_settings.json", "{\"remote\":2}\n");
  write(seed, "assets/json-data/data-game.json", "{\"coins\":0}\n");
  write(seed, "mybot/configs/vip-feature-flags.json", "{\"media\":false}\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2 cmdadd"], seed);
  run("git", ["push", "origin", "master"], seed);

  const updater = path.resolve(import.meta.dirname, "..", "scripts", "safe-update.js");
  const result = spawnSync(process.execPath, [
    updater,
    "--root", deploy,
    "--skip-process-stop",
    "--skip-install",
    "--skip-restart",
  ], { encoding: "utf8", timeout: 60000 });

  assert.equal(result.status, 0, `exit 128 regression: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /UPDATE VERIFIED/);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), run("git", ["rev-parse", "origin/master"], deploy));

  // Pure source file: remote version wins, legacy flag is gone for good.
  const defaultCommand = JSON.parse(readNormalized(deploy, "mybot/defaultCommand.json"));
  assert.ok(defaultCommand.commands.some((entry) => entry.name === "cmdadd"));
  assert.ok(!defaultCommand.commands.some((entry) => entry.name === "localcmd"));

  // Hybrid catalog: remote additions merged with non-conflicting dashboard edits.
  const command = JSON.parse(readNormalized(deploy, "assets/json-data/command.json"));
  assert.ok(command.commands.some((entry) => entry.name === "cmdadd"));
  assert.equal(command.commands.find((entry) => entry.name === "help").description, "remote help text");
  assert.equal(command.commands.find((entry) => entry.name === "game").countdown, 7);
  assert.ok(command.commands.some((entry) => entry.name === "dashboardcustom"));

  // Runtime tracked data survives the reset untouched.
  assert.equal(readNormalized(deploy, "assets/data/group_settings.json"), "{\"vps\":true}\n");
  assert.equal(readNormalized(deploy, "assets/json-data/data-game.json"), "{\"coins\":999}\n");
  assert.equal(readNormalized(deploy, "mybot/configs/vip-feature-flags.json"), "{\"media\":true}\n");

  // Index flags: catalog + runtime data re-protected, pure source unflagged.
  const flags = indexFlags(deploy);
  assert.equal(flags.get("assets/json-data/command.json"), "S");
  assert.equal(flags.get("assets/data/group_settings.json"), "S");
  assert.equal(flags.get("assets/json-data/data-game.json"), "S");
  assert.equal(flags.get("mybot/configs/vip-feature-flags.json"), "S");
  assert.notEqual(flags.get("mybot/defaultCommand.json"), "S");

  assertNoTempFiles(deploy);
});

test("conflicting catalog edits abort before the PM2 stop call with HEAD/index/worktree untouched", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-skip-conflict-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
    },
  });
  run("git", ["update-index", "--skip-worktree", "assets/json-data/command.json", "mybot/defaultCommand.json"], deploy);
  write(deploy, "assets/json-data/command.json", catalogJson([{ ...BASE_COMMANDS[0], countdown: 6 }, BASE_COMMANDS[1]]));
  write(deploy, "mybot/defaultCommand.json", catalogJson([{ ...BASE_COMMANDS[0] }, BASE_COMMANDS[1], { name: "localcmd", countdown: 1, active: true, alias: [] }]));
  const worktreeBefore = readNormalized(deploy, "assets/json-data/command.json");

  write(seed, "bot.js", "console.log('v2');\n");
  write(seed, "mybot/defaultCommand.json", catalogJson([...BASE_COMMANDS, { name: "cmdadd", description: "remote", countdown: 30, active: true, alias: [] }]));
  write(seed, "assets/json-data/command.json", catalogJson([{ ...BASE_COMMANDS[0], countdown: 9 }, BASE_COMMANDS[1]]));
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2 conflicting"], seed);
  run("git", ["push", "origin", "master"], seed);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);

  let stopCalls = 0;
  const failure = await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: true,
    install: false,
    restart: false,
  }, {
    stopFleetViaPM2: async () => {
      stopCalls += 1;
      return { success: true, stopped: [], alreadyStopped: [], missing: [], failed: [], stillRunning: [] };
    },
    restartAndVerify: async () => { throw new Error("must not restart"); },
  }).then(() => { throw new Error("expected rejection"); }, (error) => error);

  assert.match(failure.message, /PREFLIGHT FAILED/);
  assert.match(failure.message, /cmdadd|"help"/);
  assert.equal(stopCalls, 0, "fleet must not be stopped when the merge plan conflicts");
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead, "HEAD must not move");
  assert.equal(indexFlags(deploy).get("assets/json-data/command.json"), "S", "index flags must be untouched");
  assert.equal(readNormalized(deploy, "assets/json-data/command.json"), worktreeBefore, "worktree must be untouched");
  assert.equal(run("git", ["status", "--porcelain"], deploy), "", "git status must stay clean");
});

test("rollback restores pre-update policy files and index flags", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-skip-rollback-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/data-game.json": "{\"coins\":0}\n",
    },
  });
  run("git", ["update-index", "--skip-worktree", "mybot/defaultCommand.json", "assets/json-data/command.json", "assets/json-data/data-game.json"], deploy);
  write(deploy, "mybot/defaultCommand.json", catalogJson([...BASE_COMMANDS, { name: "localcmd", description: "stale", countdown: 1, active: true, alias: [] }]));
  write(deploy, "assets/json-data/command.json", catalogJson([...BASE_COMMANDS, { name: "dashboardcustom", description: "vps", countdown: 1, active: true, alias: [] }]));
  write(deploy, "assets/json-data/data-game.json", "{\"coins\":999}\n");
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);

  write(seed, "bot.js", "this is invalid javascript {{{\n");
  write(seed, "mybot/defaultCommand.json", catalogJson([...BASE_COMMANDS, { name: "cmdadd", description: "remote", countdown: 30, active: true, alias: [] }]));
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "broken"], seed);
  run("git", ["push", "origin", "master"], seed);

  const updater = path.resolve(import.meta.dirname, "..", "scripts", "safe-update.js");
  const result = spawnSync(process.execPath, [
    updater,
    "--root", deploy,
    "--skip-process-stop",
    "--skip-install",
    "--skip-restart",
  ], { encoding: "utf8", timeout: 60000 });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLBACK COMPLETE/);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead);

  const flags = indexFlags(deploy);
  assert.equal(flags.get("mybot/defaultCommand.json"), "S", "legacy flags must be restored on rollback");
  assert.equal(flags.get("assets/json-data/command.json"), "S");
  assert.equal(flags.get("assets/json-data/data-game.json"), "S");

  const defaultCommand = JSON.parse(readNormalized(deploy, "mybot/defaultCommand.json"));
  assert.ok(defaultCommand.commands.some((entry) => entry.name === "localcmd"), "VPS copy must be restored");
  assert.ok(!defaultCommand.commands.some((entry) => entry.name === "cmdadd"));
  const command = JSON.parse(readNormalized(deploy, "assets/json-data/command.json"));
  assert.ok(command.commands.some((entry) => entry.name === "dashboardcustom"));
  assert.equal(readNormalized(deploy, "assets/json-data/data-game.json"), "{\"coins\":999}\n");

  assertNoTempFiles(deploy);
});

test("lock-data.bat no longer locks mybot/defaultCommand.json", () => {
  const content = readFileSync(path.resolve(import.meta.dirname, "..", "lock-data.bat"), "utf8");
  assert.doesNotMatch(content, /skip-worktree mybot\/defaultCommand\.json/);
  assert.match(content, /skip-worktree assets\/json-data\/command\.json/);
  assert.match(content, /update\.bat/);
});

test("REGRESSION: database.json in Git but missing on VPS preserves missing state and restores skip-worktree", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-missing-db-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
      "mybot/instances/admin/data/database.json": JSON.stringify({ host: "sample-remote" }, null, 2),
    },
  });

  const dbPath = path.join(deploy, "mybot/instances/admin/data/database.json");
  rmSync(dbPath, { force: true });
  run("git", ["update-index", "--skip-worktree", "mybot/instances/admin/data/database.json"], deploy);
  assert.equal(existsSync(dbPath), false);
  assert.equal(indexFlags(deploy).get("mybot/instances/admin/data/database.json"), "S");
  assert.equal(run("git", ["status", "--porcelain"], deploy), "");

  write(seed, "bot.js", "console.log('v2');\n");
  write(seed, "mybot/instances/admin/data/database.json", JSON.stringify({ host: "sample-remote-v2" }, null, 2));
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2 with remote db template"], seed);
  run("git", ["push", "origin", "master"], seed);

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); origLog(...args); };
  try {
    const result = await runSafeUpdate({
      root: deploy,
      remote: "origin",
      branch: "master",
      stopProcesses: false,
      install: false,
      restart: false,
    });
    assert.ok(result.head);
  } finally {
    console.log = origLog;
  }

  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), run("git", ["rev-parse", "origin/master"], deploy));
  assert.equal(existsSync(dbPath), false, "database.json must remain absent on VPS");
  assert.equal(indexFlags(deploy).get("mybot/instances/admin/data/database.json"), "S", "skip-worktree must be restored");
  assert.equal(run("git", ["status", "--porcelain"], deploy), "", "git status must stay clean");
  assert.ok(logs.some((l) => /preserved missing runtime file/i.test(l)), "must log preserved missing runtime file");
  assertNoTempFiles(deploy);
});

test("REGRESSION: runtime file appearing after preflight aborts before git reset", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-db-concurrent-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
      "mybot/instances/admin/data/database.json": JSON.stringify({ host: "sample" }, null, 2),
    },
  });

  const dbPath = path.join(deploy, "mybot/instances/admin/data/database.json");
  rmSync(dbPath, { force: true });
  run("git", ["update-index", "--skip-worktree", "mybot/instances/admin/data/database.json"], deploy);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);

  write(seed, "bot.js", "console.log('v2');\n");
  run("git", ["add", "."], seed);
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
    stopFleetViaPM2: async () => {
      write(deploy, "mybot/instances/admin/data/database.json", JSON.stringify({ host: "concurrent-db" }));
      return { success: true, stopped: [], alreadyStopped: [], missing: [], failed: [], stillRunning: [] };
    },
    restartAndVerify: async () => {},
  }).then(() => { throw new Error("expected failure"); }, (err) => err);

  assert.match(failure.message, /PREFLIGHT FAILED/);
  assert.match(failure.message, /database\.json appeared after planning/);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead, "HEAD must not move");
  assertNoTempFiles(deploy);
});

test("REGRESSION: update failure after reset rolls back and restores absent state", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-db-rollback-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
      "mybot/instances/admin/data/database.json": JSON.stringify({ host: "sample" }, null, 2),
    },
  });

  const dbPath = path.join(deploy, "mybot/instances/admin/data/database.json");
  rmSync(dbPath, { force: true });
  run("git", ["update-index", "--skip-worktree", "mybot/instances/admin/data/database.json"], deploy);
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);

  write(seed, "bot.js", "syntax error {{{\n");
  write(seed, "mybot/instances/admin/data/database.json", JSON.stringify({ host: "sample-v2" }, null, 2));
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "broken v2"], seed);
  run("git", ["push", "origin", "master"], seed);

  const failure = await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: false,
    install: false,
    restart: false,
  }).then(() => { throw new Error("expected failure"); }, (err) => err);

  assert.ok(failure);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead, "HEAD must roll back");
  assert.equal(existsSync(dbPath), false, "database.json must remain absent after rollback");
  assert.equal(indexFlags(deploy).get("mybot/instances/admin/data/database.json"), "S", "skip-worktree restored on rollback");
  assert.equal(run("git", ["status", "--porcelain"], deploy), "", "git status clean after rollback");
  assertNoTempFiles(deploy);
});

test("REGRESSION: missing required catalog command.json safely aborts preflight", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-missing-catalog-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
    },
  });

  const catalogPath = path.join(deploy, "assets/json-data/command.json");
  rmSync(catalogPath, { force: true });
  const previousHead = run("git", ["rev-parse", "HEAD"], deploy);

  write(seed, "bot.js", "console.log('v2');\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2"], seed);
  run("git", ["push", "origin", "master"], seed);

  const failure = await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: false,
    install: false,
    restart: false,
  }).then(() => { throw new Error("expected failure"); }, (err) => err);

  assert.match(failure.message, /PREFLIGHT FAILED: tracked file assets\/json-data\/command\.json is missing/);
  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), previousHead);
  assertNoTempFiles(deploy);
});

test("REGRESSION: existing runtime database.json with VPS config is preserved byte-for-byte", async () => {
  const { runSafeUpdate } = await import("../scripts/safe-update.js");
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mybot-existing-db-"));
  const { seed, deploy } = buildFixture(fixtureRoot, {
    seedFiles: {
      "bot.js": "console.log('v1');\n",
      "mybot/defaultCommand.json": catalogJson(BASE_COMMANDS),
      "assets/json-data/command.json": catalogJson(BASE_COMMANDS),
      "mybot/instances/admin/data/database.json": JSON.stringify({ host: "sample-remote" }, null, 2),
    },
  });

  const vpsDbConfig = JSON.stringify({ host: "vps-mysql.internal", port: 3306, user: "vps_admin" }, null, 2) + "\n";
  const dbPath = path.join(deploy, "mybot/instances/admin/data/database.json");
  write(deploy, "mybot/instances/admin/data/database.json", vpsDbConfig);
  run("git", ["update-index", "--skip-worktree", "mybot/instances/admin/data/database.json"], deploy);

  write(seed, "bot.js", "console.log('v2');\n");
  write(seed, "mybot/instances/admin/data/database.json", JSON.stringify({ host: "remote-template-v2", port: 3307 }, null, 2));
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2 remote template"], seed);
  run("git", ["push", "origin", "master"], seed);

  await runSafeUpdate({
    root: deploy,
    remote: "origin",
    branch: "master",
    stopProcesses: false,
    install: false,
    restart: false,
  });

  assert.equal(run("git", ["rev-parse", "HEAD"], deploy), run("git", ["rev-parse", "origin/master"], deploy));
  assert.equal(readNormalized(deploy, "mybot/instances/admin/data/database.json"), vpsDbConfig.replace(/\r\n/g, "\n"));
  assert.equal(indexFlags(deploy).get("mybot/instances/admin/data/database.json"), "S");
  assert.equal(run("git", ["status", "--porcelain"], deploy), "");
  assertNoTempFiles(deploy);
});
