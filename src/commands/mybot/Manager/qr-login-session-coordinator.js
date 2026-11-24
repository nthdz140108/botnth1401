import { QR_LOGIN_EXPIRY_REASON } from "../../../utils/qr-login-expiry.js";

/**
 * Per-requester QR login session coordinator.
 *
 * Replaces the single `activeQrLoginSession` global lock. Each requester UID
 * may hold at most one QR acquisition session, but there is NO global cap on
 * how many different requesters may run QR sessions concurrently.
 *
 * States:
 *   initializing
 *     -> waiting_scan     (QR image sent successfully; countdown/deadline armed)
 *     -> waiting_confirm  (phone scanned; same deadline as waiting_scan)
 *     -> qr_acquired      (cookie + IMEI captured; requester slot released)
 *     |-> expired         (deadline passed)
 *     |-> failed          (unrecoverable error during acquisition)
 *     |-> cancelled
 *
 * The requester slot is released as soon as credentials are acquired,
 * expired, failed or cancelled — never held hostage by bootstrap /
 * provisioning or by slow/never-resolving Zalo HTTP requests.
 */

export const QR_ACQUISITION_DEADLINE_MS = 60_000;
export const QR_INIT_TIMEOUT_MS = 30_000;

export const QR_SESSION_STATES = Object.freeze({
  initializing: "initializing",
  waiting_scan: "waiting_scan",
  waiting_confirm: "waiting_confirm",
  qr_acquired: "qr_acquired",
  expired: "expired",
  failed: "failed",
  cancelled: "cancelled",
});

const sessionsByRequester = new Map();
const sessionsById = new Map();

function normalizeUid(uid) {
  return String(uid ?? "").trim();
}

function snapshot(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    requesterUid: session.requesterUid,
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    initStartedAt: session.initStartedAt,
    acquiredAt: session.acquiredAt,
    endedAt: session.endedAt,
    reason: session.reason,
    hasCredentials: Boolean(session.credentials?.cookie && session.credentials?.imei),
  };
}

function ensureSessionById(sessionId) {
  let session = sessionsById.get(sessionId);
  if (!session) {
    const requesterUid = findRequesterBySessionId(sessionId);
    session = {
      sessionId,
      requesterUid: requesterUid || "",
      state: QR_SESSION_STATES.initializing,
      createdAt: Date.now(),
      expiresAt: null,
      initStartedAt: Date.now(),
      acquiredAt: null,
      endedAt: null,
      reason: null,
      credentials: null,
    };
    if (requesterUid) sessionsByRequester.set(requesterUid, session);
    sessionsById.set(sessionId, session);
  }
  return session;
}

function findRequesterBySessionId(sessionId) {
  for (const [uid, session] of sessionsByRequester.entries()) {
    if (session.sessionId === sessionId) return uid;
  }
  return null;
}

/**
 * Begins a new QR acquisition session for a requester.
 *
 * Returns `{ ok: true, session }` when no active session exists for the
 * requester, or `{ ok: false, reason, session }` when the requester already
 * has an active session. The `admin` override (highest-level admin) is NOT
 * allowed to bypass the one-session-per-requester rule.
 *
 * @param {Object} options
 * @param {string} options.sessionId
 * @param {string} options.requesterUid
 */
