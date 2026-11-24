/**
 * Updater bootstrap: run the updater from origin/master, not from the local
 * (possibly old) working tree.
 *
 * Problem this solves: update.bat used to run the LOCAL scripts/safe-update.js
 * after `git fetch`. If the remote moved the updater forward (new logic, new
 * relative imports), the local copy executed stale logic — the update could
 * never bootstrap its own newer updater. Copying to %TEMP% instead breaks
 * relative imports (../src/...) — MODULE_NOT_FOUND (see 88c53a8).
 *
 * Solution: materialize a TEMP bundle that mirrors the REPO TREE structure:
 *
 *   <bundle>/scripts/safe-update.js          (from origin/master)
 *   <bundle>/src/runtime/fleet-stop.js       (from origin/master)
 *   ... every relative import reachable from safe-update.js ...
 *
 * All relative imports resolve inside the bundle exactly as in the repo
 * (ESM tree preserved). The bundle updater runs with `--root <repo>` so it
 * operates on the real VPS checkout. Verification happens BEFORE the fleet
 * is stopped: if any bundle file is missing or fails to import, we abort
 * with the local tree untouched (no fleet-stop, no git reset).
 *
 * Cleanup: the bundle is always removed (success or failure).
 *
 * Injectable git IO (readRemoteFile / listRemoteFiles) keeps this testable
 * without a real remote.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

/**
 * Resolve the bundle entry for scripts/safe-update.js given the repo root.
 * Kept in one place so tests and the CLI agree on the layout.
 */
export function bundleEntryPath(bundleDir) {
  return path.join(bundleDir, "scripts", "safe-update.js");
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status})\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Read one file's content from a remote ref without touching the working
 * tree: `git cat-file blob <ref>:<path>`. Returns the exact bytes as utf8.
 * Throws when the path does not exist on the ref.
 */
export function readRemoteFileDefault(root, ref, relativePath) {
  return runGit(root, ["cat-file", "blob", `${ref}:${relativePath.replaceAll("\\", "/")}`]);
}

/**
 * List every tracked file on the remote ref (used to validate that the files
 * we need exist BEFORE any destructive step).
 */
export function listRemoteFilesDefault(root, ref) {
  return runGit(root, ["ls-tree", "-r", "--name-only", "-z", ref])
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

/**
 * Extract relative specifiers from ESM import/export statements.
 * Handles: import ... from 'x'; import 'x'; export ... from 'x';
 * dynamic import('x'). Only specifiers starting with '.' are returned,
 * normalized to posix repo-relative paths with a .js extension added when
 * the specifier omits one.
 */
export function extractRelativeImports(source) {
  const specifiers = [];
  const patterns = [
    /(?:^|[;\s])import\s+[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|[;\s])import\s*["']([^"']+)["']/g,
    /(?:^|[;\s])export\s+[^;]*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      specifiers.push(match[1]);
    }
  }
  const resolved = [];
  for (const spec of specifiers) {
    if (!spec.startsWith(".")) continue;
    resolved.push(spec);
  }
  return [...new Set(resolved)];
}

/**
 * Resolve one relative specifier against an importing file to a
 * repo-relative posix path, adding .js when extensionless (ESM convention
 * in this repo: explicit .js everywhere, but stay defensive).
 */
