import test from "node:test";
import assert from "node:assert/strict";

test("sanity: qr limiter module loads", async () => {
  const mod = await import("../src/runtime/qr-recovery-limiter.js");
  assert.equal(typeof mod.runQrRecoveryWithLimit, "function");
});
