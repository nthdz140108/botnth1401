import assert from "node:assert/strict";
import test from "node:test";
import { awaitBotOperation, createRequestFence, isQrTerminal } from "../dashboard/src/v4/operation-state.js";

test("accepted HTTP responses wait for server operation readiness", async () => {
  const phases = [];
  let reads = 0;
  const result = await awaitBotOperation({ botId: "bot_1", action: "start", response: { operationId: "op1", phase: "connecting" },
    fetchOperation: async () => ({ operation: { operationId: "op1", botId: "bot_1", phase: ++reads === 1 ? "connecting" : "ws_ready", status: "running" } }),
    pause: async () => {}, onProgress: (op) => phases.push(op.phase) });
  assert.equal(reads, 2);
  assert.equal(result.phase, "ws_ready");
  assert.deepEqual(phases, ["connecting", "ws_ready"]);
});

test("operation failures and missing proof never become ws_ready", async () => {
  await assert.rejects(awaitBotOperation({ botId: "b", action: "start", response: { applied: true } }), /OPERATION_UNCONFIRMED/);
  await assert.rejects(awaitBotOperation({ botId: "b", action: "start", response: { operationId: "op" }, fetchOperation: async () => ({ operation: { phase: "error", error: { code: "LOGIN_FAILED", message: "Login failed" } } }) }), /Login failed/);
});

test("cancelled QR requests reject late results and every terminal state stops polling", () => {
  const fence = createRequestFence();
  const first = fence.capture();
  assert.equal(fence.isCurrent(first), true);
  fence.invalidate();
  assert.equal(fence.isCurrent(first), false);
  for (const state of ["configured", "failed", "cancelled", "expired", "completed", "success"]) assert.equal(isQrTerminal(state), true);
  assert.equal(isQrTerminal("verifying"), false);
});
