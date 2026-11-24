/**
 * Update data policy: classification of tracked data/config files that the
 * safe updater must treat specially because operator machines lock them with
 * `git update-index --skip-worktree` (legacy lock-data.bat) or because the
 * dashboard writes them at runtime.
 *
 * Roles:
 * - remote-wins-source: pure source files (mybot/defaultCommand.json). The
 *   remote revision is authoritative. Legacy skip-worktree flags are cleared
 *   BEFORE `git reset --hard` (otherwise reset fails with
 *   "Entry ... not uptodate. Cannot merge." when the worktree copy differs
 *   from the index and the new revision also touches the file) and are never
 *   re-attached after the update.
 * - catalog-merge: hybrid source/dashboard files (assets/json-data/command.json).
 *   Three-way merged between the previous HEAD (base), the VPS worktree copy
 *   (dashboard/runtime edits) and origin/master. Re-protected with
 *   skip-worktree after the update so the dashboard does not dirty Git state.
 * - runtime-tracked: tracked runtime data files. Always backed up, the VPS
 *   copy is restored after the reset, and skip-worktree is re-attached.
 *
 * Conflicting edits (same field changed differently on the VPS and on the
 * remote) abort the update BEFORE the PM2 fleet is stopped: HEAD, the index
 * and the worktree stay untouched.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PATH_ROLE = {
  SOURCE_REMOTE_WINS: "remote-wins-source",
  CATALOG_MERGE: "catalog-merge",
  RUNTIME_TRACKED: "runtime-tracked",
};

export const PATH_ROLES = {
  "mybot/defaultCommand.json": PATH_ROLE.SOURCE_REMOTE_WINS,
  "assets/json-data/command.json": PATH_ROLE.CATALOG_MERGE,
  "assets/data/group_settings.json": PATH_ROLE.RUNTIME_TRACKED,
  "assets/json-data/server-config.json": PATH_ROLE.RUNTIME_TRACKED,
  "assets/json-data/prophylactic.json": PATH_ROLE.RUNTIME_TRACKED,
  "assets/json-data/dqt-bot.json": PATH_ROLE.RUNTIME_TRACKED,
  "assets/json-data/data-game.json": PATH_ROLE.RUNTIME_TRACKED,
  "assets/json-data/database-config.json": PATH_ROLE.RUNTIME_TRACKED,
  "mybot/instances/admin/data/database.json": PATH_ROLE.RUNTIME_TRACKED,
  "mybot/configs/vip-feature-flags.json": PATH_ROLE.RUNTIME_TRACKED,
};

export const SOURCE_REMOTE_WINS_PATHS = Object.keys(PATH_ROLES)
  .filter((p) => PATH_ROLES[p] === PATH_ROLE.SOURCE_REMOTE_WINS);
export const CATALOG_MERGE_PATHS = Object.keys(PATH_ROLES)
  .filter((p) => PATH_ROLES[p] === PATH_ROLE.CATALOG_MERGE);
export const RUNTIME_TRACKED_PATHS = Object.keys(PATH_ROLES)
  .filter((p) => PATH_ROLES[p] === PATH_ROLE.RUNTIME_TRACKED);
export const PROTECTED_AFTER_UPDATE_PATHS = [...CATALOG_MERGE_PATHS, ...RUNTIME_TRACKED_PATHS];

export const CATALOG_PATH = "assets/json-data/command.json";

function gitSpawn(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitOutput(root, args) {
  const result = gitSpawn(root, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status})\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function gitTry(root, args) {
  const result = gitSpawn(root, args);
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** Map<posixPath, flagChar> from `git ls-files -v`. */
export function readIndexFlags(root) {
  const flags = new Map();
  for (const line of gitOutput(root, ["ls-files", "-v"]).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z])\s(.+)$/);
    if (!match) continue;
    flags.set(match[2].replaceAll("\\", "/"), match[1]);
  }
  return flags;
}

/** skip-worktree ("S") or assume-unchanged (lowercase letter) index flags. */
export function isProtectedFlag(flagChar) {
  if (!flagChar) return false;
  if (flagChar === "S") return true;
  return /[a-z]/.test(flagChar) && flagChar === flagChar.toLowerCase();
}

export function setSkipWorktree(root, relativePath) {
  gitOutput(root, ["update-index", "--skip-worktree", relativePath]);
}

export function clearIndexProtection(root, relativePath) {
  gitTry(root, ["update-index", "--no-skip-worktree", relativePath]);
  gitTry(root, ["update-index", "--no-assume-unchanged", relativePath]);
}

