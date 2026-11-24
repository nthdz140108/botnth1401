import { encodeAES, request, handleZaloResponse } from "../utils.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export const getPollDetailFactory = (api) => {
    return async function getPollDetail(pollId) {
        // Sửa lỗi URL
        let serviceURL = api.zpwServiceMap.group[0].replace("https//", "https://") + "/api/poll/detail";

        // === THÊM zpw_type VÀ zpw_ver ===
        const url = new URL(serviceURL);
        url.searchParams.set('zpw_ver', API_VERSION); // Lấy từ api constructor
        url.searchParams.set('zpw_type', API_TYPE);   // Lấy từ api constructor
        // === KẾT THÚC THÊM ===

        const imei = appContext.imei;
        if (!pollId) throw new Error("DQT_Error: Thiếu poll id");

        const params = {
            poll_id: pollId,
            imei: imei,
        };

        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams) throw new Error("DQT_Error: Không thể mã hóa params");

        const response = await request(url.toString(), { // Gửi tới URL đã sửa
            method: "POST",
            body: new URLSearchParams({
                params: encryptedParams,
            }),
        });

        return handleZaloResponse(response);
    };
};
