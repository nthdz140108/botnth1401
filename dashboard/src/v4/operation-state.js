const QR_TERMINAL = new Set(["configured", "failed", "cancelled", "expired", "completed", "success"]);

export function isQrTerminal(state) { return QR_TERMINAL.has(String(state || "").toLowerCase()); }

export function createRequestFence() {
  let generation = 0;
  return { capture: () => generation, invalidate: () => ++generation, isCurrent: (token) => token === generation };
}

export async function awaitBotOperation({ botId, action, response, fetchOperation, onProgress = () => {}, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 90_000 }) {
  const operationId = response?.operationId || response?.result?.operationId;
  let operation = response?.operation || response?.result || response;
  const deadline = Date.now() + timeoutMs;
  const terminal = (op) => {
    if (["error", "failed", "cancelled"].includes(op?.phase) || ["error", "failed", "cancelled"].includes(op?.status)) {
      const error = new Error(op.error?.message || op.message || "Operation failed");
      error.code = op.error?.code || op.code || "OPERATION_FAILED";
      error.stage = op.phase;
      throw error;
    }
    const phase = op?.phase;
    if (["stop", "shutdown", "delete", "disable", "reject"].includes(action)) return ["stopped", "deleted", "disabled", "rejected", "completed"].includes(phase);
    if (["standby", "hot_standby"].includes(action)) return phase === "standby";
    if (["start", "restart", "resume", "active"].includes(action)) return phase === "ws_ready";
    return phase === "completed";
  };
  if (terminal(operation)) return operation;
  if (!operationId || !fetchOperation) throw new Error("OPERATION_UNCONFIRMED: Máy chủ chưa xác nhận kết quả thực tế.");
  while (Date.now() < deadline) {
    const payload = await fetchOperation(`/api/bots/${encodeURIComponent(botId)}/operations/${encodeURIComponent(operationId)}`);
    operation = payload?.operation || payload;
    if (operation?.botId && operation.botId !== botId) throw new Error("OPERATION_TARGET_MISMATCH");
    onProgress({ ...operation, operationId });
    if (terminal(operation)) return operation;
    await pause(1000);
  }
  const error = new Error("OPERATION_TIMEOUT: Chưa xác nhận trạng thái cuối; hãy xem tiến trình và nhật ký.");
  error.code = "OPERATION_TIMEOUT";
  throw error;
}
