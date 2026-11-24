import { encodeAES, request, handleZaloResponse } from "../utils.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export const updateSettingsFactory = (api) => {
  const profileService = api?.zpwServiceMap?.profile?.[0];
  if (!profileService) {
    throw new Error("Missing profile endpoint (zpwServiceMap.profile[0])");
  }

  const serviceURL = new URL(`${profileService}/api/setting/update`);
  serviceURL.searchParams.set("zpw_ver", API_VERSION);
  serviceURL.searchParams.set("zpw_type", API_TYPE);

  return async function updateSettings(type, value) {
    const params = {
      [type]: value,
    };

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new Error("DQT_Error: Khong the ma hoa params");

    const finalURL = new URL(serviceURL);
    finalURL.searchParams.set("params", encryptedParams);

    const response = await request(finalURL.toString(), {
      method: "GET",
    });

    return handleZaloResponse(response);
  };
};
