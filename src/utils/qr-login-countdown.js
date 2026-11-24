import { QR_LOGIN_TIMEOUT_MS, QR_LOGIN_EXPIRY_REASON } from "./qr-login-expiry.js";
import {
  normalizeMessageReference,
  isValidReactionTarget,
  recallBotMessage,
  replaceCountdownReactionFrame,
  MAX_REACTION_BATCH_SIZE,
} from "./interaction-countdown.js";

/**
 * Builds countdown reaction representation for a remaining seconds value.
 *
 * @param {number} remaining
 * @returns {{ icon: string, rType: number }}
 */
export function buildQrCountdownReaction(remaining) {
  return "CLOCK";
}

/**
 * Starts a testable QR login countdown and message recall lifecycle.
 *
 * @param {Object} options
 * @param {Object} [options.api] Zalo API instance with addReaction / undoMessage
 * @param {Object} [options.message] The sent QR message object / response
 * @param {Object} [options.messageContext] Optional message context containing threadId, type, uidFrom
 * @param {number} [options.seconds=90] Total countdown duration in seconds
 * @param {number} [options.timeoutMs] Duration in ms (defaults to seconds * 1000 or QR_LOGIN_TIMEOUT_MS)
 * @param {Function} [options.onTick] Callback on each second tick (receives remaining)
 * @param {Function} [options.onExpire] Callback when countdown hits 0 / deadline
 * @param {Function} [options.onSuccess] Callback when completed successfully before deadline
 * @param {Function} [options.onCleanup] Callback on termination
 * @param {Function} [options.schedule] Custom timer scheduler (defaults to setTimeout)
 * @param {Function} [options.cancelSchedule] Custom timer canceller (defaults to clearTimeout)
 * @param {Function} [options.now] Clock function (defaults to Date.now)
 * @param {number} [options.maxBatchSize=50] Max reaction batch size
 * @returns {Object} Lifecycle control interface
 */
