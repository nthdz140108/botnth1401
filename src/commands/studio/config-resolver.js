import path from "node:path";
import { contractFieldIndex } from "./contract-v2.js";
import {
  readJsonCached,
  globalStudioPath,
  botStudioPath,
  groupOverridePath,
  isValidBotId,
} from "./sparse-store.js";

export function mergeCommandLayers({ contract, layers }) {
  const fields = contractFieldIndex(contract);
  const effective = {};
  const provenance = {};
  for (const [, field] of fields) {
    const chain = ["default", "global", "bot", "group"];
    let resolved = field.default !== undefined ? clone(field.default) : undefined;
    let source = "default";
    for (const scope of chain.slice(1)) {
      if (scope === "bot" && !field.allowedScopes.includes("bot")) continue;
      if (scope === "group" && !field.allowedScopes.includes("group")) continue;
      const layer = layers?.[scope];
      const override = layer ? getOverrideValue(layer, contract.commandName, field.key) : undefined;
      if (override !== undefined) {
        resolved = clone(override);
        source = scope;
      }
    }
    effective[field.key] = resolved === undefined ? null : resolved;
    provenance[field.key] = {
      value: resolved === undefined ? null : resolved,
      source,
      overridden: source !== "default",
      allowedScopes: [...field.allowedScopes],
      sensitive: Boolean(field.sensitive),
    };
  }
  return { commandName: contract.commandName, effective, provenance };
}

function getOverrideValue(layer, commandName, fieldKey) {
  const entry = layer?.commands?.[commandName];
  if (!entry || typeof entry !== "object") return undefined;
  const values = entry.values && typeof entry.values === "object" ? entry.values : entry;
  if (Object.prototype.hasOwnProperty.call(values, fieldKey)) return values[fieldKey];
  return getPath(values, fieldKey);
}

export function getPath(source, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => (
    value && typeof value === "object" && !Array.isArray(value) ? value[part] : undefined
  ), source);
}

export function setPath(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let cursor = target;
  while (parts.length > 1) {
    cursor = cursor[parts.shift()] ||= {};
  }
  cursor[parts[0]] = value;
  return target;
}

export function removePath(target, dottedPath) {
  const parts = String(dottedPath).split(".");
  let cursor = target;
  while (parts.length > 1) {
    if (!cursor || typeof cursor !== "object") return target;
    cursor = cursor[parts.shift()];
  }
  if (cursor && typeof cursor === "object") delete cursor[parts[0]];
  return target;
}

export function sparseOverrideFromPatch(contract, patch = {}, { resetKeys = [] } = {}) {
  const fields = contractFieldIndex(contract);
  const values = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = fields.get(key);
    if (!field) throw resolverError(400, "UNKNOWN_FIELD", `Unknown studio field: ${key}`);
    values[key] = value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
  return { values, resetKeys: [...resetKeys] };
}

export function applySparseOverride(baseValues, sparse) {
  const output = clone(baseValues || {});
  for (const key of sparse.resetKeys || []) delete output[key];
  for (const [key, value] of Object.entries(sparse.values || {})) output[key] = clone(value);
  return output;
}

export function resolveLayerPaths({ root, botId, threadId }) {
  return {
    global: globalStudioPath(root),
    bot: botId && isValidBotId(botId) ? botStudioPath(root, botId) : null,
    group: botId && threadId ? groupOverridePath(root, botId, threadId) : null,
  };
}

export function resolveCommandConfigSync({ root, commandName, contract, botId, threadId }) {
  const paths = resolveLayerPaths({ root, botId, threadId });
  const layers = {};
  for (const scope of ["global", "bot", "group"]) {
    const file = paths[scope];
    if (!file) continue;
    const doc = readJsonCached(file);
    if (doc) layers[scope] = doc;
  }
  return mergeCommandLayers({ contract, commandName, layers });
}

export async function resolveCommandConfig(options) {
  return resolveCommandConfigSync(options);
}

function resolverError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
