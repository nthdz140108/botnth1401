import { LRUCache } from "lru-cache";
import { updateMessageCache, resolveMessageCacheStore } from "../utils/message-cache.js";
import { createStateClaimRegistry } from "./state-claim-registry.js";
import { getGlobalLatencyTracker } from "../observability/latency-tracker.js";

export function createFastPathDispatcher(options = {}) {
  const {
    api = null,
    botId = "admin",
    handlers = {},
    metrics = null,
    stateClaims = createStateClaimRegistry({ ttlMs: 60_000 }),
    latencyTracker = getGlobalLatencyTracker(),
    maxInFlightMessages = Number(process.env.MAX_INFLIGHT_MESSAGES || 128),
    logger = console,
  } = options;

  let activeApi = api;
  let currentMessageStore = options.messageStore || resolveMessageCacheStore(api || botId);
  const messageHandler = handlers.message;
  const groupEventHandler = handlers.group_event || handlers.groupEvents;
  const undoHandler = handlers.undo || handlers.undoMessageEvents;
  const reactionHandler = handlers.reaction || handlers.reactionEvents;

  // Bounded deduplication cache: eventId/msgId -> timestamp
  const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const processedEventIds = new LRUCache({
    max: 10000,
    ttl: DEDUPE_TTL_MS,
  });

  let dispatchedCount = 0;
  let dedupeDropCount = 0;
  let overloadDropCount = 0;
  let activeInFlight = 0;
  let activeMessageInFlight = 0;

  function isDuplicate(id) {
    if (!id) return false;
    const strId = String(id);
    if (processedEventIds.has(strId)) {
      return true;
    }
    processedEventIds.set(strId, Date.now());
    return false;
  }

  async function dispatchMessage(message) {
    if (!message) return;
    const cliMsgId = message.data?.cliMsgId || message.data?.msgId;
    const eventId = String(cliMsgId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    if (cliMsgId && isDuplicate(`msg:${botId}:${cliMsgId}`)) {
      dedupeDropCount++;
      return;
    }

    if (activeMessageInFlight >= maxInFlightMessages) {
      overloadDropCount++;
      logger.warn?.(
        `[fast-path-dispatcher] shedding message ${eventId}: activeMessageInFlight=${activeMessageInFlight} >= ${maxInFlightMessages}`
      );
      try {
        currentMessageStore?.update ? currentMessageStore.update(message) : updateMessageCache(message, activeApi || botId);
      } catch {}
      return;
    }

    latencyTracker?.begin?.(eventId, "message", botId);
    latencyTracker?.mark?.(eventId, "preflight_started");

    dispatchedCount++;
    activeInFlight++;
    activeMessageInFlight++;
    metrics?.recordInbound?.({ kind: "message", threadId: message.threadId });
    try {
      currentMessageStore?.update ? currentMessageStore.update(message) : updateMessageCache(message, activeApi || botId);
    } catch {}

    try {
      latencyTracker?.mark?.(eventId, "handler_started");
      if (typeof messageHandler === "function") {
        await messageHandler(activeApi, message);
      }
      latencyTracker?.mark?.(eventId, "completed");
      latencyTracker?.finish?.(eventId, "ok");
      metrics?.recordAck?.({ eventId });
    } catch (error) {
      latencyTracker?.finish?.(eventId, "error");
      logger.error?.(`[fast-path-dispatcher] message handler error: ${error?.message || error}`);
    } finally {
      activeInFlight = Math.max(0, activeInFlight - 1);
      activeMessageInFlight = Math.max(0, activeMessageInFlight - 1);
      try {
        currentMessageStore?.update ? currentMessageStore.update(message) : updateMessageCache(message, activeApi || botId);
      } catch {}
    }
  }

  async function dispatchGroupEvent(event) {
    if (!event) return;
    const eventId = String(event.groupId ? `ge-${event.groupId}-${Date.now()}` : `ge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    dispatchedCount++;
    activeInFlight++;
    metrics?.recordInbound?.({ kind: "group_event", threadId: event.threadId || event.groupId });
    latencyTracker?.begin?.(eventId, "group_event", botId, { threadId: event.threadId, commandClass: "control" });

    try {
      latencyTracker?.mark?.(eventId, "handler_started");
      if (typeof groupEventHandler === "function") {
        await groupEventHandler(activeApi, event);
      }
      latencyTracker?.finish?.(eventId, "ok");
      metrics?.recordAck?.({ eventId });
    } catch (error) {
      latencyTracker?.finish?.(eventId, "error");
      logger.error?.(`[fast-path-dispatcher] group_event handler error: ${error?.message || error}`);
    } finally {
      activeInFlight = Math.max(0, activeInFlight - 1);
    }
  }

  async function dispatchUndo(undo) {
    if (!undo) return;
    let contentObj = undo.data?.content;
    if (typeof contentObj === "string" && contentObj.trim().startsWith("{")) {
      try { contentObj = JSON.parse(contentObj); } catch {}
    }
    const undoMsgId = contentObj?.cliMsgId || contentObj?.msgId || undo.data?.cliMsgId || undo.data?.msgId;
    const eventId = String(undoMsgId || `undo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    if (undoMsgId && isDuplicate(`undo:${botId}:${undoMsgId}`)) {
      dedupeDropCount++;
      return;
    }

    dispatchedCount++;
    activeInFlight++;
    metrics?.recordInbound?.({ kind: "undo", threadId: undo.threadId });
    latencyTracker?.begin?.(eventId, "undo", botId, { threadId: undo.threadId, commandClass: "control" });

    try {
      latencyTracker?.mark?.(eventId, "handler_started");
      if (typeof undoHandler === "function") {
        await undoHandler(activeApi, undo);
      }
      latencyTracker?.finish?.(eventId, "ok");
      metrics?.recordAck?.({ eventId });
    } catch (error) {
      latencyTracker?.finish?.(eventId, "error");
      logger.error?.(`[fast-path-dispatcher] undo handler error: ${error?.message || error}`);
    } finally {
      activeInFlight = Math.max(0, activeInFlight - 1);
    }
  }

  async function dispatchReaction(reaction) {
    if (!reaction) return;
    const msgId = reaction.data?.msgId;
    const senderId = reaction.data?.uidFrom || reaction.data?.senderId || "";
    const reactIcon = reaction.data?.content?.rType ?? reaction.data?.content?.rIcon ?? reaction.data?.reactType ?? "";
    const dedupeKey = `react:${botId}:${msgId}:${senderId}:${reactIcon}`;
    const eventId = String(msgId ? `react-${msgId}-${Date.now()}` : `react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    if (msgId && isDuplicate(dedupeKey)) {
      dedupeDropCount++;
      return;
    }

    dispatchedCount++;
    activeInFlight++;
    metrics?.recordInbound?.({ kind: "reaction", threadId: reaction.threadId });
    latencyTracker?.begin?.(eventId, "reaction", botId, { threadId: reaction.threadId, commandClass: "control" });

    try {
      latencyTracker?.mark?.(eventId, "handler_started");
      if (typeof reactionHandler === "function") {
        await reactionHandler(activeApi, reaction);
      }
      latencyTracker?.finish?.(eventId, "ok");
      metrics?.recordAck?.({ eventId });
    } catch (error) {
      latencyTracker?.finish?.(eventId, "error");
      logger.error?.(`[fast-path-dispatcher] reaction handler error: ${error?.message || error}`);
    } finally {
      activeInFlight = Math.max(0, activeInFlight - 1);
    }
  }

  async function dispatch(envelope) {
    if (!envelope) return;
    const hasEnvelopeKind = typeof envelope.kind === "string" || typeof envelope.type === "string";
    const kind = typeof envelope.kind === "string"
      ? envelope.kind
      : (typeof envelope.type === "string" ? envelope.type : "message");
    const payload = envelope.payload !== undefined
      ? envelope.payload
      : (hasEnvelopeKind && envelope.data !== undefined && envelope.threadId === undefined ? envelope.data : envelope);

    switch (kind) {
      case "message":
        return dispatchMessage(payload);
      case "group_event":
        return dispatchGroupEvent(payload);
      case "undo":
        return dispatchUndo(payload);
      case "reaction":
        return dispatchReaction(payload);
      default:
        logger.warn?.(`[fast-path-dispatcher] unknown event kind: ${kind}`);
        break;
    }
  }

  function updateApi(newApi) {
    activeApi = newApi;
    if (newApi && !options.messageStore) {
      currentMessageStore = resolveMessageCacheStore(newApi);
    }
  }

  function stats() {
    return {
      botId,
      dispatchedCount,
      dedupeDropCount,
      overloadDropCount,
      activeInFlight,
      activeMessageInFlight,
      claims: stateClaims.stats(),
    };
  }

  return {
    dispatch,
    dispatchMessage,
    dispatchGroupEvent,
    dispatchUndo,
    dispatchReaction,
    updateApi,
    stateClaims,
    stats,
  };
}