export function isTracked(root, relativePath) {
  const output = gitTry(root, ["ls-files", "--", relativePath]);
  return typeof output === "string" && output.trim().length > 0;
}

/** File content at a ref, or null when the path does not exist there. */
export function readBlobAt(root, ref, relativePath) {
  return gitTry(root, ["cat-file", "blob", `${ref}:${relativePath}`]);
}

export function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeCommandName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function commandMap(config) {
  const map = new Map();
  const duplicates = [];
  const commands = config && Array.isArray(config.commands) ? config.commands : [];
  for (const entry of commands) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
    const key = normalizeCommandName(entry.name);
    if (!key) continue;
    if (map.has(key)) {
      duplicates.push(key);
      continue;
    }
    map.set(key, entry);
  }
  return { map, duplicates };
}

function collectAliases(entry) {
  return Array.isArray(entry?.alias) ? entry.alias.map(normalizeCommandName).filter(Boolean) : [];
}

/**
 * Validate a merged command list: array shape, string names, unique command
 * names and unique alias claims across the catalog.
 */
export function validateCommandList(commands) {
  const errors = [];
  if (!Array.isArray(commands)) {
    return ["commands must be an array"];
  }
  const nameOwners = new Map();
  const aliasOwners = new Map();
  for (const entry of commands) {
    if (!entry || typeof entry !== "object") {
      errors.push(`command entry is not an object: ${stableStringify(entry)?.slice(0, 80)}`);
      continue;
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      errors.push(`command entry missing a usable name: ${stableStringify(entry)?.slice(0, 80)}`);
      continue;
    }
    const key = normalizeCommandName(entry.name);
    if (nameOwners.has(key)) {
      errors.push(`duplicate command name "${entry.name}" (also registered by "${nameOwners.get(key)}")`);
    } else {
      nameOwners.set(key, entry.name);
    }
    for (const alias of collectAliases(entry)) {
      if (alias === key) continue;
      if (nameOwners.has(alias)) {
        errors.push(`alias "${alias}" of "${entry.name}" collides with command "${nameOwners.get(alias)}"`);
      } else if (aliasOwners.has(alias)) {
        errors.push(`alias "${alias}" claimed by both "${aliasOwners.get(alias)}" and "${entry.name}"`);
      } else {
        aliasOwners.set(alias, entry.name);
      }
    }
  }
  return errors;
}

/**
 * Three-way merge of one command entry. Returns { entry, fields, conflicts }
 * where fields maps fieldName -> "vps" | "remote" | "both" | "base".
 */
function mergeCommandEntry(name, baseEntry, vpsEntry, remoteEntry) {
  const fields = {};
  const conflicts = [];
  const source = remoteEntry ?? vpsEntry ?? baseEntry ?? {};
  const merged = { ...source };
  const keys = new Set([
    ...Object.keys(baseEntry ?? {}),
    ...Object.keys(vpsEntry ?? {}),
    ...Object.keys(remoteEntry ?? {}),
  ]);
  for (const field of keys) {
    const baseValue = baseEntry?.[field];
    const vpsValue = vpsEntry?.[field];
    const remoteValue = remoteEntry?.[field];
    const vpsChanged = !deepEqual(vpsValue, baseValue);
    const remoteChanged = !deepEqual(remoteValue, baseValue);
    if (!vpsChanged) {
      merged[field] = remoteValue;
      fields[field] = "remote";
    } else if (!remoteChanged) {
      merged[field] = vpsValue;
      fields[field] = "vps";
    } else if (deepEqual(vpsValue, remoteValue)) {
      merged[field] = vpsValue;
      fields[field] = "both";
    } else {
      conflicts.push({ name, field, vps: vpsValue, remote: remoteValue });
    }
  }
  return { entry: merged, fields, conflicts };
}

/**
 * Three-way merge of command catalogs (objects with `prefix` and
 * `commands[]`). Conflict rules:
 * - same field changed differently on VPS and remote: conflict
 * - locally deleted but remotely modified (or vice versa): conflict
 * - same command created by both sides with different content: conflict
 * Local-only creations are kept; remote-only creations are added; unchanged
 * sides always adopt the changed side.
 */
