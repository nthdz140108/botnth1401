import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { Zalo } from "../zalo.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function handleGroupPendingMembersFactory(api) {
  if (!api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing group endpoint (zpwServiceMap.group[0])");
  const serviceURL = makeURL(`${api.zpwServiceMap.group[0]}/api/group/pending-mems/review`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Xử lý yêu cầu tham gia nhóm
   *
   * @param {string|number} threadId - ID của nhóm
   * @param {string[]} members - Danh sách ID của các thành viên cần xử lý
   * @param {boolean} [isApprove=true] - Chấp nhận hoặc từ chối yêu cầu
   * @throws {ZaloApiError}
   */
  return async function handleGroupPendingMembers(threadId, isApprove = true) {
		if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
			throw new ZaloApiError("Missing required app context fields");
    if (!threadId) throw new ZaloApiError("Missing threadId");
    const members = await api.getGroupPendingMembers(threadId);
    if (!members || !members.users) return;
    const listMembers = members.users.map(user => user.uid);

    const params = {
      grid: String(threadId),
      members: listMembers,
      isApprove: isApprove ? 1 : 0
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
