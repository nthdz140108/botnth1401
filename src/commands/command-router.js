import { isValidScope, normalizeScope, resolveCommandPolicy, scopeAllows } from "./command-policy.js";
import { isHighRiskCommand, resolveHighRiskPolicy } from "./high-risk-policy.js";
import { EFFECT_SCOPES, RISKS, resolveRequiredRole, roleSatisfies } from "./command-permission-policy.js";
const VALID_PERMISSIONS = new Set(["all", "member", "adminBox", "adminBot", "adminLevelHigh", "adminBotOrGroup"]);
const VALID_RISKS = new Set(RISKS);
const VALID_EFFECT_SCOPES = new Set(EFFECT_SCOPES);

export const COMMAND_RESULT_CODES = Object.freeze([
  "HANDLED",
  "ACCEPTED",
  "UNKNOWN_COMMAND",
  "AMBIGUOUS_COMMAND",
  "INSTANCE_DENIED",
  "SCOPE_DENIED",
  "PERMISSION_DENIED",
  "COMMAND_DISABLED",
  "DRY_RUN_REQUIRED",
  "KILL_SWITCH_ACTIVE",
  "MISSING_ARGUMENT",
  "MISSING_DEPENDENCY",
  "DB_BLOCKED",
  "TIMEOUT",
  "HANDLER_ERROR",
]);

const VALID_INSTANCE_SCOPES = new Set(["any", "main"]);

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeCommandName(value) {
  return normalizeToken(value).split(/\s+/).filter(Boolean).join(" ");
}

function isConfigRequirementSatisfied(config, requirement) {
  if (Array.isArray(requirement)) {
    return requirement.some((key) => hasConfigValue(config, key));
  }
  return hasConfigValue(config, requirement);
}

function formatRequirementName(requirement) {
  if (Array.isArray(requirement)) {
    return requirement.map((value) => String(value)).join(" or ");
  }
  return String(requirement);
}

function collectMissingRequirements(context = {}, definition = {}) {
  const missing = [];
  const missingDetails = [];
  const dbReady = context.dbReady ?? context.dependencies?.dbReady;
  if (definition.requiresDb && dbReady === false) {
    missing.push("database");
    missingDetails.push({ kind: "database", name: "database" });
  }

  const config = context.config;
  for (const requirement of definition.requiredConfig ?? []) {
    if (isConfigRequirementSatisfied(config, requirement)) continue;
    missing.push(requirement);
    missingDetails.push({
      kind: "config",
      name: formatRequirementName(requirement),
      requirements: Array.isArray(requirement) ? [...requirement] : [requirement],
    });
  }

  const runtimeDependencies = context.dependencies;
  for (const dependency of definition.requiredDependencies ?? []) {
    if (runtimeDependencies && runtimeDependencies[dependency] === true) continue;
    missing.push(dependency);
    missingDetails.push({ kind: "runtime", name: dependency });
  }

  return { missing, missingDetails };
}

function createRegistryError(code, key) {
  const error = new Error(`Command registry collision for ${key}`);
  error.code = code;
  error.key = key;
  return error;
}

export const VALID_EXECUTION_LANES = new Set(["fast", "control", "heavy", "broadcast"]);

