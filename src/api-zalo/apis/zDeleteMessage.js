import { appContext } from "../context.js";
import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { GroupMessage, Message, MessageType } from "../models/Message.js";
import { encodeAES, handleZaloResponse, removeUndefinedKeys, request } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function zDeleteMessageFactory(api) {
  if (!api?.zpwServiceMap?.chat?.[0] || !api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing chat/group endpoint (zpwServiceMap.chat[0]/group[0])");
  const URLType = {
    [MessageType.DirectMessage]: `${api.zpwServiceMap.chat[0]}/api/message/delete?zpw_ver=${API_VERSION}&zpw_type=${API_TYPE}`,
    [MessageType.GroupMessage]: `${api.zpwServiceMap.group[0]}/api/group/deletemsg?zpw_ver=${API_VERSION}&zpw_type=${API_TYPE}`,
  };

  /**
   * Delete a message
   *
   * @param options Message options containing cliMsgId, msgId, uidFrom, onlyMe
   * @param threadId Thread ID to delete message from
   * @param type Message type (MessageType.DirectMessage or MessageType.GroupMessage)
   *
   * @throws ZaloApiError
   */
  return async function deleteMessage(options, threadId, type = MessageType.DirectMessage) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    
    if (!options) throw new ZaloApiError("Missing message options");
    if (!threadId) throw new ZaloApiError("Missing thread ID");

    const isGroupMessage = type === MessageType.GroupMessage;
    const isSelf = appContext.uid == options.uidFrom;
    
    if (isSelf && options.onlyMe === false)
      throw new ZaloApiError("To delete your message for everyone, use undo api instead");

    const params = {
      [isGroupMessage ? "grid" : "toid"]: threadId,
      cliMsgId: Date.now()*600,
      msgs: [
        {
          cliMsgId: String(options.cliMsgId),
          globalMsgId: String(options.msgId),
          ownerId: String(options.uidFrom),
          destId: String(threadId),
        },
      ],
      onlyMe: options.onlyMe ? 1 : 0,
    };

    if (!isGroupMessage) {
      params.imei = appContext.imei;
    }

    removeUndefinedKeys(params);
    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt message");

    async function attemptRequest() {
      const response = await request(URLType[type], {
        method: "POST",
        body: new URLSearchParams({
          params: encryptedParams,
        }),
      });
      return await handleZaloResponse(response);
    }

    let result;
    const maxAttempts = 6;
    const delayMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = await attemptRequest();

      if (!result.error) break;

      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (result.error) {
      throw new ZaloApiError(result.error.message, result.error.code);
    }

    return result.data;
  };
}