export function mergeCatalogFiles({ base, vps, remote, catalogPath = CATALOG_PATH }) {
  const conflicts = [];
  const decisions = new Map();
  const keptVpsOnly = [];
  const remoteNew = [];
  const dropped = [];

  const { map: baseMap } = commandMap(base);
  const { map: vpsMap, duplicates: vpsDuplicates } = commandMap(vps);
  const { map: remoteMap, duplicates: remoteDuplicates } = commandMap(remote);

  const sourceValidationErrors = [];
  for (const key of vpsDuplicates) {
    sourceValidationErrors.push(`duplicate command name "${key}" in the VPS worktree copy`);
  }
  for (const key of remoteDuplicates) {
    sourceValidationErrors.push(`duplicate command name "${key}" in the remote copy`);
  }

  const finalNames = [];
  const added = new Set();
  const consider = (key) => {
    if (!added.has(key) && (baseMap.has(key) || vpsMap.has(key) || remoteMap.has(key))) {
      added.add(key);
      finalNames.push(key);
    }
  };
  for (const key of baseMap.keys()) consider(key);
  for (const key of remoteMap.keys()) consider(key);
  for (const key of vpsMap.keys()) consider(key);

  const mergedCommands = [];
  for (const key of finalNames) {
    const baseEntry = baseMap.get(key) ?? null;
    const vpsEntry = vpsMap.get(key) ?? null;
    const remoteEntry = remoteMap.get(key) ?? null;
    const displayName = (vpsEntry ?? remoteEntry ?? baseEntry).name;
    if (baseEntry && vpsEntry && remoteEntry) {
      const { entry, fields, conflicts: fieldConflicts } = mergeCommandEntry(displayName, baseEntry, vpsEntry, remoteEntry);
      conflicts.push(...fieldConflicts);
      mergedCommands.push(entry);
      decisions.set(key, { command: displayName, source: "merged", fields });
    } else if (baseEntry && remoteEntry && !vpsEntry) {
      if (deepEqual(remoteEntry, baseEntry)) {
        dropped.push({ command: displayName, reason: "local-delete-preserved" });
        decisions.set(key, { command: displayName, source: "dropped-local-delete" });
      } else {
        conflicts.push({
          name: displayName,
          field: "<command>",
          kind: "deleted-locally-modified-remotely",
          vps: null,
          remote: stableStringify(remoteEntry).slice(0, 200),
        });
      }
    } else if (baseEntry && vpsEntry && !remoteEntry) {
      if (deepEqual(vpsEntry, baseEntry)) {
        dropped.push({ command: displayName, reason: "remote-delete" });
        decisions.set(key, { command: displayName, source: "dropped-remote-delete" });
      } else {
        conflicts.push({
          name: displayName,
          field: "<command>",
          kind: "modified-locally-deleted-remotely",
          vps: stableStringify(vpsEntry).slice(0, 200),
          remote: null,
        });
      }
    } else if (baseEntry && !vpsEntry && !remoteEntry) {
      dropped.push({ command: displayName, reason: "deleted-both-sides" });
      decisions.set(key, { command: displayName, source: "dropped-deleted-both" });
    } else if (!baseEntry && vpsEntry && remoteEntry) {
      if (deepEqual(vpsEntry, remoteEntry)) {
        mergedCommands.push({ ...remoteEntry });
        decisions.set(key, { command: displayName, source: "created-both-identical" });
      } else {
        conflicts.push({
          name: displayName,
          field: "<command>",
          kind: "created-by-both-different-content",
          vps: stableStringify(vpsEntry).slice(0, 200),
          remote: stableStringify(remoteEntry).slice(0, 200),
        });
      }
    } else if (!baseEntry && remoteEntry && !vpsEntry) {
      mergedCommands.push({ ...remoteEntry });
      remoteNew.push(displayName);
      decisions.set(key, { command: displayName, source: "remote-new" });
    } else if (!baseEntry && vpsEntry && !remoteEntry) {
      mergedCommands.push({ ...vpsEntry });
      keptVpsOnly.push(displayName);
      decisions.set(key, { command: displayName, source: "vps-only-created" });
    }
  }

  const metaKeys = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(vps ?? {}),
    ...Object.keys(remote ?? {}),
  ]);
  metaKeys.delete("commands");
  const metaMerged = {};
  const metaFields = {};
  for (const key of metaKeys) {
    const baseValue = base?.[key];
    const vpsValue = vps?.[key];
    const remoteValue = remote?.[key];
    const vpsChanged = !deepEqual(vpsValue, baseValue);
    const remoteChanged = !deepEqual(remoteValue, baseValue);
    if (!vpsChanged) {
      metaMerged[key] = remoteValue;
      metaFields[key] = "remote";
    } else if (!remoteChanged) {
      metaMerged[key] = vpsValue;
      metaFields[key] = "vps";
    } else if (deepEqual(vpsValue, remoteValue)) {
      metaMerged[key] = vpsValue;
      metaFields[key] = "both";
    } else {
      conflicts.push({ name: `<catalog>.${key}`, field: key, vps: vpsValue, remote: remoteValue });
    }
  }

  const errors = validateCommandList(mergedCommands).concat(sourceValidationErrors);
  const merged = { ...metaMerged, commands: mergedCommands };
  const report = {
    path: catalogPath,
    base: "previous HEAD",
    vps: "dashboard/runtime worktree copy",
    remote: "origin/master",
    metaFields,
    decisions: [...decisions.values()],
    keptVpsOnly,
    remoteNew,
    dropped,
    conflicts,
    validationErrors: errors,
  };
  return { ok: conflicts.length === 0 && errors.length === 0, merged, report, conflicts, validationErrors: errors };
}

