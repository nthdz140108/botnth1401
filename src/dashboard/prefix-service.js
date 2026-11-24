import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_PREFIX = "!";
const PREFIX_PATTERN = /^\S{1,3}$/;

export class PrefixService {
  constructor({ root = process.cwd(), registry, configStore } = {}) {
    this.root = path.resolve(root);
    this.registry = registry;
    this.configStore = configStore;
  }

  async read(botId) {
    const bot = await this.#getBot(botId);
    const files = await this.#existingFiles(bot);
    if (files.length === 0) return { botId: bot.id, prefix: DEFAULT_PREFIX, available: false };
    const config = await readJson(files[0]);
    return { botId: bot.id, prefix: normalizePrefix(config?.prefix), available: true };
  }

  async update(botId, prefix) {
    if (!isValidPrefix(prefix)) {
      const error = new Error("Prefix must be 1-3 non-space characters");
      error.code = "PREFIX_INVALID";
      error.status = 400;
      throw error;
    }

    const { bot, files } = await this.#resolve(botId);
    const current = await readJson(files[0]);
    const results = [];
    for (const file of files) {
      results.push(await this.configStore.writeJson(file, { ...current, prefix }));
    }
    return {
      value: { botId: bot.id, prefix },
      backup: results.findLast((result) => result.backup)?.backup || null,
      backups: results.flatMap((result) => result.backup ? [result.backup] : []),
      changedPaths: [...new Set(results.flatMap((result) => result.changedPaths || []))],
      restartRequired: true,
      pathKey: "commandFilePath",
    };
  }

  async #resolve(botId) {
    const bot = await this.#getBot(botId);
    const files = await this.#existingFiles(bot);
    if (files.length === 0) {
      const error = new Error("Command config file not found");
      error.code = "PREFIX_UNAVAILABLE";
      error.status = 404;
      throw error;
    }
    return { bot, files };
  }

  async #existingFiles(bot) {
    const candidates = [
      path.join(this.root, "mybot", "instances", bot.id, "data", "command.json"),
      bot.paths?.commandFilePath,
    ].filter(Boolean);
    const unique = [...new Set(candidates.map((file) => path.resolve(file)))];
    const existing = [];
    for (const file of unique) {
      if (await fileExists(file)) existing.push(file);
    }
    return existing;
  }

  async #getBot(botId) {
    const bot = await this.registry.describe(botId);
    if (!bot) {
      const error = new Error("Bot not found");
      error.code = "BOT_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    return bot;
  }
}

export function isValidPrefix(value) {
  return typeof value === "string" && PREFIX_PATTERN.test(value);
}

async function readJson(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    const wrapped = new Error("Command config is invalid");
    wrapped.code = "PREFIX_CONFIG_INVALID";
    wrapped.status = 409;
    throw wrapped;
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function normalizePrefix(value) {
  return isValidPrefix(value) ? value : DEFAULT_PREFIX;
}
