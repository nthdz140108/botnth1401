import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryGuardian } from '../src/runtime/memory-guardian-core.js';
import { getNext2355Timestamp } from '../src/runtime/disk-cleanup-guardian.js';

test('MemoryGuardian integration: fake clock runs 23:55 session, records status, and reschedules next day', async () => {
  const tmpRoot = path.join(os.tmpdir(), `mybot-guardian-sched-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const statusPath = path.join(tmpRoot, '.runtime', 'disk-cleanup', 'status.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });

  // Today at 16:50:00 UTC = 23:50:00 Vietnam time
  const baseTime = Date.UTC(2026, 9, 10, 16, 50, 0, 0);
  let currentTime = baseTime;
  const now = () => currentTime;

  // Set previous day 23:55 as lastDailySuccessAt so startup catchup is not triggered
  const yesterday2355 = baseTime - (24 * 3600 * 1000) + (5 * 60 * 1000);
  fs.writeFileSync(statusPath, JSON.stringify({
    schemaVersion: 1,
    status: 'success',
    lastDailySuccessAt: new Date(yesterday2355).toISOString(),
    guardianHeartbeatAt: new Date(baseTime).toISOString(),
    nextDailyRunAt: new Date(baseTime + 5 * 60 * 1000).toISOString(),
  }, null, 2), 'utf8');

  // Fake timer store to control timeouts deterministically
  const scheduledTimers = [];
  let timerIdSeq = 1;

  const fakeSetTimeout = (fn, delayMs) => {
    const id = timerIdSeq++;
    const timerObj = { id, fn, delayMs, active: true };
    scheduledTimers.push(timerObj);
    return timerObj;
  };

  const fakeClearTimeout = (timerObj) => {
    if (timerObj) timerObj.active = false;
  };

  const fakeSetInterval = () => ({ id: timerIdSeq++, active: true });
  const fakeClearInterval = () => {};

  const mockAdapter = {
    listProcesses: async () => [
      { name: 'mybot-dashboard', status: 'online', outLogPath: null, errorLogPath: null },
    ],
    listManagedProcesses: async () => [
      { name: 'mybot-dashboard', status: 'online', outLogPath: null, errorLogPath: null },
    ],
  };

  const guardian = new MemoryGuardian({
    projectRoot: tmpRoot,
    now,
    adapter: mockAdapter,
    coordinatorOptions: {
      now,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
      setIntervalFn: fakeSetInterval,
      clearIntervalFn: fakeClearInterval,
      service: null, // Let coordinator instantiate with tmpRoot
    },
  });

  // Start guardian
  guardian.start();

  // Find daily scheduled timer
  const dailyTimer = scheduledTimers.find((t) => t.delayMs === (5 * 60 * 1000)); // 5 minutes to 23:55
  assert.ok(dailyTimer, 'Guardian must schedule 23:55 daily session for 5 minutes in the future');

  // Advance fake clock by 5 minutes to 23:55:00 Vietnam time
  currentTime += (5 * 60 * 1000) + 1000; // 23:55:01
  scheduledTimers.length = 0; // Clear queue to capture rescheduling

  // Trigger scheduled 23:55 callback
  await dailyTimer.fn();

  // 1. Verify status was recorded
  assert.ok(fs.existsSync(statusPath), 'Status file must be written to disk');
  const statusContent = JSON.parse(fs.readFileSync(statusPath, 'utf8'));

  assert.equal(statusContent.status, 'success', 'Daily run must complete successfully');
  assert.equal(statusContent.inventoryComplete, true, 'Inventory must be complete');
  assert.ok(statusContent.lastDailySuccessAt, 'lastDailySuccessAt must be set');
  assert.ok(statusContent.guardianHeartbeatAt, 'guardianHeartbeatAt must be set');

  // 2. Verify next run was rescheduled for tomorrow at 23:55 (+24 hours minus 1s)
  const rescheduledTimer = scheduledTimers.find((t) => t.delayMs > 23 * 3600 * 1000);
  assert.ok(rescheduledTimer, 'Scheduler must reschedule next daily run for tomorrow in finally block');

  const expectedTomorrow2355 = getNext2355Timestamp(currentTime);
  const diffFromTomorrow = Math.abs((currentTime + rescheduledTimer.delayMs) - expectedTomorrow2355);
  assert.ok(diffFromTomorrow < 2000, 'Rescheduled delay must point exactly to tomorrow 23:55');

  // 3. Clean shutdown
  guardian.stop();
  assert.equal(guardian.isRunning, false);
  assert.equal(guardian.diskCoordinator.isRunning, false);

  // Clean test tmp
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
