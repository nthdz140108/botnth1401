import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocmemStore } from '../src/service-debug/locmem/locmem-store.js';
import { getConsecutiveCalendarDays } from '../src/service-debug/locmem/time-util.js';

test('calendar days survive restarts and recover historical startup flags', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locmem-calendar-'));
  const dbPath = path.join(dir, 'activity');
  let store = new LocmemStore({ dbPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const days = getConsecutiveCalendarDays('2026-11-24', 7);
  for (const day of days) {
    store.recordSnapshot('g', ['u'], day);
    store.recordDailyCoverageSnapshot('g', day, true);
    if (day === '2026-11-23' || day === '2026-11-19') store.recordDowntime(null, day, 'mid_day_listener_startup');
  }
  assert.equal(store.getQualified7DayWindow('g', '2026-11-24').qualified, true);
  store.close(); store = new LocmemStore({ dbPath });
  assert.equal(store.getQualified7DayWindow('g', '2026-11-24').completeDays.length, 7);
  assert.equal(store.getQualified7DayWindow('g', '2026-11-25').qualified, false);
});

test('today does not close early; missing snapshot and storage errors remain incomplete', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locmem-calendar-'));
  const store = new LocmemStore({ dbPath: path.join(dir, 'activity') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.recordSnapshot('g', ['u'], '2026-11-24');
  store.recordDailyCoverageSnapshot('g', '2026-11-24', true);
  store.recordDowntime(null, '2026-11-24', 'listener_disconnected');
  store.finalizeTrackedDays('2026-11-24');
  assert.equal(store.getDailyCoverage('g', '2026-11-24').is_complete, 0);
  store.finalizeTrackedDays('2026-11-25');
  assert.equal(store.getDailyCoverage('g', '2026-11-24').is_complete, 1);
  store.recordDowntime('g', '2026-11-23', 'mid_day_startup');
  store.recordSnapshot('g', ['u'], '2026-11-22');
  store.recordDailyCoverageSnapshot('g', '2026-11-22', true);
  store.recordDowntime('g', '2026-11-22', 'storage_error');
  store.finalizeTrackedDays('2026-11-25');
  assert.equal(store.getDailyCoverage('g', '2026-11-23').is_complete, 0);
  assert.equal(store.getDailyCoverage('g', '2026-11-22').is_complete, 0);
});
