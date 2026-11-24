import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";

export function getGroupInfoV2Factory(api) {
  if (!api?.zpwServiceMap?.group?.[0]) throw new ZaloApiError("Missing group endpoint");
  const endpoint = `${api.zpwServiceMap.group[0]}/api/group/getgi/v2`;
  return async function getGroupInfoV2(groupId, options = {}) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent) {
      throw new ZaloApiError("Missing required app context fields");
    }
    if (!groupId || Array.isArray(groupId)) throw new ZaloApiError("Missing group ID");
    const id = String(groupId);
    const mpage = typeof options === "number" ? options : options.mpage ?? 1;
    const mcount = typeof options === "number" ? 100 : options.mcount ?? 100;
    if (!Number.isSafeInteger(mpage) || mpage < 1) throw new ZaloApiError("Invalid member page (mpage)");
    if (!Number.isSafeInteger(mcount) || mcount < 1 || mcount > 100) throw new ZaloApiError("Invalid member count (mcount)");
    const params = { grid: id, avatar_size: 120, member_avatar_size: 120, mpage, mcount };
    const encrypted = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encrypted) throw new ZaloApiError("Failed to encrypt group parameters");
    const response = await request(makeURL(endpoint, { zpw_type: API_TYPE, zpw_ver: API_VERSION, params: encrypted }), { timeout: 10000, retry: 0 });
    // Some endpoints report errors in the unencrypted outer envelope.
    const outer = await response.clone().json().catch(() => null);
    if (outer?.error_code && Number(outer.error_code) !== 0) {
      throw new ZaloApiError(outer.error_message || "Group request failed", outer.error_code, response.status);
    }
    const result = await handleZaloResponse(response);
    if (result.error) throw new ZaloApiError(result.error.message, result.error.code, result.error.status);
    const info = result.data?.gridInfoMap?.[id] || result.data?.groupInfo || result.data;
    if (!info || typeof info !== "object" || String(info.groupId) !== id) {
      throw new ZaloApiError("Invalid group response", "INVALID_GROUP_RESPONSE");
    }
    return info;
  };
}
