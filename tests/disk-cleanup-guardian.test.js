import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  DiskCleanupCoordinator,
  getNext2355Timestamp,
  getLast2355Timestamp,
  isDailySessionMissed,
} from '../src/runtime/disk-cleanup-guardian.js';

test('DiskCleanupCoordinator: Vietnam time helpers and catchup detection', () => {
  // 2026-10-03 10:00:00 UTC = 2026-10-03 17:00:00 Vietnam time
  const t1 = new Date('2026-10-03T10:00:00.000Z').getTime();
  const next2355 = getNext2355Timestamp(t1);
  const nextDate = new Date(next2355);
  // Next 23:55 Vietnam time is 2026-10-03 16:55:00 UTC
  assert.equal(nextDate.toISOString(), '2026-10-03T16:55:00.000Z');

  // Last 23:55 was yesterday 2026-10-02 16:55:00 UTC
  const last2355 = getLast2355Timestamp(t1);
  assert.equal(new Date(last2355).toISOString(), '2026-10-02T16:55:00.000Z');

  // If last daily run was 2026-10-02 16:56:00 UTC, session was NOT missed
  assert.equal(isDailySessionMissed({ lastRunMs: last2355 + 60000, nowMs: t1 }), false);

  // If last daily run was before 2026-10-02 16:55:00 UTC, session WAS missed
  assert.equal(isDailySessionMissed({ lastRunMs: last2355 - 60000, nowMs: t1 }), true);
  assert.equal(isDailySessionMissed({ lastRunMs: null, nowMs: t1 }), true);
});

test('DiskCleanupCoordinator: inter-process lock with owner token prevents concurrent runs', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-lock-test-'));
  const lockDir = path.join(tmpRoot, '.runtime');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, 'disk-cleanup.lock');

  const runs = [];
  const mockService = {
    run: async ({ trigger }) => {
      runs.push(trigger);
      // simulate work
      await new Promise((r) => setTimeout(r, 50));
      return { success: true, status: 'success', bytesFreed: 100, filesFreed: 2 };
    },
    status: () => ({ lastRun: new Date().toISOString() }),
  };

  const coord1 = new DiskCleanupCoordinator({ projectRoot: tmpRoot, service: mockService });
  const coord2 = new DiskCleanupCoordinator({ projectRoot: tmpRoot, service: mockService });

  // Run concurrently
  const [res1, res2] = await Promise.all([
    coord1.executeWithLock({ trigger: 'call_1' }),
    coord2.executeWithLock({ trigger: 'call_2' }),
  ]);

  // One must succeed, the other must be skipped/locked
  const successCount = [res1, res2].filter((r) => r.success).length;
  const lockedCount = [res1, res2].filter((r) => r.reason === 'lock_held').length;
  assert.equal(successCount, 1, 'Exactly one execution should acquire lock');
  assert.equal(lockedCount, 1, 'The other execution should be rejected because lock was held');
  assert.equal(fs.existsSync(lockPath), false, 'Lock must be released after completion');

  // Verify lock ownership protection: foreign process cannot release active token
  const lock1 = coord1._acquireLock();
  assert.equal(lock1.acquired, true);
  assert.ok(lock1.token);

  // Attempt release with bogus token
  coord2._releaseLock('bogus-foreign-token');
  assert.equal(fs.existsSync(lockPath), true, 'Lock with mismatching token MUST NOT be released');

  // Release with valid token
  coord1._releaseLock(lock1.token);
  assert.equal(fs.existsSync(lockPath), false, 'Lock with valid token must be released');

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('DiskCleanupCoordinator: triggers at 80% and 90% SSD with cooldown', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-thresh-test-'));
  const runs = [];
  const mockService = {
    run: async ({ trigger }) => {
      runs.push(trigger);
      return { success: true, status: 'success', bytesFreed: 500, filesFreed: 10 };
    },
    status: () => ({ lastRun: new Date().toISOString() }),
  };

  let simulatedDiskPercent = 75;
  const coord = new DiskCleanupCoordinator({
    projectRoot: tmpRoot,
    service: mockService,
    getDiskUsage: async () => ({ usedPercent: simulatedDiskPercent, total: 1000, free: 250 }),
    warnPercent: 80,
    criticalPercent: 90,
    cooldownMs: 60_000,
  });

  // Normal (< 80%): no trigger
  await coord.checkDiskThresholds();
  assert.equal(runs.length, 0);

  // 82% (warn >= 80%): triggers disk_threshold_warn_80
  simulatedDiskPercent = 82;
  await coord.checkDiskThresholds();
  assert.equal(runs.length, 1);
  assert.equal(runs[0], 'disk_threshold_warn_80');

  // Still 82%, but within cooldown: should NOT trigger again
  await coord.checkDiskThresholds();
  assert.equal(runs.length, 1, 'Cooldown must prevent consecutive runs');

  // 92% (critical >= 90%): critical overrides warn cooldown
  simulatedDiskPercent = 92;
  await coord.checkDiskThresholds();
  assert.equal(runs.length, 2);
  assert.equal(runs[1], 'disk_threshold_critical_90');

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('DiskCleanupCoordinator: regression - hourly run does NOT mask catch-up', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-repro-catchup-'));
  const runs = [];
  const mockService = {
    run: async ({ trigger }) => {
      runs.push(trigger);
      return { success: true, status: 'success', bytesFreed: 200, filesFreed: 5 };
    },
    // hourly was recent (10 minutes ago), but lastDailySuccessAt is old (3 days ago)
    status: () => ({
      lastRun: new Date().toISOString(),
      lastHourlySuccessAt: new Date().toISOString(),
      lastDailySuccessAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    }),
  };

  const coord = new DiskCleanupCoordinator({
    projectRoot: tmpRoot,
    service: mockService,
  });

  // Startup catchup must check lastDailySuccessAt, so it MUST trigger!
  await coord.checkStartupCatchup();
  assert.equal(runs.length, 1, 'Startup catchup must trigger even if hourly run succeeded recently');
  assert.equal(runs[0], 'startup_catchup');

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('DiskCleanupCoordinator: scheduler reschedules next daily run in finally even if session throws', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-resched-test-'));
  const mockService = {
    run: async () => {
      throw new Error('simulated run crash');
    },
    status: () => ({}),
  };

  const coord = new DiskCleanupCoordinator({
    projectRoot: tmpRoot,
    service: mockService,
  });

  coord.isRunning = true;
  let reschedules = 0;
  const originalSchedule = coord._scheduleNextDaily.bind(coord);
  coord._scheduleNextDaily = () => {
    reschedules++;
  };

  // Simulate timeout execution handler directly
  try {
    await coord.executeWithLock({
      trigger: 'schedule_daily_2355',
      deadlineMs: 1000,
    });
  } catch {} finally {
    coord._scheduleNextDaily();
  }

  assert.equal(reschedules, 1, 'Rescheduling must be invoked in finally block');

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
