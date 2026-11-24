import { LRUCache } from "lru-cache";
import { getResourceProfile } from "./resource-profile.js";
import { createProviderError, PROVIDER_ERROR_CODES, requestJson, withProviderRetry } from "../dashboard/provider-adapter.js";

const profile = getResourceProfile();
const maxEntries = profile.publicApiCacheMaxEntries || 500;

export const publicApiCache = new LRUCache({
  max: maxEntries,
  ttlAutopurge: true,
});

// Quét TTL mỗi 60 giây
const sweepInterval = setInterval(() => {
  publicApiCache.purgeStale();
}, 60 * 1000);
sweepInterval.unref?.();

function createCacheKey(provider, url) {
  return `${provider}::${url}`;
}

export function getCachedJson(provider, url) {
  const val = publicApiCache.get(createCacheKey(provider, url));
  return val !== undefined ? val : null;
}

export function setCachedJson(provider, url, value, ttlMs) {
  const ttl = Math.max(0, Number(ttlMs) || 0);
  publicApiCache.set(createCacheKey(provider, url), value, {
    ttl: ttl > 0 ? ttl : undefined,
  });
  return value;
}

export function clearPublicApiCache() {
  publicApiCache.clear();
}

export async function fetchJsonWithCache(url, options = {}) {
  const {
    provider = "public-api",
    ttlMs = 0,
    timeoutMs = 12000,
    retries = 1,
    correlationId = null,
    forceRefresh = false,
    fetchOptions = {},
  } = options;

  if (!forceRefresh) {
    const cached = getCachedJson(provider, url);
    if (cached) return cached;
  }

  const result = await withProviderRetry(
    () => requestJson(url, { ...fetchOptions, provider, correlationId }),
    { provider, timeoutMs, retries, correlationId },
  );
  if (result == null) {
    throw createProviderError(PROVIDER_ERROR_CODES.INVALID_RESPONSE, `${provider}: empty response`, { provider, correlationId, url });
  }
  if (ttlMs > 0) setCachedJson(provider, url, result, ttlMs);
  return result;
}

