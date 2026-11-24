import fs from "node:fs/promises";
import path from "node:path";

import { VIP_FEATURE_FLAGS } from "../utils/command-baseline.js";

const FLAG_KEYS = Object.freeze(Object.keys(VIP_FEATURE_FLAGS));

export class VipFeatureFlagService {
  constructor({ root = process.cwd(), filePath = null } = {}) {
    this.root = path.resolve(root);
    this.filePath = filePath ? path.resolve(filePath) : path.join(this.root, "mybot", "configs", "vip-feature-flags.json");
  }

  async read() {
    const flags = await readFlagsFile(this.filePath);
    return {
      filePath: this.filePath,
      flags: normalizeFlags(flags),
      defaults: { ...VIP_FEATURE_FLAGS },
    };
  }

  async update(patch) {
    validatePatch(patch);
    const current = normalizeFlags(await readFlagsFile(this.filePath));
    const next = { ...current, ...patch };
    const changedKeys = FLAG_KEYS.filter((key) => current[key] !== next[key]);
    if (changedKeys.length === 0) {
      return { filePath: this.filePath, flags: current, defaults: { ...VIP_FEATURE_FLAGS }, changedKeys, backup: null };
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const previous = await fs.readFile(this.filePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

    let backup = null;
    if (previous !== null) {
      const backupDir = path.join(this.root, "mybot", "migration", "phase-0");
      await fs.mkdir(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `vip-feature-flags-${Date.now()}-${process.pid}.bak.json`);
      await fs.writeFile(backupPath, previous, "utf8");
      const allBackups = (await fs.readdir(backupDir).catch(() => []))
        .filter((name) => name.startsWith("vip-feature-flags-") && name.endsWith(".bak.json"))
        .sort()
        .reverse();
      for (const stale of allBackups.slice(3)) {
        await fs.rm(path.join(backupDir, stale), { force: true }).catch(() => {});
      }
      backup = { file: backupPath };
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(path.dirname(this.filePath), ".vip-flags-"));
    const tempPath = path.join(tempDir, "vip-feature-flags.json");
    try {
      await fs.writeFile(tempPath, JSON.stringify(next, null, 2) + "\n", "utf8");
      await fs.rename(tempPath, this.filePath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    return { filePath: this.filePath, flags: next, defaults: { ...VIP_FEATURE_FLAGS }, changedKeys, backup };
  }
}

function normalizeFlags(flags) {
  const current = {};
  for (const key of FLAG_KEYS) {
    current[key] = Boolean(flags?.[key] ?? VIP_FEATURE_FLAGS[key]);
  }
  return current;
}

function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw createFlagError("VIP feature flag patch must be an object");
  }
  const invalidKeys = Object.keys(patch).filter((key) => !FLAG_KEYS.includes(key));
  const invalidTypes = Object.entries(patch)
    .filter(([, value]) => typeof value !== "boolean")
    .map(([key]) => key);
  if (invalidKeys.length || invalidTypes.length) {
    throw createFlagError("VIP feature flag patch contains invalid values", { invalidKeys, invalidTypes });
  }
}

async function readFlagsFile(filePath) {
  const source = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return {};
  return JSON.parse(source);
}

function createFlagError(message, details = {}) {
  const error = new Error(message);
  error.code = "VIP_FEATURE_FLAG_INVALID";
  error.status = 400;
  Object.assign(error, details);
  return error;
}
