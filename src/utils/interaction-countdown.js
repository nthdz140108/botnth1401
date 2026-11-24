let _defaultSendProcessingFn = null;
async function resolveSendProcessingFn(fn) {
  if (typeof fn === "function") return fn;
  if (!_defaultSendProcessingFn) {
    try {
      const mod = await import("../service-debug/chat-zalo/chat-style/chat-style.js");
      _defaultSendProcessingFn = mod.sendMessageProcessingRequest;
    } catch (e) {
      _defaultSendProcessingFn = null;
    }
  }
  return _defaultSendProcessingFn;
}

const activeCountdownSessions = new Map();

export function extractMessageId(responseOrMessage) {
  if (!responseOrMessage) return "";

  const innerMsg = Array.isArray(responseOrMessage?.message)
    ? responseOrMessage.message[0]
    : responseOrMessage?.message;

  const attachment0 = Array.isArray(responseOrMessage?.attachment)
    ? responseOrMessage.attachment[0]
    : responseOrMessage?.attachment;

  const linkMsg = responseOrMessage?.link;

  const candidates = [
    responseOrMessage?.data?.msgId,
    responseOrMessage?.data?.globalMsgId,
    responseOrMessage?.data?.msgIds?.[0],
    responseOrMessage?.msgId,
    responseOrMessage?.globalMsgId,
    responseOrMessage?.msgIds?.[0],
    responseOrMessage?.data?.cliMsgId,
    responseOrMessage?.cliMsgId,
    responseOrMessage?.data?.clientId,
    responseOrMessage?.clientId,
    innerMsg?.data?.msgId,
    innerMsg?.data?.globalMsgId,
    innerMsg?.data?.msgIds?.[0],
    innerMsg?.msgId,
    innerMsg?.globalMsgId,
    innerMsg?.data?.cliMsgId,
    innerMsg?.cliMsgId,
    innerMsg?.data?.clientId,
    innerMsg?.clientId,
    attachment0?.data?.msgId,
    attachment0?.data?.globalMsgId,
    attachment0?.data?.msgIds?.[0],
    attachment0?.msgId,
    attachment0?.globalMsgId,
    attachment0?.data?.cliMsgId,
    attachment0?.cliMsgId,
    attachment0?.data?.clientId,
    attachment0?.clientId,
    attachment0?.clientFileId,
    attachment0?.photoId,
    attachment0?.fileId,
    linkMsg?.data?.msgId,
    linkMsg?.data?.globalMsgId,
    linkMsg?.msgId,
    linkMsg?.globalMsgId,
    linkMsg?.data?.cliMsgId,
    linkMsg?.cliMsgId,
    responseOrMessage?.data?.quote?.globalMsgId,
    responseOrMessage?.data?.quote?.msgId,
    responseOrMessage?.data?.quote?.cliMsgId,
  ];

  const found = candidates.find(
    (cand) => cand !== undefined && cand !== null && String(cand).trim() !== ""
  );
  return found !== undefined ? String(found) : "";
}

