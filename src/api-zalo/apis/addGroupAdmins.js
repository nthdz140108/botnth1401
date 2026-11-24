import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function addGroupAdminsFactory(api) {
  if (!api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing group endpoint (zpwServiceMap.group[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.group[0]}/api/group/admins/add`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Thêm quản trị viên vào nhóm (white key).
   *
   * Client phải là chủ sở hữu của nhóm.
   *
   * @param {string|string[]} members - Một hoặc nhiều ID thành viên cần thêm làm quản trị viên
   * @param {string|number} groupId - ID của nhóm cần thêm quản trị viên
   * @throws {ZaloApiError}
   */
  return async function addGroupAdmins(groupId, members) {
    if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
    if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
    if (!appContext.cookie) throw new ZaloApiError("Cookie is not available");
    if (!appContext.userAgent) throw new ZaloApiError("User agent is not available");

    members = Array.isArray(members) ? members.map(String) : [String(members)];

    const params = {
      grid: String(groupId),
      members: members,
      imei: appContext.imei,
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
