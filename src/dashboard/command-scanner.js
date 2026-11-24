import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isValidScope, resolveCommandPolicy } from "../commands/command-policy.js";
import { withReleaseCommandDefaults } from "../utils/release-command-catalog.js";

const PERMISSIONS = new Set(["all", "adminBot", "adminBox", "adminBotOrGroup", "adminLevelHigh"]);

export class CommandScanner {
  constructor({ root = process.cwd(), registry, env = process.env, dependencyChecker = defaultDependencyChecker } = {}) {
    this.root = path.resolve(root);
    this.registry = registry;
    this.env = env && typeof env === "object" ? env : process.env;
    this.dependencyChecker = typeof dependencyChecker === "function" ? dependencyChecker : defaultDependencyChecker;
  }

  async scan() {
    const registryPath = path.join(this.root, "assets", "json-data", "command.json");
    const registry = withReleaseCommandDefaults(JSON.parse(await fs.readFile(registryPath, "utf8")), this.env);
    const commands = Array.isArray(registry.commands) ? registry.commands : [];
    const diagnostics = [];
    const aliases = new Map();
    const hasHandlerRegistry = Boolean(this.registry?.lookup?.get);
    if (!hasHandlerRegistry) {
      diagnostics.push({ type: "handler_registry_unavailable" });
    }
    for (const command of commands) {
      const names = [command.name, ...(Array.isArray(command.alias) ? command.alias : [])].filter(Boolean);
      for (const alias of names) {
        const key = normalizeCommandKey(alias);
        if (aliases.has(key)) diagnostics.push({ type: "duplicate_alias", value: alias, commands: [aliases.get(key), command.name] });
        else aliases.set(key, command.name);
      }
      if (!PERMISSIONS.has(command.permission)) diagnostics.push({ type: "invalid_permission", command: command.name, value: command.permission });
      if (command.scope !== undefined && !isValidScope(command.scope)) diagnostics.push({ type: "invalid_scope", command: command.name, value: command.scope });
      const definition = hasHandlerRegistry ? getRegisteredDefinition(this.registry, command.name) : null;
      const handlerAvailable = Boolean(definition && typeof definition.handler === "function");
      const requiredConfig = normalizeList(definition?.requiredConfig);
      const requiredDependencies = normalizeList(definition?.requiredDependencies);
      const missingConfig = requiredConfig.filter((key) => !hasConfigValue(this.env, key));
      const missingDependencies = [];
      for (const dependency of requiredDependencies) {
        if (!await this.dependencyChecker(dependency, { root: this.root, env: this.env })) missingDependencies.push(dependency);
      }
      const registryActive = definition ? definition.active !== false : command.active !== false;
      const enabled = registryActive && handlerAvailable && missingConfig.length === 0 && missingDependencies.length === 0;
      if (!handlerAvailable) diagnostics.push({ type: "missing_handler", command: command.name });
      if (missingConfig.length > 0) diagnostics.push({ type: "missing_config", command: command.name, missing: missingConfig });
      if (missingDependencies.length > 0) diagnostics.push({ type: "missing_dependency", command: command.name, missing: missingDependencies });
      if (definition && Boolean(command.active !== false) !== registryActive) diagnostics.push({ type: "active_mismatch", command: command.name, active: command.active !== false, registryActive });
      if (command.syntax && typeof command.syntax !== "string") diagnostics.push({ type: "invalid_syntax", command: command.name });
      command.active = command.active !== false;
      command.enabled = enabled;
      command.handlerAvailable = handlerAvailable;
      command.requiredConfig = requiredConfig;
      command.requiredDependencies = requiredDependencies;
      command.missingConfig = missingConfig;
      command.missingDependencies = missingDependencies;
      command.registryActive = registryActive;
    }
    return {
      prefix: registry.prefix || "!",
      commands: commands.map((command) => resolveCommandPolicy({ command })),
      diagnostics,
      scannedAt: new Date().toISOString(),
    };
  }
}

function getRegisteredDefinition(registry, name) {
  const entries = registry.lookup.get(normalizeCommandKey(name));
  if (Array.isArray(entries)) return entries.length === 1 ? entries[0] : null;
  return entries || null;
}

function normalizeCommandKey(value) {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function validateCommandOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Overrides must be an object");
  const result = {};
  for (const [name, value] of Object.entries(overrides)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid override for ${name}`);
    result[name] = {};
    for (const [key, field] of Object.entries(value)) {
      if (key === "active" && typeof field !== "boolean") throw new Error(`active must be boolean for ${name}`);
      if (key === "scope" && !isValidScope(field)) throw new Error(`Invalid scope for ${name}`);
      if (key === "alias" && (!Array.isArray(field) || field.some((item) => typeof item !== "string" || !item.trim()))) throw new Error(`alias must be string array for ${name}`);
      if (key === "permission" && !PERMISSIONS.has(field)) throw new Error(`Invalid permission for ${name}`);
      if (key === "countdown" && (!Number.isInteger(field) || field < 0)) throw new Error(`Invalid countdown for ${name}`);
      if (["description", "syntax", "icon"].includes(key) && typeof field !== "string") throw new Error(`${key} must be string for ${name}`);
      if (key === "type" && (!Number.isInteger(field) || field < 0)) throw new Error(`Invalid type for ${name}`);
      result[name][key] = key === "alias" ? [...field] : field;
    }
  }
  return result;
}

async function walk(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function normalizeList(values) {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.trim()) : [];
}

function hasConfigValue(config, key) {
  if (!config || typeof config !== "object") return false;
  const value = config[key];
  return value !== undefined && value !== null && String(value).trim() !== "";
}

const dependencyCache = new Map();
const DEP_CACHE_TTL_MS = 60_000;

export async function defaultDependencyChecker(name) {
  const strName = String(name);
  const hit = dependencyCache.get(strName);
  if (hit && Date.now() - hit.timestamp < DEP_CACHE_TTL_MS) {
    return hit.available;
  }
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [strName], { stdio: "ignore" });
  const available = result.status === 0;
  dependencyCache.set(strName, { available, timestamp: Date.now() });
  return available;
}

export function clearDependencyCache() {
  dependencyCache.clear();
}
