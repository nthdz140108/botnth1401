import fs from "node:fs/promises";
import path from "node:path";
import { validateCommandOverrides } from "./command-scanner.js";
import { ConfigStore } from "./config-store.js";
import { isValidScope, resolveCommandPolicy } from "../commands/command-policy.js";
import { withReleaseCommandDefaults } from "../utils/release-command-catalog.js";

const PERMISSIONS = new Set(["all", "adminBot", "adminBox", "adminBotOrGroup", "adminLevelHigh"]);

export class CommandService {
  constructor({ root = process.cwd(), registry, scanner, configStore } = {}) {
    this.root = path.resolve(root);
    this.registry = registry;
    this.scanner = scanner;
    this.globalPath = path.join(this.root, "assets", "json-data", "command.json");
    this.overrideDir = path.join(this.root, "mybot", "command-overrides");
    this.configStore = configStore || new ConfigStore({ backupDir: path.join(this.root, "logs", "dashboard-backups") });
  }

  async scan() {
    return this.scanner.scan();
  }

  async list() {
    return this.scanner.scan();
  }

  async updateGlobal(name, patch) {
    const global = await this.#readGlobal(false);
    const current = findCommand(withReleaseCommandDefaults(global).commands, name);
    if (!current) throw commandNotFound(name);
    let validated;
    try {
      validated = this.#validatePatch(patch, name);
    } catch (error) {
      error.status = 400;
      error.code = "COMMAND_VALIDATION_FAILED";
      throw error;
    }
    const updated = { ...current, ...validated, active: current.active !== false };
    const commands = global.commands.includes(current)
      ? global.commands.map((command) => command === current ? updated : command)
      : [...global.commands, updated];
    try { this.#validateCollection(withReleaseCommandDefaults({ ...global, commands }).commands); } catch (error) { throw validationError(error); }
    const result = await this.configStore.writeJson(this.globalPath, { ...global, commands });
    return { ...result, value: { ...global, commands } };
  }

  async createGlobal(command) {
    const global = await this.#readGlobal(false);
    let next;
    try {
      next = { ...global, commands: [...global.commands, this.#validateCommand(command, "new command")] };
      this.#validateCollection(withReleaseCommandDefaults(next).commands);
    } catch (error) {
      throw validationError(error);
    }
    const result = await this.configStore.writeJson(this.globalPath, next);
    return { ...result, value: next };
  }

  async deleteGlobal(name) {
    const global = await this.#readGlobal(false);
    const current = findCommand(withReleaseCommandDefaults(global).commands, name);
    if (!current) throw commandNotFound(name);
    const releaseCommand = findCommand(withReleaseCommandDefaults({ commands: [] }).commands, current.name);
    if (releaseCommand) throw validationError(new Error("Lệnh thuộc release; hãy tắt active bằng cấu hình riêng của bot thay vì xóa."));
    const next = { ...global, commands: global.commands.filter((command) => command !== current) };
    const result = await this.configStore.writeJson(this.globalPath, next);
    return { ...result, value: next };
  }

  async listForBot(botId) {
    const [global, scanned] = await Promise.all([this.#readGlobal(), this.scan()]);
    const override = await this.#readOverride(botId);
    const scannedByName = new Map((Array.isArray(scanned?.commands) ? scanned.commands : []).map((command) => [normalizeCommandKey(command.name), command]));
    return {
      botId,
      commands: global.commands.map((command) => {
        const commandOverride = override[command.name] || null;
        const policy = resolveCommandPolicy({
          command,
          override: commandOverride,
        });
        const scannedCommand = scannedByName.get(normalizeCommandKey(command.name)) || {};
        const effectiveActive = commandOverride && typeof commandOverride.active === "boolean"
          ? commandOverride.active
          : command.active !== false;
        const enabled = effectiveActive
          && Boolean(scannedCommand.handlerAvailable)
          && (Array.isArray(scannedCommand.missingConfig) ? scannedCommand.missingConfig.length === 0 : true)
          && (Array.isArray(scannedCommand.missingDependencies) ? scannedCommand.missingDependencies.length === 0 : true);
        return {
          ...policy,
          ...scannedCommand,
          active: command.active !== false,
          enabled,
          override: commandOverride,
        };
      }),
    };
  }

  async updateOverride(botId, name, patch) {
    const override = await this.#readOverride(botId);
    try {
      const global = await this.#readGlobal();
      const current = findCommand(global.commands, name);
      if (!current) throw commandNotFound(name);
      const canonicalName = current.name;
      override[canonicalName] = validateCommandOverrides({ [canonicalName]: patch })[canonicalName];
      this.#validateCollection(global.commands.map((command) => {
        const savedOverride = override[command.name] || {};
        return command === current ? { ...command, ...savedOverride } : { ...command, ...savedOverride };
      }));
    } catch (error) {
      error.status = 400;
      error.code = "COMMAND_VALIDATION_FAILED";
      throw error;
    }
    const file = this.#overridePath(botId);
    const result = await this.configStore.writeJson(file, override);
    return { ...result, value: override };
  }

  async deleteOverride(botId, name) {
    const override = await this.#readOverride(botId);
    const global = await this.#readGlobal();
    const current = findCommand(global.commands, name);
    if (!current) throw commandNotFound(name);
    const commandKeys = new Set([current.name, ...(Array.isArray(current.alias) ? current.alias : [])].map(normalizeCommandKey));
    for (const key of Object.keys(override)) {
      if (commandKeys.has(normalizeCommandKey(key))) delete override[key];
    }
    const file = this.#overridePath(botId);
    const result = await this.configStore.writeJson(file, override);
    return { ...result, value: override };
  }

  async copyFromAdmin(botId) {
    const admin = await this.#readOverride("admin");
    const file = this.#overridePath(botId);
    const result = await this.configStore.writeJson(file, admin);
    return { ...result, value: admin };
  }

  async applyAll({ commandName, patch }) {
    const bots = await this.registry.list();
    const botIds = [];
    for (const bot of bots) {
      if (bot.id === "admin") continue;
      await this.updateOverride(bot.id, commandName, patch);
      botIds.push(bot.id);
    }
    return { botIds };
  }

  validatePatch(name, patch) {
    return this.#validatePatch(patch, name);
  }

  #validatePatch(patch, name) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error(`Invalid override for ${name}`);
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "name") {
        if (typeof value !== "string" || !value.trim()) throw new Error(`name must be a non-empty string for ${name}`);
      } else if (key === "alias") {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`alias must be string array for ${name}`);
      } else if (key === "permission") {
        if (!PERMISSIONS.has(value)) throw new Error(`Invalid permission for ${name}`);
      } else if (key === "countdown") {
        if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid countdown for ${name}`);
      } else if (["active"].includes(key)) {
        if (typeof value !== "boolean") throw new Error(`active must be boolean for ${name}`);
      } else if (key === "scope") {
        if (!isValidScope(value)) throw new Error(`Invalid scope for ${name}`);
      } else if (["description", "syntax", "icon"].includes(key)) {
        if (typeof value !== "string") throw new Error(`${key} must be string for ${name}`);
      } else if (key === "type") {
        if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid type for ${name}`);
      }
      next[key] = value;
    }
    return next;
  }

  #validateCommand(command, name) {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error(`Invalid ${name}`);
    const next = this.#validatePatch(command, name);
    if (!next.name) throw new Error(`name must be a non-empty string for ${name}`);
    return next;
  }

  #validateCollection(commands) {
    const names = new Map();
    for (const command of commands) {
      if (!command?.name || typeof command.name !== "string" || !command.name.trim()) throw new Error("Command name is required");
      if (command.alias !== undefined && (!Array.isArray(command.alias) || command.alias.some((alias) => typeof alias !== "string" || !alias.trim()))) {
        throw new Error(`Invalid aliases for ${command.name}`);
      }
      for (const value of [command.name, ...(Array.isArray(command.alias) ? command.alias : [])]) {
        const key = normalizeCommandKey(value);
        if (names.has(key)) throw new Error(`Duplicate alias: ${value}`);
        names.set(key, command.name);
      }
    }
  }

  async #readGlobal(includeDefaults = true) {
    try {
      const value = JSON.parse(await fs.readFile(this.globalPath, "utf8"));
      const catalog = { prefix: value.prefix || "!", commands: Array.isArray(value.commands) ? value.commands : [] };
      return includeDefaults ? withReleaseCommandDefaults(catalog) : catalog;
    } catch {
      const catalog = { prefix: "!", commands: [] };
      return includeDefaults ? withReleaseCommandDefaults(catalog) : catalog;
    }
  }

  async #readOverride(botId) {
    try {
      return JSON.parse(await fs.readFile(this.#overridePath(botId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  #overridePath(botId) {
    if (typeof botId !== "string" || !botId.trim() || botId.includes("..") || /[\\/\0]/.test(botId) || !/^[a-zA-Z0-9._-]+$/.test(botId) || botId === "." || botId === "..") {
      const error = new Error("Invalid bot id");
      error.status = 400;
      error.code = "INVALID_BOT_ID";
      throw error;
    }
    const resolved = path.resolve(this.overrideDir, `${botId}.json`);
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    const overridePrefix = this.overrideDir.endsWith(path.sep) ? this.overrideDir : `${this.overrideDir}${path.sep}`;
    if (!resolved.startsWith(rootPrefix) || !resolved.startsWith(overridePrefix)) {
      const error = new Error("Invalid bot override path");
      error.status = 400;
      error.code = "INVALID_BOT_ID";
      throw error;
    }
    return resolved;
  }
}

function findCommand(commands, identifier) {
  const key = normalizeCommandKey(identifier);
  if (!key) return null;
  return commands.find((command) => [command.name, ...(Array.isArray(command.alias) ? command.alias : [])]
    .some((candidate) => normalizeCommandKey(candidate) === key)) || null;
}

function normalizeCommandKey(value) {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function commandNotFound(name) {
  const error = new Error(`Command not found: ${name}`);
  error.status = 404;
  error.code = "COMMAND_NOT_FOUND";
  return error;
}

function validationError(error) {
  error.status = 400;
  error.code = "COMMAND_VALIDATION_FAILED";
  return error;
}
