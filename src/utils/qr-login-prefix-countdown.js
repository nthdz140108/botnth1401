import {
  startInteractionCountdown,
  completeInteractionCountdown,
  cancelInteractionCountdown,
} from "./interaction-countdown.js";

export function buildPrefixTimeoutMessage(prefix) {
  return `✅ Hết thời gian đặt prefix. Bot sẽ dùng prefix hiện tại là: ${prefix}`;
}

export function buildPrefixCountdownReaction(remaining) {
  return "CLOCK";
}

export function startQrLoginPrefixCountdown({
  key,
  botUid,
  api,
  message,
  messageContext,
  seconds = 60,
  onTick,
  getCurrentPrefix,
  onExpired,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}) {
  const sessionKey = key || (botUid ? `qr_prefix_${botUid}` : null);

  // If api & message are provided, delegate to unified startInteractionCountdown
  if (api && message) {
    return startInteractionCountdown({
      key: sessionKey,
      api,
      message,
      messageContext,
      seconds,
      deleteOnExpire: true,
      onExpire: async () => {
        if (typeof onExpired === "function") {
          const currentPrefix = typeof getCurrentPrefix === "function" ? await getCurrentPrefix() : null;
          await onExpired(currentPrefix);
        }
      },
      schedule,
      cancelSchedule,
    });
  }

  // Fallback for direct unit tests with onTick
  let remaining = Number(seconds) || 60;
  let timerId;
  let stopped = false;

  const run = async () => {
    if (stopped) return;

    if (typeof onTick === "function") {
      await onTick(remaining);
    }
    if (stopped) return;

    if (remaining === 0) {
      if (typeof onExpired === "function") {
        const currentPrefix = typeof getCurrentPrefix === "function" ? await getCurrentPrefix() : null;
        await onExpired(currentPrefix);
      }
      return;
    }

    remaining -= 1;
    timerId = schedule(run, 1000);
  };

  timerId = schedule(run, 0);

  return () => {
    stopped = true;
    if (timerId !== undefined && typeof cancelSchedule === "function") cancelSchedule(timerId);
    if (sessionKey) {
      completeInteractionCountdown(sessionKey);
    }
  };
}
