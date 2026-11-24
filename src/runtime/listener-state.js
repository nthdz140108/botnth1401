/**
 * Listener Runtime State — process-wide singleton bridge between the Zalo
 * WebSocket listener and the runtime web bridge (PM2 health surface).
 *
 * Purpose (port-closed fix):
 * - A transient Zalo listener failure must NEVER close the runtime web
 *   bridge. Under PM2, closing the bridge made the process look `online`
 *   while its port stayed closed (or, worse, health probes reported a dead
 *   socket as healthy). The bridge stays open; only the listener retries.
 * - Readiness must reflect the ability to RECEIVE messages:
 *   listenerState: starting | connected | retrying | stopped.
 * - Startup phase tracking (startupPid/startupPhase/startupStartedAt/
 *   startupLastError/startupUpdatedAt) lets /internal/runtime/identity
 *   report what the CURRENT process is doing without confusing it with
 *   lastReadyAt from an older PID.
 */

export const LISTENER_STATES = Object.freeze([
  "starting",
  "connected",
  "retrying",
  "stopped",
  "standby",
  "hot_standby",
]);

export const STARTUP_PHASES = Object.freeze([
  "login",
  "login-retry",
  "qr-recovery",
  "api-ready",
  "listener-retrying",
  "ready",
]);

export const LOGIN_DEADLINE_MS = 30_000;
export const QR_RECOVERY_LIMIT_MS = 120_000;

/**
 * Wrap a promise with a deadline. Rejects with an Error carrying `code`
 * "DEADLINE_EXCEEDED" when `ms` elapses before `promise` settles.
 */
