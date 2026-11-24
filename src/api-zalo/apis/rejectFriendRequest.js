import { encodeAES, request, handleZaloResponse } from "../utils.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export const rejectFriendRequestFactory = (api) => {
    return async function rejectFriendRequest(friendId) {
        let serviceURL = api.zpwServiceMap.friend[0].replace("https//", "https://") + "/api/friend/reject";
        const url = new URL(serviceURL);
        url.searchParams.set('zpw_ver', API_VERSION);
        url.searchParams.set('zpw_type', API_TYPE);

        const params = {
            fid: friendId,
        };

        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams) throw new Error("DQT_Error: Không thể mã hóa params");

        const response = await request(url.toString(), {
            method: "POST",
            body: new URLSearchParams({
                params: encryptedParams,
            }),
        });

        return handleZaloResponse(response);
    };
};
