import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { handleZaloResponse, request, makeURL } from "../utils.js";

export function getAllGroupsFactory(api) {
  if (!api?.zpwServiceMap?.group?.[0])
    throw new ZaloApiError("Missing group endpoint (zpwServiceMap.group[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.group[0]}/api/group/getlg/v4`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Lấy danh sách tất cả các nhóm
   *
   * @throws ZaloApiError
   */
  return async function getAllGroups() {
    if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
    if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
    if (!appContext.cookie) throw new ZaloApiError("Cookie is not available");
    if (!appContext.userAgent) throw new ZaloApiError("User agent is not available");

    const response = await request(serviceURL, {
      method: "GET",
    });

    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code);

    return result.data;
  };
}
