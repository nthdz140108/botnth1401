import { updateMessageCache } from "../utils/message-cache.js";

/**
 * Creates an inbound dispatcher that maps serializable InboundEnvelope objects
 * to real Zalo bot event handlers.
 *
 * @param {Object} options
 * @param {Object} options.api - Zalo API instance
 * @param {Object} options.handlers - Mapping of { message, group_event, undo, reaction } handlers
 * @param {Object} [options.logger] - Logger instance
 * @returns {Object} { dispatch, serializeEvent, deserializeEvent, updateApi }
 */
export function createInboundDispatcher(options = {}) {
  let {
    api,
    handlers = {},
    logger = console,
  } = options;

  let messageHandler = handlers.message;
  let groupEventHandler = handlers.group_event;
  let undoHandler = handlers.undo;
  let reactionHandler = handlers.reaction;

  function updateApi(newApi) {
    api = newApi;
  }

  function serializeEvent(kind, event) {
    if (!event) return {};
    try {
      return JSON.parse(JSON.stringify(event));
    } catch {
      return { ...event };
    }
  }

  function deserializeEvent(envelope) {
    if (!envelope) return {};
    return envelope.payload || {};
  }

  async function dispatch(envelope) {
    if (!envelope) return;
    const kind = envelope.kind || "message";
    const event = deserializeEvent(envelope);

    switch (kind) {
      case "message":
        try {
          updateMessageCache(event);
        } catch {}
        if (typeof messageHandler === "function") {
          try {
            await messageHandler(api, event);
          } finally {
            try {
              updateMessageCache(event);
            } catch {}
          }
        }
        break;

      case "group_event":
        if (typeof groupEventHandler === "function") {
          await groupEventHandler(api, event);
        }
        break;

      case "undo":
        if (typeof undoHandler === "function") {
          await undoHandler(api, event);
        }
        break;

      case "reaction":
        if (typeof reactionHandler === "function") {
          await reactionHandler(api, event);
        }
        break;

      default:
        logger.warn?.(`[inbound-dispatcher] unknown event kind: ${kind}`);
        break;
    }
  }

  return {
    dispatch,
    serializeEvent,
    deserializeEvent,
    updateApi,
  };
}