export function beginQrSession({ sessionId, requesterUid }) {
  const normUid = normalizeUid(requesterUid);
  if (!normUid) {
    return { ok: false, reason: "MISSING_REQUESTER_UID", session: null };
  }

  const existing = sessionsByRequester.get(normUid);
  if (existing) {
    return {
      ok: false,
      reason: "REQUESTER_HAS_ACTIVE_QR_SESSION",
      session: existing,
    };
  }

  const session = {
    sessionId: String(sessionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    requesterUid: normUid,
    state: QR_SESSION_STATES.initializing,
    createdAt: Date.now(),
    expiresAt: null,
    initStartedAt: Date.now(),
    acquiredAt: null,
    endedAt: null,
    reason: null,
    credentials: null,
  };

  sessionsByRequester.set(normUid, session);
  sessionsById.set(session.sessionId, session);
  return { ok: true, session };
}

/**
 * Marks a session as having its QR image displayed to the requester and arms
 * the hard 60s deadline from the moment the image was sent.
 */
export function markQrDisplayed(sessionId, { expiresAt } = {}) {
  const session = sessionsById.get(sessionId);
  if (!session) return null;
  session.state = QR_SESSION_STATES.waiting_scan;
  session.expiresAt = typeof expiresAt === "number" && expiresAt > 0
    ? expiresAt
    : Date.now() + QR_ACQUISITION_DEADLINE_MS;
  return snapshot(session);
}

export function markWaitingConfirm(sessionId) {
  const session = sessionsById.get(sessionId);
  if (!session) return null;
  session.state = QR_SESSION_STATES.waiting_confirm;
  return snapshot(session);
}

/**
 * Marks a session as acquired (cookie + IMEI captured) and releases the
 * requester slot immediately. Bootstrap / provisioning continues
 * independently and no longer blocks the requester from starting a new QR.
 */
export function markCredentialsAcquired(sessionId, { credentials } = {}) {
  const session = sessionsById.get(sessionId);
  if (!session) return null;
  // A confirmation arriving at/after the deadline must never resurrect an
  // expired/failed/cancelled session, and must never provision a bot.
  if (session.state !== QR_SESSION_STATES.initializing
    && session.state !== QR_SESSION_STATES.waiting_scan
    && session.state !== QR_SESSION_STATES.waiting_confirm) {
    return snapshot(session);
  }
  if (session.expiresAt && Date.now() >= session.expiresAt) {
    return expireQrSession(sessionId, QR_LOGIN_EXPIRY_REASON);
  }
  session.state = QR_SESSION_STATES.qr_acquired;
  session.acquiredAt = Date.now();
  session.endedAt = Date.now();
  if (credentials && typeof credentials === "object") {
    session.credentials = credentials;
  }
  releaseRequesterSlot(session);
  return snapshot(session);
}

export function failQrSession(sessionId, reason) {
  const session = sessionsById.get(sessionId);
  if (!session) return null;
  if (session.state === QR_SESSION_STATES.qr_acquired) {
    // Provisioning is detached from the QR slot; a post-acquisition failure
    // must not reacquire/block the requester slot.
    return snapshot(session);
  }
  session.state = QR_SESSION_STATES.failed;
  session.reason = reason || "failed";
  session.endedAt = Date.now();
  releaseRequesterSlot(session);
  return snapshot(session);
}

export function expireQrSession(sessionId, reason) {
  const session = sessionsById.get(sessionId);
  if (!session) return null;
  if (session.state === QR_SESSION_STATES.qr_acquired) {
    return snapshot(session);
  }
  session.state = QR_SESSION_STATES.expired;
  session.reason = reason || QR_LOGIN_EXPIRY_REASON;
  session.endedAt = Date.now();
  releaseRequesterSlot(session);
  return snapshot(session);
}

export function cancelQrSession(sessionId, reason) {
  const session = sessionsById.get(sessionId);
  if (!session) return null;
  if (session.state === QR_SESSION_STATES.qr_acquired) {
    return snapshot(session);
  }
  session.state = QR_SESSION_STATES.cancelled;
  session.reason = reason || "cancelled";
  session.endedAt = Date.now();
  releaseRequesterSlot(session);
  return snapshot(session);
}

/**
 * Releases the requester slot associated with a session. The session record
 * is retained (by id) so late confirmations can be recognised and discarded,
 * but the requester is immediately free to start a new QR session.
 */
function releaseRequesterSlot(session) {
  if (!session) return;
  const current = sessionsByRequester.get(session.requesterUid);
  if (current && current.sessionId === session.sessionId) {
    sessionsByRequester.delete(session.requesterUid);
  }
}

export function hasActiveQrSession(requesterUid) {
  return Boolean(sessionsByRequester.get(normalizeUid(requesterUid)));
}

export function getQrSession(sessionId) {
  const session = sessionsById.get(sessionId);
  return session ? snapshot(session) : null;
}

export function listQrSessions() {
  return Array.from(sessionsById.values()).map(snapshot);
}

/**
 * Sweeps sessions that are stuck in `initializing` (QR image was never sent)
 * past the 30s initialization timeout, or in `waiting_*` past their deadline.
 * Stuck sessions are failed/expired and their requester slot is released.
 */
export function sweepExpiredQrSessions({ now = Date.now() } = {}) {
  const released = [];
  for (const [sessionId, session] of Array.from(sessionsById.entries())) {
    if (session.state === QR_SESSION_STATES.qr_acquired) continue;
    if (session.state === QR_SESSION_STATES.initializing) {
      if (now - session.initStartedAt > QR_INIT_TIMEOUT_MS) {
        expireQrSession(sessionId, "init_timeout");
        released.push(sessionId);
      }
      continue;
    }
    if (session.expiresAt && now >= session.expiresAt) {
      expireQrSession(sessionId, QR_LOGIN_EXPIRY_REASON);
      released.push(sessionId);
    }
  }
  return released;
}

/**
 * Removes stale session records entirely. Used by tests and by cleanup after
 * the provisioning handoff has detached from the QR acquisition lifecycle.
 */
export function purgeQrSession(sessionId) {
  const session = sessionsById.get(sessionId);
  if (session) {
    sessionsById.delete(sessionId);
  }
  return Boolean(session);
}

/**
 * Returns true when the given requester UID has a QR acquisition session that
 * is still holding the per-requester slot (i.e. not yet acquired/expired/failed).
 * Used by `showinfo` and quota checks so the QR-running state comes from the
 * coordinator instead of the stale 5-minute quota reservation file.
 */
export function isRequesterSlotBusy(requesterUid) {
  return hasActiveQrSession(requesterUid);
}

/**
 * Builds the `hasInFlightReservation`-compatible result for quota checks.
 * Old quota-reservations entries from prior runs are no longer a lock: only
 * the in-memory coordinator decides whether the requester currently holds a QR.
 */
export function qrSessionBlockingResult(requesterUid) {
  return {
    hasInFlightReservation: isRequesterSlotBusy(requesterUid),
    activeQrSession: getActiveSessionSnapshot(requesterUid),
  };
}

function getActiveSessionSnapshot(requesterUid) {
  const session = sessionsByRequester.get(normalizeUid(requesterUid));
  return session ? snapshot(session) : null;
}
