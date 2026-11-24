import test from "node:test";
import assert from "node:assert/strict";
import { wrapWithLimiter, getTransportLimiterFor } from "../src/api-zalo/transport-limiter.js";

test("outbound lanes isolate sendMessage from uploadAttachment queue saturation", async () => {
  const api = {
    sendMessage: async (msg) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, msg };
    },
    uploadAttachment: async (files) => {
      await new Promise((r) => setTimeout(r, 100)); // Heavy upload
      return { ok: true, files };
    },
    addReaction: async (react) => {
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, react };
    },
  };

  wrapWithLimiter(api, {
    heavy: { maxConcurrent: 1, minTime: 50 },
    "fast-text": { maxConcurrent: 8, minTime: 0 },
    control: { maxConcurrent: 8, minTime: 0 },
  });

  // 1. Saturated heavy uploads (2 uploads queued)
  const upload1 = api.uploadAttachment(["file1"]);
  const upload2 = api.uploadAttachment(["file2"]);

  // 2. While uploads are in flight, send 5 text messages
  const startSend = Date.now();
  const sendPromises = [
    api.sendMessage("text1"),
    api.sendMessage("text2"),
    api.sendMessage("text3"),
    api.sendMessage("text4"),
    api.sendMessage("text5"),
  ];

  const sendResults = await Promise.all(sendPromises);
  const sendDuration = Date.now() - startSend;

  assert.equal(sendResults.length, 5);
  // Send messages should complete well before heavy uploads finish!
  assert.ok(sendDuration < 80, `Send duration was ${sendDuration}ms, should be < 80ms`);

  const [u1, u2] = await Promise.all([upload1, upload2]);
  assert.equal(u1.ok, true);
  assert.equal(u2.ok, true);
});
