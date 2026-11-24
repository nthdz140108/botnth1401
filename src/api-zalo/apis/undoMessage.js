import { appContext } from "../context.js";
import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { GroupMessage, Message, MessageType } from "../models/Message.js";
import { encodeAES, handleZaloResponse, request } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";
export function undoMessageFactory(api) {
  if (!api?.zpwServiceMap?.chat?.[0] || !api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing chat/group endpoint (zpwServiceMap.chat[0]/group[0])");
  const URLType = {
    [MessageType.DirectMessage]: `${api.zpwServiceMap.chat[0]}/api/message/undo?zpw_ver=${API_VERSION}&zpw_type=${API_TYPE}`,
    [MessageType.GroupMessage]: `${api.zpwServiceMap.group[0]}/api/group/undomsg?zpw_ver=${API_VERSION}&zpw_type=${API_TYPE}`,
  };
  /**
   * Undo a message
   *
   * @param message Message or GroupMessage instance that has quote to undo OR normalized bot message reference
   *
   * @throws ZaloApiError
   */
  return async function undo(message) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    if (!message) throw new ZaloApiError("Missing message to undo");

    const quote = message.data?.quote ?? message.quote;
    const msgId = quote?.globalMsgId ?? quote?.msgId ?? message.data?.globalMsgId ?? message.data?.msgId ?? message.globalMsgId ?? message.msgId;
    const cliMsgId = quote?.cliMsgId ?? message.data?.cliMsgId ?? message.cliMsgId;
    const threadId = message.threadId ?? message.data?.threadId ?? message.grid ?? message.toid;
    const isGroup = message.type === MessageType.GroupMessage || Number(message.type) === 1 || Number(message.data?.type) === 1;
    const messageType = isGroup ? MessageType.GroupMessage : MessageType.DirectMessage;

    if (!msgId) throw new ZaloApiError("Missing msgId for undo message", "UNDO_MSG_ID_MISSING");
    if (!cliMsgId) throw new ZaloApiError("Missing cliMsgId for undo message", "UNDO_CLI_MSG_ID_MISSING");
    if (!threadId) throw new ZaloApiError("Missing threadId for undo message");

    const params = {
      msgId: String(msgId),
      clientId: Date.now(),
      cliMsgIdUndo: String(cliMsgId),
    };

    if (isGroup) {
      params["grid"] = String(threadId);
      params["visibility"] = 0;
      params["imei"] = appContext.imei;
    } else {
      params["toid"] = String(threadId);
    }
    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt message");

    const url = URLType[messageType];
    const response = await request(url, {
      method: "POST",
      body: new URLSearchParams({
        params: encryptedParams,
      }),
    });
    const result = await handleZaloResponse(response);
    if (result.error) {
      throw new ZaloApiError(
        result.error.message,
        result.error.code,
        result.error.status ?? response.status,
        { retryable: result.error.retryable }
      );
    }
    return result.data;
  };
}
