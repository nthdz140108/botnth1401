import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocmemStore } from '../src/service-debug/locmem/locmem-store.js';
import { getConsecutiveCalendarDays } from '../src/service-debug/locmem/time-util.js';
import { runMonthlyCleanup } from '../src/service-debug/locmem/locmem-cleanup.js';
import { handleLocmemCommand } from '../src/service-debug/locmem/locmem-service.js';
import { PendingConfirmationManager } from '../src/service-debug/locmem/locmem-pending.js';
test('30 day window requires every day and survives monthly cleanup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locmem30-'));
  const store = new LocmemStore({ dbPath: path.join(dir, 'activity') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const days = getConsecutiveCalendarDays('2026-11-24', 30);
  for (const day of days.slice(0, 29)) {
    store.recordSnapshot('g', ['inactive', 'active'], day);
    store.recordDailyCoverageSnapshot('g', day, true);
  }
  assert.equal(store.getQualifiedWindow('g', '2026-11-24').qualified, false);
  store.recordSnapshot('g', ['inactive', 'active'], days[29]);
  store.recordDailyCoverageSnapshot('g', days[29], true);
  store.recordActivity({ groupId: 'g', memberId: 'active', dateKey: days[29], messageCount: 1 });
  runMonthlyCleanup('admin', { storeOverride: store, todayKey: '2026-11-24', monthKey: '2026-11', force: true });
  assert.equal(store.getQualifiedWindow('g', '2026-11-24').completeDays.length, 30);
  assert.deepEqual(store.getInactiveCandidates({ groupId: 'g', completeDays: days, todayDateKey: '2026-11-24', requiredDays: 30 }), ['inactive']);
});

test('real command sends previews one second apart without spending scan deadline on pacing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locmem30-send-'));
  const store = new LocmemStore({ dbPath: path.join(dir, 'activity') });
  const manager = new PendingConfirmationManager();
  t.after(() => { manager.clear(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const members = Array.from({ length: 26 }, (_, i) => String(100 + i));
  for (const day of getConsecutiveCalendarDays('2026-11-24', 30)) {
    store.recordSnapshot('g', members, day);
    store.recordDailyCoverageSnapshot('g', day, true);
  }
  const times = [];
  const messages = [];
  const result = await handleLocmemCommand({
    api: {
      getGroupInfo: async () => ({ creatorId: 'current_bot_id', memVerList: members }),
      sendMessage: async payload => { times.push(Date.now()); messages.push(payload.msg); return { msgId: String(times.length) }; },
    },
    botUid: 'current_bot_id', threadId: 'g', senderId: 'admin', todayKey: '2026-11-24',
    authorization: { isAdminLevelHigh: true }, storeOverride: store, pendingManager: manager, scanDeadlineMs: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1000);
  assert.ok(messages[0].includes('30 ngày'));
  assert.ok(manager.hasPending('g'));
});
