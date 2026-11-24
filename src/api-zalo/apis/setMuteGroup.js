import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";
import { API_TYPE, API_VERSION } from "../constants.js";

// Đổi tên Factory
export function setMuteGroupFactory(api) {
  const profileService = api?.zpwServiceMap?.profile?.[0];
  if (!profileService) {
    throw new ZaloApiError("Missing profile endpoint (zpwServiceMap.profile[0])");
  }
  const serviceURL = makeURL(`${profileService}/api/social/profile/setmute`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
  });

  /**
   * Bật hoặc tắt thông báo cho một nhóm chat.
   *
   * @param {string|number} groupId - ID của nhóm cần bật/tắt thông báo
   * @param {boolean} isMuted - `true` để tắt thông báo (mute), `false` để bật lại (unmute).
   * @throws {ZaloApiError}
   */
  // Đổi tên hàm và tham số
  return async function setMuteGroup(groupId, isMuted = true) {
    if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
    if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
    if (!appContext.cookie) throw new ZaloApiError("Cookie is not available");
    if (!appContext.userAgent) throw new ZaloApiError("User agent is not available");

    if (!groupId) throw new ZaloApiError("Missing groupId");

    const params = {
      // --- SỬA LỖI Ở ĐÂY ---
      // Tham số chính xác cho nhóm phải là "grid"
      grid: String(groupId),
      // --- KẾT THÚC SỬA LỖI ---
      mute: isMuted ? 1 : 0, // 1 = mute, 0 = unmute
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