export function normalizeMessageReference(
  messageOrResponse,
  fallbackContextOrThreadId = "",
  fallbackType = 0,
  fallbackUid = ""
) {
  let contextThreadId = "";
  let contextType = null;
  let contextUid = "";

  if (
    fallbackContextOrThreadId &&
    typeof fallbackContextOrThreadId === "object"
  ) {
    const ctx = fallbackContextOrThreadId;
    contextThreadId = String(
      ctx.threadId ??
        ctx.data?.threadId ??
        ctx.data?.idTo ??
        ctx.grid ??
        ctx.toid ??
        ""
    );
    if (ctx.type !== undefined && ctx.type !== null) {
      contextType = Number(ctx.type);
    } else if (ctx.messageType !== undefined && ctx.messageType !== null) {
      contextType = Number(ctx.messageType);
    } else if (ctx.data?.type !== undefined && ctx.data?.type !== null) {
      contextType = Number(ctx.data.type);
    } else if (ctx.isGroup !== undefined && ctx.isGroup !== null) {
      contextType = ctx.isGroup ? 1 : 0;
    }
    contextUid = String(
      ctx.data?.uidFrom ??
        ctx.uidFrom ??
        ctx.senderId ??
        ctx.data?.senderId ??
        ""
    );
  } else if (
    fallbackContextOrThreadId !== undefined &&
    fallbackContextOrThreadId !== null &&
    fallbackContextOrThreadId !== ""
  ) {
    contextThreadId = String(fallbackContextOrThreadId);
    if (fallbackType !== undefined && fallbackType !== null) {
      contextType = Number(fallbackType);
    }
    if (fallbackUid !== undefined && fallbackUid !== null) {
      contextUid = String(fallbackUid);
    }
  }

  if (!messageOrResponse) {
    return {
      type: contextType !== null ? Number(contextType) : Number(fallbackType || 0),
      threadId: String(contextThreadId || ""),
      data: {
        msgId: "",
        cliMsgId: "",
        globalMsgId: "",
        uidFrom: String(contextUid || fallbackUid || ""),
      },
    };
  }

  const innerMsg = Array.isArray(messageOrResponse?.message)
    ? messageOrResponse.message[0]
    : messageOrResponse?.message;

  const attachment0 = Array.isArray(messageOrResponse?.attachment)
    ? responseOrAttachment(messageOrResponse?.attachment)
    : messageOrResponse?.attachment;

  const linkMsg = messageOrResponse?.link;

  const threadCandidates = [
    messageOrResponse?.threadId,
    messageOrResponse?.data?.threadId,
    messageOrResponse?.grid,
    messageOrResponse?.toid,
    innerMsg?.threadId,
    innerMsg?.data?.threadId,
    attachment0?.threadId,
    attachment0?.data?.threadId,
    linkMsg?.threadId,
    linkMsg?.data?.threadId,
    contextThreadId,
  ];

  const resolvedThread = threadCandidates.find(
    (t) => t !== undefined && t !== null && String(t).trim() !== ""
  );
  const threadId = resolvedThread !== undefined ? String(resolvedThread) : "";

  const typeCandidates = [
    messageOrResponse?.type,
    messageOrResponse?.data?.type,
    innerMsg?.type,
    innerMsg?.data?.type,
    attachment0?.type,
    attachment0?.data?.type,
    linkMsg?.type,
    linkMsg?.data?.type,
    contextType,
    fallbackType,
  ];

  const resolvedType = typeCandidates.find(
    (t) => t !== undefined && t !== null && !isNaN(Number(t))
  );
  const type = resolvedType !== undefined ? (Number(resolvedType) === 1 ? 1 : 0) : 0;

  const msgIdCandidates = [
    messageOrResponse?.data?.msgId,
    messageOrResponse?.data?.globalMsgId,
    messageOrResponse?.data?.msgIds?.[0],
    messageOrResponse?.msgId,
    messageOrResponse?.globalMsgId,
    messageOrResponse?.msgIds?.[0],
    innerMsg?.data?.msgId,
    innerMsg?.data?.globalMsgId,
    innerMsg?.data?.msgIds?.[0],
    innerMsg?.msgId,
    innerMsg?.globalMsgId,
    attachment0?.data?.msgId,
    attachment0?.data?.globalMsgId,
    attachment0?.data?.msgIds?.[0],
    attachment0?.msgId,
    attachment0?.globalMsgId,
    attachment0?.photoId,
    attachment0?.fileId,
    linkMsg?.data?.msgId,
    linkMsg?.data?.globalMsgId,
    linkMsg?.msgId,
    linkMsg?.globalMsgId,
    messageOrResponse?.data?.quote?.globalMsgId,
    messageOrResponse?.data?.quote?.msgId,
  ];

  const resolvedMsgId = msgIdCandidates.find(
    (id) => id !== undefined && id !== null && String(id).trim() !== ""
  );
  const msgId = resolvedMsgId !== undefined ? String(resolvedMsgId) : "";

  const cliMsgIdCandidates = [
    messageOrResponse?.data?.cliMsgId,
    messageOrResponse?.cliMsgId,
    messageOrResponse?.data?.clientId,
    messageOrResponse?.clientId,
    innerMsg?.data?.cliMsgId,
    innerMsg?.cliMsgId,
    innerMsg?.data?.clientId,
    innerMsg?.clientId,
    attachment0?.data?.cliMsgId,
    attachment0?.cliMsgId,
    attachment0?.data?.clientId,
    attachment0?.clientId,
    attachment0?.clientFileId,
    linkMsg?.data?.cliMsgId,
    linkMsg?.cliMsgId,
    linkMsg?.data?.clientId,
    linkMsg?.clientId,
    messageOrResponse?.data?.quote?.cliMsgId,
  ];

  const resolvedCliMsgId = cliMsgIdCandidates.find(
    (id) => id !== undefined && id !== null && String(id).trim() !== ""
  );
  const cliMsgId = resolvedCliMsgId !== undefined ? String(resolvedCliMsgId) : "";

  const globalMsgIdCandidates = [
    messageOrResponse?.data?.globalMsgId,
    messageOrResponse?.globalMsgId,
    innerMsg?.data?.globalMsgId,
    innerMsg?.globalMsgId,
    attachment0?.data?.globalMsgId,
    attachment0?.globalMsgId,
    linkMsg?.data?.globalMsgId,
    linkMsg?.globalMsgId,
    messageOrResponse?.data?.quote?.globalMsgId,
    msgId,
  ];
  const resolvedGlobalMsgId = globalMsgIdCandidates.find(
    (id) => id !== undefined && id !== null && String(id).trim() !== ""
  );
  const globalMsgId = resolvedGlobalMsgId !== undefined
    ? String(resolvedGlobalMsgId)
    : msgId;

  const uidCandidates = [
    messageOrResponse?.data?.uidFrom,
    messageOrResponse?.uidFrom,
    innerMsg?.data?.uidFrom,
    innerMsg?.uidFrom,
    attachment0?.data?.uidFrom,
    attachment0?.uidFrom,
    linkMsg?.data?.uidFrom,
    linkMsg?.uidFrom,
    contextUid,
    fallbackUid,
  ];

  const resolvedUid = uidCandidates.find(
    (uid) => uid !== undefined && uid !== null && String(uid).trim() !== ""
  );
  const uidFrom = resolvedUid !== undefined ? String(resolvedUid) : "";

  return {
    type,
    threadId,
    data: {
      msgId,
      cliMsgId,
      globalMsgId,
      uidFrom,
    },
  };
}

