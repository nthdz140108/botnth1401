import { CooldownLedger } from "../command-behavior-context.js";
import { CUSTOM_COMMAND_COUNTDOWN } from "./store.js";

const ledgers = new Map();

function ledgerFor(commandName) {
  const key = String(commandName ?? "");
  if (!ledgers.has(key)) {
    ledgers.set(key, new CooldownLedger());
  }
  return ledgers.get(key);
}

export function checkCustomCommandCooldown({ userId, threadId, commandName, now = Date.now() }) {
  const verdict = ledgerFor(commandName).consume({
    behavior: { operation: { cooldownMode: "perUserThread" } },
    fallbackCountdownSeconds: CUSTOM_COMMAND_COUNTDOWN,
    userId: String(userId ?? ""),
    threadId: String(threadId ?? ""),
    now,
  });
  return verdict;
}
