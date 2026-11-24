const TRANSITIONS = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["paused", "succeeded", "failed", "cancelled"]),
  paused: new Set(["running", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(["queued"]),
  cancelled: new Set(["queued"]),
};

export function createJobState(jobId, status = "queued", meta = {}) {
  if (!jobId) throw new TypeError("jobId is required");
  if (!TRANSITIONS[status]) throw new TypeError(`Unknown job status: ${status}`);
  return { jobId: String(jobId), status, progress: 0, updatedAt: new Date().toISOString(), ...meta };
}

export function transitionJob(state, nextStatus, patch = {}) {
  if (!state || !TRANSITIONS[state.status]) throw new TypeError("Invalid job state");
  if (!TRANSITIONS[state.status].has(nextStatus)) throw new Error(`Invalid job transition: ${state.status} -> ${nextStatus}`);
  const progress = nextStatus === "succeeded" ? 100 : nextStatus === "queued" ? 0 : patch.progress ?? state.progress;
  return { ...state, ...patch, status: nextStatus, progress, updatedAt: new Date().toISOString() };
}

export function isTerminalJob(state) {
  return ["succeeded", "failed", "cancelled"].includes(state?.status);
}
