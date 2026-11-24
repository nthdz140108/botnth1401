import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";
import { Zalo } from "../zalo.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function getStickersFactory(api) {
    if (!api?.zpwServiceMap?.sticker) throw new ZaloApiError("Missing sticker endpoint (zpwServiceMap.sticker)");
    if (!api.zpwServiceMap) {
        throw new ZaloApiError("Chưa đăng nhập hoặc phiên đăng nhập đã hết hạn");
    }
    const stickerEndpoint = Array.isArray(api.zpwServiceMap.sticker)
      ? api.zpwServiceMap.sticker[0]
      : api.zpwServiceMap.sticker;
    const serviceURL = makeURL(`${stickerEndpoint}/api/message/sticker`, {
        zpw_ver: API_VERSION,
        zpw_type: API_TYPE,
    });
    /**
     * Get stickers by keyword
     *
     * @param keyword Keyword to search for
     * @returns Sticker IDs
     *
     * @throws ZaloApiError
     */
    return async function getStickers(keyword) {
        if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
          throw new ZaloApiError("Missing required app context fields");
        if (!keyword) throw new ZaloApiError("Missing keyword");
        const params = {
            keyword: keyword,
            gif: 1,
            guggy: 0,
            imei: appContext.imei,
        };
        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams)
            throw new ZaloApiError("Failed to encrypt message");
        const finalServiceUrl = new URL(serviceURL);
        finalServiceUrl.pathname = finalServiceUrl.pathname + "/suggest/stickers";
        const response = await request(makeURL(finalServiceUrl.toString(), {
            params: encryptedParams,
        }));
        const result = await handleZaloResponse(response);
        if (result.error)
            throw new ZaloApiError(result.error.message, result.error.code);
        const suggestions = result.data;
        const stickerIds = [];
        // @TODO: Implement these
        // suggestions.sugg_guggy, suggestions.sugg_gif
        if (suggestions.sugg_sticker)
            suggestions.sugg_sticker.forEach((sticker) => stickerIds.push(sticker.sticker_id));
        return stickerIds;
    };
}
