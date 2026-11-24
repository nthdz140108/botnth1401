import { API_TYPE, API_VERSION } from "../constants.js";
import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export function buildGetAllFriendsParams(
  imei,
  count = 20000,
  page = 1,
  avatarSize = 120
) {
  return {
    incInvalid: 1,
    page,
    count,
    avatar_size: avatarSize,
    actiontime: 0,
    imei,
  };
}

export function getAllFriendsFactory(api) {
  if (!api?.zpwServiceMap?.profile?.[0]) {
    throw new ZaloApiError("Missing profile endpoint (zpwServiceMap.profile[0])");
  }
  const serviceURL = makeURL(
    `${api.zpwServiceMap.profile[0]}/api/social/friend/getfriends`,
    {
      zpw_ver: API_VERSION,
      zpw_type: API_TYPE,
    }
  );

  return async function getAllFriends(count = 20000, page = 1, avatarSize = 120) {
    if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
    if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
    if (!appContext.cookie) throw new ZaloApiError("Cookie is not available");
    if (!appContext.userAgent) throw new ZaloApiError("User agent is not available");

    const params = buildGetAllFriendsParams(
      appContext.imei,
      count,
      page,
      avatarSize
    );
    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt params");

    const response = await request(makeURL(serviceURL, { params: encryptedParams }), {
      method: "GET",
    });
    const result = await handleZaloResponse(response);
    if (result.error) {
      throw new ZaloApiError(
        result.error.message,
        result.error.code,
        result.error.status
      );
    }

    return result.data;
  };
}
