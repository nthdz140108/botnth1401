import { Zalo } from "../zalo.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function removeGroupAdminsFactory(api) {
  if (!api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing group endpoint (zpwServiceMap.group[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.group[0]}/api/group/admins/remove`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Xóa quản trị viên khỏi nhóm (white key) theo ID.
   *
   * Client phải là chủ sở hữu của nhóm.
   *
   * @param {string|string[]} members - Một hoặc nhiều ID quản trị viên cần xóa
   * @param {string|number} groupId - ID của nhóm cần xóa quản trị viên
   * @throws {ZaloApiError}
   */
  return async function removeGroupAdmins(groupId, members) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    if (!groupId) throw new ZaloApiError("Missing groupId");
    if (!members) throw new ZaloApiError("Missing members");

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
