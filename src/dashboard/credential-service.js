import fs from "node:fs/promises";
import path from "node:path";
import { ConfigStore } from "./config-store.js";

const SENSITIVE_KEYS = /cookie|token|password|secret|imei|useragent|credential/i;
const PLACEHOLDER_VALUES = new Set(["[REDACTED]", "[masked]"]);
const OMIT = Symbol("OMIT");

function assertSafeBotId(botId) {
  if (typeof botId !== "string" || !botId.trim() || botId.includes("..") || /[\\/\0]/.test(botId) || !/^[a-zA-Z0-9._-]+$/.test(botId) || botId === "." || botId === "..") {
    const error = new Error("Invalid bot id");
    error.status = 400;
    error.code = "INVALID_BOT_ID";
    throw error;
  }
}

function botNotFoundError() {
  const error = new Error("Bot not found");
  error.status = 404;
  error.code = "BOT_NOT_FOUND";
  return error;
}

export class CredentialService {
  constructor({ root = process.cwd(), registry, configStore } = {}) {
    this.root = path.resolve(root);
    this.registry = registry;
    this.configStore = configStore || new ConfigStore({ backupDir: path.join(this.root, "logs", "dashboard-backups") });
  }

  async read(botId) {
    assertSafeBotId(botId);
    const bot = await this.registry.describe(botId);
    if (!bot) throw botNotFoundError();
    const loaded = await this.#readCredentialFile(bot);
    if (!loaded.configured) return loaded;
    return { configured: true, state: "configured", value: loaded.value };
  }

  async reveal(botId) {
    assertSafeBotId(botId);
    const bot = await this.registry.describe(botId);
    if (!bot) throw botNotFoundError();
    return this.#readCredentialFile(bot);
  }

  async update(botId, patch) {
    assertSafeBotId(botId);
    const bot = await this.registry.describe(botId);
    if (!bot) throw botNotFoundError();
    const current = await this.#readCredentialFile(bot);
    const next = this.#merge(current, patch);
    const file = this.#resolveSafeFile(bot);
    if (!file) throw new Error("Credential file not found");
    const result = await this.configStore.writeJson(file, next);
    return { ...result, value: redact(next) };
  }

  #resolveSafeFile(bot) {
    const candidate = bot?.configPath || bot?.paths?.credentialPath;
    if (!candidate || typeof candidate !== "string") return null;
    const resolved = path.resolve(this.root, candidate);
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (!resolved.startsWith(rootPrefix)) {
      const error = new Error("Unsafe credential path");
      error.status = 400;
      error.code = "INVALID_CREDENTIAL_PATH";
      throw error;
    }
    return resolved;
  }

  async #readCredentialFile(bot) {
    const file = this.#resolveSafeFile(bot);
    if (!file) return { configured: false, state: "missing" };
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      return { configured: true, state: "configured", value: redact(raw), raw };
    } catch (error) {
      if (error.code === "ENOENT") return { configured: false, state: "missing" };
      return { configured: false, state: "invalid" };
    }
  }

  #merge(current, patch) {
    const base = current?.raw && typeof current.raw === "object" && !Array.isArray(current.raw) ? current.raw : {};
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ...base };
    const sanitized = sanitizePatchValue(patch);
    if (sanitized === OMIT) return { ...base };
    return deepMergeCredential(base, sanitized, patch);
  }
}

function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER_VALUES.has(value.trim());
}

function sanitizePatchValue(value) {
  if (isPlaceholder(value)) return OMIT;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const cleaned = value
      .map((item) => sanitizePatchValue(item))
      .filter((item) => item !== OMIT);
    return cleaned.length === 0 ? OMIT : cleaned;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return {};
    const out = {};
    let kept = 0;
    for (const [key, item] of entries) {
      const cleaned = sanitizePatchValue(item);
      if (cleaned !== OMIT) {
        out[key] = cleaned;
        kept += 1;
      }
    }
    return kept === 0 ? OMIT : out;
  }
  return value;
}

function deepMergeCredential(base, cleanPatch, originalPatch) {
  const result = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  if (!cleanPatch || typeof cleanPatch !== "object" || Array.isArray(cleanPatch)) return result;
  for (const [key, val] of Object.entries(cleanPatch)) {
    const origVal = originalPatch?.[key];
    const isExplicitEmptyObject = origVal && typeof origVal === "object" && !Array.isArray(origVal) && Object.keys(origVal).length === 0;
    if (
      !isExplicitEmptyObject &&
      val && typeof val === "object" && !Array.isArray(val) &&
      result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
    ) {
      result[key] = deepMergeCredential(result[key], val, origVal);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function redact(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.test(key) ? "[masked]" : item && typeof item === "object" ? redact(item) : item;
  }
  return out;
}
