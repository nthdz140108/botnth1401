/**
 * Listener Binder: owns all Zalo event listener callbacks.
 *
 * Problem it solves: every call to `apiInstance.listener.on(...)` adds a NEW
 * listener. If bindBotEventHandlers() is called multiple times (re-login,
 * reconnect), listeners accumulate and each message is processed N times.
 *
 * Solution: bindZaloListeners() stores the EXACT callbacks it registered and
 * returns a dispose() that removes only those callbacks. Reconnect flow MUST
 * call dispose() on the old binder before creating a new one.
 *
 * NEVER use removeAllListeners() — that would destroy library-internal
 * listeners owned by zca-js.
 */

export const ZALO_EVENTS = ['message', 'group_event', 'undo', 'reaction', 'error', 'closed', 'connected', 'cipher_key'];

/**
 * Bind Zalo listeners and return a disposer.
 *
 * @param {object} listenerEmitter - apiInstance.listener (EventEmitter-like)
 * @param {object} handlers - { message, group_event, undo, reaction, error, closed, connected, cipher_key }
 * @returns {{ dispose: () => void, getListenerCounts: () => object }}
 */
export function bindZaloListeners(listenerEmitter, handlers = {}) {
  if (!listenerEmitter || typeof listenerEmitter.on !== 'function') {
    throw new Error('bindZaloListeners: listenerEmitter must be an EventEmitter');
  }

  const registered = []; // { event, callback }

  const safeBind = (event, callback) => {
    if (typeof callback !== 'function') return;
    listenerEmitter.on(event, callback);
    registered.push({ event, callback });
  };

  safeBind('message', handlers.message);
  safeBind('group_event', handlers.group_event);
  safeBind('undo', handlers.undo);
  safeBind('reaction', handlers.reaction);
  safeBind('error', handlers.error);
  safeBind('closed', handlers.closed);
  safeBind('connected', handlers.connected);
  safeBind('cipher_key', handlers.cipher_key);

  return {
    /**
     * Remove exactly the callbacks registered by this binder.
     * Uses removeListener(event, callback) — never removeAllListeners.
     */
    dispose() {
      let removed = 0;
      for (const { event, callback } of registered) {
        try {
          listenerEmitter.removeListener(event, callback);
          removed++;
        } catch {}
      }
      registered.length = 0;
      return removed;
    },

    /**
     * Get current listener counts per event (for leak detection).
     */
    getListenerCounts() {
      const counts = {};
      for (const event of ZALO_EVENTS) {
        try {
          counts[event] = typeof listenerEmitter.listenerCount === 'function'
            ? listenerEmitter.listenerCount(event)
            : (listenerEmitter._events?.[event]?.length || (listenerEmitter._events?.[event] ? 1 : 0));
        } catch {
          counts[event] = -1;
        }
      }
      return counts;
    },

    /**
     * Number of callbacks this binder registered.
     */
    get size() {
      return registered.length;
    },
  };
}

/**
 * Baseline tracker: monitors listener counts across reconnect cycles.
 * If counts exceed baseline for N consecutive checks, reports a leak.
 */
export class ListenerLeakDetector {
  constructor({ threshold = 3, onLeak = null } = {}) {
    this.baseline = null;
    this.consecutiveOver = new Map(); // event -> consecutive count
    this.threshold = threshold;
    this.onLeak = onLeak;
  }

  /**
   * Capture baseline counts once (after first bind).
   */
  setBaseline(counts) {
    this.baseline = { ...counts };
  }

  /**
   * Check current counts against baseline.
   * Returns { leaked: string[], reports: object }
   */
  check(counts) {
    if (!this.baseline) return { leaked: [], reports: {} };
    const leaked = [];
    const reports = {};
    for (const [event, count] of Object.entries(counts)) {
      const base = this.baseline[event] ?? 0;
      if (count > base) {
        const c = (this.consecutiveOver.get(event) || 0) + 1;
        this.consecutiveOver.set(event, c);
        if (c >= this.threshold) {
          leaked.push(event);
          reports[event] = { baseline: base, current: count, consecutive: c };
        }
      } else {
        this.consecutiveOver.delete(event);
      }
    }
    if (leaked.length > 0 && typeof this.onLeak === 'function') {
      this.onLeak(leaked, reports);
    }
    return { leaked, reports };
  }

  reset() {
    this.baseline = null;
    this.consecutiveOver.clear();
  }
}
