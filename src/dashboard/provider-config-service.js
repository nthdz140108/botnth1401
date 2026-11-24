import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { sanitizeUrl } from "./provider-adapter.js";

export const PROVIDER_CONFIG_KEYS = Object.freeze([
  "GEMINI_API_KEYS",
  "SOUNDCLOUD_CLIENT_ID",
  "SIMSIMI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GOOGLE_SEARCH_API_KEY",
  "GOOGLE_SEARCH_CSE_ID",
  "GOOGLE_SEARCH_ENGINE_ID",
  "OPENWEATHER_API_KEY",
  "WEATHER_API_KEY",
  "WEATHERAPI_KEY",
  "TOMORROW_API_KEY",
  "HOANGDEV_API_KEY",
  "TIKTOK_SEARCH_API_URL",
  "TIKTOK_SEARCH_API_KEY",
  "TIKTOK_COOKIE",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_DOWNLOADER_SECRET",
  "SPOTIFY_DOWNLOADER_PASSPHRASE",
  "TENOR_API_KEY",
  "REMOVE_BG_API_KEY",
  "ZINGMP3_API_KEY",
  "ZINGMP3_SECRET_KEY",
  "ZALO_DIRTYCONTENT_API_KEY",
  "IMGUR_CLIENT_ID",
  "INSTAGRAM_APP_ID",
  "FM_X_APIKEY",
  "YOUTUBE_API_KEY",
  "YOUTUBE_COOKIES",
  "YOUTUBE_PROXY_URL",
  "ZALO_WEB_URL",
  "ZALO_ORIGIN",
  "ZALO_REFERER",
  "ZALO_USER_AGENT",
  "PINTEREST_API_KEY",
  "PINTEREST_COOKIE",
  "CAPCUT_API_KEY",
  "CAPCUT_COOKIE",
  "CAPCUT_BASE_URL",
  "SERPAPI_API_KEY",
  "VIRUSTOTAL_API_KEY",
  "SAFE_BROWSING_API_KEY",
  "URLVOID_API_KEY",
  "WHOIS_API_KEY",
  "ABUSEIPDB_API_KEY",
  "ALIENVAULT_API_KEY",
  "SHODAN_API_KEY",
  "KIRA_API_KEY",
  "KIRA_BASE_URL",
  "KIRA_MODEL",
  "KIRA_TIMEOUT_MS",
]);

export const PROVIDER_GROUPS = Object.freeze([
  { id: "gemini", label: "Gemini", keys: ["GEMINI_API_KEYS"] },
  { id: "gpt-deepseek", label: "GPT / DeepSeek", keys: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] },
  { id: "google-search", label: "Google Search", keys: ["GOOGLE_SEARCH_API_KEY", "GOOGLE_SEARCH_CSE_ID", "GOOGLE_SEARCH_ENGINE_ID"] },
  { id: "security", label: "Security", keys: ["SERPAPI_API_KEY", "SERPAPI_KEY", "VIRUSTOTAL_API_KEY", "SAFE_BROWSING_API_KEY", "GOOGLE_SAFEBROWSING_API_KEY", "URLVOID_API_KEY", "WHOIS_API_KEY", "ABUSEIPDB_API_KEY", "ALIENVAULT_API_KEY", "SHODAN_API_KEY"] },
  { id: "tiktok", label: "TikTok", keys: ["TIKTOK_SEARCH_API_URL", "TIKTOK_SEARCH_API_KEY", "TIKTOK_COOKIE"] },
  { id: "youtube", label: "YouTube", keys: ["YOUTUBE_API_KEY", "YOUTUBE_COOKIES", "YOUTUBE_PROXY_URL"] },
  { id: "zalo", label: "Zalo Runtime", keys: ["ZALO_WEB_URL", "ZALO_ORIGIN", "ZALO_REFERER", "ZALO_USER_AGENT"] },
  { id: "pinterest", label: "Pinterest", keys: ["PINTEREST_API_KEY", "PINTEREST_COOKIE"] },
  { id: "capcut", label: "CapCut", keys: ["CAPCUT_API_KEY", "CAPCUT_COOKIE", "CAPCUT_BASE_URL"] },
  { id: "music", label: "Music Providers", keys: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_DOWNLOADER_SECRET", "SPOTIFY_DOWNLOADER_PASSPHRASE", "ZINGMP3_API_KEY", "ZINGMP3_SECRET_KEY", "SOUNDCLOUD_CLIENT_ID"] },
  { id: "kiraai", label: "KiraAI", keys: ["KIRA_API_KEY", "KIRA_BASE_URL", "KIRA_MODEL", "KIRA_TIMEOUT_MS"] },
]);

