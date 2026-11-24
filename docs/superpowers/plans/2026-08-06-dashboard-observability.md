# Dashboard Observability Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, safe, realtime dashboard metrics and the overview API without changing existing dashboard operations.

**Architecture:** `dashboard/server.js` constructs the observability service and passes adapters for existing configuration sources and Socket.IO. Focused modules in `dashboard/observability/` own state persistence, sampling, and overview projection, allowing Node tests to use temporary directories and deterministic clocks without starting the dashboard.

**Tech Stack:** Node.js ESM, Express 4, Socket.IO 4, `systeminformation`, `node:test`, `fs/promises`.

## Global Constraints

- Preserve Express, plain JavaScript, all existing routes, and existing Socket.IO events.
- Do not modify bot core, database, authentication, roles, audit trail, or user data under `assets/`.
- Persist only safe operational metrics; exclude cookies, IMEI, user agent, credentials, and user-identifying audit data.
- Sample and emit metrics every 15 seconds; retain no more than seven days and 1,000 activities.
- Use atomic temp-file then rename persistence and recover corrupt files by renaming them `.corrupt-<timestamp>`.
- Default API range is `24h`; only `24h` and `7d` are valid.

---

### Task 1: Create a deterministic observability store

**Files:**
- Create: `dashboard/observability/store.js`
- Create: `tests/observability-store.test.cjs`

**Interfaces:**
- Produces `createObservabilityStore({ filePath, now })` with `load()`, `recordSample(sample)`, `recordActivity(activity)`, `getState()`, and `flush()`.
- `recordSample` accepts a safe normalized sample with ISO `timestamp`, CPU, memory, disk, bot, message, and alert numeric fields.
- `getState()` returns `{ samples, minuteBuckets, activities, warnings }`.

- [ ] **Step 1: Write failing store tests**

```js
test("store aggregates samples into a one-minute bucket", async () => {
  const store = createObservabilityStore({ filePath, now: () => new Date("2026-08-06T00:00:30.000Z") });
  await store.load();
  await store.recordSample({ timestamp: "2026-08-06T00:00:30.000Z", cpu: 10, memory: 20, disk: 30, onlineBots: 2, messages: 3, alerts: 1 });
  assert.deepEqual(store.getState().minuteBuckets[0], {
    timestamp: "2026-08-06T00:00:00.000Z", cpuAvg: 10, cpuMax: 10, memoryAvg: 20,
    diskAvg: 30, onlineBots: 2, messages: 3, alerts: 1,
  });
});

test("store prunes seven-day samples and retains 1,000 newest activities", async () => {
  await store.recordSample({ timestamp: "2026-07-29T23:59:59.000Z", cpu: 1, memory: 1, disk: 1, onlineBots: 0, messages: 0, alerts: 0 });
  for (let index = 0; index < 1001; index += 1) await store.recordActivity({ type: "bot-status", timestamp: new Date(1722988800000 + index).toISOString() });
  assert.equal(store.getState().samples.length, 0);
  assert.equal(store.getState().activities.length, 1000);
});
test("store writes through a temporary file and reloads persisted state", async () => {
  await store.recordActivity({ type: "bot-status", timestamp: "2026-08-06T00:00:00.000Z" }); await store.flush();
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  const reloaded = createObservabilityStore({ filePath }); await reloaded.load();
  assert.equal(reloaded.getState().activities.length, 1);
});
test("store renames an unreadable JSON file and starts empty", async () => {
  await fs.promises.writeFile(filePath, "{not json}"); await store.load();
  assert.deepEqual(store.getState().activities, []);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.startsWith("metrics.json.corrupt-")), true);
});
```

- [ ] **Step 2: Run the tests and verify the expected missing-module failure**

Run: `node --test tests/observability-store.test.cjs`

Expected: failure because `dashboard/observability/store.js` does not exist.

- [ ] **Step 3: Implement the minimal store**

```js
export function createObservabilityStore({ filePath, now = () => new Date() }) {
  return { load, recordSample, recordActivity, getState, flush };
}
```

Use `fs/promises`, retain samples and minute buckets newer than `now - 7 days`, cap activities with `slice(-1000)`, and remove non-contract fields before returning state.

- [ ] **Step 4: Run the store tests and verify they pass**

Run: `node --test tests/observability-store.test.cjs`

Expected: all store tests pass.

### Task 2: Create collector and overview service

**Files:**
- Create: `dashboard/observability/collector.js`
- Create: `dashboard/observability/service.js`
- Create: `tests/observability-service.test.cjs`

**Interfaces:**
- Consumes the store from Task 1.
- `createMetricsCollector({ collectHealth, collectSnapshot, emit, store, intervalMs, setIntervalFn, clearIntervalFn })` exposes `start()`, `stop()`, and `collectNow()`.
- `createObservabilityService({ store, collector, now, adapters })` exposes `start()`, `stop()`, `getOverview(range)`, and `recordActivity(event)`.

- [ ] **Step 1: Write failing service tests**

