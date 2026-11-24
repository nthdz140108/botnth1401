export const DEFAULT_SCOPE = "both";
export const VALID_SCOPES = Object.freeze(["group", "private", "both"]);

const scopeSet = new Set(VALID_SCOPES);

export function isValidScope(value) {
  return typeof value === "string" && scopeSet.has(value);
}

export function normalizeScope(value) {
  return isValidScope(value) ? value : DEFAULT_SCOPE;
}

export function resolveCommandPolicy({ command = {}, override = null } = {}) {
  const globalScope = normalizeScope(command.scope);
  const overrideScope = isValidScope(override?.scope) ? override.scope : null;

  return {
    ...command,
    scope: globalScope,
    effectiveScope: overrideScope || globalScope,
    override: override && typeof override === "object" ? { ...override } : null,
  };
}

export function scopeAllows(scope, chatScope) {
  const effectiveScope = normalizeScope(scope);
  return effectiveScope === "both" || effectiveScope === chatScope;
}
