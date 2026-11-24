import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function sendBankCardFactory(api) {
  if (!api?.zpwServiceMap?.zimsg?.[0]) throw new ZaloApiError("Missing zimsg endpoint (zpwServiceMap.zimsg[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.zimsg[0]}/api/transfer/card`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Gửi thông tin thẻ ngân hàng đến một cuộc trò chuyện
   *
   * @param {Object} message Thông tin tin nhắn
   * @param {string|number} message.threadId ID của người dùng/nhóm
   * @param {number} message.type Loại tin nhắn (DirectMessage/GroupMessage)
   * @param {string} binBank Mã BIN của ngân hàng
   * @param {string} accountNumber Số tài khoản
   * @param {string} accountName Tên chủ tài khoản  
   * @throws {ZaloApiError}
   */
  return async function sendBankCard(message, binBank, accountNumber, accountName) {
		if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
			throw new ZaloApiError("Missing required app context fields");
    if (!message) throw new ZaloApiError("Missing message");
    if (!binBank) throw new ZaloApiError("Missing binBank");
    if (!accountNumber) throw new ZaloApiError("Missing accountNumber");
    if (!accountName) throw new ZaloApiError("Missing accountName");

    const params = {
      binBank: parseInt(binBank),
      numAccBank: accountNumber,
      nameAccBank: accountName,
      cliMsgId: message.data.cliMsgId,
      tsMsg: message.data.ts,
      destUid: message.threadId,
      destType: message.type
    };

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt params");

    const response = await request(serviceURL, {
      method: "POST",
      body: new URLSearchParams({
        params: encryptedParams,
      }),
    });

    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code);

    return result.data;
  };
} 