export function createCommandDefinition(input = {}) {
  const name = normalizeCommandName(input.name);
  if (!name) throw new TypeError("Command definition name is required");
  if (typeof input.handler !== "function") {
    throw new TypeError(`Command handler is required for ${name}`);
  }

  const scope = normalizeScope(input.scope);
  if (input.scope !== undefined && !isValidScope(input.scope)) {
    throw new TypeError(`Invalid command scope for ${name}: ${scope}`);
  }
  const permission = input.permission ?? "all";
  if (!VALID_PERMISSIONS.has(permission)) {
    throw new TypeError(`Invalid command permission for ${name}: ${permission}`);
  }
  const risk = input.risk ?? "normal";
  if (!VALID_RISKS.has(risk)) {
    throw new TypeError(`Invalid command risk for ${name}: ${risk}`);
  }
  const instanceScope = input.instanceScope ?? "any";
  if (!VALID_INSTANCE_SCOPES.has(instanceScope)) {
    throw new TypeError(`Invalid command instanceScope for ${name}: ${instanceScope}`);
  }
  if (input.effectScope !== undefined && !VALID_EFFECT_SCOPES.has(input.effectScope)) {
    throw new TypeError(`Invalid command effectScope for ${name}: ${input.effectScope}`);
  }

  const executionLane = (input.executionLane && VALID_EXECUTION_LANES.has(input.executionLane))
    ? input.executionLane
    : "fast";

  const aliases = [...new Set((input.aliases ?? []).map(normalizeCommandName).filter(Boolean))];
  const definition = {
    name,
    aliases,
    handler: input.handler,
    permission,
    permissionExplicit: input.permission !== undefined,
    type: input.type ?? 1,
    active: input.active !== false,
    countdown: Number.isFinite(input.countdown) ? input.countdown : 0,
    description: input.description ?? "",
    scope,
    effectScope: input.effectScope ?? "user",
    requiresDb: input.requiresDb === true,
    requiredConfig: normalizeRequiredConfig(input.requiredConfig, name),
    requiredDependencies: normalizeRequiredDependencies(input.requiredDependencies, name),
    risk,
    instanceScope,
    executionLane,
    timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : 0,
    minArgs: Number.isInteger(input.minArgs) && input.minArgs > 0 ? input.minArgs : 0,
  };

  return Object.freeze({
    ...definition,
    aliases: Object.freeze(aliases),
    requiredConfig: Object.freeze(definition.requiredConfig),
    requiredDependencies: Object.freeze(definition.requiredDependencies),
  });
}

export function createCommandRegistry(definitions = []) {
  const normalizedDefinitions = definitions.map((definition) => createCommandDefinition({
    ...definition,
    requiredDependencies: [
      ...(definition?.requiredDependencies ?? []),
      "zaloSession",
    ],
  }));
  const lookup = new Map();

  for (const definition of normalizedDefinitions) {
    for (const key of [definition.name, ...definition.aliases]) {
      const entries = lookup.get(key) ?? [];
      entries.push(definition);
      lookup.set(key, entries);
    }
  }

  for (const [key, entries] of lookup) {
    if (entries.length > 1) throw createRegistryError("COMMAND_REGISTRY_COLLISION", key);
  }

  const keys = [...lookup.keys()].sort((left, right) => {
    const lengthDifference = right.split(" ").length - left.split(" ").length;
    return lengthDifference || right.length - left.length;
  });

  return Object.freeze({
    definitions: Object.freeze([...normalizedDefinitions]),
    canonicalNames: new Set(normalizedDefinitions.map(({ name }) => name)),
    lookup,
    keys: Object.freeze(keys),
  });
}

export function resolveCommand(commandParts, registry) {
  const normalizedParts = Array.isArray(commandParts)
    ? commandParts.map(normalizeToken).filter(Boolean)
    : [];
  if (!registry || normalizedParts.length === 0) {
    return { code: "UNKNOWN_COMMAND", commandParts: normalizedParts };
  }

  const keys = registry.keys ?? [...(registry.lookup?.keys?.() ?? [])];
  for (const key of keys) {
    const keyParts = key.split(" ");
    if (keyParts.length > normalizedParts.length) continue;
    const candidate = normalizedParts.slice(0, keyParts.length).join(" ");
    if (candidate !== key) continue;

    const entries = registry.lookup.get(key);
    if (Array.isArray(entries) && entries.length > 1) {
      return { code: "AMBIGUOUS_COMMAND", commandParts: normalizedParts, matchedParts: keyParts };
    }

    const definition = Array.isArray(entries) ? entries[0] : entries;
    if (!definition) continue;
    return {
      code: "RESOLVED",
      definition,
      args: normalizedParts.slice(keyParts.length),
      matchedParts: keyParts,
      commandParts: normalizedParts,
    };
  }

  return { code: "UNKNOWN_COMMAND", commandParts: normalizedParts };
}

