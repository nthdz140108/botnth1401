import fs from "node:fs";
import path from "node:path";
import { resolveCommandPolicy } from "./command-policy.js";
import { readJsonCached, globalStudioPath, botStudioPath, groupOverridePath } from "./studio/sparse-store.js";
import { mergeCommandLayers } from "./studio/config-resolver.js";
import { toBehaviorProfile } from "./studio/behavior-bridge.js";
import { getCommandStudioContract } from "./studio/contracts.js";
import { withReleaseCommandDefaults } from "../utils/release-command-catalog.js";

export const ADMIN_ONLY_MASS_COMMANDS = new Set(["spamjoin", "spamgroup", "addfriendall", "sendresourcesfile", "sendsrc", "sendresourcesvideo", "sendresourcesimage", "sendresourcesaudio", "autojoin", "sendtask", "todo", "sendp", "tagall", "kickall", "blockall", "kickallmember", "blockallmember", "leaveallbox", "leavelock", "dispersegroup", "kickimg", "blockimg", "key", "target", "setcmd", "locmem"]);

function normalizeSafeBotId(botId) {
  const raw = String(botId || "admin").trim() || "admin";
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) {
    return { raw, slug: raw, hasTraversal: false, isStrict: true };
  }
  const hasTraversal = raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0");
  const slug = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return {
    raw,
    slug: slug && /^[a-zA-Z0-9_-]+$/.test(slug) ? slug : "admin",
    hasTraversal,
    isStrict: false,
  };
}

function resolveContainedFile(baseDir, fileName) {
  const resolvedBase = path.resolve(baseDir);
  const candidate = path.resolve(resolvedBase, fileName);
  if (!candidate.startsWith(resolvedBase + path.sep)) return null;
  return candidate;
}

export function loadRuntimeCommandPolicy({ root = process.env.PROJECT_ROOT || process.cwd(), botId = "admin" } = {}) {
  const resolvedRoot = path.resolve(root);
  const { raw, slug, hasTraversal, isStrict } = normalizeSafeBotId(botId);
  const overridesDir = path.resolve(resolvedRoot, "mybot", "command-overrides");

  let overrides = {};
  if (!hasTraversal) {
    const rawOverrideFile = resolveContainedFile(overridesDir, `${raw}.json`);
    if (rawOverrideFile && fs.existsSync(rawOverrideFile)) {
      overrides = readJson(rawOverrideFile) || {};
    } else {
      const slugOverrideFile = resolveContainedFile(overridesDir, `${slug}.json`);
      if (slugOverrideFile) {
        overrides = readJson(slugOverrideFile) || {};
      }
    }
  }

  let studioBot = null;
  if (!hasTraversal) {
    const instancesDir = path.resolve(resolvedRoot, "mybot", "instances");
    if (isStrict) {
      try {
        const studioFile = botStudioPath(resolvedRoot, raw);
        if (path.resolve(studioFile).startsWith(instancesDir + path.sep)) {
          studioBot = readStudioLayer(studioFile);
        }
      } catch {
        studioBot = null;
      }
    } else {
      const rawInstanceStudio = path.resolve(instancesDir, raw, "data", "command-studio.json");
      if (rawInstanceStudio.startsWith(instancesDir + path.sep) && fs.existsSync(rawInstanceStudio)) {
        studioBot = readStudioLayer(rawInstanceStudio);
      } else {
        try {
          const slugStudioFile = botStudioPath(resolvedRoot, slug);
          if (path.resolve(slugStudioFile).startsWith(instancesDir + path.sep)) {
            studioBot = readStudioLayer(slugStudioFile);
          }
        } catch {
          studioBot = null;
        }
      }
    }
  }

  return {
    commands: withReleaseCommandDefaults(readJson(path.join(resolvedRoot, "assets", "json-data", "command.json")) || {}).commands || [],
    overrides,
    studioGlobal: readStudioLayer(globalStudioPath(resolvedRoot)),
    studioBot,
  };
}

function readStudioLayer(file) {
  const doc = readJsonCached(file);
  if (!doc || typeof doc !== "object") return null;
  return { commands: doc.commands && typeof doc.commands === "object" ? doc.commands : {} };
}

export function resolveRuntimeCommandPolicy(command, policy = {}) {
  const globalCommand = findCommand(policy.commands, command);
  const configuredCommand = globalCommand?.scope === undefined
    ? command
    : { ...command, scope: globalCommand.scope };
  const overrideEntry = findOverride(policy.overrides, globalCommand?.name || command?.name, command);
  const resolved = resolveCommandPolicy({ command: configuredCommand, override: overrideEntry });
  const behavior = mergeBehaviorProfiles(globalCommand?.behavior ?? null, overrideEntry?.behavior ?? null);
  const key = normalizeKey(globalCommand?.name || command?.name);
  const boosted = ADMIN_ONLY_MASS_COMMANDS.has(key) ? { ...resolved, permission: "adminLevelHigh", risk: resolved.risk || "critical" } : resolved;
  return { ...boosted, behavior };
}

