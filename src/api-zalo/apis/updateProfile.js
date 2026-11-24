import { encodeAES, request, handleZaloResponse } from "../utils.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export const updateProfileFactory = (api) => {
  return async function updateProfile(payload) {
    const profile = payload?.profile ?? payload ?? {};
    const biz = payload?.biz ?? {};

    const profileService = api?.zpwServiceMap?.profile?.[0];
    if (!profileService) {
      throw new Error("Missing profile endpoint (zpwServiceMap.profile[0])");
    }

    const serviceURL = new URL(`${profileService}/api/social/profile/update`);
    serviceURL.searchParams.set("zpw_ver", API_VERSION);
    serviceURL.searchParams.set("zpw_type", API_TYPE);

    const params = {
      profile: JSON.stringify({
        name: profile.name,
        dob: profile.dob,
        gender: profile.gender,
      }),
      biz: JSON.stringify({
        desc: biz.description,
        cate: biz.cate,
        addr: biz.address,
        website: biz.website,
        email: biz.email,
      }),
      language: appContext.language,
    };

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new Error("DQT_Error: Khong the ma hoa params");

    const response = await request(serviceURL.toString(), {
      method: "POST",
      body: new URLSearchParams({
        params: encryptedParams,
      }),
    });

    return handleZaloResponse(response);
  };
};
