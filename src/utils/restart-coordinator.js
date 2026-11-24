const IDLE_PHASE = "idle";

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function createRestartCoordinator({
  stop,
  start,
  delayMs = 0,
  onStateChange = () => {},
} = {}) {
  if (typeof stop !== "function") throw new TypeError("stop must be a function");
  if (typeof start !== "function") throw new TypeError("start must be a function");

  let inFlight = null;
  let state = {
    phase: IDLE_PHASE,
    reason: null,
    context: null,
    generation: 0,
    inFlight: false,
  };

  function notify(nextState) {
    state = nextState;
    try {
      onStateChange({ ...state });
    } catch {
      // State reporting must not change restart behavior.
    }
  }

  function transition(phase, reason, context, generation) {
    notify({
      phase,
      reason,
      context,
      generation,
      inFlight: Boolean(inFlight),
    });
  }

  function resolveDelay(reason, context) {
    const value = typeof delayMs === "function" ? delayMs({ reason, context }) : delayMs;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function restart(reason = "manual", context = {}) {
    if (inFlight) return inFlight;

    const generation = state.generation + 1;
    let resolveRun;
    let rejectRun;
    const run = new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    inFlight = run;

    (async () => {
      try {
        transition("stopping", reason, context, generation);
        await stop(context);
        await wait(resolveDelay(reason, context));
        transition("starting", reason, context, generation);
        const result = await start(context);
        transition("running", reason, context, generation);
        resolveRun(result);
      } catch (error) {
        transition(IDLE_PHASE, reason, context, generation);
        rejectRun(error);
      } finally {
        if (inFlight === run) {
          inFlight = null;
          state = { ...state, inFlight: false };
        }
      }
    })();

    return run;
  }

  function getState() {
    return { ...state, inFlight: Boolean(inFlight) };
  }

  return { restart, getState };
}
