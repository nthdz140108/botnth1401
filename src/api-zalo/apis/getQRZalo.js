import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function getQRLinkFactory(api) {
  if (!api?.zpwServiceMap?.friend?.[0]) throw new ZaloApiError("Missing friend endpoint (zpwServiceMap.friend[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/mget-qr`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Lấy Link QR của người dùng
   *
   * @param {string|number} userId ID người dùng của danh thiếp
   */
  return async function getQRLink(userId) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    if (!userId) throw new ZaloApiError("User ID is not available");

    const params = {
      fids: [userId.toString()],
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
