import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Updater bootstrap tests: the updater executed on a VPS must come from
 * origin/master, not from the local (possibly old) working tree.
 *
 * Regression scenario: local scripts/safe-update.js is OLD or BROKEN, while
 * origin/master carries a NEW updater. update.bat -> update-bootstrap.js must
 * still execute the REMOTE updater successfully.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("extractRelativeImports finds static, dynamic, and export-from specifiers", async () => {
  const { extractRelativeImports } = await import("../scripts/update-bootstrap.js");
  const source = [
    "import { a } from './a.js';",
    'import b from "../lib/b.js";',
    "import './side-effect.js';",
    "export { x } from './re-export.js';",
    "await import('./lazy.js');",
    "import { absolute } from 'node:path';",
    "import { pkg } from 'some-package';",
  ].join("\n");
  assert.deepEqual(extractRelativeImports(source).sort(), [
    "../lib/b.js",
    "./a.js",
    "./lazy.js",
    "./re-export.js",
    "./side-effect.js",
  ].sort());
});

test("resolveRelativeSpecifier normalizes extensionless specifiers", async () => {
  const { resolveRelativeSpecifier } = await import("../scripts/update-bootstrap.js");
  assert.equal(resolveRelativeSpecifier("scripts/safe-update.js", "../src/runtime/fleet-stop.js"), "src/runtime/fleet-stop.js");
  assert.equal(resolveRelativeSpecifier("src/a/b.js", "./c.js"), "src/a/c.js");
  assert.equal(resolveRelativeSpecifier("src/a/b.js", "../x"), "src/x.js");
});

test("collectImportGraph gathers entry plus all reachable relative imports", async () => {
  const { collectImportGraph } = await import("../scripts/update-bootstrap.js");
  const files = {
    "scripts/safe-update.js": "import { stop } from '../src/runtime/fleet-stop.js';\nimport './helper.js';\n",
    "scripts/helper.js": "import path from 'node:path';\n",
    "src/runtime/fleet-stop.js": "import { PM2Adapter } from './pm2-adapter.js';\n",
    "src/runtime/pm2-adapter.js": "export class PM2Adapter {}\n",
  };
  const graph = collectImportGraph("scripts/safe-update.js", {
    readRemoteFile: (rel) => files[rel],
    remoteFiles: Object.keys(files),
  });
  assert.deepEqual([...graph.keys()].sort(), [
    "scripts/helper.js",
    "scripts/safe-update.js",
    "src/runtime/fleet-stop.js",
    "src/runtime/pm2-adapter.js",
  ].sort());
});

test("collectImportGraph aborts when the remote ref is missing a required file", async () => {
  const { collectImportGraph } = await import("../scripts/update-bootstrap.js");
  const files = {
    "scripts/safe-update.js": "import { stop } from '../src/runtime/fleet-stop.js';\n",
    // fleet-stop.js MISSING on the remote
  };
  assert.throws(
    () => collectImportGraph("scripts/safe-update.js", {
      readRemoteFile: (rel) => files[rel],
      remoteFiles: Object.keys(files),
    }),
    (err) => err.name === "ImportGraphError" && /fleet-stop\.js/.test(err.message),
  );
});

