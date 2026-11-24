import fs from "fs";
import path from "path";
import { getProjectRoot } from "../utils/env.js";

/**
 * Parses a simple .env formatted file content into an object of key-value pairs.
 */
export function parseEnvFile(content) {
  const result = {};
  if (!content || typeof content !== "string") return result;

  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    if (!key) continue;

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }
  return result;
}

/**
 * Loads .env.local then .env without overwriting already set process.env variables.
 */
export function loadIdentityEnv({ projectRoot = getProjectRoot(), override = false } = {}) {
  const root = projectRoot || getProjectRoot();
  const envLocalPath = path.join(root, ".env.local");
  const envPath = path.join(root, ".env");

  const loadedKeys = [];

  // 1. Load .env.local first
  if (fs.existsSync(envLocalPath)) {
    try {
      const parsed = parseEnvFile(fs.readFileSync(envLocalPath, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (override || process.env[k] === undefined) {
          process.env[k] = v;
          loadedKeys.push(k);
        }
      }
    } catch {}
  }

  // 2. Load .env second
  if (fs.existsSync(envPath)) {
    try {
      const parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (override || process.env[k] === undefined) {
          process.env[k] = v;
          loadedKeys.push(k);
        }
      }
    } catch {}
  }

  return loadedKeys;
}

const VALID_IDENTIFIER_REGEX = /^[a-zA-Z0-9_]+$/;

/**
 * Validates database or identifier name against a strict whitelist.
 */
export function validateDatabaseName(name) {
  const str = String(name || "").trim();
  if (!str || !VALID_IDENTIFIER_REGEX.test(str)) {
    throw new Error(`Invalid database identifier: "${name}". Only alphanumeric and underscore characters are allowed.`);
  }
  return str;
}

/**
 * Masks sensitive fields (such as passwords) in a config object.
 */
export function maskSensitiveConfig(config) {
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    password: config.password ? "******" : "",
  };
}