```js
test("collector samples immediately and then every 15 seconds", async () => {
  const intervals = [];
  const collector = createMetricsCollector({ intervalMs: 15000, setIntervalFn: (fn, ms) => (intervals.push([fn, ms]), 1), clearIntervalFn() {}, store, collectHealth, collectSnapshot, emit });
  await collector.start();
  assert.equal(samples.length, 1);
  assert.equal(intervals[0][1], 15000);
});

test("overview returns 5-minute 24h buckets and 15-minute 7d buckets", async () => {
  const overview = await service.getOverview("24h");
  assert.equal(overview.series.length, 288);
  assert.deepEqual(Object.keys(overview.series[0]), ["timestamp", "cpuAvg", "cpuMax", "memoryAvg", "diskAvg", "onlineBots", "messages", "alerts"]);
});

test("overview preserves available health when one source fails", async () => {
  adapters.getHealth = async () => ({ cpu: { text: "12%" }, memory: { text: "1 GB" }, warnings: ["disk unavailable"] });
  const overview = await service.getOverview("24h");
  assert.equal(overview.health.cpu.text, "12%"); assert.deepEqual(overview.warnings, ["disk unavailable"]);
});
test("activity redacts forbidden fields before persistence and socket emission", async () => {
  await service.recordActivity({ type: "bot-status", cookie: "secret", imei: "device", userAgent: "agent", credential: "secret" });
  const event = emitted.find(([name]) => name === "dashboard:activity")[1];
  assert.deepEqual(event, { type: "bot-status", timestamp: event.timestamp });
});
```

- [ ] **Step 2: Run the tests and verify the expected missing-module failure**

Run: `node --test tests/observability-service.test.cjs`

Expected: failure because the collector and service modules do not exist.

- [ ] **Step 3: Implement the collector and service**

```js
export function createMetricsCollector({ collectHealth, collectSnapshot, emit, store, intervalMs = 15000, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  return { start: async () => { await collectNow(); timer = setIntervalFn(collectNow, intervalMs); }, stop, collectNow };
}
```

`getOverview` validates ranges, generates zero-filled periods, combines minute buckets into range buckets, obtains summary/fleet via adapters, and returns warnings rather than throwing for partial health failures. `recordActivity` accepts only an event type, optional safe subject label, and timestamp; it strips forbidden keys, records it, flushes, and emits `dashboard:activity`.

- [ ] **Step 4: Run the service tests and verify they pass**

Run: `node --test tests/observability-service.test.cjs`

Expected: all collector, projection, warning, and redaction tests pass.

### Task 3: Integrate the endpoint and Socket.IO events into the dashboard server

**Files:**
- Modify: `dashboard/server.js`
- Modify: `dashboard/package.json`
- Create: `tests/dashboard-overview-contract.test.cjs`

**Interfaces:**
- Consumes `createObservabilityStore`, `createMetricsCollector`, and `createObservabilityService`.
- Produces `GET /api/dashboard/overview?range=24h|7d`, `dashboard:metrics`, and `dashboard:activity` while preserving `botStatus`.

- [ ] **Step 1: Write the failing HTTP contract tests**

```js
test("overview defaults to 24h and has its complete response contract", async () => {
  const response = await request(server, "/api/dashboard/overview");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ["fleet", "generatedAt", "health", "range", "recentActivity", "series", "success", "summary", "warnings"].sort());
  assert.equal(response.body.range, "24h");
});

test("overview accepts 7d and rejects another range", async () => {
  assert.equal((await request(server, "/api/dashboard/overview?range=7d")).statusCode, 200);
  const invalid = await request(server, "/api/dashboard/overview?range=month");
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { success: false, code: "INVALID_RANGE" });
});
```

Refactor server construction only as needed to export a testable `createDashboardServer({ observabilityFilePath, systemInformation, startBackgroundServices })` without calling `listen` during import. Keep the executable entry point calling `start()`.

- [ ] **Step 2: Run the tests and verify the expected endpoint failure**

Run: `node --test tests/dashboard-overview-contract.test.cjs`

Expected: failure because `/api/dashboard/overview` is not registered.

- [ ] **Step 3: Integrate production adapters minimally**

```js
app.get("/api/dashboard/overview", async (req, res) => {
  const range = req.query.range || "24h";
  if (range !== "24h" && range !== "7d") return res.status(400).json({ success: false, code: "INVALID_RANGE" });
  res.json(await observability.getOverview(range));
});
```

Add `systeminformation` to `dashboard/package.json`, build health from CPU/memory/disk plus bot connection, derive fleet via `refreshBotRegistry`, groups via `getGroupSettingsPath`, commands via `getJsonFilePath("command.json")`, and messages from existing message-log reads. Start the service after configurations load; stop it on shutdown. Add sanitized activities at existing bot connect/disconnect and successful bot operation results.

- [ ] **Step 4: Run contract and regression tests**

Run: `node --test tests/dashboard-overview-contract.test.cjs tests/observability-store.test.cjs tests/observability-service.test.cjs tests/dashboard.test.cjs`

Expected: all tests pass with no unhandled rejection or missing-DOM noise.

### Task 4: Verify the dashboard-wide contract

**Files:**
- Modify: `package.json`
- Modify: `dashboard/package.json`

- [ ] **Step 1: Add the new observability tests to the root test command**

```json
"test": "node --test tests/fixes.test.js tests/dashboard.test.cjs tests/observability-store.test.cjs tests/observability-service.test.cjs tests/dashboard-overview-contract.test.cjs"
```

- [ ] **Step 2: Run UTF-8 validation**

Run: `node tests/check-dashboard-utf8.cjs`

Expected: `dashboard utf8 check passed`.

- [ ] **Step 3: Run the complete test command**

Run: `npm test`

Expected: zero failures; record any pre-existing `EPIPE` runner behavior separately if it still occurs.

- [ ] **Step 4: Inspect changed files for sensitive values**

Run: `rg -n -i "cookie|imei|useragent|credential" dashboard/observability tests/observability-*.test.cjs tests/dashboard-overview-contract.test.cjs`

Expected: occurrences appear only in explicit redaction test fixtures, never in emitted or persisted asserted payloads.
