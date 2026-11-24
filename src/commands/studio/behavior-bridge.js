import { getPath } from "./config-resolver.js";

export function toBehaviorProfile(effective) {
  const behavior = {};
  const killSwitch = effective["operation.enabled"] === false;
  if (killSwitch) setPathValue(behavior, "operation.killSwitch", true);
  const cooldownMode = effective["operation.cooldownMode"];
  if (cooldownMode) setPathValue(behavior, "operation.cooldownMode", cooldownMode);
  const cooldownSeconds = effective["operation.cooldownSeconds"];
  if (cooldownSeconds !== undefined && cooldownSeconds !== null) {
    setPathValue(behavior, "operation.cooldownOverride", Number(cooldownSeconds));
  }
  const maxUses = effective["operation.maxUsesPerHour"];
  if (maxUses !== undefined && maxUses !== null) setPathValue(behavior, "operation.maxUsesPerHour", Number(maxUses));
  if (effective["responses.useCustomTemplates"]) {
    setPathValue(behavior, "responses.useCustomTemplates", true);
    for (const key of ["onSuccess", "onCooldown", "onPermissionDenied", "onScopeDenied", "onError", "onKillSwitch"]) {
      const template = effective[`responses.templates.${key}`];
      if (template) setPathValue(behavior, `responses.templates.${key}`, String(template));
    }
  }
  const mode = effective["restrictions.mode"];
  if (mode && mode !== "all") setPathValue(behavior, "restrictions.mode", mode);
  for (const [fieldKey, path] of [
    ["restrictions.allowedThreads", "restrictions.allowedThreads"],
    ["restrictions.blockedThreads", "restrictions.blockedThreads"],
    ["restrictions.allowedUsers", "restrictions.allowedUsers"],
  ]) {
    const rows = normalizeIdRows(effective[fieldKey]);
    if (rows.length > 0) setPathValue(behavior, path, rows);
  }
  return behavior;
}

export function fromBehaviorProfile(behavior) {
  const patch = {};
  if (!behavior || typeof behavior !== "object") return patch;
  const killSwitch = getPath(behavior, "operation.killSwitch");
  if (killSwitch === true) patch["operation.enabled"] = false;
  const mode = getPath(behavior, "operation.cooldownMode");
  if (mode) patch["operation.cooldownMode"] = mode;
  const override = getPath(behavior, "operation.cooldownOverride");
  if (override !== undefined && override !== null) patch["operation.cooldownSeconds"] = Number(override);
  const maxUses = getPath(behavior, "operation.maxUsesPerHour");
  if (maxUses !== undefined && maxUses !== null) patch["operation.maxUsesPerHour"] = Number(maxUses);
  const useCustom = getPath(behavior, "responses.useCustomTemplates");
  if (useCustom === true) patch["responses.useCustomTemplates"] = true;
  const templates = getPath(behavior, "responses.templates") || {};
  for (const [key, value] of Object.entries(templates)) {
    if (value) patch[`responses.templates.${key}`] = String(value);
  }
  const restrictionMode = getPath(behavior, "restrictions.mode");
  if (restrictionMode && restrictionMode !== "all") patch["restrictions.mode"] = restrictionMode;
  for (const key of ["allowedThreads", "blockedThreads", "allowedUsers"]) {
    const rows = getPath(behavior, `restrictions.${key}`);
    if (Array.isArray(rows) && rows.length > 0) patch[`restrictions.${key}`] = clone(rows);
  }
  return patch;
}

export function migrateBehaviorProfileToV2(commandName, behavior) {
  return {
    commandName,
    values: fromBehaviorProfile(behavior),
    migratedAt: new Date().toISOString(),
  };
}

export function applySecretsToEnv(effective, { env = process.env } = {}) {
  const applied = [];
  for (const [key, value] of Object.entries(effective || {})) {
    if (!key.startsWith("secrets.")) continue;
    if (typeof value === "string" && value.length > 0) {
      const envName = key.slice("secrets.".length);
      env[envName] = value;
      applied.push(envName);
    }
  }
  return applied;
}

export function overlayBehaviorWithStudio(policy, { studioGlobal, studioBot, studioGroup, contractFor }) {
  const merged = policy && typeof policy === "object" ? { ...policy } : {};
  const entries = new Map(Array.isArray(merged.commands) ? merged.commands.map((c) => [c.name, c]) : []);
  for (const layer of [studioGlobal, studioBot, studioGroup]) {
    const commands = layer?.commands || {};
    for (const [commandName, entry] of Object.entries(commands)) {
      const contract = contractFor(commandName);
      if (!contract) continue;
      const values = entry?.values || entry || {};
      const behaviorPatch = toBehaviorProfile(values);
      if (Object.keys(behaviorPatch).length === 0) continue;
      const existing = entries.get(commandName) || { name: commandName };
      existing.behavior = deepMergeBehavior(existing.behavior || {}, behaviorPatch);
      entries.set(commandName, existing);
    }
  }
  merged.commands = [...entries.values()];
  return merged;
}

function normalizeIdRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (typeof row === "string") return { threadId: row, userId: row };
      if (row && typeof row === "object") {
        const id = row.threadId || row.userId || row.id || "";
        return row.threadId ? { threadId: String(row.threadId) } : { userId: String(id) };
      }
      return null;
    })
    .filter(Boolean);
}

function deepMergeBehavior(base, patch) {
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMergeBehavior(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function setPathValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let cursor = target;
  while (parts.length > 1) {
    cursor = cursor[parts.shift()] ||= {};
  }
  cursor[parts[0]] = value;
  return target;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
