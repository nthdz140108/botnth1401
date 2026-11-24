/**
 * In-memory manager for pending !locmem confirmation requests.
 * Stored in-memory only: restart auto-cancels pending requests so stale
 * messages cannot be accidentally confirmed later.
 */
export class PendingConfirmationManager {
  constructor(defaultExpiresMs = 120000) {
    this.defaultExpiresMs = Number(defaultExpiresMs) || 120000;
    this.byThread = new Map();
    this.byMsgId = new Map();
  }

  /**
   * Checks whether a pending confirmation exists and has not expired for a group.
   * @param {string} threadId
   * @returns {boolean}
   */
  hasPending(threadId) {
    const key = String(threadId || "");
    const existing = this.byThread.get(key);
    if (!existing) return false;
    if (Date.now() >= existing.expiresAt) {
      this.remove(key);
      return false;
    }
    return true;
  }

  /**
   * Adds a new pending confirmation request for a group.
   * Rejects if group already has an active pending request.
   * @param {object} params
   * @param {string} params.threadId
   * @param {string} params.serverMsgId
   * @param {string[]} params.candidates
   * @param {object} params.dateRange
   * @param {number} [params.expiresMs=120000]
   * @param {string} [params.botUid="admin"]
   * @returns {object}
   */
  addRequest({ threadId, serverMsgId, candidates, dateRange, expiresMs, botUid = "admin" }) {
    const tId = String(threadId || "");
    const sMsgId = String(serverMsgId || "");
    if (!tId || !sMsgId) {
      throw new Error("threadId and serverMsgId are required for pending confirmation");
    }

    if (this.hasPending(tId)) {
      throw new Error("Yêu cầu trước đó trong nhóm vẫn đang chờ xác nhận");
    }

    const finalExpiresMs = Number(expiresMs) || this.defaultExpiresMs || 120000;
    const expiresAt = Date.now() + finalExpiresMs;
    const timer = setTimeout(() => {
      this.remove(tId);
    }, finalExpiresMs);
    timer.unref?.();

    const request = {
      threadId: tId,
      serverMsgId: sMsgId,
      candidates: Array.isArray(candidates) ? [...candidates] : [],
      dateRange: dateRange || {},
      expiresAt,
      botUid: String(botUid || "admin"),
      timer,
    };

    this.byThread.set(tId, request);
    this.byMsgId.set(`${tId}:${sMsgId}`, request);
    return request;
  }

  /**
   * Alias/wrapper for creating a pending confirmation request.
   */
  createRequest({ groupId, threadId, requestedBy, candidateUids, candidates, candidateNames, qualifiedDays, dateRange, previewMsgIds, serverMsgId, expiresMs = 120000, botUid = "admin" } = {}) {
    const tId = String(groupId || threadId || "");
    const sMsgId = String(serverMsgId || "");
    if (!tId || !sMsgId) return null;
    if (this.hasPending(tId)) return null;

    try {
      return this.addRequest({
        threadId: tId,
        serverMsgId: sMsgId,
        candidates: candidateUids || candidates || [],
        dateRange: dateRange || { qualifiedDays },
        expiresMs,
        botUid,
      });
    } catch {
      return null;
    }
  }

  /**
   * Retrieves pending request without removing it.
   * @param {string} threadId
   * @returns {object|null}
   */
  getPending(threadId) {
    const tId = String(threadId || "");
    if (!this.hasPending(tId)) return null;
    const req = this.byThread.get(tId);
    if (!req) return null;
    return {
      ...req,
      groupId: req.threadId,
      candidateUids: req.candidates,
    };
  }

  /**
   * Atomically takes and removes the request matching threadId and serverMsgId.
   * Returns null if not found, expired, or already taken.
   * Prevents double-execution on concurrent or multiple reactions.
   * @param {string} threadId
   * @param {string} serverMsgId
   * @returns {object|null}
   */
  takeRequest(threadId, serverMsgId) {
    const tId = String(threadId || "");
    const sMsgId = String(serverMsgId || "");
    const key = `${tId}:${sMsgId}`;

    const request = this.byMsgId.get(key);
    if (!request) return null;

    if (Date.now() >= request.expiresAt) {
      this.remove(tId);
      return null;
    }

    // Atomically delete immediately before returning
    this.remove(tId);
    return {
      ...request,
      groupId: request.threadId,
      candidateUids: request.candidates,
    };
  }

  /**
   * Removes and cancels timer for pending request in a group.
   * @param {string} threadId
   */
  remove(threadId) {
    const tId = String(threadId || "");
    const request = this.byThread.get(tId);
    if (request) {
      try {
        clearTimeout(request.timer);
      } catch {}
      this.byThread.delete(tId);
      this.byMsgId.delete(`${request.threadId}:${request.serverMsgId}`);
    }
  }

  /**
   * Clears all pending requests and timers.
   */
  clear() {
    for (const request of this.byThread.values()) {
      try {
        clearTimeout(request.timer);
      } catch {}
    }
    this.byThread.clear();
    this.byMsgId.clear();
  }
}

export const defaultPendingManager = new PendingConfirmationManager();
