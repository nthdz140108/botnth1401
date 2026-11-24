const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const collectorUrl = pathToFileURL(path.join(__dirname, "../dashboard/observability/collector.js")).href;
const serviceUrl = pathToFileURL(path.join(__dirname, "../dashboard/observability/service.js")).href;

function store() { const samples = []; const activities = []; let flushes = 0; return { samples, activities, recordSample: async (x) => samples.push(x), recordActivity: async (x) => activities.push(x), flush: async () => { flushes += 1; }, get flushes() { return flushes; }, getState: () => ({ minuteBuckets: samples, activities }) }; }

test("collector samples immediately and schedules every 15 seconds", async () => {
  const { createMetricsCollector } = await import(collectorUrl);
  const saved = store(); const timers = []; const emitted = [];
  const collector = createMetricsCollector({ store: saved, collectHealth: async () => ({ cpu: 12, memory: 23, disk: 34 }), collectSnapshot: async () => ({ onlineBots: 2, messages: 3, alerts: 1 }), emit: (...args) => emitted.push(args), setIntervalFn: (fn, ms) => (timers.push({ fn, ms }), 9), clearIntervalFn() {} });
  await collector.start();
  assert.equal(saved.samples.length, 1); assert.equal(saved.flushes, 1); assert.equal(timers[0].ms, 15000); assert.equal(emitted[0][0], "dashboard:metrics");
  collector.stop();
});

test("service projects required zero-filled 24-hour and 7-day series", async () => {
  const { createObservabilityService } = await import(serviceUrl);
  const now = () => new Date("2026-08-06T00:00:00.000Z"); const saved = store(); const emitted = [];
  saved.samples.push({ timestamp: "2026-08-05T23:59:00.000Z", cpuAvg: 10, cpuMax: 12, memoryAvg: 20, diskAvg: 30, onlineBots: 2, messages: 4, alerts: 1 });
  const service = createObservabilityService({ store: saved, now, emit: (...args) => emitted.push(args), adapters: { getSummary: async () => ({ onlineBots: 2 }), getHealth: async () => ({ cpu: { text: "10%" } }), getFleet: async () => [] } });
  const daily = await service.getOverview("24h"); const weekly = await service.getOverview("7d");
  assert.equal(daily.series.length, 288); assert.equal(weekly.series.length, 672); assert.deepEqual(Object.keys(daily.series[0]), ["timestamp", "cpuAvg", "cpuMax", "memoryAvg", "diskAvg", "onlineBots", "messages", "alerts"]);
  await service.recordActivity({ type: "bot-status", cookie: "x", imei: "x", userAgent: "x", credential: "x" });
  assert.deepEqual(saved.activities[0], { type: "bot-status", timestamp: saved.activities[0].timestamp }); assert.equal(emitted[0][0], "dashboard:activity");
});

test("service keeps response valid when health contributes warnings", async () => {
  const { createObservabilityService } = await import(serviceUrl);
  const service = createObservabilityService({ store: store(), now: () => new Date("2026-08-06T00:00:00.000Z"), emit() {}, adapters: { getSummary: async () => ({}), getFleet: async () => [], getHealth: async () => ({ cpu: { text: "12%" }, warnings: ["disk unavailable"] }) } });
  const response = await service.getOverview("24h"); assert.equal(response.health.cpu.text, "12%"); assert.deepEqual(response.warnings, ["disk unavailable"]);
});

test("service averages average metrics and sums counters within each range bucket", async () => {
  const { createObservabilityService } = await import(serviceUrl);
  const saved = store();
  saved.samples.push(
    { timestamp: "2026-08-05T23:51:00.000Z", cpuAvg: 10, cpuMax: 20, memoryAvg: 30, diskAvg: 40, onlineBots: 2, messages: 3, alerts: 1 },
    { timestamp: "2026-08-05T23:54:00.000Z", cpuAvg: 20, cpuMax: 30, memoryAvg: 50, diskAvg: 60, onlineBots: 3, messages: 4, alerts: 2 },
  );
  const service = createObservabilityService({ store: saved, now: () => new Date("2026-08-06T00:00:00.000Z"), emit() {}, adapters: { getSummary: async () => ({}), getHealth: async () => ({}), getFleet: async () => [] } });
  const point = (await service.getOverview("24h")).series.at(-2);
  assert.deepEqual({ cpuAvg: point.cpuAvg, cpuMax: point.cpuMax, memoryAvg: point.memoryAvg, diskAvg: point.diskAvg, onlineBots: point.onlineBots, messages: point.messages, alerts: point.alerts }, { cpuAvg: 15, cpuMax: 30, memoryAvg: 40, diskAvg: 50, onlineBots: 3, messages: 7, alerts: 3 });
});

test("activity contract persists and emits only operational type, safe subject, and timestamp", async () => {
  const { createObservabilityService } = await import(serviceUrl);
  const saved = store();
  const emitted = [];
  const service = createObservabilityService({ store: saved, now: () => new Date("2026-08-06T00:00:00.000Z"), emit: (...args) => emitted.push(args), adapters: { getSummary: async () => ({}), getFleet: async () => [], getHealth: async () => ({}) } });
  await service.recordActivity({ type: "bot-status", subject: "Fleet status changed", uid: "123", userName: "Lan", email: "lan@example.test", cookie: "secret" });
  assert.deepEqual(saved.activities[0], { type: "bot-status", subject: "Fleet status changed", timestamp: "2026-08-06T00:00:00.000Z" });
  assert.deepEqual(emitted[0][1], saved.activities[0]);
});
