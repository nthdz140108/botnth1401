export const STUDIO_CONTRACT_VERSION = 2;

export const STUDIO_SCOPES = Object.freeze(["global", "bot", "group"]);
export const STUDIO_FIELD_TYPES = Object.freeze([
  "boolean", "number", "string", "text", "select", "template", "emoji", "table",
]);
export const STUDIO_APPLY_MODES = Object.freeze(["config", "scheduler", "restart"]);

export const COMMON_TAB_IDS = Object.freeze({
  overview: "Tổng quan",
  handler: "Handler & luồng",
  operation: "Vận hành",
  responses: "Phản hồi",
  permissions: "Quyền & giới hạn",
  secrets: "Secrets",
  history: "Lịch sử",
});

export function commonTab(id, extra = {}) {
  return { id, title: COMMON_TAB_IDS[id] || id, fields: [], ...extra };
}

function fail(errors, path, message) {
  errors.push({ path, message });
}

export function validateStudioContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return { ok: false, errors: [{ path: "", message: "Contract must be an object" }] };
  }
  if (contract.version !== STUDIO_CONTRACT_VERSION) {
    fail(errors, "version", `version must be ${STUDIO_CONTRACT_VERSION}`);
  }
  if (!contract.commandName || typeof contract.commandName !== "string") {
    fail(errors, "commandName", "commandName is required");
  }
  if (!Array.isArray(contract.aliases) || contract.aliases.some((a) => typeof a !== "string")) {
    fail(errors, "aliases", "aliases must be an array of strings");
  }
  if (typeof contract.permission !== "string" || !contract.permission) {
    fail(errors, "permission", "permission is required");
  }
  const handlerRef = contract.handlerRef;
  if (!handlerRef || typeof handlerRef !== "object") {
    fail(errors, "handlerRef", "handlerRef is required");
  } else {
    if (typeof handlerRef.module !== "string" || !handlerRef.module) fail(errors, "handlerRef.module", "module is required");
    if (!("export" in handlerRef)) fail(errors, "handlerRef.export", "export is required (string or null)");
    if (!Array.isArray(handlerRef.dependencies)) fail(errors, "handlerRef.dependencies", "dependencies must be an array");
    if (!Array.isArray(handlerRef.providers)) fail(errors, "handlerRef.providers", "providers must be an array");
    if (typeof handlerRef.flow !== "string") fail(errors, "handlerRef.flow", "flow description required");
  }
  if (!Array.isArray(contract.tabs) || contract.tabs.length === 0) {
    fail(errors, "tabs", "at least one tab is required");
  } else {
    const seenTabs = new Set();
    for (const tab of contract.tabs) {
      if (!tab || typeof tab.id !== "string" || !tab.id) {
        fail(errors, "tabs", "each tab needs a non-empty id");
        continue;
      }
      if (seenTabs.has(tab.id)) fail(errors, `tabs.${tab.id}`, "duplicate tab id");
      seenTabs.add(tab.id);
      if (!Array.isArray(tab.fields)) {
        fail(errors, `tabs.${tab.id}.fields`, "fields must be an array");
        continue;
      }
      const seenFields = new Set();
      for (const field of tab.fields) {
        if (!field || typeof field.key !== "string" || !field.key) {
          fail(errors, `tabs.${tab.id}.fields`, "each field needs a non-empty key");
          continue;
        }
        if (seenFields.has(field.key)) fail(errors, field.key, "duplicate field key");
        seenFields.add(field.key);
        if (!STUDIO_FIELD_TYPES.includes(field.type)) fail(errors, field.key, `unsupported type ${field.type}`);
        if (!Array.isArray(field.allowedScopes) || field.allowedScopes.length === 0
          || field.allowedScopes.some((s) => !STUDIO_SCOPES.includes(s))) {
          fail(errors, field.key, "allowedScopes must be a non-empty subset of global/bot/group");
        }
        if ("default" in field && typeof field.default === "undefined") {
          fail(errors, field.key, "default must not be undefined");
        }
        if (field.sensitive && !field.allowedScopes.includes("global")) {
          fail(errors, field.key, "sensitive fields must not be overridable below global scope");
        }
        if (!["config", "scheduler", "restart"].includes(field.apply || "config")) {
          fail(errors, field.key, "apply must be config|scheduler|restart");
        }
      }
    }
  }
  if (typeof contract.adapter !== "string" || !contract.adapter) {
    fail(errors, "adapter", "adapter id is required");
  }
  return { ok: errors.length === 0, errors };
}

export function contractFieldIndex(contract) {
  const index = new Map();
  for (const tab of contract?.tabs || []) {
    for (const field of tab.fields || []) {
      index.set(field.key, { ...field, tabId: tab.id });
    }
  }
  return index;
}

export function defaultValuesFor(contract) {
  const values = {};
  for (const [, field] of contractFieldIndex(contract)) {
    values[field.key] = field.default !== undefined ? JSON.parse(JSON.stringify(field.default)) : defaultValueForType(field);
  }
  return values;
}

function defaultValueForType(field) {
  switch (field.type) {
    case "boolean": return false;
    case "number": return field.nullable ? null : 0;
    case "table": return [];
    default: return field.nullable ? null : "";
  }
}
