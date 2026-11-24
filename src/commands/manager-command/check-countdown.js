import { showCooldownClock } from "../../utils/interaction-countdown.js";

export { showCooldownClock };

export async function sendReactionWaitingCountdown(api, message, count, commandName) {
  const seconds = Number(count) || 1;
  return showCooldownClock({
    api,
    message,
    remainingMs: seconds * 1000,
  });
}