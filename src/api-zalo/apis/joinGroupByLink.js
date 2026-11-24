import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function joinGroupByLinkFactory(api) {
  if (!api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing group endpoint (zpwServiceMap.group[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.group[0]}/api/group/link/join`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Tham gia nhóm thông qua link
   * 
   * @param {string} link - Link tham gia nhóm (dạng https://zalo.me/g/xxxxxx)
   * @throws {ZaloApiError}
   */
  return async function joinGroupByLink(link) {
		if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
			throw new ZaloApiError("Missing required app context fields");
    if (!link) throw new ZaloApiError("Link is not available");

    const params = {
      link: link,
      clientLang: appContext.language || "vi"
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