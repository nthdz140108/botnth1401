import { API_TYPE, API_VERSION } from "../constants.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { makeURL, encodeAES, request, handleZaloResponse } from "../utils.js";

export function getSettingsFactory(api) {
  const profileService = api?.zpwServiceMap?.profile?.[0];
  if (!profileService) {
    throw new ZaloApiError("Missing profile endpoint (zpwServiceMap.profile[0])");
  }

  const serviceURL = makeURL(`${profileService}/api/setting/me`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  return async function getSettings() {
    if (!appContext.secretKey || !appContext.imei) {
      throw new ZaloApiError("Missing required app context fields");
    }

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify({ imei: appContext.imei }));
    if (!encryptedParams) {
      throw new ZaloApiError("Failed to encrypt params");
    }

    const finalServiceUrl = new URL(serviceURL);
    finalServiceUrl.searchParams.append("params", encryptedParams);

    const response = await request(finalServiceUrl.toString(), {
      method: "GET",
    });

    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
    return result.data;
  };
}
