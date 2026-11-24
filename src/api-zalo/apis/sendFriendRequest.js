import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function sendFriendRequestFactory(api) {
  if (!api?.zpwServiceMap?.friend?.[0]) throw new ZaloApiError("Missing friend endpoint (zpwServiceMap.friend[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/sendreq`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Gửi yêu cầu kết bạn đến một người dùng
   *
   * @param {string|number} userId ID người dùng để gửi yêu cầu kết bạn
   * @param {string} msg Tin nhắn yêu cầu kết bạn
   * @param {string} [language="vi"] Ngôn ngữ phản hồi hoặc giao diện Zalo
   * @throws {ZaloApiError}
   */
  return async function sendFriendRequest(userId, msg, language = "vi") {
		if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
			throw new ZaloApiError("Missing required app context fields");
    if (!userId) throw new ZaloApiError("Missing userId");
    if (!msg) throw new ZaloApiError("Missing friend request message");

    const params = {
      toid: userId.toString(),
      msg: msg,
      reqsrc: 30,
      imei: appContext.imei,
      language: language,
      srcParams: JSON.stringify({
        uidTo: userId.toString()
      })
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
