import fs from "fs/promises";
import path from "path";

const BUCKET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SAMPLE_RETENTION_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 240;
const MAX_ACTIVITIES = 1000;

function emptyState() {
  return { samples: [], minuteBuckets: [], activities: [], warnings: [] };
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function minuteTimestamp(timestamp) {
  const value = new Date(timestamp).getTime();
  return new Date(Math.floor(value / 60000) * 60000).toISOString();
}

function normalizeState(value) {
  const state = emptyState();
  if (!value || typeof value !== "object") return state;
  state.samples = Array.isArray(value.samples) ? value.samples : [];
  state.minuteBuckets = Array.isArray(value.minuteBuckets) ? value.minuteBuckets : [];
  state.activities = Array.isArray(value.activities) ? value.activities : [];
  state.warnings = Array.isArray(value.warnings) ? value.warnings : [];
  return state;
}

export function createObservabilityStore({ filePath, now = () => new Date() }) {
  let state = emptyState();

  function prune() {
    const nowMs = now().getTime();
    const bucketCutoff = nowMs - BUCKET_RETENTION_MS;
    const sampleCutoff = nowMs - SAMPLE_RETENTION_MS;
    state.samples = state.samples
      .filter((entry) => new Date(entry.timestamp).getTime() >= sampleCutoff)
      .slice(-MAX_SAMPLES);
    state.minuteBuckets = state.minuteBuckets.filter((entry) => new Date(entry.timestamp).getTime() >= bucketCutoff);
    state.activities = state.activities
      .filter((entry) => new Date(entry.timestamp).getTime() >= bucketCutoff)
      .slice(-MAX_ACTIVITIES);
  }

  async function load() {
    try {
      state = normalizeState(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") {
        const corruptPath = `${filePath}.corrupt-${now().getTime()}`;
        try { await fs.rename(filePath, corruptPath); } catch {}
      }
      state = emptyState();
    }
    prune();
  }

  async function recordSample(sample) {
    const normalized = {
      timestamp: new Date(sample.timestamp || now()).toISOString(),
      cpu: numeric(sample.cpu), memory: numeric(sample.memory), disk: numeric(sample.disk),
      onlineBots: numeric(sample.onlineBots), messages: numeric(sample.messages), alerts: numeric(sample.alerts),
    };
    state.samples.push(normalized);
    const timestamp = minuteTimestamp(normalized.timestamp);
    const existing = state.minuteBuckets.find((bucket) => bucket.timestamp === timestamp);
    const bucket = existing || { timestamp, cpuAvg: 0, cpuMax: 0, memoryAvg: 0, diskAvg: 0, onlineBots: 0, messages: 0, alerts: 0, _count: 0 };
    bucket._count += 1;
    bucket.cpuAvg = ((bucket.cpuAvg * (bucket._count - 1)) + normalized.cpu) / bucket._count;
    bucket.cpuMax = Math.max(bucket.cpuMax, normalized.cpu);
    bucket.memoryAvg = ((bucket.memoryAvg * (bucket._count - 1)) + normalized.memory) / bucket._count;
    bucket.diskAvg = ((bucket.diskAvg * (bucket._count - 1)) + normalized.disk) / bucket._count;
    bucket.onlineBots = normalized.onlineBots;
    bucket.messages += normalized.messages;
    bucket.alerts += normalized.alerts;
    if (!existing) state.minuteBuckets.push(bucket);
    prune();
    return normalized;
  }

  async function recordActivity(activity) {
    state.activities.push({ ...activity, timestamp: new Date(activity.timestamp || now()).toISOString() });
    prune();
  }

  function getState() {
    return JSON.parse(JSON.stringify(state, (key, value) => key === "_count" ? undefined : value));
  }

  async function flush() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(getState()), "utf8");
    await fs.rename(temporaryPath, filePath);
  }

  return { load, recordSample, recordActivity, getState, flush };
}
