import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('terminal render utilities', async () => {
  const { pad, truncate, stripAnsi, formatUptime, formatMemory } = await import('../../src/runtime/terminal-render.js');

  // pad
  assert.equal(pad('hi', 5), 'hi   ');
  assert.equal(pad('hi', 5, ' ', 'left'), '   hi');
  assert.equal(pad('hello world', 5), 'hell…');

  // truncate
  assert.equal(truncate('hello world', 5), 'hell…');
  assert.equal(truncate('hi', 10), 'hi');

  // stripAnsi
  assert.equal(stripAnsi('\x1b[32mgreen\x1b[0m'), 'green');
  assert.equal(stripAnsi('plain text'), 'plain text');

  // formatUptime
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(5000), '5s');
  assert.equal(formatUptime(65000), '1m 5s');
  assert.equal(formatUptime(3_600_000), '1h 0m');
  assert.equal(formatUptime(86_400_000), '1d 0h');

  // formatMemory
  assert.equal(formatMemory(0), '0MB');
  assert.equal(formatMemory(1024 * 1024), '1.0MB');
  assert.equal(formatMemory(5.5 * 1024 * 1024), '5.5MB');
});

test('terminal monitor: redraws when process list changes', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  let callCount = 0;
  const mockAdapter = {
    listProcesses: async () => {
      callCount++;
      // Use NORMALIZED shape (post-PM2Adapter normalization)
      return [
        { name: 'admin', kind: 'main', status: 'online', pid: 100, pm2Id: 0, rss: 100 * 1024 * 1024, uptime: 30000 },
        { name: 'user-123', kind: 'child', status: 'online', pid: 101, pm2Id: 1, rss: 50 * 1024 * 1024, uptime: 20000 },
      ];
    },
  };
  monitor.adapter = mockAdapter;
  const lines = [];
  monitor.onOutput = (line) => lines.push(line);
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    monitor.start();
    await new Promise(r => setTimeout(r, 250));
    await monitor.stop();
    assert.ok(callCount >= 2, `Expected at least 2 calls, got ${callCount}`);
    const headerCount = lines.filter(l => l.includes('BOT NAME')).length;
    assert.ok(headerCount <= 1, `Header should appear at most once, got ${headerCount}: ${JSON.stringify(lines)}`);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('terminal monitor: redraws when process list changes', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  let callCount = 0;
  const mockAdapter = {
    listProcesses: async () => {
      callCount++;
      if (callCount === 1) {
        return [{ name: 'admin', kind: 'main', status: 'online', pid: 100, pm2Id: 0, rss: 100 * 1024 * 1024, uptime: 30000 }];
      }
      return [
        { name: 'admin', kind: 'main', status: 'online', pid: 100, pm2Id: 0, rss: 200 * 1024 * 1024, uptime: 30000 },
        { name: 'user-123', kind: 'child', status: 'online', pid: 101, pm2Id: 1, rss: 50 * 1024 * 1024, uptime: 10000 },
      ];
    },
  };
  monitor.adapter = mockAdapter;
  const lines = [];
  monitor.onOutput = (line) => lines.push(line);
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    monitor.start();
    await new Promise(r => setTimeout(r, 300));
    await monitor.stop();
    const headerCount = lines.filter(l => l.includes('BOT NAME')).length;
    assert.ok(headerCount >= 2, `Header should appear at least 2 times on change, got ${headerCount}`);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('terminal monitor: only redraws when process list changes (no change case)', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  let callCount = 0;
  const mockAdapter = {
    listProcesses: async () => {
      callCount++;
      return [
        { name: 'admin', kind: 'main', status: 'online', pid: 100, pm2Id: 0, rss: 100 * 1024 * 1024, uptime: 30000 },
      ];
    },
  };
  monitor.adapter = mockAdapter;
  const lines = [];
  monitor.onOutput = (line) => lines.push(line);
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    monitor.start();
    await new Promise(r => setTimeout(r, 250));
    await monitor.stop();
    assert.ok(callCount >= 2, `Expected at least 2 calls, got ${callCount}`);
    const headerCount = lines.filter(l => l.includes('BOT NAME')).length;
    assert.ok(headerCount <= 1, `Header should appear at most once when no change, got ${headerCount}`);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('terminal monitor: shows error state when PM2 unavailable with backoff', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 30 });
  const mockAdapter = {
    listProcesses: async () => null,
  };
  monitor.adapter = mockAdapter;
  const lines = [];
  monitor.onOutput = (line) => lines.push(line);
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    monitor.start();
    await new Promise(r => setTimeout(r, 150));
    await monitor.stop();
    const hasError = lines.some(l => l.includes('PM2 UNAVAILABLE') || l.includes('Cannot connect'));
    assert.ok(hasError, `Should show PM2 error state, got: ${JSON.stringify(lines)}`);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('terminal monitor: does not stream message/command logs', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 30 });
  const mockAdapter = {
    listProcesses: async () => [
      { name: 'admin', kind: 'main', status: 'online', pid: 100, pm2Id: 0, rss: 100 * 1024 * 1024, uptime: 30000 },
    ],
  };
  monitor.adapter = mockAdapter;
  const lines = [];
  monitor.onOutput = (line) => lines.push(line);
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    monitor.start();
    await new Promise(r => setTimeout(r, 100));
    await monitor.stop();
    const forbidden = ['!mybot', '[CMD]', 'message', 'error', 'stack', 'Error:'];
    for (const word of forbidden) {
      const found = lines.some(l => l.toLowerCase().includes(word.toLowerCase()));
      assert.ok(!found, `Monitor should not show '${word}' content, but found: ${JSON.stringify(lines)}`);
    }
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('reconcile: starts main + dashboard + guardian via adapter', async () => {
  const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
  const root = process.cwd();
  const started = [];
  const mockAdapter = {
    listProcesses: async () => [],
    startBot: async (desc) => { started.push(desc.pm2Name); return { success: true, pm2Name: desc.pm2Name }; },
    stopBot: async () => ({ success: true }),
    restartBot: async () => ({ success: true }),
    deleteBot: async () => ({ success: true }),
    sendMemoryPressure: async () => ({ success: true }),
  };
  const main = createLaunchDescriptor({ kind: 'main', projectRoot: root });
  const dash = createLaunchDescriptor({ kind: 'dashboard', projectRoot: root });
  const guard = createLaunchDescriptor({ kind: 'guardian', projectRoot: root });
  await mockAdapter.startBot(main);
  await mockAdapter.startBot(dash);
  await mockAdapter.startBot(guard);
  assert.deepEqual(started, ['admin', 'mybot-dashboard', 'mybot-guardian']);
  assert.equal(dash.pm2MaxMemoryRestart, '180M');
  assert.equal(guard.pm2MaxMemoryRestart, '150M');
  assert.equal(main.pm2MaxMemoryRestart, '512M');
});

test('run.bat file exists and uses reconcile-and-monitor', async () => {
  const fs = await import('node:fs');
  const runBatPath = path.resolve('run.bat');
  if (!fs.existsSync(runBatPath)) return;
  const content = fs.readFileSync(runBatPath, 'utf8');
  assert.ok(!content.includes('start "MyBot Bot"'), 'run.bat must NOT open separate CMD for bot');
  assert.ok(content.includes('reconcile-and-monitor') || content.includes('terminal-monitor'), 'run.bat must invoke reconcile-and-monitor script');
});