function hasConfigValue(config, key) {
  if (!config || typeof config !== "object") return false;
  const value = config[key];
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeRequiredConfig(requirements, name) {
  if (requirements === undefined) return [];
  if (!Array.isArray(requirements)) {
    throw new TypeError(`Invalid command requiredConfig for ${name}`);
  }

  return requirements.map((requirement) => normalizeRequiredConfigRequirement(requirement, name));
}

function normalizeRequiredConfigRequirement(requirement, name) {
  if (Array.isArray(requirement)) {
    const normalized = [...new Set(requirement.map((value) => normalizeRequiredConfigKey(value, name)).filter(Boolean))];
    if (normalized.length === 0) {
      throw new TypeError(`Invalid command requiredConfig for ${name}`);
    }
    return normalized;
  }

  const normalized = normalizeRequiredConfigKey(requirement, name);
  if (!normalized) {
    throw new TypeError(`Invalid command requiredConfig for ${name}`);
  }
  return normalized;
}

function normalizeRequiredConfigKey(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`Invalid command requiredConfig for ${name}`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`Invalid command requiredConfig for ${name}`);
  }
  return normalized;
}

function normalizeRequiredDependencies(dependencies, name) {
  if (dependencies === undefined) return [];
  if (!Array.isArray(dependencies)) {
    throw new TypeError(`Invalid command dependency for ${name}`);
  }

  const normalized = [...new Set(dependencies.map((dependency) => {
    if (typeof dependency !== "string") {
      throw new TypeError(`Invalid command dependency for ${name}`);
    }
    const value = dependency.trim();
    if (!value) {
      throw new TypeError(`Invalid command dependency for ${name}`);
    }
    return value;
  }))];
  return normalized;
}

function getErrorResult(error) {
  // Expected control-lane timeouts are NOT genuine handler failures: they must
  // surface as a friendly TIMEOUT result (never a HANDLER_ERROR which would
  // generate a CMD-* reference sent to the user).
  if (error && (error.code === "CONTROL_TIMEOUT" || error?.name === "AbortError")) {
    return { code: "TIMEOUT", command: error?.command || "", error: undefined };
  }
  return { code: "HANDLER_ERROR", error: error instanceof Error ? error : new Error(String(error)) };
}

