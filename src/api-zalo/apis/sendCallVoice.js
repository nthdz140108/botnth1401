import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { appContext } from "../context.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export function buildCallVoiceRequests(api, targetId) {
  const voiceService = api?.zpwServiceMap?.voice_call?.[0];
  if (!voiceService) {
    throw new ZaloApiError("Missing voice_call endpoint (zpwServiceMap.voice_call[0])");
  }

  const requestCallURL = makeURL(`${voiceService}/api/voicecall/requestcall`, {
    zpw_ver: API_VERSION,
    zpw_type: 24,
  });
  const requestConfirmURL = makeURL(`${voiceService}/api/voicecall/request`, {
    zpw_ver: API_VERSION,
    zpw_type: 24,
  });

  const callId = Math.floor(Date.now() / 1000);
  const requestCallParams = {
    calleeId: targetId,
    callId,
    codec: "[]\n",
    typeRequest: 1,
    imei: appContext.imei,
  };
  const confirmParams = {
    calleeId: targetId,
    codec: JSON.stringify([
      {
        dynamicFptime: 0,
        frmPtime: 20,
        name: "opus/16000/1",
        payload: 112,
      },
    ]),
    callId,
    imei: appContext.imei,
    subCommand: 3,
  };

  return {
    callId,
    requestCallURL,
    requestConfirmURL,
    requestCallParams,
    confirmParams,
  };
}

export function sendCallVoiceFactory(api) {
  return async function sendCallVoice(targetId) {
    if (!appContext.imei || !appContext.secretKey) {
      throw new ZaloApiError("Missing required app context fields");
    }

    const {
      requestCallURL,
      requestConfirmURL,
      requestCallParams,
      confirmParams,
    } = buildCallVoiceRequests(api, targetId);

    const encryptedParams1 = encodeAES(appContext.secretKey, JSON.stringify(requestCallParams));
    if (!encryptedParams1) throw new ZaloApiError("Failed to encrypt params");

    const response1 = await request(requestCallURL, {
      method: "POST",
      body: new URLSearchParams({ params: encryptedParams1 }),
    });
    const result1 = await handleZaloResponse(response1, appContext);
    if (result1.error) throw new ZaloApiError(result1.error.message, result1.error.code);

    const encryptedParams2 = encodeAES(appContext.secretKey, JSON.stringify({
      ...confirmParams,
      rtcpAddress: result1.data.rtcpIP,
      rtpAddress: result1.data.rtpIP,
      session: result1.data.sessId,
    }));
    if (!encryptedParams2) throw new ZaloApiError("Failed to encrypt call params");

    const response2 = await request(requestConfirmURL, {
      method: "POST",
      body: new URLSearchParams({ params: encryptedParams2 }),
    });
    const result2 = await handleZaloResponse(response2, appContext);
    if (result2.error) throw new ZaloApiError(result2.error.message, result2.error.code);

    return result2.data;
  };
}
