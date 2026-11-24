import fs from "node:fs/promises";
import path from "node:path";

const ANTI_RULE_KEYS = Object.freeze([
  "antiLink",
  "antiTag",
  "antiForward",
  "antiSticker",
  "antiText",
  "antiFile",
  "antiPhotoVideo",
  "antiVoice",
  "antiUndo",
  "antiNude",
  "antiSpam",
  "antiJoinLeave",
  "whitelist",
  "removeLinks",
  "removeTags",
  "blockForward",
  "allowSticker",
  "antiMention",
]);

const DEFAULT_ANTI_RULES = Object.freeze({
  antiLink: false,
  antiTag: false,
  antiForward: false,
  antiSticker: false,
  antiText: false,
  antiFile: false,
  antiPhotoVideo: false,
  antiVoice: false,
  antiUndo: false,
  antiNude: false,
  antiSpam: false,
  antiJoinLeave: false,
  whitelist: {},
  removeLinks: false,
  removeTags: false,
  blockForward: false,
  allowSticker: false,
  antiMention: false,
});

export const ANTI_CONFIG_FILENAME = "config-anti.json";
export const ANTI_LINK_WHITELIST_FILENAME = "link-whitelist.json";
export const ANTI_LIST_FILENAME = "list.json";

export function createDefaultAntiState() {
  return {
    badWords: [],
    linkRegex: "",
    violations: {},
    violationsNude: {},
    groups: {},
    migratedSources: [],
  };
}

export function normalizeAntiState(rawState = {}) {
  const state = createDefaultAntiState();
  const source = rawState && typeof rawState === "object" ? rawState : {};
  state.badWords = Array.isArray(source.badWords) ? [...new Set(source.badWords.filter(Boolean))] : [];
  state.linkRegex = typeof source.linkRegex === "string" && source.linkRegex.trim()
    ? source.linkRegex.trim()
    : defaultLinkRegex();
  state.violations = normalizeObject(source.violations);
  state.violationsNude = normalizeObject(source.violationsNude);
  state.groups = normalizeGroups(source.groups);
  state.migratedSources = Array.isArray(source.migratedSources)
    ? [...new Set(source.migratedSources.filter((value) => typeof value === "string" && value))]
    : [];
  return state;
}

export function normalizeGroupSettingsThread(threadSettings = {}) {
  const normalized = { ...threadSettings };
  for (const [key, value] of Object.entries(DEFAULT_ANTI_RULES)) {
    if (key === "whitelist") {
      normalized.whiteList = normalizeObject(threadSettings.whiteList || threadSettings.whitelist);
      normalized.whitelist = normalized.whiteList;
      continue;
    }
    if (key === "removeLinks") {
      normalized.removeLinks = Boolean(threadSettings.removeLinks ?? threadSettings.antiLink ?? value);
      continue;
    }
    if (key === "removeTags") {
      normalized.removeTags = Boolean(threadSettings.removeTags ?? threadSettings.antiTag ?? value);
      continue;
    }
    if (key === "blockForward") {
      normalized.blockForward = Boolean(threadSettings.blockForward ?? threadSettings.antiForward ?? value);
      continue;
    }
    if (key === "allowSticker") {
      const stickerValue = threadSettings.allowSticker;
      normalized.allowSticker = typeof stickerValue === "boolean"
        ? stickerValue
        : Boolean(threadSettings.antiSticker ? false : value);
      continue;
    }
    normalized[key] = Boolean(threadSettings[key] ?? value);
  }
  normalized.whiteList = normalizeObject(normalized.whiteList);
  normalized.whitelist = normalized.whiteList;
  return normalized;
}

export async function migrateAntiConfigFiles(rootDir = process.cwd()) {
  const antiDir = path.join(rootDir, "src", "service-debug", "anti-service");
  const configPath = path.join(antiDir, ANTI_CONFIG_FILENAME);
  const linkWhitelistPath = path.join(antiDir, ANTI_LINK_WHITELIST_FILENAME);
  const listPath = path.join(antiDir, ANTI_LIST_FILENAME);
  await fs.mkdir(antiDir, { recursive: true });

  const currentConfig = normalizeAntiState(await readJson(configPath));
  const migratedSources = new Set(currentConfig.migratedSources);
  const legacyGroupSettings = path.join(rootDir, "assets", "data", "group_settings.json");
  const legacyWhitelist = path.join(rootDir, "assets", "data", "link-whitelist.json");

  const legacyGroups = await readJson(legacyGroupSettings);
  if (legacyGroups && typeof legacyGroups === "object" && !Array.isArray(legacyGroups)) {
    currentConfig.groups = mergeGroups(currentConfig.groups, legacyGroups);
    migratedSources.add("assets/data/group_settings.json");
  }

  await writeJsonIfChanged(configPath, { ...currentConfig, migratedSources: [...migratedSources] });

  const whitelistData = await readJson(linkWhitelistPath);
  await writeJsonIfChanged(linkWhitelistPath, normalizeObject(whitelistData));

  const listData = await readJson(listPath);
  await writeJsonIfChanged(listPath, Array.isArray(listData) ? listData : []);

  const legacyWhitelistData = await readJson(legacyWhitelist);
  if (legacyWhitelistData && Object.keys(legacyWhitelistData).length > 0) {
    await writeJsonIfChanged(linkWhitelistPath, normalizeObject(legacyWhitelistData));
  }

  return {
    configPath,
    linkWhitelistPath,
    listPath,
    state: normalizeAntiState(await readJson(configPath)),
  };
}

export function resolveGroupAntiSettings(groupSettings, threadId) {
  const threadSettings = normalizeGroupSettingsThread(groupSettings?.[threadId] || {});
  if (groupSettings && threadId && !groupSettings[threadId]) {
    groupSettings[threadId] = threadSettings;
  }
  return threadSettings;
}

export function createAntiRuleResult({ handled = false, rule = null, action = null, reason = null } = {}) {
  return { handled, rule, action, reason };
}

export async function evaluateAntiRules(context, rules = []) {
  for (const rule of rules) {
    try {
      const outcome = await rule.run(context);
      if (outcome?.handled) return outcome;
    } catch (error) {
      if (typeof context?.onError === "function") {
        context.onError({ error, rule: rule.name, context });
      }
    }
  }
  return createAntiRuleResult();
}

export function getAntiRuleStatus(groupSettings, threadId, key) {
  const threadSettings = resolveGroupAntiSettings(groupSettings, threadId);
  return Boolean(threadSettings[key]);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonIfChanged(file, next) {
  const current = await readJson(file);
  if (deepEqual(current, next)) return false;
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => typeof key === "string" && key));
}

function normalizeGroups(groups) {
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) return {};
  const next = {};
  for (const [threadId, settings] of Object.entries(groups)) {
    next[threadId] = normalizeGroupSettingsThread(settings);
  }
  return next;
}

function mergeGroups(baseGroups, legacyGroups) {
  const merged = normalizeGroups(baseGroups);
  for (const [threadId, settings] of Object.entries(legacyGroups)) {
    merged[threadId] = normalizeGroupSettingsThread({
      ...(merged[threadId] || {}),
      ...settings,
    });
  }
  return merged;
}

function defaultLinkRegex() {
  return "(?:https?:\\/\\/|www\\.)\\S+|(?<!\\w)[a-zA-Z0-9-]+[.,](?:com|net|org|vn|info|biz|io|xyz|me|tv|online|store|club|site|app|blog|dev|tech|cloud|game|shop|click|space|asia|fun|tokyo|website|link|co|gov|edu)(?:\\/\\S*)?(?!\\w)";
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