export function serializeCatalog(merged) {
  return JSON.stringify(merged, null, 2);
}

export function writeFileAtomic(filePath, content) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-update-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}

function parseJsonOrThrow(label, relativePath, content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `PREFLIGHT FAILED: ${label} copy of ${relativePath} is not valid JSON (${error.message}). `
      + "Fix or remove the file, then rerun update.bat.",
    );
  }
}

/**
 * Read-only preflight: index flag snapshot + per-file byte snapshot +
 * three-way catalog merge plan. Throws (BEFORE the fleet is stopped) when:
 * - a tracked policy file is missing from the worktree,
 * - any copy of the catalog is not valid JSON,
 * - the merge produces conflicts or validation errors.
 */
export function buildUpdatePlan({ root, previousHead, remoteRef }) {
  const flags = readIndexFlags(root);
  const files = new Map();
  for (const relativePath of Object.keys(PATH_ROLES)) {
    const worktreePath = path.join(root, relativePath);
    const vpsExists = existsSync(worktreePath);
    const vpsBytes = vpsExists ? readFileSync(worktreePath, "utf8") : null;
    const baseBlob = readBlobAt(root, previousHead, relativePath);
    const remoteBlob = readBlobAt(root, remoteRef, relativePath);
    const role = PATH_ROLES[relativePath];
    if (baseBlob !== null && !vpsExists) {
      if (role !== PATH_ROLE.RUNTIME_TRACKED) {
        throw new Error(
          `PREFLIGHT FAILED: tracked file ${relativePath} is missing from the worktree. `
          + "Restore it (git checkout -- " + relativePath + "), then rerun update.bat.",
        );
      }
    }
    files.set(relativePath, {
      vpsExists,
      vpsBytes,
      baseBlob,
      remoteBlob,
      tracked: baseBlob !== null || remoteBlob !== null,
      flagged: isProtectedFlag(flags.get(relativePath)),
      role,
    });
  }

  const catalogSnapshot = files.get(CATALOG_PATH);
  const catalog = { mergeNeeded: false, writeNeeded: false, mergedJson: null, report: null };
  if (catalogSnapshot && catalogSnapshot.remoteBlob !== null) {
    const vpsChanged = catalogSnapshot.vpsBytes !== null && catalogSnapshot.vpsBytes !== catalogSnapshot.baseBlob;
    const remoteChanged = catalogSnapshot.remoteBlob !== catalogSnapshot.baseBlob;
    if (vpsChanged || remoteChanged) {
      const baseParsed = catalogSnapshot.baseBlob === null ? null : parseJsonOrThrow("previous-HEAD", CATALOG_PATH, catalogSnapshot.baseBlob);
      const vpsParsed = catalogSnapshot.vpsBytes === null ? null : parseJsonOrThrow("worktree (VPS)", CATALOG_PATH, catalogSnapshot.vpsBytes);
      const remoteParsed = parseJsonOrThrow("remote", CATALOG_PATH, catalogSnapshot.remoteBlob);
      const result = mergeCatalogFiles({ base: baseParsed, vps: vpsParsed, remote: remoteParsed, catalogPath: CATALOG_PATH });
      if (!result.ok) {
        const lines = [];
        for (const conflict of result.conflicts) {
          if (conflict.kind) {
            lines.push(`  - "${conflict.name}" ${conflict.kind}`);
          } else {
            lines.push(`  - "${conflict.name}" field "${conflict.field}": VPS=${stableStringify(conflict.vps)} REMOTE=${stableStringify(conflict.remote)}`);
          }
        }
        for (const validationError of result.validationErrors) {
          lines.push(`  - validation: ${validationError}`);
        }
        throw new Error(
          `PREFLIGHT FAILED: catalog merge conflicts in ${CATALOG_PATH}:\n${lines.join("\n")}\n`
          + "Resolve the conflicts on this machine (or restore the file from the dashboard backup), then rerun update.bat. "
          + "HEAD, the index and the worktree were NOT changed.",
        );
      }
      const remoteSame = deepEqual(result.merged, remoteParsed);
      catalog.mergeNeeded = true;
      catalog.writeNeeded = !remoteSame;
      catalog.mergedJson = serializeCatalog(result.merged);
      catalog.report = result.report;
    }
  }

  return { flags, files, catalog };
}

