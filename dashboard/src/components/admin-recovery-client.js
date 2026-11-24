export const ADMIN_RECOVERY_POLL_INTERVAL_MS = 2000;

const TERMINAL_STATES = new Set(["expired", "failed", "cancelled", "success"]);
const ACTIVE_STATES = new Set(["starting", "waiting_scan", "waiting_confirm"]);

function unwrapRecoveryPayload(body) {
  if (!body || typeof body !== "object") return null;
  if (body.data && typeof body.data === "object" && (body.success === true || body.success === undefined)) {
    return body.data;
  }
  return body;
}

export function isTerminalRecoveryState(state) {
  return TERMINAL_STATES.has(state);
}

export function isActiveRecoveryState(state) {
  return ACTIVE_STATES.has(state);
}

export function createAdminRecoveryPoller({ request, intervalMs = ADMIN_RECOVERY_POLL_INTERVAL_MS, onChange } = {}) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  if (typeof onChange !== "function") throw new TypeError("onChange must be a function");

  let timer = null;
  let polling = false;
  let inFlight = false;
  let lastNotified = null;

  async function poll() {
    if (inFlight) return;
    inFlight = true;
    try {
      const payload = unwrapRecoveryPayload(await request("/api/system/admin-recovery"));
      if (!payload || typeof payload !== "object") return;
      const state = payload.state;
      const key = payload.sessionId && (isActiveRecoveryState(state) || isTerminalRecoveryState(state))
        ? `${state}:${payload.sessionId}`
        : `state:${state}`;
      if (key === lastNotified) return;
      lastNotified = key;
      onChange(payload);
    } catch {
      // Transient failures (network, 401 during logout) keep polling silently.
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (polling) return;
      polling = true;
      poll();
      timer = setInterval(() => {
        poll();
      }, intervalMs);
      if (typeof timer === "object" && timer && typeof timer.unref === "function") timer.unref();
    },
    stop() {
      polling = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    isPolling() {
      return polling;
    },
  };
}
