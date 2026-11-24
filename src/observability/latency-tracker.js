import { performance } from "node:perf_hooks";

export const REQUIRED_PHASES = Object.freeze([
  "ws_received",
  "decoded",
  "preflight_started",
  "group_info_resolved",
  "security_evaluated",
  "dispatch_completed",
  "cooldown_claimed",
  "handler_started",
  "first_response_completed",
  "outbound_started",
  "outbound_called",
  "acknowledged",
  "completed",
]);

const FORBIDDEN_METADATA_KEYS = new Set([
  "content", "msgcontent", "message", "body", "text", "caption",
  "cookie", "secret", "secretkey", "token", "password", "key",
  "imei", "apikey", "api_key", "authorization", "auth", "credential"
]);

function sanitizeMetadata(metadata = {}) {
  const safe = {};
  if (!metadata || typeof metadata !== "object") return safe;
  for (const [k, v] of Object.entries(metadata)) {
    const lk = k.toLowerCase();
    if (FORBIDDEN_METADATA_KEYS.has(lk) || lk.includes("secret") || lk.includes("token") || lk.includes("cookie") || lk.includes("content") || lk.includes("pass")) {
      continue; // NEVER store chat content or secrets
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      safe[k] = v;
    }
  }
  return safe;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function emptyPercentileWindow() {
  return {
    samples: [],
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
    min: 0,
    count: 0,
  };
}

function finalizePercentiles(window) {
  if (!window.samples.length) {
    window.p50 = 0;
    window.p95 = 0;
    window.p99 = 0;
    window.max = 0;
    window.min = 0;
    window.count = 0;
    return window;
  }
  const sorted = [...window.samples].sort((a, b) => a - b);
  window.p50 = Number(percentile(sorted, 50).toFixed(2));
  window.p95 = Number(percentile(sorted, 95).toFixed(2));
  window.p99 = Number(percentile(sorted, 99).toFixed(2));
  window.min = Number(sorted[0].toFixed(2));
  window.max = Number(sorted[sorted.length - 1].toFixed(2));
  window.count = sorted.length;
  return window;
}

export function createLatencyTracker(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => performance.now();
  const metrics = options.metrics || null;
  const maxSamples = Number(options.maxSamples ?? 4096);
  const activeEvents = new Map();

  // Buckets:
  // byBot: botId -> { total: emptyPercentileWindow(), byKind: Map, byClass: Map, byPhase: Map }
  const botBuckets = new Map();
  const globalTotal = emptyPercentileWindow();
  const phaseTransitions = new Map();

  function getOrCreateBotBucket(botId = "default") {
    const key = String(botId || "default");
    if (!botBuckets.has(key)) {
      botBuckets.set(key, {
        total: emptyPercentileWindow(),
        byKind: new Map(),
        byClass: new Map(),
        byPhase: new Map(),
      });
    }
    return botBuckets.get(key);
  }

  function pushSample(window, duration) {
    window.samples.push(duration);
    if (window.samples.length > maxSamples) {
      window.samples.splice(0, window.samples.length - maxSamples);
    }
  }

  function begin(eventId, kind = "message", botId = "admin", metadata = {}) {
    const id = String(eventId);
    const now = clock();
    const event = {
      eventId: id,
      kind: kind || "message",
      botId: String(botId || "admin"),
      commandClass: metadata.commandClass || "fast-text",
      phases: new Map(),
      startedAt: now,
      metadata: sanitizeMetadata(metadata),
    };
    event.phases.set("ws_received", now);
    activeEvents.set(id, event);
    return event;
  }

  function mark(eventId, phase, timestamp = null) {
    const id = String(eventId);
    const event = activeEvents.get(id);
    if (!event) return null;
    const now = timestamp !== null ? timestamp : clock();
    event.phases.set(phase, now);
    return event;
  }

  function setCommandClass(eventId, commandClass) {
    const id = String(eventId);
    const event = activeEvents.get(id);
    if (event) {
      event.commandClass = commandClass;
    }
  }

  function finish(eventId, status = "completed") {
    const id = String(eventId);
    const event = activeEvents.get(id);
    if (!event) return null;

    const finishedAt = clock();
    event.phases.set("completed", finishedAt);
    const totalDuration = Math.max(0, finishedAt - event.startedAt);

    activeEvents.delete(id);

    // Record sample in global
    pushSample(globalTotal, totalDuration);

    // Record sample in bot bucket
    const botBucket = getOrCreateBotBucket(event.botId);
    pushSample(botBucket.total, totalDuration);

    // Record sample by kind
    if (!botBucket.byKind.has(event.kind)) {
      botBucket.byKind.set(event.kind, emptyPercentileWindow());
    }
    pushSample(botBucket.byKind.get(event.kind), totalDuration);

    // Record sample by commandClass
    const cmdClass = event.commandClass || "fast-text";
    if (!botBucket.byClass.has(cmdClass)) {
      botBucket.byClass.set(cmdClass, emptyPercentileWindow());
    }
    pushSample(botBucket.byClass.get(cmdClass), totalDuration);

    // Record phase transitions
    const phases = [...event.phases.entries()];
    for (let i = 0; i < phases.length - 1; i++) {
      const [fromPhase, fromTime] = phases[i];
      const [toPhase, toTime] = phases[i + 1];
      const phaseDelta = Math.max(0, toTime - fromTime);
      const transitionKey = `${fromPhase}->${toPhase}`;

      if (!phaseTransitions.has(transitionKey)) {
        phaseTransitions.set(transitionKey, emptyPercentileWindow());
      }
      pushSample(phaseTransitions.get(transitionKey), phaseDelta);

      if (!botBucket.byPhase.has(transitionKey)) {
        botBucket.byPhase.set(transitionKey, emptyPercentileWindow());
      }
      pushSample(botBucket.byPhase.get(transitionKey), phaseDelta);
    }

    if (event.phases.has("first_response_completed") && event.phases.has("ws_received")) {
      const e2eDelta = Math.max(0, event.phases.get("first_response_completed") - event.phases.get("ws_received"));
      const e2eKey = "ws_received->first_response_completed";
      if (!phaseTransitions.has(e2eKey)) {
        phaseTransitions.set(e2eKey, emptyPercentileWindow());
      }
      pushSample(phaseTransitions.get(e2eKey), e2eDelta);
      if (!botBucket.byPhase.has(e2eKey)) {
        botBucket.byPhase.set(e2eKey, emptyPercentileWindow());
      }
      pushSample(botBucket.byPhase.get(e2eKey), e2eDelta);
    }

    if (metrics && typeof metrics.recordOutbound === "function") {
      metrics.recordOutbound({
        operation: `event:${event.kind}:${cmdClass}`,
        status,
        durationMs: totalDuration,
      });
    }

    return {
      eventId: id,
      botId: event.botId,
      kind: event.kind,
      commandClass: cmdClass,
      totalDurationMs: Number(totalDuration.toFixed(2)),
      status,
      phases: Object.fromEntries(event.phases),
    };
  }

  function snapshot(botId = null) {
    finalizePercentiles(globalTotal);

    if (botId !== null) {
      const bKey = String(botId);
      const bucket = botBuckets.get(bKey);
      if (!bucket) {
        return {
          botId: bKey,
          total: emptyPercentileWindow(),
          byKind: {},
          byClass: {},
          byPhase: {},
          inFlight: 0,
        };
      }
      finalizePercentiles(bucket.total);
      const byKind = {};
      for (const [k, w] of bucket.byKind) {
        byKind[k] = { ...finalizePercentiles(w) };
      }
      const byClass = {};
      for (const [c, w] of bucket.byClass) {
        byClass[c] = { ...finalizePercentiles(w) };
      }
      const byPhase = {};
      for (const [p, w] of bucket.byPhase) {
        byPhase[p] = { ...finalizePercentiles(w) };
      }

      let inFlightCount = 0;
      for (const ev of activeEvents.values()) {
        if (ev.botId === bKey) inFlightCount++;
      }

      return {
        botId: bKey,
        total: { ...bucket.total },
        byKind,
        byClass,
        byPhase,
        inFlight: inFlightCount,
      };
    }

    const bots = {};
    for (const [bId, bucket] of botBuckets) {
      finalizePercentiles(bucket.total);
      const byKind = {};
      for (const [k, w] of bucket.byKind) {
        byKind[k] = { ...finalizePercentiles(w) };
      }
      const byClass = {};
      for (const [c, w] of bucket.byClass) {
        byClass[c] = { ...finalizePercentiles(w) };
      }
      const byPhase = {};
      for (const [p, w] of bucket.byPhase) {
        byPhase[p] = { ...finalizePercentiles(w) };
      }
      bots[bId] = {
        total: { ...bucket.total },
        byKind,
        byClass,
        byPhase,
      };
    }

    const transitions = {};
    for (const [trKey, w] of phaseTransitions) {
      transitions[trKey] = { ...finalizePercentiles(w) };
    }

    return {
      global: { ...globalTotal },
      bots,
      transitions,
      inFlight: activeEvents.size,
    };
  }

  function clear() {
    activeEvents.clear();
    botBuckets.clear();
    phaseTransitions.clear();
    globalTotal.samples = [];
  }

  return {
    begin,
    mark,
    setCommandClass,
    finish,
    snapshot,
    clear,
    get inFlight() {
      return activeEvents.size;
    },
  };
}

let defaultTracker = null;
export function getGlobalLatencyTracker() {
  if (!defaultTracker) {
    defaultTracker = createLatencyTracker();
  }
  return defaultTracker;
}
