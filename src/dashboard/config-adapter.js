const BOOLEAN_FEATURES = new Set(["privateMode", "antiLink", "antiSpam", "antiFile", "antiPhoto", "antiVoice", "autoApprove", "autoReply", "learning", "scheduler", "game", "database"]);

export function diffConfig(before, after) {
  const result = { added: [], removed: [], changed: [] };
  compare(before || {}, after || {}, "", result);
  return result;
}

export function validateConfig(config) {
  const warnings = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["Config must be an object"];
  if ("prefix" in config && (typeof config.prefix !== "string" || !config.prefix.trim())) warnings.push("prefix must be a non-empty string");
  if ("alias" in config && (!Array.isArray(config.alias) || config.alias.some((item) => typeof item !== "string" || !item.trim()))) warnings.push("alias must be a string array");
  if (config.features && typeof config.features === "object") for (const key of BOOLEAN_FEATURES) if (key in config.features && typeof config.features[key] !== "boolean") warnings.push(`${key} must be boolean`);
  return warnings;
}

function compare(before, after, prefix, result) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in before)) result.added.push(path);
    else if (!(key in after)) result.removed.push(path);
    else if (isObject(before[key]) && isObject(after[key])) compare(before[key], after[key], path, result);
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) result.changed.push(path);
  }
}
function isObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
