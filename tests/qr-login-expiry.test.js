import test from "node:test";
import assert from "node:assert/strict";
import {
  QR_LOGIN_EXPIRY_REASON,
  QR_LOGIN_TIMEOUT_MS,
  isQrLoginExpiredResponse,
  isQrLoginExpiredSignal,
} from "../src/utils/qr-login-expiry.js";
import { waitingConfirm, waitingScan } from "../src/commands/mybot/Credentials/qr-login.js";

test("uses the dashboard QR login timeout as the shared default", () => {
  assert.equal(QR_LOGIN_TIMEOUT_MS, 90000);
});

test("detects an explicit expired QR response", () => {
  assert.equal(isQrLoginExpiredResponse({ error_message: "QR code expired" }), true);
  assert.equal(isQrLoginExpiredResponse({ error_message: "invalid credentials" }), false);
});

test("recognizes the QR expiry abort reason", () => {
  const controller = new AbortController();
  controller.abort(QR_LOGIN_EXPIRY_REASON);

  assert.equal(isQrLoginExpiredSignal(controller.signal), true);
  assert.equal(isQrLoginExpiredSignal(new AbortController().signal), false);
});

test("command QR polling reports expiry instead of cancellation", async () => {
  const controller = new AbortController();
  controller.abort(QR_LOGIN_EXPIRY_REASON);
  let expired = false;
  const session = { fetchWithCookies: async () => { throw new Error("request should not run"); } };

  assert.equal(
    await waitingScan("code", session, controller.signal, { onExpired: () => { expired = true; } }),
    false,
  );
  assert.equal(expired, true);

  const confirmation = await waitingConfirm("code", session, { signal: controller.signal });
  assert.equal(confirmation[0], null);
  assert.equal(confirmation[1], null);
  assert.equal(confirmation[2].expired, true);
});
