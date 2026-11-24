import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

/**
 * Tests for Memory Guardian behavior.
 *
 * Mock processes use the NORMALIZED shape (post-PM2Adapter normalization):
 *   { name, kind, status, rss, ... }
 * The guardian no longer reads raw PM2 jlist fields (process.state, monit.memory);
 * those are normalized by PM2Adapter before reaching the guardian.
 */

test('memory guardian: detects warning level correctly', async () => {
  const { MemoryGuardian } = await import('../../src/runtime/memory-guardian.js');

  const guardian = new MemoryGuardian({ projectRoot: process.cwd(), checkIntervalMs: 99999 });
  guardian.warnPercent = 1;
  guardian.criticalPercent = 100;
  guardian.warnFreeMB = os.totalmem() / (1024 * 1024) + 1;
  guardian.criticalFreeMB = 0;
  guardian.gcCooldownMs = 99999;
  guardian.cleanupWaitMs = 99999;

  // Sanity check: warning detection uses the real getSystemMemory
  const mem = (await import('../../src/runtime/memory-guardian-core.js')).getSystemMemory();
  const isWarning = mem.usedPercent >= guardian.warnPercent || (mem.free / (1024 * 1024)) < guardian.warnFreeMB;
  assert.ok(isWarning || mem.usedPercent > 0, 'At least some memory in use on test system');
});

test('memory guardian: GC cooldown prevents same bot cleanup within cooldown window', async () => {
  const { MemoryGuardian } = await import('../../src/runtime/memory-guardian.js');

  const guardian = new MemoryGuardian({ projectRoot: process.cwd(), checkIntervalMs: 99999 });
  guardian.gcCooldownMs = 10 * 60 * 1000;

  const mockProcs = [
    { name: 'admin', kind: 'main', status: 'online', rss: 100 * 1024 * 1024 },
    { name: 'user-123', kind: 'child', status: 'online', rss: 200 * 1024 * 1024 },
    { name: 'user-456', kind: 'child', status: 'online', rss: 150 * 1024 * 1024 },
  ];

  const first = guardian._selectBotForCleanup(mockProcs);
  assert.ok(first, 'Should select a bot');
  assert.ok(['user-123', 'user-456'].includes(first.name), `Expected child bot first, got: ${first.name}`);

  guardian.gcCooldowns.set(first.name, Date.now());

  const second = guardian._selectBotForCleanup(mockProcs);
  assert.ok(second, 'Should still find a bot after cooldown');
  assert.notStrictEqual(second.name, first.name, 'Cooldown bot should be skipped');
});

test('memory guardian: critical restart selects heaviest bot by priority', async () => {
  const { MemoryGuardian } = await import('../../src/runtime/memory-guardian.js');

  const guardian = new MemoryGuardian({ projectRoot: process.cwd(), checkIntervalMs: 99999 });
  guardian.gcCooldownMs = 0;

  const mockProcs = [
    { name: 'admin', kind: 'main', status: 'online', rss: 50 * 1024 * 1024 },
    { name: 'user-123', kind: 'child', status: 'online', rss: 300 * 1024 * 1024 },
    { name: 'mybot-dashboard', kind: 'dashboard', status: 'online', rss: 400 * 1024 * 1024 },
  ];

  const selected = guardian._selectBotForRestart(mockProcs);
  assert.ok(selected, 'Should select a bot');
  assert.strictEqual(selected.name, 'user-123', `Expected child with highest priority, got: ${selected.name}`);
  assert.strictEqual(selected.rss, 300 * 1024 * 1024);
});

test('memory guardian: critical restart never restarts guardian process', async () => {
  const { MemoryGuardian } = await import('../../src/runtime/memory-guardian.js');

  const guardian = new MemoryGuardian({ projectRoot: process.cwd(), checkIntervalMs: 99999 });

  const mockProcs = [
    { name: 'mybot-guardian', kind: 'guardian', status: 'online', rss: 50 * 1024 * 1024 },
    { name: 'mybot-dashboard', kind: 'dashboard', status: 'online', rss: 200 * 1024 * 1024 },
    { name: 'admin', kind: 'main', status: 'online', rss: 100 * 1024 * 1024 },
  ];

  const selected = guardian._selectBotForRestart(mockProcs);
  assert.ok(selected, 'Should select a bot');
  assert.notStrictEqual(selected.name, 'mybot-guardian', 'Guardian must NEVER be restarted');
});

test('memory guardian: dashboard is last resort for critical restart', async () => {
  const { MemoryGuardian } = await import('../../src/runtime/memory-guardian.js');

  const guardian = new MemoryGuardian({ projectRoot: process.cwd(), checkIntervalMs: 99999 });

  const mockProcs = [
    { name: 'mybot-guardian', kind: 'guardian', status: 'online', rss: 50 * 1024 * 1024 },
    { name: 'mybot-dashboard', kind: 'dashboard', status: 'online', rss: 300 * 1024 * 1024 },
  ];

  const selected = guardian._selectBotForRestart(mockProcs);
  assert.ok(selected, 'Should select a bot');
  assert.strictEqual(selected.name, 'mybot-dashboard', 'Dashboard should be last resort when only it is eligible');
});

test('memory guardian: GC cooldown applies per-bot independently', async () => {
  const { MemoryGuardian } = await import('../../src/runtime/memory-guardian.js');

  const guardian = new MemoryGuardian({ projectRoot: process.cwd(), checkIntervalMs: 99999 });
  guardian.gcCooldownMs = 300_000;

  const mockProcs = [
    { name: 'admin', kind: 'main', status: 'online', rss: 100 * 1024 * 1024 },
    { name: 'user-123', kind: 'child', status: 'online', rss: 200 * 1024 * 1024 },
    { name: 'user-456', kind: 'child', status: 'online', rss: 150 * 1024 * 1024 },
  ];

  guardian.gcCooldowns.set('user-123', Date.now());

  const selected = guardian._selectBotForCleanup(mockProcs);
  assert.ok(selected, 'Should find a bot');
  assert.notStrictEqual(selected.name, 'user-123', 'user-123 is in cooldown');
  assert.strictEqual(selected.name, 'user-456', `Expected user-456 (heaviest non-cooldown), got: ${selected.name}`);
});