export function getCommandBehavior(policy, commandName) {
  const globalCommand = findCommand(policy?.commands, { name: commandName });
  const overrideEntry = findOverride(policy?.overrides, globalCommand?.name || commandName, { name: commandName });
  return mergeBehaviorProfiles(globalCommand?.behavior ?? null, overrideEntry?.behavior ?? null);
}

export function isAdminOnlyMassCommand(command) {
  return ADMIN_ONLY_MASS_COMMANDS.has(normalizeKey(command?.name || command));
}

export function resolveStudioBehaviorOverlay(policy, commandName, { botId, threadId, root = process.env.PROJECT_ROOT || process.cwd() } = {}) {
  const contract = getCommandStudioContract(commandName);
  if (!contract) return null;
  const layers = buildLayerDocs({ policy, root, botId, threadId });
  const resolved = mergeCommandLayers({ contract, commandName: contract.commandName, layers });
  return toBehaviorProfile(resolved.effective);
}

export function resolveCommandConfigForContext({ policy, root = process.env.PROJECT_ROOT || process.cwd(), commandName, botId, threadId }) {
  try {
    const contract = getCommandStudioContract(commandName);
    if (!contract) return null;
    return mergeCommandLayers({
      contract,
      commandName: contract.commandName,
      layers: buildLayerDocs({ policy, root, botId, threadId }),
    });
  } catch {
    return null;
  }
}

function buildLayerDocs({ policy, root, botId, threadId }) {
  const layers = { global: policy?.studioGlobal || null, bot: policy?.studioBot || null, group: null };
  if (botId && threadId && /^[a-zA-Z0-9_-]+$/.test(String(threadId))) {
    try {
      const resolvedRoot = path.resolve(root);
      const instancesDir = path.resolve(resolvedRoot, "mybot", "instances");
      const { raw, slug, hasTraversal, isStrict } = normalizeSafeBotId(botId);
      if (!hasTraversal) {
        let doc;
        if (isStrict) {
          doc = readJsonCached(groupOverridePath(resolvedRoot, raw, threadId));
        } else {
          const rawGroupFile = path.resolve(instancesDir, raw, "data", "command-group-overrides", `${threadId}.json`);
          if (rawGroupFile.startsWith(instancesDir + path.sep) && fs.existsSync(rawGroupFile)) {
            doc = readJsonCached(rawGroupFile);
          } else {
            doc = readJsonCached(groupOverridePath(resolvedRoot, slug, threadId));
          }
        }
        if (doc) layers.group = { commands: doc.commands && typeof doc.commands === "object" ? doc.commands : {} };
      }
    } catch {}
  }
  return layers;
}

function findCommand(commands, command) {
  const candidates = [command?.name, ...(Array.isArray(command?.aliases) ? command.aliases : []), ...(Array.isArray(command?.alias) ? command.alias : [])]
    .map(normalizeKey)
    .filter(Boolean);
  return (Array.isArray(commands) ? commands : []).find((entry) => [entry?.name, ...(Array.isArray(entry?.alias) ? entry.alias : [])]
    .map(normalizeKey)
    .some((key) => candidates.includes(key))) || null;
}

function findOverride(overrides, canonicalName, command) {
  const targetKeys = [canonicalName, command?.name, ...(Array.isArray(command?.aliases) ? command.aliases : []), ...(Array.isArray(command?.alias) ? command.alias : [])]
    .map(normalizeKey)
    .filter(Boolean);
  const entry = Object.entries(overrides || {}).find(([key]) => targetKeys.includes(normalizeKey(key)));
  return entry?.[1] && typeof entry[1] === "object" ? entry[1] : null;
}

function isProfileObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeBehaviorProfiles(globalBehavior, overrideBehavior) {
  if (!isProfileObject(globalBehavior)) {
    return overrideBehavior === undefined ? null : structuredCloneSafe(overrideBehavior);
  }
  if (!isProfileObject(overrideBehavior)) return structuredCloneSafe(globalBehavior);
  const merged = {};
  for (const key of new Set([...Object.keys(globalBehavior), ...Object.keys(overrideBehavior)])) {
    merged[key] = key in overrideBehavior
      ? mergeBehaviorProfiles(globalBehavior[key] ?? null, overrideBehavior[key])
      : structuredCloneSafe(globalBehavior[key]);
  }
  return merged;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    return {};
  }
}