/** Policy paths flagged (skip-worktree / assume-unchanged) at preflight. */
export function flaggedPolicyPaths(plan) {
  const flagged = [];
  for (const [relativePath, snapshot] of plan.files) {
    if (snapshot.flagged) flagged.push(relativePath);
  }
  return flagged;
}

/**
 * Abort when a policy file changed or unexpectedly appeared between preflight
 * and the destructive phase (e.g. the dashboard wrote concurrently): the
 * merge plan would be applied against stale bytes or miss new runtime data.
 */
export function verifyPolicyFilesUnchanged(root, plan) {
  for (const [relativePath, snapshot] of plan.files) {
    const worktreePath = path.join(root, relativePath);
    const current = existsSync(worktreePath) ? readFileSync(worktreePath, "utf8") : null;
    if (!snapshot.vpsExists) {
      if (current !== null) {
        throw new Error(
          `PREFLIGHT FAILED: ${relativePath} appeared after planning (dashboard wrote concurrently?). `
          + "Aborting BEFORE any Git change — rerun update.bat.",
        );
      }
      continue;
    }
    if (current !== snapshot.vpsBytes) {
      throw new Error(
        `PREFLIGHT FAILED: ${relativePath} changed after planning (dashboard wrote concurrently?). `
        + "Aborting BEFORE any Git change — rerun update.bat.",
      );
    }
  }
}

/**
 * Apply the preflight plan AFTER `git reset --hard`:
 * - write the merged catalog (atomic temp+rename) when the merge differs from
 *   the remote revision;
 * - restore the VPS copy of every runtime-tracked data file if it existed on the VPS,
 *   or delete it if it did not exist on the VPS (preserving missing runtime file state);
 * - re-attach skip-worktree only to the dashboard catalog and runtime data
 *   files that were flagged before the update (never to pure source files).
 */
export function applyPolicyAfterReset(root, plan) {
  const applied = { catalogWritten: false, restored: [], preservedMissing: [], reprotected: [] };
  const catalog = plan.catalog;
  if (catalog.mergeNeeded && catalog.writeNeeded && catalog.mergedJson !== null) {
    writeFileAtomic(path.join(root, CATALOG_PATH), catalog.mergedJson);
    applied.catalogWritten = true;
    console.log(`[5/8] Applied three-way catalog merge to ${CATALOG_PATH}`);
  }
  for (const [relativePath, snapshot] of plan.files) {
    if (snapshot.role !== PATH_ROLE.RUNTIME_TRACKED) continue;
    const target = path.join(root, relativePath);
    if (!snapshot.vpsExists) {
      if (existsSync(target)) {
        rmSync(target, { force: true });
      }
      applied.preservedMissing.push(relativePath);
      continue;
    }
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current !== snapshot.vpsBytes) {
      writeFileAtomic(target, snapshot.vpsBytes);
      applied.restored.push(relativePath);
    }
  }
  for (const relativePath of PROTECTED_AFTER_UPDATE_PATHS) {
    const snapshot = plan.files.get(relativePath);
    if (snapshot?.flagged && isTracked(root, relativePath)) {
      setSkipWorktree(root, relativePath);
      applied.reprotected.push(relativePath);
    }
  }
  return applied;
}

/**
 * Rollback helper: restore the exact pre-update VPS state of every policy
 * file (worktree bytes, missing-file state, AND index protection flags),
 * including pure source files that the success path deliberately leaves unflagged.
 */
export function restorePolicyRollback(root, plan) {
  if (!plan) return;
  for (const [relativePath, snapshot] of plan.files) {
    const target = path.join(root, relativePath);
    if (!snapshot.vpsExists) {
      if (existsSync(target)) {
        rmSync(target, { force: true });
      }
    } else if (snapshot.vpsBytes !== null) {
      writeFileAtomic(target, snapshot.vpsBytes);
    }
  }
  for (const [relativePath, snapshot] of plan.files) {
    if (snapshot.flagged && isTracked(root, relativePath)) {
      setSkipWorktree(root, relativePath);
    }
  }
}