test("materializeBundle preserves the repo tree so ESM imports resolve in-bundle", async () => {
  const { materializeBundle, collectImportGraph } = await import("../scripts/update-bootstrap.js");
  const files = new Map([
    ["scripts/safe-update.js", "import './sub/helper.js';\nconsole.log('entry');\n"],
    ["scripts/sub/helper.js", "export const help = 1;\n"],
  ]);
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-bundle-materialize-"));
  try {
    const entry = materializeBundle(bundleDir, files);
    assert.equal(entry, path.join(bundleDir, "scripts", "safe-update.js"));
    assert.ok(fs.existsSync(path.join(bundleDir, "scripts", "sub", "helper.js")));
    const graph = collectImportGraph("scripts/safe-update.js", {
      readRemoteFile: (rel) => fs.readFileSync(path.join(bundleDir, rel), "utf8"),
      remoteFiles: ["scripts/safe-update.js", "scripts/sub/helper.js"],
    });
    assert.ok(graph.has("scripts/sub/helper.js"));
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("REGRESSION: local updater old/broken but remote updater new — remote bundle is executed", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-bootstrap-regression-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");

  run("git", ["init", "--bare", remote], fixtureRoot);
  fs.mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Bootstrap Test"], seed);
  // v1: LOCAL updater is what the deploy clone gets — deliberately broken.
  write(seed, "scripts/safe-update.js", "this local updater is broken {{{\n");
  write(seed, "scripts/update-bootstrap.js", fs.readFileSync(path.join(REPO_ROOT, "scripts", "update-bootstrap.js"), "utf8"));
  write(seed, "app.txt", "version-1\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);
  const localHeadBefore = run("git", ["rev-parse", "HEAD"], deploy);

  // v2 on the remote: a NEW working updater that leaves a marker proving it ran.
  const remoteUpdater = [
    "import { runSafeUpdate } from './core/run-safe.js';",
    "const rootIndex = process.argv.indexOf('--root');",
    "runSafeUpdate({ root: process.argv[rootIndex + 1] });",
    "",
  ].join("\n");
  const remoteCore = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "export function runSafeUpdate({ root }) {",
    "  console.log('REMOTE-UPDATER-RAN root=' + root);",
    "  fs.writeFileSync(path.join(root, 'remote-updater-marker.txt'), 'ran', 'utf8');",
    "}",
    "",
  ].join("\n");
  write(seed, "scripts/safe-update.js", remoteUpdater);
  write(seed, "scripts/core/run-safe.js", remoteCore);
  write(seed, "app.txt", "version-2\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v2 new updater"], seed);
  run("git", ["push", "origin", "master"], seed);

  // update.bat fetches BEFORE invoking the bootstrap — replicate that here.
  run("git", ["fetch", "origin", "master"], deploy);

  // Run the bootstrap from the LOCAL deploy tree (its own safe-update.js is
  // broken — only the bootstrap contract is needed).
  const result = spawnSync(process.execPath, [
    path.join(deploy, "scripts", "update-bootstrap.js"),
    "--root", deploy,
  ], { encoding: "utf8", timeout: 60000, cwd: deploy });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /REMOTE-UPDATER-RAN root=/);
  assert.match(result.stdout, new RegExp(deploy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(fs.existsSync(path.join(deploy, "remote-updater-marker.txt")), "remote updater must have executed");
  // Local tree untouched by the bootstrap itself: HEAD still at v1 (the local
  // clone's only commit), origin/master advanced to v2 — no git reset happened.
  assert.equal(
    run("git", ["rev-parse", "HEAD"], deploy),
    localHeadBefore,
    "local HEAD must remain at the pre-update commit",
  );
  assert.notEqual(
    run("git", ["rev-parse", "origin/master"], deploy),
    run("git", ["rev-parse", "HEAD"], deploy),
    "origin/master must be ahead (v2) while HEAD stays at v1",
  );

  // TEMP bundle cleaned up.
  const bundles = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("mybot-updater-bundle-"));
  assert.deepEqual(bundles, [], "no TEMP bundle may survive the run");
});

test("bootstrap aborts with local tree untouched when the remote ref lacks updater files", async () => {
  const { runRemoteUpdater } = await import("../scripts/update-bootstrap.js");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-bootstrap-missing-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");

  run("git", ["init", "--bare", remote], fixtureRoot);
  fs.mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Bootstrap Test"], seed);
  // Remote does NOT contain scripts/safe-update.js at all.
  write(seed, "README.md", "nothing here\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);

  await assert.rejects(
    runRemoteUpdater({ root: deploy, mkdtemp: (p) => fs.mkdtempSync(p), rm: (t, o) => fs.rmSync(t, o) }),
    (err) => err.name === "ImportGraphError" || /missing required updater files|safe-update\.js/.test(err.message),
  );
  // The deploy tree is untouched: HEAD unchanged, no marker files.
  assert.ok(!fs.existsSync(path.join(deploy, "remote-updater-marker.txt")));
});

test("bootstrap cleans up the TEMP bundle even when the remote updater fails", async () => {
  const { runRemoteUpdater } = await import("../scripts/update-bootstrap.js");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-bootstrap-fail-"));
  const remote = path.join(fixtureRoot, "remote.git");
  const seed = path.join(fixtureRoot, "seed");
  const deploy = path.join(fixtureRoot, "deploy");

  run("git", ["init", "--bare", remote], fixtureRoot);
  fs.mkdirSync(seed);
  run("git", ["init", "-b", "master"], seed);
  run("git", ["config", "user.email", "test@example.com"], seed);
  run("git", ["config", "user.name", "Bootstrap Test"], seed);
  write(seed, "scripts/safe-update.js", "import './core/run-safe.js';\nprocess.exit(7);\n");
  write(seed, "scripts/core/run-safe.js", "export const x = 1;\n");
  run("git", ["add", "."], seed);
  run("git", ["commit", "-m", "v1"], seed);
  run("git", ["remote", "add", "origin", remote], seed);
  run("git", ["push", "-u", "origin", "master"], seed);
  run("git", ["clone", remote, deploy], fixtureRoot);

  const result = await runRemoteUpdater({
    root: deploy,
    mkdtemp: (p) => fs.mkdtempSync(p),
    rm: (t, o) => fs.rmSync(t, o),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  const bundles = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("mybot-updater-bundle-"));
  assert.deepEqual(bundles, [], "failed runs must also clean the TEMP bundle");
});

test("real repo bundle: import graph of the actual scripts/safe-update.js is complete", async () => {
  // This test walks the graph of the REAL safe-update.js in this repo to
  // prove the extractor understands it, with all transitive runtime files
  // treated as known (mirroring a real remote that contains the whole tree).
  const { collectImportGraph } = await import("../scripts/update-bootstrap.js");
  const entrySource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "safe-update.js"), "utf8");
  // All repo-tracked files exist on a real remote ref.
  const tracked = run("git", ["ls-tree", "-r", "--name-only", "HEAD"], REPO_ROOT)
    .split("\n").filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  const graph = collectImportGraph("scripts/safe-update.js", {
    readRemoteFile: (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"),
    remoteFiles: tracked,
  });
  assert.ok(graph.has("scripts/safe-update.js"));
  assert.ok(graph.has("src/runtime/fleet-stop.js"), "real updater imports fleet-stop via relative path");
  // fleet-stop imports pm2-adapter (relative), which imports launch-descriptor.
  assert.ok(graph.has("src/runtime/pm2-adapter.js"), "transitive relative imports must be collected");
  assert.ok(graph.has("src/runtime/launch-descriptor.js"), "deep transitive imports must be collected");
});
