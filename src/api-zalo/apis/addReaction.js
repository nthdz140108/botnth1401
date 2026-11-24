import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { MessageType } from "../models/Message.js";
import { ReactionMap } from "../models/Reaction.js";
import { decodeAES, encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export function addReactionFactory(api) {
  if (!api?.zpwServiceMap?.reaction?.[0]) throw new ZaloApiError("Missing reaction endpoint (zpwServiceMap.reaction[0])");
  const directMessageServiceURL = makeURL(`${api.zpwServiceMap.reaction[0]}/api/message/reaction`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });
  const groupMessageServiceURL = makeURL(`${api.zpwServiceMap.reaction[0]}/api/group/reaction`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Add reaction to one or multiple messages
   *
   * Supported forms:
   * - addReaction(icon, messages): legacy single-operation form
   * - addReaction([{ icon, messages }, ...]): multi-operation form, all packed
   *   into the SAME react_list of ONE HTTP request (each operation's rMsg must
   *   respect the 50-target protocol cap enforced by the caller)
   *
   * @param iconOrOperations Reaction icon OR array of { icon, messages } operations
   * @param messages Single message object or array of message objects (legacy form only)
   *
   * @throws ZaloApiError
   */
  return async function addReaction(iconOrOperations, messages) {
    if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
    if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
    if (!appContext.cookie) throw new ZaloApiError("Cookie is not available");
    if (!appContext.userAgent) throw new ZaloApiError("User agent is not available");

    const operations = Array.isArray(iconOrOperations)
      ? iconOrOperations.map((op) => ({
          icon: op?.icon,
          messages: Array.isArray(op?.messages) ? op.messages : [op?.messages],
        }))
      : [{
          icon: iconOrOperations,
          messages: Array.isArray(messages) ? messages : [messages],
        }];

    if (operations.length === 0) throw new ZaloApiError("No reactions to apply");
    const firstMessage = operations[0].messages[0];
    if (!firstMessage) throw new ZaloApiError("No messages to react to");
    const isGroupMessage = firstMessage.type === MessageType.GroupMessage;
    const threadId = firstMessage.threadId;

    const react_list = operations.map((op, index) => {
      const reaction = ReactionMap[op.icon] || ReactionMap.NONE;
      const { rType, text } = reaction;
      const rMsg = op.messages.map(msg => ({
        gMsgID: parseInt(msg.data.msgId),
        cMsgID: parseInt(msg.data.cliMsgId),
        msgType: parseInt(msg.type),
      }));

      return {
        message: JSON.stringify({
          rMsg,
          rIcon: text,
          rType,
          source: 6,
        }),
        clientId: Date.now() + index,
      };
    });

    const params = {
      react_list,
      toid: isGroupMessage ? undefined : String(threadId),
      grid: isGroupMessage ? String(threadId) : undefined,
    };

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt message");

    const url = isGroupMessage ? groupMessageServiceURL : directMessageServiceURL;
    const response = await request(url, {
      method: "POST",
      body: new URLSearchParams({
        params: encryptedParams,
      }),
    });

    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
    if (operations.length === 1) {
      const reaction = ReactionMap[operations[0].icon] || ReactionMap.NONE;
      return { icon: operations[0].icon, rType: reaction.rType };
    }
    return {
      icons: operations.map((op) => op.icon),
      rTypes: operations.map((op) => (ReactionMap[op.icon] || ReactionMap.NONE).rType),
      reactCount: react_list.length,
    };
  };
}
