export function createStateClaimRegistry(options = {}) {
  const ttlMs = Number(options.ttlMs ?? 60_000);
  const claims = new Map(); // key -> { eventId, claimedAt, expiresAt }

  function tryClaim(key, eventId = null, customTtlMs = null) {
    if (!key) return false;
    const strKey = String(key);
    const now = Date.now();
    const existing = claims.get(strKey);

    if (existing && existing.expiresAt > now) {
      // Already claimed and not expired
      return false;
    }

    const effectiveTtl = customTtlMs !== null ? Number(customTtlMs) : ttlMs;
    claims.set(strKey, {
      eventId: eventId ? String(eventId) : null,
      claimedAt: now,
      expiresAt: now + effectiveTtl,
    });
    return true;
  }

  function release(key, eventId = null) {
    if (!key) return false;
    const strKey = String(key);
    const existing = claims.get(strKey);
    if (!existing) return false;

    if (eventId !== null && existing.eventId !== null && existing.eventId !== String(eventId)) {
      // Owned by a different eventId
      return false;
    }

    claims.delete(strKey);
    return true;
  }

  function has(key) {
    if (!key) return false;
    const strKey = String(key);
    const existing = claims.get(strKey);
    if (!existing) return false;
    if (existing.expiresAt <= Date.now()) {
      claims.delete(strKey);
      return false;
    }
    return true;
  }

  function get(key) {
    if (!key) return null;
    const strKey = String(key);
    const existing = claims.get(strKey);
    if (!existing) return null;
    if (existing.expiresAt <= Date.now()) {
      claims.delete(strKey);
      return null;
    }
    return { ...existing };
  }

  function prune(now = Date.now()) {
    let prunedCount = 0;
    for (const [key, claim] of claims.entries()) {
      if (claim.expiresAt <= now) {
        claims.delete(key);
        prunedCount++;
      }
    }
    return prunedCount;
  }

  function clear() {
    claims.clear();
  }

  function stats() {
    return {
      size: claims.size,
      ttlMs,
    };
  }

  return {
    tryClaim,
    release,
    has,
    get,
    prune,
    clear,
    stats,
  };
}

let globalClaims = null;
export function getGlobalStateClaimRegistry() {
  if (!globalClaims) {
    globalClaims = createStateClaimRegistry();
  }
  return globalClaims;
}
