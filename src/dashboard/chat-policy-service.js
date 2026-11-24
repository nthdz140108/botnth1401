import fs from "node:fs/promises";
import path from "node:path";

const POLICY_KEYS = new Set(["groupEnabled", "privateEnabled"]);

export class ChatPolicyService {
  constructor({ root = process.cwd(), registry, configStore } = {}) {
    this.root = path.resolve(root);
    this.registry = registry;
    this.configStore = configStore;
  }

  async read(botId) {
    const target = await this.#resolveTarget(botId);
    const value = await readJson(target.file);
    return {
      botId: String(botId),
      groupEnabled: value.groupEnabled !== false,
      privateEnabled: value.privateEnabled !== false,
      path: target.file,
      value,
    };
  }

  async update(botId, patch) {
    const target = await this.#resolveTarget(botId);
    validatePatch(patch);
    const current = await readJson(target.file);
    const next = {
      ...current,
      groupEnabled: current.groupEnabled !== false,
      privateEnabled: current.privateEnabled !== false,
      ...patch,
    };
    const result = await this.configStore.writeJson(target.file, next);
    return {
      ...result,
      botId: String(botId),
      policy: {
        botId: String(botId),
        groupEnabled: next.groupEnabled,
        privateEnabled: next.privateEnabled,
      },
      path: target.file,
    };
  }

  async #resolveTarget(botId) {
    const bot = await this.registry?.describe?.(botId);
    if (!bot) throw botNotFound(botId);
    const file = bot.paths?.WEB_CONFIG_PATH
      || bot.paths?.webConfigPath
      || bot.config?.WEB_CONFIG_PATH
      || path.join(this.root, "assets", "web-config", "web-config.json");
    return { bot, file: path.resolve(file) };
  }
}

function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw validationError("Chat policy must be an object");
  for (const [key, value] of Object.entries(patch)) {
    if (!POLICY_KEYS.has(key) || typeof value !== "boolean") throw validationError(`${key} must be boolean`);
  }
}

async function readJson(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be an object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function botNotFound(botId) {
  const error = new Error(`Bot not found: ${botId}`);
  error.status = 404;
  error.code = "BOT_NOT_FOUND";
  return error;
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "CHAT_POLICY_VALIDATION_FAILED";
  return error;
}
