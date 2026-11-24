import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { encodeAES, handleZaloResponse, makeURL, request, getImageMetaData } from "../utils.js";

export function changeAccountAvatarFactory(api) {
    const serviceURL = makeURL(
        `${api.zpwServiceMap.profile[0]}/api/social/profile/setavatar`,
        {
            zpw_ver: API_VERSION,
            zpw_type: API_TYPE,
        }
    );

    return async function changeAccountAvatar(avatarPath) {
        if (
            !appContext.secretKey ||
            !appContext.imei ||
            !appContext.cookie ||
            !appContext.userAgent
        ) {
            throw new ZaloApiError("Missing required app context fields");
        }

        const filePath = String(avatarPath);
        if (!filePath) throw new ZaloApiError("Missing avatarPath");

        const { metadata, fileBuffer } = await getImageMetaData(filePath);

        await request(metadata.uploadUrl, {
            method: "POST",
            body: fileBuffer,
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Upload-Mode": 1,
            },
        });

        const params = {
            attachId: metadata.fileId,
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
        if (result.error) {
            throw new ZaloApiError(result.error.message, result.error.code);
        }

        return result.data;
    };
}
