import { LRUCache } from "lru-cache";
import { executeCommand, resolveCommand } from "./command-router.js";
import { commandRegistry, phase1Registry } from "./command-registry.js";
import { CooldownLedger } from "./command-behavior-context.js";

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
  userId,
  threadId = "",
  isAdminLevelHighest = false,
  isMainBotAdmin = false,
  registry = commandRegistry,
  ledger = null,
  now = Date.now(),
}) {
  const resolved = resolveCommand(commandParts, registry);
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
  const resolved = resolveCommand(context.commandParts, registry);
  if (resolved.code === "UNKNOWN_COMMAND") return null;
  if (resolved.code !== "RESOLVED") return { ...resolved, definition: null };

  const result = await executeCommand({
    ...context,
    args: resolved.args,
    aliasCommand: resolved.matchedParts.join(" "),
  }, resolved.definition);

  return { ...result, definition: resolved.definition, resolved };
}

export async function dispatchPhase1Command(context = {}, registry = phase1Registry) {
  return dispatchCommand(context, registry);
}
