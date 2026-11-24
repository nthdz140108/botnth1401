export const QR_LOGIN_TIMEOUT_MS = 90000;
export const QR_LOGIN_EXPIRY_REASON = "qr_expired";

export function isQrLoginExpiredResponse(payload) {
  if (payload?.expired === true || payload?.reason === QR_LOGIN_EXPIRY_REASON) return true;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  const normalized = text.toLowerCase();
  return /\bqr(?:\s+code)?\b[\s\S]{0,40}\b(?:expired|expire|timeout|timed out)\b/.test(normalized)
    || /\b(?:expired|expire|timeout|timed out)\b[\s\S]{0,40}\bqr(?:\s+code)?\b/.test(normalized);
}

export function isQrLoginExpiredSignal(signal) {
  return Boolean(signal?.aborted && signal.reason === QR_LOGIN_EXPIRY_REASON);
}