const PROVIDER_KEY_SET = new Set(PROVIDER_CONFIG_KEYS);

export async function readProviderConfig(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const fallback = await readDotenvFile(path.join(resolvedRoot, ".env"));
  const local = await readDotenvFile(path.join(resolvedRoot, ".env.local"));
  const effective = { ...fallback, ...local };
  for (const key of PROVIDER_CONFIG_KEYS) {
    if (process.env[key] !== undefined) effective[key] = process.env[key];
  }

  return {
    keys: PROVIDER_CONFIG_KEYS.map((name) => {
      const configured = Boolean(String(effective[name] ?? "").trim());
      return { name, configured, masked: configured ? "********" : "" };
    }),
    groups: PROVIDER_GROUPS.map((group) => summarizeGroup(group, effective)),
    health: summarizeProviderHealth(effective),
  };
}

export async function updateProviderConfig(root = process.cwd(), values) {
  validateValues(values);
  const resolvedRoot = path.resolve(root);
  const localPath = path.join(resolvedRoot, ".env.local");
  const backupDir = path.join(resolvedRoot, "logs", "dashboard-backups");
  const previous = await readRawFile(localPath);
  const current = previous === null ? {} : dotenv.parse(previous);
  const changedKeys = Object.keys(values)
    .filter((key) => normalizeValue(current[key]) !== normalizeValue(values[key]))
    .sort();

  if (changedKeys.length === 0) {
    return { ...(await readProviderConfig(resolvedRoot)), changedKeys, backup: null, restartRequired: true };
  }

  let backup = null;
  if (previous !== null) {
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `provider-env-${Date.now()}-${process.pid}.bak`);
    await fs.writeFile(backupPath, previous, "utf8");
    backup = { file: backupPath };
  }

  const eol = previous?.includes("\r\n") ? "\r\n" : "\n";
  const sourceLines = previous === null ? [] : previous.split(/\r?\n/);
  const nextLines = applyUpdates(sourceLines, values);
  const output = nextLines.join(eol);
  const tempDir = await fs.mkdtemp(path.join(resolvedRoot, ".provider-config-"));
  try {
    const tempPath = path.join(tempDir, path.basename(localPath));
    await fs.writeFile(tempPath, output, "utf8");
    await fs.rename(tempPath, localPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return {
    ...(await readProviderConfig(resolvedRoot)),
    changedKeys,
    backup,
    restartRequired: true,
  };
}

async function readFirstExisting(paths) {
  for (const file of paths) {
    const data = await readRawFile(file);
    if (data !== null) return data;
  }
  return null;
}

export class ProviderConfigService {
  constructor({ root = process.cwd() } = {}) {
    this.root = path.resolve(root);
  }

  read() {
    return readProviderConfig(this.root);
  }

  update(values) {
    return updateProviderConfig(this.root, values);
  }
}

async function readDotenvFile(file) {
  const source = await readRawFile(file);
  return source === null ? {} : dotenv.parse(source);
}

async function readRawFile(file) {
  return fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function validateValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw providerConfigError("Provider config values must be an object");
  }
  const invalidKeys = Object.keys(values).filter((key) => !PROVIDER_KEY_SET.has(key));
  const invalidTypes = Object.entries(values)
    .filter(([, value]) => typeof value !== "string")
    .map(([key]) => key);
  if (invalidKeys.length || invalidTypes.length) {
    throw providerConfigError("Provider config contains invalid values", {
      invalidKeys,
      invalidTypes,
    });
  }
}

