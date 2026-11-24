import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";

export function getGroupInfoFactory(api) {
    if (!api?.zpwServiceMap?.group?.[0])
        throw new ZaloApiError("Missing group endpoint (zpwServiceMap.group[0])");
    const serviceURL = makeURL(`${api.zpwServiceMap.group[0]}/api/group/getmg-v2`, {
        zpw_ver: API_VERSION,
        zpw_type: API_TYPE,
    });
    /**
     * Get group information
     *
     * @param groupId Group ID or list of group IDs
     *
     * @throws ZaloApiError
     */
    return async function getGroupInfo(groupId) {
        if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
            throw new ZaloApiError("Missing required app context fields");
        if (!groupId) throw new ZaloApiError("Missing groupId");
        if (!Array.isArray(groupId)) groupId = [groupId];

        let params = {
            gridVerMap: {},
        };
        for (const id of groupId) {
            params.gridVerMap[id] = 0;
        }
        params.gridVerMap = JSON.stringify(params.gridVerMap);
        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams)
            throw new ZaloApiError("Failed to encrypt message");
        const response = await request(serviceURL, {
            method: "POST",
            body: new URLSearchParams({
                params: encryptedParams,
            }),
        });
        const result = await handleZaloResponse(response);
        if (result.error)
            throw new ZaloApiError(result.error.message, result.error.code, result.error.status);
        return result.data;
    };
}
