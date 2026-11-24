const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const storeModuleUrl = pathToFileURL(path.join(__dirname, "../dashboard/observability/store.js")).href;

async function makeFixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mybot-observability-"));
  const filePath = path.join(directory, "metrics.json");
  return { directory, filePath, cleanup: () => fsp.rm(directory, { recursive: true, force: true }) };
}

async function createStore(filePath, now) {
  const { createObservabilityStore } = await import(storeModuleUrl);
  return createObservabilityStore({ filePath, now });
}

test("store aggregates samples into one-minute buckets", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const store = await createStore(fixture.filePath, () => new Date("2026-08-06T00:00:30.000Z"));
  await store.load();
  await store.recordSample({ timestamp: "2026-08-06T00:00:10.000Z", cpu: 10, memory: 20, disk: 30, onlineBots: 2, messages: 3, alerts: 1 });
  await store.recordSample({ timestamp: "2026-08-06T00:00:40.000Z", cpu: 30, memory: 40, disk: 50, onlineBots: 4, messages: 5, alerts: 2 });

  assert.deepEqual(store.getState().minuteBuckets, [{
    timestamp: "2026-08-06T00:00:00.000Z", cpuAvg: 20, cpuMax: 30, memoryAvg: 30,
    diskAvg: 40, onlineBots: 4, messages: 8, alerts: 3,
  }]);
});

test("store prunes expired samples and retains the newest 1,000 activities", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const now = () => new Date("2026-08-06T00:00:00.000Z");
  const store = await createStore(fixture.filePath, now);
  await store.load();
  await store.recordSample({ timestamp: "2026-07-29T23:59:59.000Z", cpu: 1, memory: 1, disk: 1, onlineBots: 0, messages: 0, alerts: 0 });
  for (let index = 0; index < 1001; index += 1) {
    await store.recordActivity({ type: "bot-status", timestamp: new Date(Date.parse("2026-08-05T00:00:00.000Z") + index).toISOString(), index });
  }

  const state = store.getState();
  assert.equal(state.samples.length, 0);
  assert.equal(state.activities.length, 1000);
  assert.equal(state.activities[0].index, 1);
});

test("store persists atomically and reloads saved state", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const store = await createStore(fixture.filePath, () => new Date("2026-08-06T00:00:00.000Z"));
  await store.load();
  await store.recordActivity({ type: "bot-status", timestamp: "2026-08-06T00:00:00.000Z" });
  await store.flush();

  assert.equal(fs.existsSync(`${fixture.filePath}.tmp`), false);
  const reloaded = await createStore(fixture.filePath, () => new Date("2026-08-06T00:00:00.000Z"));
  await reloaded.load();
  assert.deepEqual(reloaded.getState().activities, [{ type: "bot-status", timestamp: "2026-08-06T00:00:00.000Z" }]);
});

test("store recovers from corrupt JSON by renaming the damaged file", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await fsp.writeFile(fixture.filePath, "{not json}", "utf8");
  const store = await createStore(fixture.filePath, () => new Date("2026-08-06T00:00:00.000Z"));
  await store.load();

  assert.deepEqual(store.getState().activities, []);
  assert.equal((await fsp.readdir(fixture.directory)).some((name) => name.startsWith("metrics.json.corrupt-")), true);
});
