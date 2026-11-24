import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export function getUserInfoFactory(api) {
  if (!api?.zpwServiceMap?.profile?.[0])
    throw new ZaloApiError("Missing profile endpoint (zpwServiceMap.profile[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.profile[0]}/api/social/friend/getprofiles/v2`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Lấy thông tin người dùng Zalo
   *
   * @param userId ID người dùng Zalo hoặc mảng các ID
   * 
   * @throws ZaloApiError
   */
  return async function getUserInfo(userId) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    if (!userId) throw new ZaloApiError("Missing userId");

    const params = {
      phonebook_version: Math.floor(Date.now() / 1000),
      friend_pversion_map: [],
      avatar_size: 120,
      language: "vi",
      show_online_status: 1,
      imei: appContext.imei
    };

    if (Array.isArray(userId)) {
      params.friend_pversion_map = userId.map(id => `${id}_0`);
    } else {
      params.friend_pversion_map.push(`${userId}_0`);
    }

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams)
      throw new ZaloApiError("Failed to encrypt params");

    const finalServiceUrl = new URL(serviceURL);
    finalServiceUrl.searchParams.append("params", encryptedParams);
    const response = await request(makeURL(finalServiceUrl.toString(), {
      params: encryptedParams,
    }));
    const result = await handleZaloResponse(response);
    if (result.error && result.error.code != 216)
      throw new ZaloApiError(result.error.message, result.error.code);
    if (!result.data)
      throw new ZaloApiError("Empty user info data");
    return result.data;
  };
}
