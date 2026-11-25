import { tenantPermissionVerdict } from "../dashboard/portal-command-permissions.js";
import { assertPortalRuntimeAllowed } from "../dashboard/portal-policy.js";
import { LRUCache } from "lru-cache";
import { executeCommand, resolveCommand } from "./command-router.js";
import { commandRegistry, phase1Registry } from "./command-registry.js";
import { CooldownLedger } from "./command-behavior-context.js";

export function normalizeDispatchParts(commandParts, prefix = "") {
  if (!Array.isArray(commandParts) || commandParts.length === 0) return [];
  const first = String(commandParts[0] ?? "").trim();
  if (!first) return commandParts.slice(1);
  if (prefix && first.toLowerCase().startsWith(prefix.toLowerCase()) && first.length > prefix.length) {
    return [first.slice(prefix.length).trim(), ...commandParts.slice(1)];
  }
  if (/^[!./#$%^&*~`?-]+[a-z0-9]/i.test(first)) {
    const stripped = first.replace(/^[!./#$%^&*~`?-]+/, "").trim();
    if (stripped) return [stripped, ...commandParts.slice(1)];
  }
  return commandParts;
}

export function isMyBotAdminCooldownBypass({ command, isAdminLevelHighest = false, isMainBotAdmin = false }) {
  return command === "mybot" && Boolean(isAdminLevelHighest || isMainBotAdmin);
}

const dispatcherCooldownLedgers = new LRUCache({ max: 500 });

export function getDispatcherCooldownLedger(commandName) {
  let ledger = dispatcherCooldownLedgers.get(commandName);
  if (!ledger) {
    ledger = new CooldownLedger();
    dispatcherCooldownLedgers.set(commandName, ledger);
  }
  return ledger;
}

export function checkDispatcherCooldown({
  commandParts,
  prefix = "",
  userId,
  threadId = "",
  isAdminLevelHighest = false,
  isMainBotAdmin = false,
  registry = commandRegistry,
  ledger = null,
  now = Date.now(),
}) {
  const normalizedParts = normalizeDispatchParts(commandParts, prefix);
  const resolved = resolveCommand(normalizedParts, registry);
  if (resolved.code !== "RESOLVED") {
    return { allowed: true, resolved, bypassed: false };
  }
  const command = resolved.definition.name;
  if (isMyBotAdminCooldownBypass({ command, isAdminLevelHighest, isMainBotAdmin })) {
    return { allowed: true, bypassed: true, command, definition: resolved.definition, resolved };
  }

  const activeLedger = ledger || getDispatcherCooldownLedger(command);
  const fallbackCountdownSeconds = Number(resolved.definition.countdown) || 0;
  const verdict = activeLedger.consume({
    fallbackCountdownSeconds,
    userId,
    threadId,
    now,
  });

  return {
    allowed: verdict.allowed,
    remainingSeconds: verdict.remainingSeconds || 0,
    command,
    bypassed: false,
    definition: resolved.definition,
    resolved,
  };
}

export async function dispatchCommand(context = {}, registry = commandRegistry) {
  const portalKey = process.env.BOT_KEY || process.env.BOT_NAME || "";
  if (portalKey.startsWith("portal_")) assertPortalRuntimeAllowed(process.env.PROJECT_ROOT || process.cwd(), portalKey, { uid: context.api?.getOwnId?.() });
  const normalizedParts = normalizeDispatchParts(context.commandParts, context.prefix || "");
  const resolved = resolveCommand(normalizedParts, registry);
  if (resolved.code === "UNKNOWN_COMMAND") return null;
  if (resolved.code !== "RESOLVED") return { ...resolved, definition: null };

  if (portalKey.startsWith("portal_")) {
    const verdict = tenantPermissionVerdict(process.env.PROJECT_ROOT || process.cwd(), portalKey, resolved.definition.name, context.permissionLevel, resolved.definition);
    if (!verdict.allowed) return {code:"PERMISSION_DENIED",command:resolved.definition.name,requiredRole:verdict.requiredRole,definition:resolved.definition,resolved};
  }
  const result = await executeCommand({
    ...context,
    commandParts: normalizedParts,
    args: resolved.args,
    aliasCommand: resolved.matchedParts.join(" "),
  }, resolved.definition);

  return { ...result, definition: resolved.definition, resolved };
}

export async function dispatchPhase1Command(context = {}, registry = phase1Registry) {
  return dispatchCommand(context, registry);
}
