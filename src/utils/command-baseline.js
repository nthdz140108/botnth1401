import fs from "node:fs/promises";
import path from "node:path";

import { commandRegistry } from "../commands/command-registry.js";

export const VIP_FEATURE_FLAGS = Object.freeze({
  "vip.media": true,
  "vip.ai": true,
  "vip.group": true,
  "vip.utility": true,
  "vip.highRisk": true,
});

export const VIP_FLAG_GROUPS = Object.freeze({
  media: Object.freeze(["vip.media"]),
  ai: Object.freeze(["vip.ai"]),
  group: Object.freeze(["vip.group"]),
  utility: Object.freeze(["vip.utility"]),
  highRisk: Object.freeze(["vip.highRisk"]),
});

const DEFAULT_BASELINE_DIR = ["mybot", "migration", "phase-0"];
const DEFAULT_FLAGS_PATH = ["mybot", "configs", "vip-feature-flags.json"];

export function buildCommandBaseline({ commandConfig, defaultCommandConfig, registry = commandRegistry } = {}) {
  const commandEntries = extractCommandEntries(commandConfig);
  const defaultEntries = extractCommandEntries(defaultCommandConfig);
  const registryDefinitions = Array.isArray(registry?.definitions) ? registry.definitions : [];

  const commandMap = buildCommandMap(commandEntries);
  const defaultMap = buildCommandMap(defaultEntries);
  const registryMap = buildCommandMap(registryDefinitions.map(toRegistryEntry));

  const collisions = findCollisions(commandEntries);
  const missingInDefault = [...commandMap.keys()].filter((name) => !defaultMap.has(name)).sort();
  const missingInCommand = [...defaultMap.keys()].filter((name) => !commandMap.has(name)).sort();
  const registryMissingHandlers = registryDefinitions
    .filter((definition) => typeof definition.handler !== "function")
    .map((definition) => definition.name)
    .sort();
  const registryMissingInCommand = [...registryMap.keys()].filter((name) => !commandMap.has(name)).sort();
  const activeMismatch = [];
  const permissionMismatch = [];

  for (const [name, command] of commandMap.entries()) {
    const defaultCommand = defaultMap.get(name);
    if (!defaultCommand) continue;
    if (Boolean(command.active) !== Boolean(defaultCommand.active)) {
      activeMismatch.push(name);
    }
    if (String(command.permission ?? "") !== String(defaultCommand.permission ?? "")) {
      permissionMismatch.push(name);
    }
  }

  return {
    summary: {
      canonicalCount: commandEntries.length,
      registryCount: registryDefinitions.length,
      defaultCount: defaultEntries.length,
      collisionCount: collisions.length,
      activeMismatchCount: activeMismatch.length,
      permissionMismatchCount: permissionMismatch.length,
    },
    commands: [...commandMap.values()],
    defaults: [...defaultMap.values()],
    collisions,
    missingInDefault,
    missingInCommand,
    registryMissingHandlers,
    registryMissingInCommand,
    activeMismatch,
    permissionMismatch,
    featureFlags: { ...VIP_FEATURE_FLAGS },
    featureFlagGroups: cloneFlagGroups(VIP_FLAG_GROUPS),
  };
}

export async function readCommandBaselineFiles(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const [commandConfig, defaultCommandConfig] = await Promise.all([
    readJsonFile(path.join(resolvedRoot, "assets", "json-data", "command.json")),
    readJsonFile(path.join(resolvedRoot, "mybot", "defaultCommand.json")),
  ]);
  return buildCommandBaseline({ commandConfig, defaultCommandConfig });
}

export async function writePhase0BaselineSnapshot(root = process.cwd(), snapshot = null) {
  const resolvedRoot = path.resolve(root);
  const baseline = snapshot ?? await readCommandBaselineFiles(resolvedRoot);
  const baselineDir = path.join(resolvedRoot, ...DEFAULT_BASELINE_DIR);
  const flagsPath = path.join(resolvedRoot, ...DEFAULT_FLAGS_PATH);
  await fs.mkdir(baselineDir, { recursive: true });
  await fs.mkdir(path.dirname(flagsPath), { recursive: true });

  const baselineFile = path.join(baselineDir, "command-baseline.json");
  const metadataFile = path.join(baselineDir, "README.md");
  const payload = JSON.stringify(baseline, null, 2) + "\n";
  const flagsPayload = JSON.stringify(VIP_FEATURE_FLAGS, null, 2) + "\n";
  const readme = [
    "# Phase 0 Baseline",
    "",
    "This folder stores the frozen command baseline and VIP feature-flag defaults for HHH.",
    "It is safe to regenerate because it only mirrors canonical config and runtime metadata.",
    "",
  ].join("\n");

  await Promise.all([
    fs.writeFile(baselineFile, payload, "utf8"),
    fs.writeFile(metadataFile, readme, "utf8"),
    fs.writeFile(flagsPath, flagsPayload, "utf8"),
  ]);

  return { baselineFile, metadataFile, flagsPath, baseline };
}

export function detectCommandRegistryCollisions(registry = commandRegistry) {
  const definitions = Array.isArray(registry?.definitions) ? registry.definitions : [];
  const seen = new Map();
  const collisions = [];

  for (const definition of definitions) {
    for (const key of [definition.name, ...(definition.aliases ?? [])]) {
      const normalized = normalizeName(key);
      if (!normalized) continue;
      if (seen.has(normalized)) {
        collisions.push({ key: normalized, first: seen.get(normalized), second: definition.name });
        continue;
      }
      seen.set(normalized, definition.name);
    }
  }

  return collisions;
}

function toRegistryEntry(definition) {
  return {
    name: definition.name,
    aliases: definition.aliases ?? [],
    permission: definition.permission,
    active: definition.active,
  };
}

function findCollisions(entries) {
  const seen = new Map();
  const collisions = [];
  for (const entry of entries) {
    for (const key of [entry.name, ...(entry.alias ?? [])]) {
      const normalized = normalizeName(key);
      if (!normalized) continue;
      if (seen.has(normalized)) {
        collisions.push({ key: normalized, first: seen.get(normalized), second: entry.name });
        continue;
      }
      seen.set(normalized, entry.name);
    }
  }
  return collisions;
}

function extractCommandEntries(config) {
  if (!config || !Array.isArray(config.commands)) return [];
  return config.commands.map((command) => ({
    name: normalizeName(command.name),
    alias: uniqueNames(command.alias ?? command.aliases ?? []),
    permission: command.permission ?? "all",
    active: command.active !== false,
    countdown: Number.isFinite(command.countdown) ? command.countdown : 0,
    type: command.type ?? 1,
    description: command.description ?? "",
    syntax: command.syntax ?? "",
  })).filter((entry) => entry.name);
}

function buildCommandMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

function uniqueNames(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeName).filter(Boolean))];
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cloneFlagGroups(groups) {
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, [...value]]));
}

async function readJsonFile(file) {
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}