function providerConfigError(message, details = {}) {
  const error = new Error(message);
  error.code = "PROVIDER_CONFIG_INVALID";
  error.status = 400;
  Object.assign(error, details);
  return error;
}

function normalizeValue(value) {
  return String(value ?? "").trim();
}

function applyUpdates(lines, values) {
  const found = new Set();
  const next = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    const key = match?.[1];
    if (!key || !Object.prototype.hasOwnProperty.call(values, key)) {
      next.push(line);
      continue;
    }
    if (found.has(key)) continue;
    found.add(key);
    const value = values[key];
    if (normalizeValue(value) !== "") next.push(`${key}=${serializeValue(value)}`);
  }

  for (const [key, value] of Object.entries(values)) {
    if (found.has(key) || normalizeValue(value) === "") continue;
    next.push(`${key}=${serializeValue(value)}`);
  }
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  return next.length ? [...next, ""] : [];
}

function serializeValue(value) {
  const normalized = value.trim();
  return /[\s#"'\\\n\r]/.test(normalized) ? JSON.stringify(value) : value;
}

function summarizeGroup(group, env) {
  const configuredKeys = group.keys.filter((key) => Boolean(String(env[key] ?? "").trim()));
  const missingKeys = group.keys.filter((key) => !Boolean(String(env[key] ?? "").trim()));
  const status = configuredKeys.length === group.keys.length ? "healthy" : configuredKeys.length ? "degraded" : "missing";
  return {
    id: group.id,
    label: group.label,
    status,
    configured: configuredKeys.length,
    required: group.keys.length,
    missingKeys,
    configuredKeys: configuredKeys.map((key) => ({ name: key, masked: "********" })),
  };
}

function summarizeProviderHealth(env) {
  return Object.fromEntries(PROVIDER_GROUPS.map((group) => [group.id, summarizeHealthItem(group, env)]));
}

function summarizeHealthItem(group, env) {
  const configuredKeys = group.keys.filter((key) => Boolean(String(env[key] ?? "").trim()));
  const missingKeys = group.keys.filter((key) => !Boolean(String(env[key] ?? "").trim()));
  return {
    provider: group.id,
    label: group.label,
    status: configuredKeys.length === group.keys.length ? "healthy" : configuredKeys.length ? "degraded" : "missing",
    configuredKeys: configuredKeys.length,
    missingKeys: missingKeys.length,
    dependencies: group.keys.map((name) => ({ name, configured: Boolean(String(env[name] ?? "").trim()) })),
    endpointHints: providerEndpointHints(group.id, env),
  };
}

function providerEndpointHints(providerId, env) {
  const hints = {
    gemini: { baseUrl: "https://generativelanguage.googleapis.com", note: "Uses Gemini API keys from environment" },
    "gpt-deepseek": { baseUrl: env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || null, note: "Uses OpenAI-compatible endpoint if configured" },
    "google-search": { baseUrl: "https://www.googleapis.com/customsearch/v1", note: "Google Search provider metadata only" },
    tiktok: { baseUrl: env.TIKTOK_SEARCH_API_URL || null, note: "Uses TikTok search provider URL when configured" },
    youtube: { baseUrl: "https://www.youtube.com", note: "Media workflow health is config driven" },
    zalo: { baseUrl: env.ZALO_WEB_URL || "https://chat.zalo.me", note: "Zalo runtime uses config adapter defaults" },
    pinterest: { baseUrl: null, note: "Pinterest health is config driven" },
    capcut: { baseUrl: null, note: "CapCut health is config driven" },
    music: { baseUrl: null, note: "Music provider health is config driven" },
  };
  const hint = hints[providerId] || { baseUrl: null, note: "Provider health is config driven" };
  return {
    ...hint,
    baseUrl: sanitizeUrl(hint.baseUrl || "") || null,
  };
}
