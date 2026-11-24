import test from "node:test";
import assert from "node:assert/strict";

import { appContext } from "../src/api-zalo/context.js";
import { buildCallVoiceRequests } from "../src/api-zalo/apis/sendCallVoice.js";

test("buildCallVoiceRequests prepares the two-step call flow without mutating context", () => {
  const originalNow = Date.now;
  Date.now = () => 1710000000 * 1000;
  const originalImei = appContext.imei;
  appContext.imei = "imei-123";

  try {
    const payload = buildCallVoiceRequests({
      zpwServiceMap: {
        voice_call: ["https://voice.example.zalo.me"],
      },
    }, "user-456");

    assert.equal(payload.callId, 1710000000);
    const callUrl = new URL(payload.requestCallURL);
    const confirmUrl = new URL(payload.requestConfirmURL);
    assert.equal(callUrl.pathname, "/api/voicecall/requestcall");
    assert.equal(confirmUrl.pathname, "/api/voicecall/request");
    assert.equal(callUrl.searchParams.get("zpw_type"), "24");
    assert.equal(confirmUrl.searchParams.get("zpw_type"), "24");
    assert.equal(callUrl.searchParams.get("zpw_ver"), "671");
    assert.equal(confirmUrl.searchParams.get("zpw_ver"), "671");
    assert.deepEqual(payload.requestCallParams, {
      calleeId: "user-456",
      callId: 1710000000,
      codec: "[]\n",
      typeRequest: 1,
      imei: "imei-123",
    });
    assert.equal(payload.confirmParams.session, undefined);
    assert.equal(payload.confirmParams.rtcpAddress, undefined);
    assert.equal(payload.confirmParams.rtpAddress, undefined);
    assert.equal(payload.confirmParams.subCommand, 3);
  } finally {
    Date.now = originalNow;
    appContext.imei = originalImei;
  }
});