export function resolveRelativeSpecifier(fromRepoPath, specifier) {
  const baseDir = path.posix.dirname(fromRepoPath.replaceAll("\\", "/"));
  let target = path.posix.normalize(path.posix.join(baseDir, specifier.replaceAll("\\", "/")));
  if (!path.posix.extname(target)) target = `${target}.js`;
  return target.replace(/^\.\//, "");
}

/**
 * Traverse the relative-import graph of `entry` on the remote ref and return
 * every repo-relative file that must be materialized into the bundle
 * (entry included). Throws ImportGraphError when a referenced file is
 * missing from the ref — the caller must abort BEFORE fleet-stop.
 */
export function collectImportGraph(entry, {
  readRemoteFile,
  remoteFiles,
  maxFiles = 500,
} = {}) {
  const missing = [];
  const files = new Map(); // repoRelPath -> source
  const queue = [entry.replaceAll("\\", "/")];
  const known = new Set(remoteFiles);
  while (queue.length > 0) {
    const current = queue.shift();
    if (files.has(current)) continue;
    if (!known.has(current)) {
      missing.push(current);
      continue;
    }
    const source = readRemoteFile(current);
    files.set(current, source);
    for (const spec of extractRelativeImports(source)) {
      const target = resolveRelativeSpecifier(current, spec);
      if (!files.has(target)) queue.push(target);
    }
    if (files.size > maxFiles) {
      throw new Error(`Import graph exceeded ${maxFiles} files — refusing to materialize (runaway import graph?)`);
    }
  }
  if (missing.length > 0) {
    const error = new Error(`Remote ref is missing required updater files: ${missing.join(", ")}`);
    error.name = "ImportGraphError";
    error.missing = missing;
    throw error;
  }
  return files;
}

/**
 * Materialize the bundle directory from the collected file map.
 * Returns the bundle entry path.
 */
export function materializeBundle(bundleDir, files) {
  for (const [relativePath, source] of files) {
    const target = path.join(bundleDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf8");
  }
  return bundleEntryPath(bundleDir);
}

/**
 * Static verification before execution: every materialized file must parse
 * as a module (`node --check`), and the entry must expose the expected
 * updater surface. Catches truncated/corrupt extraction BEFORE the fleet is
 * stopped.
 */
export function verifyBundle(entryPath, { nodePath = process.execPath } = {}) {
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Bundle entry missing: ${entryPath}`);
  }
  const scriptsDir = path.dirname(entryPath);
  for (const name of fs.readdirSync(scriptsDir)) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(scriptsDir, name);
    const check = spawnSync(nodePath, ["--check", file], { encoding: "utf8", windowsHide: true });
    if (check.status !== 0) {
      throw new Error(`Bundle file failed syntax check: ${file}\n${check.stderr || check.stdout}`);
    }
  }
  // Import-graph verification for the WHOLE entry graph (relative imports
  // resolve inside the bundle because the tree structure is preserved).
  const runtimeDir = path.join(path.dirname(path.dirname(entryPath)), "src", "runtime");
  if (fs.existsSync(runtimeDir)) {
    for (const name of fs.readdirSync(runtimeDir)) {
      if (!name.endsWith(".js")) continue;
      const check = spawnSync(nodePath, ["--check", path.join(runtimeDir, name)], { encoding: "utf8", windowsHide: true });
      if (check.status !== 0) {
        throw new Error(`Bundle file failed syntax check: ${name}\n${check.stderr || check.stdout}`);
      }
    }
  }
  return true;
}

/**
 * High-level entry: build the remote bundle and run the remote updater with
 * --root pointing at the repo. The child's stdio is inherited so update.bat
 * shows the real updater output. The bundle is always cleaned up.
 *
 * @param {object} options
 * @param {string} options.root VPS repo root
 * @param {string} [options.remote] default "origin"
 * @param {string} [options.branch] default "master"
 * @param {string[]} [options.updaterArgs] extra args after --root (default none)
 * @returns {Promise<{ok:boolean, exitCode:number, bundleDir:string, head:string}>}
 */
export async function runRemoteUpdater({
  root,
  remote = "origin",
  branch = "master",
  updaterArgs = [],
  nodePath = process.execPath,
  readRemoteFile = readRemoteFileDefault,
  listRemoteFiles = listRemoteFilesDefault,
  mkdtemp = (prefix) => fs.mkdtempSync(prefix),
  rm = (target, opts) => fs.rmSync(target, opts),
} = {}) {
  const ref = `${remote}/${branch}`;
  const remoteFiles = listRemoteFiles(root, ref);
  const entry = "scripts/safe-update.js";
  const files = collectImportGraph(entry, {
    readRemoteFile: (rel) => readRemoteFile(root, ref, rel),
    remoteFiles,
  });

  const bundleDir = mkdtemp(path.join(os.tmpdir(), "mybot-updater-bundle-"));
  let ok = false;
  let exitCode = 1;
  try {
    const bundleEntry = materializeBundle(bundleDir, files);
    verifyBundle(bundleEntry, { nodePath });

    // The bundle imports must resolve INSIDE the bundle: prove it statically
    // before handing over to the child. Resolve the entry's import graph
    // against the bundle and assert every referenced file exists there.
    const bundleFiles = new Set(files.keys());
    const queue = [entry];
    while (queue.length > 0) {
      const current = queue.shift();
      const source = fs.readFileSync(path.join(bundleDir, current), "utf8");
      for (const spec of extractRelativeImports(source)) {
        const target = resolveRelativeSpecifier(current, spec);
        if (!bundleFiles.has(target)) {
          throw new Error(`Bundle is incomplete: ${current} imports ${target} which was not materialized`);
        }
        queue.push(target);
      }
    }

    console.log(`[BOOTSTRAP] Running updater from ${ref} bundle (${files.size} files)...`);
    const result = spawnSync(nodePath, [
      bundleEntry,
      "--root", root,
      ...updaterArgs,
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    ok = result.status === 0;
    exitCode = result.status ?? 1;
  } finally {
    try {
      rm(bundleDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; TEMP is cleaned by the OS anyway.
    }
  }
  return { ok, exitCode, bundleDir, ref };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === moduleFile;
if (isMain) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : process.cwd();
  const extra = [];
  const skipRestart = !args.includes("--restart");
  if (skipRestart) extra.push("--skip-restart");
  runRemoteUpdater({ root, updaterArgs: extra })
    .then((res) => {
      if (!res.ok) {
        console.error(`UPDATE FAILED: remote updater exited ${res.exitCode}`);
        process.exitCode = res.exitCode || 1;
      }
    })
    .catch((error) => {
      console.error(`UPDATE FAILED: ${error.message}`);
      process.exitCode = 1;
    });
}
