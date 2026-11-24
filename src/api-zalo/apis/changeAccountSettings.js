import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function changeAccountSettingFactory(api) {
  const profileService = api?.zpwServiceMap?.profile?.[0];
  if (!profileService) {
    throw new ZaloApiError("Missing profile endpoint (zpwServiceMap.profile[0])");
  }
  const serviceURL = makeURL(`${profileService}/api/social/profile/update`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Change account information
   *
   * @param {string} name - New account name
   * @param {string} dob - Date of birth (yyyy-mm-dd)
   * @param {number|string} gender - 0 = Male, 1 = Female
   * @param {object} biz - Optional business info
   * @param {string} language - Language (default: "vi")
   */
  return async function changeAccountSetting(name, dob, gender, biz = {}, language = "vi") {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent) {
      throw new ZaloApiError("Missing required app context fields");
    }

    if (!name || !dob || gender === undefined) {
      throw new ZaloApiError("Missing required parameters: name, dob, or gender");
    }

    const rawPayload = {
      profile: JSON.stringify({ name, dob, gender: parseInt(gender) }),
      biz: JSON.stringify(biz),
      language,
    };

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(rawPayload));
    if (!encryptedParams) {
      throw new ZaloApiError("Failed to encrypt params");
    }

    const response = await request(serviceURL, {
      method: "POST",
      body: new URLSearchParams({ params: encryptedParams }),
    });

    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
    return result.data;
  };
}
