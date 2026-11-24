import fs from "node:fs/promises";
import path from "node:path";
import { COMMAND_BEHAVIOR_SCHEMA, defaultBehaviorProfile } from "./command-behavior-schema.js";
import { ConfigStore } from "./config-store.js";

export function validateBehaviorProfile(input) {
  const errors = [];
  const normalized = defaultBehaviorProfile();

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", message: "Behavior profile must be an object" }], normalized: null };
  }
  if (input.version !== undefined && input.version !== 1) {
    errors.push({ path: "version", message: "Unsupported behavior version" });
  }

  for (const group of COMMAND_BEHAVIOR_SCHEMA.groups) {
    for (const field of group.fields) {
      const provided = getPathValue(input, field.key);
      if (provided === undefined) continue;
      const error = validateFieldValue(field, provided);
      if (error) errors.push({ path: field.key, message: error });
      else setPathValue(normalized, field.key, clone(provided));
    }
  }
  for (const key of Object.keys(input)) {
    if (key !== "version" && !COMMAND_BEHAVIOR_SCHEMA.groups.some((group) => group.fields.some((field) => field.key.startsWith(`${key}.`)))) {
      errors.push({ path: key, message: "Unknown field" });
    }
  }

  const paramItems = normalized.params?.items || [];
  for (const item of paramItems) {
    if (!String(item.key || "").trim()) errors.push({ path: "params.items", message: "Parameter keys must be non-empty" });
  }
  const paramKeys = new Set(paramItems.map((item) => String(item.key || "").trim().toLowerCase()));
  if (paramItems.length !== paramKeys.size) {
    errors.push({ path: "params.items", message: "Parameter keys must be unique" });
  }
  return errors.length ? { ok: false, errors, normalized: null } : { ok: true, errors: [], normalized };
}

function getPathValue(source, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), source);
}

function setPathValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let cursor = target;
  while (parts.length > 1) {
    cursor = cursor[parts.shift()] ||= {};
  }
  cursor[parts[0]] = value;
}

function validateFieldValue(field, value) {
  switch (field.type) {
    case "select":
      if (!field.options.includes(value)) return `Must be one of: ${field.options.join(", ")}`;
      return null;
    case "number": {
      if (value === null) return field.nullable ? null : "Must be a number";
      if (!Number.isInteger(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        return `Must be an integer${field.min !== undefined ? ` ≥ ${field.min}` : ""}${field.max !== undefined ? ` ≤ ${field.max}` : ""}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "Must be a boolean";
    case "text":
    case "template":
    case "emoji":
      return typeof value === "string" ? null : "Must be a string";
    case "table": {
      if (!Array.isArray(value)) return "Must be an array";
      for (const row of value) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return "Table rows must be objects";
        for (const column of field.columns) {
          const cell = row[column.key];
          if (cell === undefined || cell === "") continue;
          if (column.type === "number" && !Number.isFinite(Number(cell))) return `Column ${column.key} must be numeric`;
          if (column.control === "select" && !column.options.includes(cell)) return `Column ${column.key} must be one of: ${column.options.join(", ")}`;
        }
      }
      return null;
    }
    default:
      return `Unsupported field type: ${field.type}`;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class BehaviorStore {
  constructor({ root = process.cwd(), configStore } = {}) {
    this.root = path.resolve(root);
    this.globalPath = path.join(this.root, "assets", "json-data", "command.json");
    this.overrideDir = path.join(this.root, "mybot", "command-overrides");
    this.configStore = configStore || new ConfigStore({ backupDir: path.join(this.root, "logs", "dashboard-backups") });
  }

  static effective(globalProfile, overrideProfile) {
    return deepMerge(defaultBehaviorProfile(), globalProfile, overrideProfile);
  }

  #assertCommandExists(globalDoc, commandName) {
    const found = (Array.isArray(globalDoc.commands) ? globalDoc.commands : [])
      .find((command) => command.name === commandName);
    if (!found) {
      const error = new Error(`COMMAND_NOT_FOUND: Command not found: ${commandName}`);
      error.status = 404;
      error.code = "COMMAND_NOT_FOUND";
      throw error;
    }
    return found;
  }

  async getGlobal(commandName) {
    const doc = await this.#readGlobal();
    const command = (doc.commands || []).find((entry) => entry.name === commandName);
    return command?.behavior ? clone(command.behavior) : null;
  }

  async setGlobal(commandName, profile) {
    const doc = await this.#readGlobal();
    const command = this.#assertCommandExists(doc, commandName);
    command.behavior = clone(profile);
    const result = await this.configStore.writeJson(this.globalPath, doc);
    return { ...result, value: doc };
  }

  async resetGlobal(commandName) {
    const doc = await this.#readGlobal();
    const command = this.#assertCommandExists(doc, commandName);
    delete command.behavior;
    const result = await this.configStore.writeJson(this.globalPath, doc);
    return { ...result, value: doc };
  }

  async getForBot(botId, commandName) {
    const override = await this.#readOverride(botId);
    const entry = override[commandName];
    return { override: entry?.behavior ? clone(entry.behavior) : null };
  }

  async setForBot(botId, commandName, profile) {
    const doc = await this.#readGlobal();
    this.#assertCommandExists(doc, commandName);
    const override = await this.#readOverride(botId);
    override[commandName] = { ...(override[commandName] || {}), behavior: clone(profile) };
    const result = await this.configStore.writeJson(this.#overridePath(botId), override);
    return { ...result, value: override };
  }

  async resetForBot(botId, commandName) {
    const doc = await this.#readGlobal();
    this.#assertCommandExists(doc, commandName);
    const override = await this.#readOverride(botId);
    if (override[commandName]) {
      delete override[commandName].behavior;
      if (Object.keys(override[commandName]).length === 0) delete override[commandName];
      const result = await this.configStore.writeJson(this.#overridePath(botId), override);
      return { ...result, value: override };
    }
    return { backup: null, changedPaths: [], value: override };
  }

  async #readGlobal() {
    try {
      return JSON.parse(await fs.readFile(this.globalPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { prefix: "!", commands: [] };
      throw error;
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
    if (!/^[a-zA-Z0-9_-]+$/.test(String(botId))) throw new Error("Invalid bot id");
    return path.join(this.overrideDir, `${botId}.json`);
  }
}

function deepMerge(...layers) {
  const output = {};
  for (const layer of layers.filter(Boolean)) {
    for (const [key, value] of Object.entries(layer)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        output[key] = deepMerge(output[key], value);
      } else if (value !== undefined) {
        output[key] = clone(value);
      }
    }
  }
  return output;
}
