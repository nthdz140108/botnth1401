import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, request, handleZaloResponse } from "../utils.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export const rejectFriendRequestFactory = (api) => {
    if (!api?.zpwServiceMap?.friend?.[0]) {
        throw new ZaloApiError("Missing friend endpoint (zpwServiceMap.friend[0])");
    }
    return async function rejectFriendRequest(friendId) {
        if (!appContext.secretKey) {
            throw new ZaloApiError("Missing required app context fields");
        }
        if (!friendId) {
            throw new ZaloApiError("Missing friendId");
        }

        const serviceURL = api.zpwServiceMap.friend[0].replace("https//", "https://") + "/api/friend/reject";
        const url = new URL(serviceURL);
        url.searchParams.set("zpw_ver", API_VERSION);
        url.searchParams.set("zpw_type", API_TYPE);

        const params = {
            fid: friendId,
        };

        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams) throw new ZaloApiError("Không thể mã hóa params");

        const response = await request(url.toString(), {
            method: "POST",
            body: new URLSearchParams({
                params: encryptedParams,
            }),
        });

        const result = await handleZaloResponse(response);
        if (result?.error) {
            throw new ZaloApiError(result.error.message, result.error.code);
        }
        return result?.data ?? result;
    };
};
