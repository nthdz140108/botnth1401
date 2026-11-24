/**
 * Resource Profile Manager for MyBot Fleet (VPS 4 GB Optimization).
 *
 * Supports two profiles:
 * - 'lean' (default for VPS 4GB):
 *   - On-demand native workers (start with 0 NSFW/canvas, max 2, idle 5m -> 0).
 *   - Image buffer cache: Main 32 MB, Child 16 MB, TTL 120s; oversized buffers not cached.
 *   - Message cache RAM: Main 10,000 entries, Child 5,000 entries; disk/UNDO fallback.
 *   - Public API cache: LRU max 500 entries, TTL sweep every 60s.
 *   - Heavy command dynamic import single-flight.
 * - 'compat' (rollback mode):
 *   - Pre-forked workers (2 each), no 5m zero-reap.
 *   - Image buffer cache: 64 MB, TTL 180s.
 *   - Message cache RAM: 20,000 entries.
 *   - Public API cache: standard Map without 500 cap.
 *
 * Canary support:
 *   Set MYBOT_LEAN_BOT_KEYS=key1,key2 to enable lean mode for specific child bots
 *   while the rest of the fleet runs in compat mode.
 */

import { getInstanceKind } from "./env.js";

export function getResourceProfile(botKey = null, instanceKind = null) {
  const effectiveKey = String(
    botKey ||
    process.env.BOT_KEY ||
    process.env.BOT_UID ||
    process.env.BOT_NAME ||
    "admin"
  ).trim();

  const effectiveKind = String(
    instanceKind ||
    process.env.MYBOT_INSTANCE_KIND ||
    (effectiveKey === "admin" || effectiveKey === "main" ? "main" : "child")
  ).trim().toLowerCase();

  const isMain = effectiveKind === "main";

  const rawEnv = process.env.MYBOT_RESOURCE_PROFILE;
  let globalProfile = "compat";
  if (rawEnv !== undefined && rawEnv !== null && rawEnv !== "") {
    const normalized = String(rawEnv).trim().toLowerCase();
    if (normalized === "lean") {
      globalProfile = "lean";
    } else if (normalized === "compat") {
      globalProfile = "compat";
    } else {
      console.warn?.(`[resource-profile] Unknown MYBOT_RESOURCE_PROFILE "${rawEnv}", defaulting safely to "compat"`);
      globalProfile = "compat";
    }
  }

  const leanKeysRaw = process.env.MYBOT_LEAN_BOT_KEYS || "";
  const leanKeys = leanKeysRaw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const isCanaryLean = Boolean(
    leanKeys.includes(effectiveKey) ||
    (process.env.BOT_UID && leanKeys.includes(String(process.env.BOT_UID).trim()))
  );

  const isLean = Boolean(globalProfile === "lean" || isCanaryLean);
  const profileName = isLean ? "lean" : "compat";

  const imageBufferMaxBytes = isLean
    ? (isMain ? 32 * 1024 * 1024 : 16 * 1024 * 1024)
    : 64 * 1024 * 1024;
  const imageBufferTtlMs = isLean ? 120 * 1000 : 180 * 1000;

  const messageCacheMaxEntries = isLean
    ? (isMain ? 10_000 : 5_000)
    : 20_000;

  const publicApiCacheMaxEntries = isLean ? 500 : 2000;

  return {
    profile: profileName,
    isLean,
    isMain,
    botKey: effectiveKey,
    kind: isMain ? "main" : "child",

    imageBuffer: {
      maxBytes: imageBufferMaxBytes,
      ttlMs: imageBufferTtlMs,
    },
    imageBufferMaxBytes,
    imageBufferTtlMs,

    messageCache: {
      maxEntries: messageCacheMaxEntries,
      ttlMs: 24 * 60 * 60 * 1000,
    },
    messageCacheMaxEntries,

    publicApiCache: {
      maxEntries: publicApiCacheMaxEntries,
      sweepIntervalMs: 60 * 1000,
    },
    publicApiCacheMaxEntries,

    workers: {
      initialProcesses: isLean ? 0 : 2,
      maxProcesses: 2,
      idleTimeoutMs: isLean ? 300_000 : 0, // 5 minutes
      onDemand: isLean,
    },
  };
}
