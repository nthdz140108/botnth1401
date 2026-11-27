import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { MessageType } from "../models/Message.js";
import { appContext } from "../context.js";
import { rememberOutboundMessage, rememberOutboundReceipt } from "../outbound-message-registry.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";

export function sendBusinessCardFactory(api) {
	if (!api?.zpwServiceMap?.file?.[0]) throw new ZaloApiError("Missing file endpoint (zpwServiceMap.file[0])");
	const directMessageServiceURL = makeURL(`${api.zpwServiceMap.file[0]}/api/message/forward`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });
  const groupMessageServiceURL = makeURL(`${api.zpwServiceMap.file[0]}/api/group/forward`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  async function prepareQrCode(userId) {
    const qrCodeUrls = await api.getQRLink(userId);
    const qrCodeUrl = qrCodeUrls?.[String(userId)];
    if (typeof qrCodeUrl !== "string" || !qrCodeUrl) throw new ZaloApiError("QR Code URL not found");
    return qrCodeUrl;
  }

  /**
   * Gửi danh thiếp (business card) đến một cuộc trò chuyện
   *
   * @param {Message} message Tin nhắn đến
   * @param {string|number} userId ID người dùng của danh thiếp
   * @param {string|number} [phone] Số điện thoại kèm theo danh thiếp (tùy chọn)
   * @param {number} [ttl=0] Thời gian tồn tại của tin nhắn (tùy chọn)
   * @throws {ZaloApiError}
   */
  async function sendBusinessCard(message, userId, phone, type, threadId, ttl = 0, preparedQrCodeUrl = null) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
			throw new ZaloApiError("Missing required app context fields");
    if (!userId) throw new ZaloApiError("Missing userId");
    
    type = message ? message.type : type;
    threadId = message ? message.threadId : threadId;

    const qrCodeUrl = preparedQrCodeUrl ?? await prepareQrCode(userId);

    const params = {
      ttl: ttl,
      msgType: 6,
      clientId: Date.now().toString()*600,
      msgInfo: {
        contactUid: userId.toString(),
        qrCodeUrl,
      }
    };

    if (phone) {
      params.msgInfo.phone = phone.toString();
    }

    if (type === MessageType.DirectMessage) {
      params.toId = threadId.toString();
      params.imei = appContext.imei;
    } else {
      params.visibility = 0;
      params.grid = threadId.toString();
    }

    params.msgInfo = JSON.stringify(params.msgInfo);

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt params");

    const serviceURL = type === MessageType.DirectMessage ? directMessageServiceURL : groupMessageServiceURL;

    const botId = appContext.uid;
    rememberOutboundMessage(botId, threadId, { clientId: params.clientId });
    const response = await request(serviceURL, {
      method: "POST",
      body: new URLSearchParams({
        params: encryptedParams,
      }),
    });

    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code);

    rememberOutboundReceipt(botId, threadId, result.data);
    return result.data;
  }
  sendBusinessCard.prepare = prepareQrCode;
  return sendBusinessCard;
}
