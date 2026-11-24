import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocmemStore, closeAllLocmemStores } from "../src/service-debug/locmem/locmem-store.js";
import { handleDayRollover } from "../src/service-debug/locmem/locmem-tracker.js";

test("stored full-day evidence closes yesterday independently of failed group discovery", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locmem-rollover-"));
  const dbPath = path.join(dir, "activity");
  const store = new LocmemStore({ dbPath, botUid: "bot" });
  t.after(() => { closeAllLocmemStores(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.beginTrackingDay("2026-10-01");
  store.recordSnapshot("group", ["member"], "2026-10-01");
  store.recordDailyCoverageSnapshot("group", "2026-10-01", true);
  await handleDayRollover({ getAllGroups: async () => { throw new Error("offline"); } },
    { locmemDbPath: dbPath, botKey: "bot" },
    { yesterdayKey: "2026-10-01", todayKey: "2026-10-02" });
  assert.equal(store.getDailyCoverage("group", "2026-10-01").is_complete, 1);
});

test("calendar policy counts a disconnected day when its snapshot and data exist", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locmem-downtime-"));
  const store = new LocmemStore({ dbPath: path.join(dir, "activity"), botUid: "bot" });
  t.after(() => { closeAllLocmemStores(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.beginTrackingDay("2026-10-01");
  store.recordDowntime(null, "2026-10-01", "listener_disconnected");
  store.recordSnapshot("group", ["member"], "2026-10-01");
  store.recordDailyCoverageSnapshot("group", "2026-10-01", true);
  store.finalizeTrackedDays("2026-10-02");
  assert.equal(store.getDailyCoverage("group", "2026-10-01").is_complete, 1);
});

test("midnight rollover records the new tracking day before snapshot discovery", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locmem-start-"));
  const dbPath = path.join(dir, "activity");
  const store = new LocmemStore({ dbPath, botUid: "bot" });
  t.after(() => { closeAllLocmemStores(); fs.rmSync(dir, { recursive: true, force: true }); });
  await handleDayRollover({ getAllGroups: async () => ({ gridVerMap: {} }) },
    { locmemDbPath: dbPath, botKey: "bot" },
    { todayKey: "2026-10-02", trackingAtStart: true });
  assert.equal(store.meta.tracked_days?.["2026-10-02"]?.started, true);
});

test("corrupt stored day is reported rather than treated as an empty day", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locmem-corrupt-"));
  const store = new LocmemStore({ dbPath: path.join(dir, "activity"), botUid: "bot" });
  t.after(() => { closeAllLocmemStores(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(store.storeDir, "2026-10-01.json"), "{");
  assert.throws(() => store.getDailyCoverage("group", "2026-10-01"));
});