export function startQrLoginCountdown(options = {}) {
  const {
    api = null,
    message = options.initialMessage || null,
    messageContext = options.quoteMessage || (options.threadId ? { threadId: options.threadId, type: options.type } : null),
    seconds = options.totalSeconds || 90,
    timeoutMs = (options.totalSeconds ? options.totalSeconds * 1000 : ((options.seconds || 90) * 1000)),
    onTick = null,
    onExpire = options.onExpired || null,
    onSuccess = null,
    onCleanup = null,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
    now,
    maxBatchSize = MAX_REACTION_BATCH_SIZE,
  } = options;
  const targetMessage = message || options.initialMessage || null;
  const sessionNow = now || (typeof schedule?.now === "function" ? schedule.now : () => Date.now());
  const durationMs = Number(timeoutMs) || Number(seconds) * 1000 || QR_LOGIN_TIMEOUT_MS;
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const startTime = sessionNow();
  const expiresAt = startTime + durationMs;
  const messageRef = targetMessage ? normalizeMessageReference(targetMessage, messageContext) : null;
  const abortController = new AbortController();

  let remaining = totalSeconds;
  let timerId = null;
  let renderPromise = null;
  let isStopped = false;
  let isExpired = false;
  let isSucceeded = false;
  let isCancelled = false;
  let renderedCount = 0;
  let isQrRecalled = false;

  const recallQrMessage = async () => {
    if (isQrRecalled || !api || !messageRef) return;
    isQrRecalled = true;
    console.log(
      `[QR Countdown] Attempting QR message recall: threadId="${messageRef.threadId}", type=${messageRef.type}, ` +
      `msgId="${messageRef.data?.msgId || ""}", cliMsgId="${messageRef.data?.cliMsgId || ""}"`
    );
    try {
      const recalled = await recallBotMessage({ api, message: messageRef });
      if (recalled) {
        console.log("[QR Countdown] Recalled QR message successfully");
      } else {
        console.warn("[QR Countdown] recallBotMessage returned false — QR message may not have been recalled");
      }
    } catch (error) {
      console.error(`[QR Countdown] Failed to recall QR message: ${error?.message || error}`);
    }
  };

  const stopReaction = async () => {
    if (renderPromise) {
      try {
        await renderPromise;
      } catch {}
      renderPromise = null;
    }
    if (renderedCount > 0 && api && messageRef) {
      const toUndo = renderedCount;
      renderedCount = 0;
      await replaceCountdownReactionFrame({
        api,
        messageRef,
        renderedCount: toUndo,
        nextCount: 0,
        maxBatchSize,
      });
    }
  };

  const stopTimer = () => {
    isStopped = true;
    if (timerId !== null && timerId !== undefined) {
      if (typeof cancelSchedule === "function") {
        cancelSchedule(timerId);
      }
      timerId = null;
    }
  };

  const handleExpire = async () => {
    if (isExpired || isSucceeded || isCancelled) return;
    isExpired = true;
    stopTimer();

    if (!abortController.signal.aborted) {
      abortController.abort(QR_LOGIN_EXPIRY_REASON);
    }

    await stopReaction();
    await recallQrMessage();

    if (typeof onExpire === "function") {
      try {
        await onExpire();
      } catch (error) {
        console.error(`[QR Countdown] onExpire handler error: ${error?.message || error}`);
      }
    }

    if (typeof onCleanup === "function") {
      try {
        await onCleanup();
      } catch (error) {
        console.error(`[QR Countdown] onCleanup handler error: ${error?.message || error}`);
      }
    }
  };

  const handleSuccess = async () => {
    if (isExpired || isSucceeded || isCancelled) return;
    isSucceeded = true;
    stopTimer();

    await stopReaction();
    await recallQrMessage();

    if (typeof onSuccess === "function") {
      try {
        await onSuccess();
      } catch (error) {
        console.error(`[QR Countdown] onSuccess handler error: ${error?.message || error}`);
      }
    }

    if (typeof onCleanup === "function") {
      try {
        await onCleanup();
      } catch (error) {
        console.error(`[QR Countdown] onCleanup handler error: ${error?.message || error}`);
      }
    }
  };

  const cancel = async (reason = "cancelled") => {
    if (isExpired || isSucceeded || isCancelled) return;
    isCancelled = true;
    stopTimer();

    if (!abortController.signal.aborted) {
      abortController.abort(reason);
    }

    await stopReaction();
    await recallQrMessage();

    if (typeof onCleanup === "function") {
      try {
        await onCleanup();
      } catch (error) {
        console.error(`[QR Countdown] onCleanup handler error: ${error?.message || error}`);
      }
    }
  };

  let isFirstTick = true;

  const tick = async () => {
    if (isStopped || isExpired || isSucceeded || isCancelled) return;

    if (renderPromise) {
      try {
        await renderPromise;
      } catch {}
      renderPromise = null;
    }

    if (isStopped || isExpired || isSucceeded || isCancelled) return;

    const nextCount = isFirstTick
      ? totalSeconds
      : Math.max(0, Math.ceil((expiresAt - sessionNow()) / 1000));
    isFirstTick = false;
    remaining = nextCount;

    if (typeof onTick === "function") {
      try {
        await onTick(remaining);
      } catch (error) {
        console.error(`[QR Countdown] onTick error: ${error?.message || error}`);
      }
    }

    if (isStopped || isExpired || isSucceeded || isCancelled) return;

    if (remaining <= 0 || sessionNow() >= expiresAt) {
      await handleExpire();
      return;
    }

    if (api && messageRef) {
      renderPromise = (async () => {
        renderedCount = await replaceCountdownReactionFrame({
          api,
          messageRef,
          renderedCount,
          nextCount,
          maxBatchSize,
        });
        return renderedCount;
      })();

      await renderPromise;
      renderPromise = null;
    }

    if (isStopped || isExpired || isSucceeded || isCancelled) {
      if (renderedCount > 0 && api && messageRef) {
        const toUndo = renderedCount;
        renderedCount = 0;
        await replaceCountdownReactionFrame({
          api,
          messageRef,
          renderedCount: toUndo,
          nextCount: 0,
          maxBatchSize,
        });
      }
      return;
    }

    timerId = schedule(tick, 1000);
  };

  timerId = schedule(tick, 0);

  return {
    expiresAt,
    signal: abortController.signal,
    getAbortSignal: () => abortController.signal,
    abortController,
    messageRef,
    get remaining() {
      return remaining;
    },
    get isExpired() {
      return isExpired;
    },
    get isSucceeded() {
      return isSucceeded;
    },
    get isCancelled() {
      return isCancelled;
    },
    get isStopped() {
      return isStopped;
    },
    stop: async () => {
      stopTimer();
      await stopReaction();
      await recallQrMessage();
    },
    cancel,
    expire: handleExpire,
    success: handleSuccess,
    recallQrMessage,
  };
}