function responseOrAttachment(attachment) {
  return Array.isArray(attachment) ? attachment[0] : attachment;
}

export function isValidReactionTarget(messageRef) {
  if (!messageRef) return false;
  const threadId = String(messageRef.threadId || "").trim();
  const type = Number(messageRef.type);
  const msgId = String(messageRef.data?.msgId || "").trim();
  const cliMsgId = String(messageRef.data?.cliMsgId || "").trim();
  return Boolean(threadId && (type === 0 || type === 1) && (msgId || cliMsgId));
}

export function buildCountdownReaction(remaining) {
  return "CLOCK";
}

export const MAX_REACTION_BATCH_SIZE = 50;

let lastReactionBatchError = null;

export function resetReactionBatchErrorState() {
  lastReactionBatchError = null;
}

export function buildReactionOperations({
  icon,
  messageRef,
  count = 0,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  const operations = [];
  let remaining = Math.max(0, Math.floor(Number(count) || 0));
  while (remaining > 0) {
    const size = Math.min(remaining, maxBatchSize);
    operations.push({ icon, messages: Array(size).fill(messageRef) });
    remaining -= size;
  }
  return operations;
}

function reportReactionBatchError(prefix, error) {
  const errMsg = error?.message || String(error);
  if (lastReactionBatchError !== errMsg) {
    lastReactionBatchError = errMsg;
    console.error(`${prefix}: ${errMsg}`);
  }
}

export async function applyReactionBatch({
  api,
  icon = "CLOCK",
  messageRef,
  count = 1,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  if (!api || typeof api.addReaction !== "function" || !isValidReactionTarget(messageRef) || count <= 0) {
    return 0;
  }

  try {
    await api.addReaction(buildReactionOperations({ icon, messageRef, count, maxBatchSize }));
    lastReactionBatchError = null;
    return count;
  } catch (error) {
    reportReactionBatchError("[Countdown] Failed to apply reaction batch", error);
    return 0;
  }
}

export async function undoReactionBatch({
  api,
  messageRef,
  count = 1,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  if (!api || typeof api.addReaction !== "function" || !isValidReactionTarget(messageRef) || count <= 0) {
    return 0;
  }

  try {
    await api.addReaction(buildReactionOperations({ icon: "UNDO", messageRef, count, maxBatchSize }));
    lastReactionBatchError = null;
    return count;
  } catch (error) {
    reportReactionBatchError("[Countdown] Failed to UNDO reaction batch", error);
    return 0;
  }
}

export async function replaceCountdownReactionFrame({
  api,
  messageRef,
  renderedCount = 0,
  nextCount = 0,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  const current = Math.max(0, Math.floor(Number(renderedCount) || 0));
  const next = Math.max(0, Math.floor(Number(nextCount) || 0));
  if (current === next) return current;
  if (!api || typeof api.addReaction !== "function" || !isValidReactionTarget(messageRef)) return current;

  const operations = [
    ...buildReactionOperations({ icon: "UNDO", messageRef, count: current, maxBatchSize }),
    ...buildReactionOperations({ icon: "CLOCK", messageRef, count: next, maxBatchSize }),
  ];
  if (operations.length === 0) return current;

  try {
    await api.addReaction(operations);
    lastReactionBatchError = null;
    return next;
  } catch (error) {
    reportReactionBatchError("[Countdown] Failed to apply reaction batch", error);
    return current;
  }
}

export function isRetryableRecallError(error) {
  if (error?.retryable === true) return true;
  const status = Number(error?.status);
  return status === 408 || status === 429 || status >= 500;
}

export async function recallBotMessage({
  api,
  message,
  messageContext,
  maxRetries = 2,
  delayMs = 300,
  detailed = false,
}) {
  if (!api || typeof api.undoMessage !== "function") {
    console.warn("[RecallBotMessage] api.undoMessage is not available");
    return detailed
      ? { ok: false, reason: "NO_UNDO_API", reference: null, retryable: false }
      : false;
  }
  const messageRef = normalizeMessageReference(message, messageContext);
  const hasType = messageRef?.type === 0 || messageRef?.type === 1;
  const hasThread = Boolean(String(messageRef?.threadId || "").trim());
  const msgId = String(
    messageRef?.data?.globalMsgId ||
    messageRef?.data?.msgId ||
    ""
  ).trim();
  const cliMsgId = String(messageRef?.data?.cliMsgId || "").trim();

  if (!hasThread || !hasType || !msgId || !cliMsgId) {
    const reason = !cliMsgId ? "missing_cli_msg_id" : (!msgId ? "missing_msg_id" : "invalid_target");
    console.warn(
      `[RecallBotMessage] Skipped invalid target: reason="${reason}" threadId="${messageRef?.threadId || ""}", type=${messageRef?.type}, ` +
      `msgId="${messageRef?.data?.msgId || ""}", globalMsgId="${messageRef?.data?.globalMsgId || ""}", cliMsgId="${messageRef?.data?.cliMsgId || ""}"`
    );
    return detailed
      ? { ok: false, reason, reference: messageRef, retryable: false }
      : false;
  }

  console.log(
    `[RecallBotMessage] Attempting undo: threadId="${messageRef.threadId}", type=${messageRef.type}, ` +
    `msgId="${messageRef.data?.msgId || ""}", cliMsgId="${messageRef.data?.cliMsgId || ""}", ` +
    `globalMsgId="${messageRef.data?.globalMsgId || ""}"`
  );

  let lastError = null;
  let lastIsRetryable = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await api.undoMessage(messageRef);
      console.log(`[RecallBotMessage] Undo succeeded on attempt ${attempt + 1}`);
      return detailed
        ? { ok: true, reference: messageRef, retryable: false }
        : true;
    } catch (err) {
      lastError = err;
      lastIsRetryable = isRetryableRecallError(err);
      if (!lastIsRetryable || attempt === maxRetries) {
        console.error(
          `[RecallBotMessage] Failed to undo message after ${attempt + 1} attempt(s): ${err?.message || err}` +
          ` | code=${err?.code ?? ""} status=${err?.status ?? ""} retryable=${lastIsRetryable} threadId="${messageRef.threadId}" type=${messageRef.type} msgId="${messageRef.data?.msgId || ""}" cliMsgId="${messageRef.data?.cliMsgId || ""}"`
        );
        return detailed
          ? {
              ok: false,
              reason: err?.message || "RECALL_FAILED",
              reference: messageRef,
              retryable: lastIsRetryable,
              error: err,
            }
          : false;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return detailed
    ? {
        ok: false,
        reason: lastError?.message || "RECALL_FAILED",
        reference: messageRef,
        retryable: lastIsRetryable,
        error: lastError,
      }
    : false;
}

export async function recallBotMessageDetailed(options) {
  return recallBotMessage({ ...options, detailed: true });
}

export function startInteractionCountdown({
  key,
  api,
  message,
  messageContext,
  seconds = 60,
  timeoutMs,
  onExpire,
  deleteOnExpire = false,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  now,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  const normalizedKey = key !== undefined && key !== null ? String(key) : null;

  const remainingSeconds = Math.floor(Number(seconds) || 0);
  if (!api || !message || remainingSeconds <= 0) {
    return () => Promise.resolve(false);
  }

  const sessionNow = now || (typeof schedule?.now === "function" ? schedule.now : () => Date.now());
  const messageRef = normalizeMessageReference(message, messageContext);
  const startTime = sessionNow();
  const durationMs = timeoutMs !== undefined && timeoutMs !== null ? Number(timeoutMs) : remainingSeconds * 1000;
  const expiresAt = startTime + durationMs;

  const session = {
    key: normalizedKey,
    api,
    messageRef,
    remaining: remainingSeconds,
    expiresAt,
    renderedCount: 0,
    targetWarningLogged: false,
    stopped: false,
    timerId: null,
    renderPromise: null,
    onExpire,
    deleteOnExpire: Boolean(deleteOnExpire),
    schedule,
    cancelSchedule,
    now: sessionNow,
    maxBatchSize,
  };

  const previousCleanup = normalizedKey && activeCountdownSessions.has(normalizedKey)
    ? cancelInteractionCountdown(normalizedKey)
    : Promise.resolve(false);

  if (normalizedKey) {
    activeCountdownSessions.set(normalizedKey, session);
  }

  const handleExpiry = async () => {
    if (session.stopped) return;
    session.stopped = true;

    if (session.timerId !== null && session.timerId !== undefined) {
      if (typeof session.cancelSchedule === "function") {
        session.cancelSchedule(session.timerId);
      }
      session.timerId = null;
    }

    if (session.key && activeCountdownSessions.get(session.key) === session) {
      activeCountdownSessions.delete(session.key);
    }

    if (session.renderPromise) {
      try {
        await session.renderPromise;
      } catch {}
      session.renderPromise = null;
    }

    if (session.renderedCount > 0) {
      const toClear = session.renderedCount;
      session.renderedCount = 0;
      await replaceCountdownReactionFrame({
        api: session.api,
        messageRef: session.messageRef,
        renderedCount: toClear,
        nextCount: 0,
        maxBatchSize: session.maxBatchSize,
      });
    }

    if (typeof session.onExpire === "function") {
      try {
        await session.onExpire();
      } catch (error) {
        console.error(
          `[Countdown] onExpire handler failed: ${error?.message || error}`
        );
      }
    }

    if (session.deleteOnExpire) {
      try {
        await recallBotMessage({ api: session.api, message: session.messageRef });
      } catch (error) {
        console.error(
          `[Countdown] undoMessage on expire failed: ${error?.message || error}`
        );
      }
    }
  };

  const tick = async () => {
    if (session.stopped) return;

    if (session.renderPromise) {
      try {
        await session.renderPromise;
      } catch {}
      session.renderPromise = null;
    }

    if (session.stopped) return;

    const nextCount = Math.max(0, Math.ceil((session.expiresAt - session.now()) / 1000));
    session.remaining = nextCount;

    if (session.remaining <= 0) {
      await handleExpiry();
      return;
    }

    if (!isValidReactionTarget(session.messageRef)) {
      if (!session.targetWarningLogged) {
        session.targetWarningLogged = true;
        console.warn(
          `[Countdown] Skipping reaction: Invalid reaction target (threadId="${session.messageRef?.threadId}", type=${session.messageRef?.type}, msgId="${session.messageRef?.data?.msgId}", cliMsgId="${session.messageRef?.data?.cliMsgId}")`
        );
      }
      session.timerId = session.schedule(tick, 1000);
      return;
    }

    session.renderPromise = (async () => {
      session.renderedCount = await replaceCountdownReactionFrame({
        api: session.api,
        messageRef: session.messageRef,
        renderedCount: session.renderedCount,
        nextCount,
        maxBatchSize: session.maxBatchSize,
      });
      return session.renderedCount;
    })();

    await session.renderPromise;
    session.renderPromise = null;

    if (session.stopped) {
      if (session.renderedCount > 0) {
        const toClear = session.renderedCount;
        session.renderedCount = 0;
        await replaceCountdownReactionFrame({
          api: session.api,
          messageRef: session.messageRef,
          renderedCount: toClear,
          nextCount: 0,
          maxBatchSize: session.maxBatchSize,
        });
      }
      return;
    }

    session.timerId = session.schedule(tick, 1000);
  };

  session.renderPromise = Promise.resolve(previousCleanup)
    .then(async () => {
      if (session.stopped) return 0;
      if (!isValidReactionTarget(session.messageRef)) {
        if (!session.targetWarningLogged) {
          session.targetWarningLogged = true;
          console.warn(
            `[Countdown] Skipping reaction: Invalid reaction target (threadId="${session.messageRef?.threadId}", type=${session.messageRef?.type}, msgId="${session.messageRef?.data?.msgId}", cliMsgId="${session.messageRef?.data?.cliMsgId}")`
          );
        }
        return 0;
      }
      session.renderedCount = await replaceCountdownReactionFrame({
        api: session.api,
        messageRef: session.messageRef,
        renderedCount: 0,
        nextCount: session.remaining,
        maxBatchSize: session.maxBatchSize,
      });
      if (session.stopped && session.renderedCount > 0) {
        const toClear = session.renderedCount;
        session.renderedCount = 0;
        await replaceCountdownReactionFrame({
          api: session.api,
          messageRef: session.messageRef,
          renderedCount: toClear,
          nextCount: 0,
          maxBatchSize: session.maxBatchSize,
        });
      }
      return session.renderedCount;
    })
    .catch((error) => {
      console.error(`[Countdown] Initial reaction batch failed: ${error?.message || error}`);
      return 0;
    });

  session.timerId = session.schedule(tick, 1000);

  return () => {
    return cancelInteractionCountdown(session.key ? session.key : session);
  };
}

export async function completeInteractionCountdown(keyOrSession) {
  if (!keyOrSession) return false;

  let session = null;
  if (typeof keyOrSession === "object") {
    session = keyOrSession;
  } else {
    const key = String(keyOrSession);
    session = activeCountdownSessions.get(key);
  }

  if (!session) return false;

  session.stopped = true;

  if (session.timerId !== null && session.timerId !== undefined) {
    if (typeof session.cancelSchedule === "function") {
      session.cancelSchedule(session.timerId);
    }
    session.timerId = null;
  }

  if (session.key && activeCountdownSessions.get(session.key) === session) {
    activeCountdownSessions.delete(session.key);
  }

  if (session.renderPromise) {
    try {
      await session.renderPromise;
    } catch {}
    session.renderPromise = null;
  }

  if (session.renderedCount > 0 && session.api && typeof session.api.addReaction === "function") {
    const toUndo = session.renderedCount;
    session.renderedCount = 0;
    await replaceCountdownReactionFrame({
      api: session.api,
      messageRef: session.messageRef,
      renderedCount: toUndo,
      nextCount: 0,
      maxBatchSize: session.maxBatchSize,
    });
  }

  return true;
}

export async function cancelInteractionCountdown(keyOrSession) {
  return await completeInteractionCountdown(keyOrSession);
}

export function showCooldownClock({
  api,
  message,
  messageContext,
  remainingMs,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  maxBatchSize = MAX_REACTION_BATCH_SIZE,
}) {
  return startInteractionCountdown({
    api,
    message,
    messageContext,
    seconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    timeoutMs: remainingMs,
    schedule,
    cancelSchedule,
    maxBatchSize,
  });
}

export function getInteractionCountdown(key) {
  if (key === undefined || key === null) return null;
  return activeCountdownSessions.get(String(key)) || null;
}

export function hasInteractionCountdown(key) {
  if (key === undefined || key === null) return false;
  return activeCountdownSessions.has(String(key));
}

export function clearAllInteractionCountdowns() {
  resetReactionBatchErrorState();
  for (const session of Array.from(activeCountdownSessions.values())) {
    completeInteractionCountdown(session);
  }
  activeCountdownSessions.clear();
}

export async function createDownloadProgress({
  api,
  message,
  caption,
  ttl = 8000,
  sendProcessingFn,
}) {
  let progressMsgRef = null;
  let isCompleted = false;

  if (api && message && caption) {
    try {
      const sendFn = await resolveSendProcessingFn(sendProcessingFn);
      const sent = sendFn
        ? await sendFn(api, message, { caption }, ttl)
        : null;
      if (sent) {
        progressMsgRef = normalizeMessageReference(
          sent,
          message
        );
      }
    } catch (err) {
      console.error(
        `[DownloadProgress] Failed to send processing message: ${err?.message || err}`
      );
    }
  }

  const complete = async () => {
    if (isCompleted) return false;
    isCompleted = true;

    if (!progressMsgRef || !api || typeof api.undoMessage !== "function") {
      return false;
    }

    try {
      return await recallBotMessage({ api, message: progressMsgRef });
    } catch (err) {
      console.error(
        `[DownloadProgress] Failed to recall processing message on complete: ${err?.message || err}`
      );
      return false;
    }
  };

  return {
    messageRef: progressMsgRef,
    complete,
  };
}

export function openMediaSelection({
  key,
  api,
  prompt,
  messageContext,
  seconds = 60,
  onClaim,
  onExpire,
  schedule,
  cancelSchedule,
  now,
}) {
  const normalizedKey = key !== undefined && key !== null ? String(key) : null;
  let status = "open";
  let terminalPromise = null;
  const messageRef = normalizeMessageReference(prompt, messageContext);

  const cleanupPromptMessage = async (replyMessage = null) => {
    let targetRef = messageRef;
    const quote = replyMessage?.data?.quote || replyMessage?.quote;
    if (quote) {
      const quoteServerId = quote.globalMsgId || quote.msgId;
      const storedServerId = messageRef?.data?.globalMsgId || messageRef?.data?.msgId;
      if (quoteServerId && storedServerId && String(quoteServerId) === String(storedServerId)) {
        if (!targetRef.data?.cliMsgId && quote.cliMsgId) {
          targetRef = {
            ...targetRef,
            data: {
              ...targetRef.data,
              cliMsgId: String(quote.cliMsgId),
            },
          };
        }
      }
    }
    if (
      api &&
      typeof api.undoMessage === "function" &&
      targetRef?.data?.msgId &&
      targetRef?.data?.cliMsgId
    ) {
      try {
        await recallBotMessage({ api, message: targetRef });
      } catch (err) {
        console.warn(`[MediaSelection] Prompt cleanup error: ${err?.message || err}`);
      }
    }
  };

  const finish = (nextStatus, replyMessage = null) => {
    if (status !== "open") {
      return Promise.resolve({ ok: false, reason: status });
    }
    status = nextStatus;
    terminalPromise ??= (async () => {
      if (normalizedKey) await completeInteractionCountdown(normalizedKey);
      else await cancelCountdown();
      await cleanupPromptMessage(replyMessage);
      return { ok: true, reason: nextStatus };
    })();
    return terminalPromise;
  };

  const handleExpiry = async () => {
    if (status !== "open") return;
    status = "expired";
    if (typeof onExpire === "function") {
      try {
        await onExpire();
      } catch (err) {
        console.error(
          `[MediaSelection] onExpire error: ${err?.message || err}`
        );
      }
    }
  };

  const cancelCountdown = startInteractionCountdown({
    key: normalizedKey,
    api,
    message: prompt,
    messageContext,
    seconds,
    deleteOnExpire: true,
    onExpire: handleExpiry,
    schedule,
    cancelSchedule,
    now,
  });

  const claim = async (claimHandler, replyMessage = null) => {
    const term = await finish("claimed", replyMessage);
    if (!term.ok) {
      return term;
    }

    if (typeof onClaim === "function") {
      try {
        await onClaim();
      } catch (err) {
        console.error(
          `[MediaSelection] onClaim error: ${err?.message || err}`
        );
      }
    }

    if (typeof claimHandler === "function") {
      const res = await claimHandler();
      return { ok: true, result: res };
    }

    return { ok: true };
  };

  const cancel = async () => {
    const term = await finish("expired");
    if (!term.ok) return;

    if (typeof onExpire === "function") {
      try {
        await onExpire();
      } catch (err) {}
    }
  };

  return {
    key: normalizedKey,
    getStatus: () => status,
    isOpen: () => status === "open",
    isClaimed: () => status === "claimed",
    isExpired: () => status === "expired",
    claim,
    cancel,
  };
}