export function withDeadline(promise, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    let settled = false;
    // NOTE: the timer is intentionally NOT unref'd — an unref'd deadline
    // never fires when nothing else keeps the event loop alive, which would
    // let a hung login hang the whole startup.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`${label} exceeded ${ms}ms`);
      error.code = "DEADLINE_EXCEEDED";
      reject(error);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Create a listener runtime state instance. One instance per process;
 * `getListenerRuntimeState()` below holds the singleton.
 */
export function createListenerRuntimeState({
  now = () => Date.now(),
  pid = process.pid,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWebBridgeClosureRequested = null,
} = {}) {
  let listenerConnected = false;
  let listenerState = "starting";
  let listenerLastError = null;
  let startupPid = pid;
  let startupPhase = "login";
  let startupStartedAt = now();
  let startupLastError = null;
  let startupUpdatedAt = now();
  // Connection generation: bumped every time we (re)establish a successful
  // listener connection (startup or reconnect). Guards against a STALE
  // `closed`/`error` event emitted by a previous socket overwriting the
  // `connected` state of a newer socket right after a successful reconnect.
  let connectionGeneration = 0;

  function snapshot() {
    return {
      listenerConnected,
      listenerState,
      listenerLastError,
      startupPid,
      startupPhase,
      startupStartedAt,
      startupLastError,
      startupUpdatedAt,
      connectionGeneration,
    };
  }

  function setStartupPhase(phase, error = null) {
    startupPhase = phase;
    startupUpdatedAt = now();
    if (error !== null) startupLastError = error;
  }

  function setStartupError(error) {
    startupLastError = error ? String(error) : null;
    startupUpdatedAt = now();
  }

  /**
   * Open a NEW socket connection generation. Called by the Listener right
   * before it creates a WebSocket so every socket is tagged with a fresh,
   * monotonically increasing generation. A late `closed`/`error` event from a
   * REPLACED socket carries an OLDER generation and is rejected by
   * markRetryingForGeneration(), so a stale socket can never overwrite the
   * healthy `connected` state of the current socket.
   */
  function beginConnection() {
    connectionGeneration += 1;
    return connectionGeneration;
  }

  function markConnected() {
    listenerConnected = true;
    listenerState = "connected";
    listenerLastError = null;
    if (startupPhase === "listener-retrying") {
      setStartupPhase("ready");
    }
    // NOTE: intentionally does NOT bump connectionGeneration. That is the
    // Listener's job at socket creation (beginConnection()), so the generation
    // always identifies WHICH socket emitted an event. This lets a stale
    // closed/error from an old socket be recognized and dropped.
  }

  function markConnectedForGeneration(generation) {
    if (generation != null && generation !== connectionGeneration) return false;
    markConnected();
    return true;
  }

  /**
   * Heal the listener state back to `connected` using live-event evidence.
   *
   * If the process receives a REAL Zalo event (message/group_event/undo/
   * reaction) AFTER a transport `closed`/`error` wrongly set `retrying`, that
   * is proof the socket is actually alive. This resets the state to connected
   * WITHOUT bumping the generation (we did not open a new socket, so a stale
   * `closed` from the current socket is still logically "the same socket" and
   * must not clobber the heal). It also clears the last error so the readiness
   * surface stops reporting `listener-disconnected`.
   */
  function markEventEvidence() {
    if (listenerConnected && listenerState === "connected") return;
    listenerConnected = true;
    listenerState = "connected";
    listenerLastError = null;
    if (startupPhase === "listener-retrying") setStartupPhase("ready");
  }

  function markRetrying(reason) {
    listenerConnected = false;
    listenerState = "retrying";
    listenerLastError = reason ? String(reason) : null;
  }

  function markRetryingForGeneration(reason, generation) {
    // Guard: a `closed`/`error` event carries the generation of the socket it
    // came from. If the current generation is newer than the event's, this is
    // a stale event from a socket that was already replaced — it must not
    // overwrite the healthy `connected` state of the current socket.
    if (generation != null && generation !== connectionGeneration) return false;
    markRetrying(reason);
    return true;
  }

  function markStarting() {
    listenerConnected = false;
    listenerState = "starting";
    listenerLastError = null;
  }

  function markStopped(reason = null) {
    listenerConnected = false;
    listenerState = "stopped";
    if (reason !== null) listenerLastError = String(reason);
  }

  function markStandby(reason = "hot_standby") {
    listenerConnected = false;
    listenerState = "standby";
    if (reason !== null) listenerLastError = String(reason);
  }

  function isStandby() {
    return listenerState === "standby" || listenerState === "hot_standby";
  }

  /**
   * Abortable sleep: resolves early when the signal aborts.
   */
  function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      // NOTE: timer is intentionally NOT unref'd. An unref'd sleep lets the
      // process exit mid-retry when nothing else keeps the event loop alive,
      // which would kill the retry loop (and the PM2-managed bot) silently.
    });
  }

  /**
   * Connect the Zalo WebSocket listener with unbounded (or bounded) retries.
   *
   * KEY CONTRACT: this function NEVER asks for a web-bridge closure. The
   * `onWebBridgeClosureRequested` hook exists only so tests can assert that
   * it is not called; production code must not wire it to closeWebServer().
   * A failed `start()` keeps the HTTP/socket bridge open and retries until
   * the signal aborts (process shutdown) — PM2 keeps reporting `online`
   * and the port stays bound the whole time.
   *
   * @param {object} options
   * @param {() => Promise|void} options.start starts the listener
   * @param {AbortSignal} [options.signal] aborts the retry loop
   * @param {number} [options.retryDelayMs] delay between attempts
   * @param {number} [options.maxRetries] attempt cap (Infinity = unbounded)
   * @param {(event: object) => void} [options.onEvent] observability hook
   */
  async function connectListenerWithRetry({
    start,
    signal = null,
    retryDelayMs = 15_000,
    maxRetries = Infinity,
    onEvent = null,
  } = {}) {
    if (typeof start !== "function") throw new TypeError("start must be a function");
    markStarting();
    let attempts = 0;
    while (true) {
      if (signal?.aborted) {
        return { connected: false, aborted: true, attempts, error: listenerLastError };
      }
      attempts += 1;
      try {
        await start();
        markConnected();
        onEvent?.({ type: "connected", attempts });
        return { connected: true, aborted: false, attempts, error: null };
      } catch (error) {
        markRetrying(error?.message || String(error));
        setStartupPhase("listener-retrying");
        onEvent?.({ type: "retry", attempts, error: error?.message || String(error) });
        if (attempts >= maxRetries) {
          return { connected: false, aborted: Boolean(signal?.aborted), attempts, error: error?.message || String(error) };
        }
        await abortableSleep(retryDelayMs, signal);
      }
    }
  }

  return {
    getSnapshot: snapshot,
    setStartupPhase,
    setStartupError,
    beginConnection,
    markConnected,
    markConnectedForGeneration,
    markRetrying,
    markRetryingForGeneration,
    markEventEvidence,
    markStarting,
    markStopped,
    markStandby,
    isStandby,
    connectListenerWithRetry,
    get connectionGeneration() {
      return connectionGeneration;
    },
    /** exposed for tests only: proves the bridge-closure hook is NOT wired */
    _onWebBridgeClosureRequested: onWebBridgeClosureRequested,
  };
}

let _singleton = null;

/**
 * Process-wide singleton used by src/index.js and web-server.js.
 */
export function getListenerRuntimeState() {
  if (!_singleton) _singleton = createListenerRuntimeState();
  return _singleton;
}

/** Test hook: reset the singleton. */
export function resetListenerRuntimeState() {
  _singleton = null;
}
