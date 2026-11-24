import test from "node:test";
import assert from "node:assert/strict";
import { wrapWithLimiter, isDeliveryRejection } from "../src/api-zalo/transport-limiter.js";

test("reactions and undo messages are not blocked behind broadcast jobs", async () => {
  const api = {
    sendMessageForward: async (item) => {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true, item };
    },
    addReaction: async (react) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, react };
    },
    undoMessage: async (undo) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, undo };
    },
  };

  wrapWithLimiter(api, {
    broadcast: { maxConcurrent: 1, minTime: 50 },
    control: { maxConcurrent: 8, minTime: 0 },
  });

  // Start 3 broadcast jobs
  const b1 = api.sendMessageForward("msg1");
  const b2 = api.sendMessageForward("msg2");
  const b3 = api.sendMessageForward("msg3");

  // Immediately dispatch reactions and undos
  const startControl = Date.now();
  const c1 = await api.addReaction("like");
  const c2 = await api.undoMessage("undo1");
  const controlDuration = Date.now() - startControl;

  assert.equal(c1.ok, true);
  assert.equal(c2.ok, true);
  // Control actions should resolve in ~10-20ms, way before 3 * 80ms broadcast queue finishes
  assert.ok(controlDuration < 60, `Control duration was ${controlDuration}ms, should be < 60ms`);

  await Promise.all([b1, b2, b3]);
});

test("delivery rejections are detected and flagged on error", () => {
  const paramError = new Error("Tham số không hợp lệ");
  paramError.name = "ZaloApiError";
  assert.equal(isDeliveryRejection(paramError), true);

  const netError = new Error("ECONNRESET");
  assert.equal(isDeliveryRejection(netError), false);
});