export async function executeCommand(context = {}, definition) {
  if (!definition) return { code: "UNKNOWN_COMMAND" };

  const scope = normalizeScope(context.scope);
  if (definition.instanceScope === "main" && context.instanceKind === "child") {
    return {
      code: "INSTANCE_DENIED",
      command: definition.name,
      instanceScope: definition.instanceScope,
      instanceKind: context.instanceKind,
    };
  }
  if (definition.active === false) {
    return { code: "COMMAND_DISABLED", command: definition.name };
  }

  const permissionPolicy = resolveRequiredRole({
    canonicalName: definition.name,
    alias: context.aliasCommand || definition.name,
    args: Array.isArray(context.args) ? context.args : [],
    scope,
    definition,
  });
  if (permissionPolicy.failClosed && !definition.permissionExplicit) {
    return {
      code: "PERMISSION_DENIED",
      command: definition.name,
      reason: "POLICY_MISSING",
      requiredRole: permissionPolicy.requiredRole,
    };
  }
  const definitionPermissionName = definition.permission === "adminBotOrGroup" ? "adminBox" : definition.permission;
  const requiredRole = roleSatisfies(permissionPolicy.requiredRole, definitionPermissionName)
    ? permissionPolicy.requiredRole
    : definitionPermissionName === "all" ? "member" : definitionPermissionName;

  const isHighRisk = isHighRiskCommand(definition)
    || definition.risk === "critical"
    || definition.risk === "high"
    || permissionPolicy.risk === "critical"
    || permissionPolicy.risk === "high";
  let effectivePermissionLevel = context.permissionLevel;
  if (isHighRisk && (context.isMainBotAdmin || context.isAdminLevelHighest)) {
    effectivePermissionLevel = "adminLevelHigh";
  }

  if (effectivePermissionLevel !== undefined) {
    if (!roleSatisfies(effectivePermissionLevel, requiredRole)) {
      return {
        code: "PERMISSION_DENIED",
        command: definition.name,
        requiredRole,
        effectScope: permissionPolicy.effectScope,
        risk: permissionPolicy.risk,
      };
    }
  }

  const policy = resolveCommandPolicy({
    command: definition,
    override: context.scopeOverride === undefined ? null : { scope: context.scopeOverride },
  });
  if (!scopeAllows(policy.effectiveScope, scope)) {
    return { code: "SCOPE_DENIED", scope, command: definition.name };
  }

  const args = Array.isArray(context.args) ? context.args : [];
  if (args.length < definition.minArgs) {
    return { code: "MISSING_ARGUMENT", command: definition.name, minArgs: definition.minArgs };
  }

  const missingRequirements = collectMissingRequirements(context, definition);
  if (missingRequirements.missing.length > 0) {
    return {
      code: "MISSING_DEPENDENCY",
      command: definition.name,
      missing: missingRequirements.missing,
      missingDetails: missingRequirements.missingDetails,
    };
  }

  const highRiskPolicy = resolveHighRiskPolicy(definition, context);
  if (!highRiskPolicy.allowed) {
    return { code: highRiskPolicy.code, command: definition.name, risk: highRiskPolicy.riskLevel };
  }

  const broker = context.workloadBroker;
  const lane = definition.executionLane || "fast";
  const runHandler = () => definition.handler({ ...context, args });

  if (broker && (lane === "heavy" || lane === "broadcast")) {
    let job;
    if (lane === "heavy" && typeof broker.submitHeavy === "function") {
      job = broker.submitHeavy(definition.name, { ...context, args }, runHandler);
    } else if (lane === "broadcast" && typeof broker.submitBroadcast === "function") {
      job = broker.submitBroadcast({ ...context, args }, runHandler,
        definition.timeoutMs > 0 ? { timeoutMs: definition.timeoutMs } : undefined);
    }

    if (job && job.jobId) {
      if (job.promise && typeof job.promise.catch === "function") {
        job.promise.catch((bgErr) => {
          console.error(`[WORKLOAD BROKER] Background error in lane '${lane}' for command '${definition.name}':`, bgErr);
          const targetThreadId = context.threadId || context.message?.threadId;
          const targetType = context.type ?? context.message?.type;
          if (context.api && typeof context.api.sendMessage === "function" && targetThreadId && targetType !== undefined) {
            Promise.resolve(
              context.api.sendMessage(
                { msg: `⚠️ Lỗi xử lý tác vụ (${definition.name}): ${bgErr?.message || "Đã xảy ra lỗi"}`, quote: context.message, ttl: 30000 },
                targetThreadId,
                targetType
              )
            ).catch((sendErr) => {
              console.error(`[WORKLOAD BROKER] Failed to send background error fallback (${definition.name}):`, sendErr);
            });
          }
        });
      }

      return {
        code: "ACCEPTED",
        command: definition.name,
        jobId: job.jobId,
        lane,
      };
    }
  }

  let invocation;
  if (broker && typeof broker.runFast === "function") {
    if (lane === "control" && typeof broker.runControl === "function") {
      invocation = broker.runControl(definition.name, runHandler);
    } else {
      invocation = broker.runFast(definition.name, runHandler);
    }
  } else {
    invocation = Promise.resolve().then(runHandler);
  }

  if (!(definition.timeoutMs > 0)) {
    try {
      return { code: "HANDLED", value: await invocation };
    } catch (error) {
      return getErrorResult(error);
    }
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ code: "TIMEOUT", command: definition.name }), definition.timeoutMs);
  });
  try {
    const value = await Promise.race([invocation, timeout]);
    return value?.code === "TIMEOUT" ? value : { code: "HANDLED", value };
  } catch (error) {
    return getErrorResult(error);
  } finally {
    clearTimeout(timer);
  }
}
