import test from 'node:test';
import assert from 'node:assert/strict';

test('terminal monitor: infra rows labeled infra without probing, bot rows resolved by real readiness', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  const probed = [];
  const mockAdapter = {
    listProcesses: async () => [
      { name: 'mybot-dashboard', kind: 'dashboard', status: 'online', pid: 100, pm2Id: 0, rss: 100 * 1024 * 1024, uptime: 30000 },
      { name: 'mybot-guardian', kind: 'guardian', status: 'online', pid: 101, pm2Id: 1, rss: 50 * 1024 * 1024, uptime: 30000 },
      { name: 'admin', kind: 'main', status: 'online', pid: 102, pm2Id: 2, rss: 100 * 1024 * 1024, uptime: 30000, env: { BOT_MANAGED: 'true', BOT_KEY: 'admin', WEB_PORT: '2000' } },
      { name: 'user-123', kind: 'child', status: 'online', pid: 103, pm2Id: 3, rss: 50 * 1024 * 1024, uptime: 20000, env: { BOT_MANAGED: 'true', BOT_KEY: 'user-123', WEB_PORT: '3001' } },
    ],
  };
  monitor.adapter = mockAdapter;
  monitor.portProbe = async (port) => { probed.push(port); return true; };
  monitor.identityFetcher = async (port) => {
    if (port === 2000) return { kind: 'main', botKey: 'admin', liveZaloUid: 'u-main', pid: 102, listenerConnected: true };
    return { kind: 'child', botKey: 'user-123', liveZaloUid: 'u-123', pid: 103, listenerConnected: true };
  };
  const lines = [];
  monitor.onOutput = (line) => lines.push(line);
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    monitor.start();
    await new Promise(r => setTimeout(r, 200));
    await monitor.stop();
    const table = lines.join('\n');
    assert.ok(table.includes('READINESS'), 'readiness column header must be present');
    assert.ok(table.includes('infra'), 'infrastructure rows must be labeled infra');
    assert.ok(table.includes('ready'), 'verified bot rows must show ready');
    // At least one tick probes exactly the two bot ports (no infra ports).
    const uniqueProbed = [...new Set(probed)].sort((a, b) => a - b);
    assert.deepEqual(uniqueProbed, [2000, 3001], 'only bot ports may be probed');
    assert.ok(!table.includes('n/a'), 'no row may show n/a anymore');
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('terminal monitor: shows concrete not-ready reasons for bot rows', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  const mockAdapter = {
    listProcesses: async () => [
      { name: 'admin', kind: 'main', status: 'stopped', pid: null, pm2Id: 0, rss: 0, uptime: 0 },
      { name: 'bot-a', kind: 'child', status: 'online', pid: 110, pm2Id: 1, rss: 10, uptime: 5000, env: { BOT_MANAGED: 'true', BOT_KEY: 'bot-a', WEB_PORT: '3101' } },
      { name: 'bot-b', kind: 'child', status: 'online', pid: 111, pm2Id: 2, rss: 10, uptime: 5000, env: { BOT_MANAGED: 'true', BOT_KEY: 'bot-b', WEB_PORT: '3102' } },
      { name: 'bot-c', kind: 'child', status: 'online', pid: 112, pm2Id: 3, rss: 10, uptime: 5000, env: { BOT_MANAGED: 'true', BOT_KEY: 'bot-c', WEB_PORT: '3103' } },
    ],
  };
  monitor.adapter = mockAdapter;
  monitor.portProbe = async (port) => port !== 3102; // 3102 closed
  monitor.identityFetcher = async (port) => {
    if (port === 3103) return { kind: 'child', botKey: 'OTHER', liveZaloUid: 'x', pid: 112, listenerConnected: true }; // mismatch
    return { kind: 'child', botKey: 'bot-a', liveZaloUid: 'x', pid: 110, listenerConnected: true };
  };
  const rows = await monitor._fetchState();
  const labels = await Promise.all(rows.map((p) => monitor._readinessLabel(p)));
  // Order rows by name to be robust against list ordering.
  const byName = Object.fromEntries(rows.map((p, i) => [p.name, labels[i]]));
  assert.equal(byName['admin'], 'pm2-stopped');
  assert.equal(byName['bot-a'], 'ready');
  assert.equal(byName['bot-b'], 'port-closed');
  assert.equal(byName['bot-c'], 'identity-mismatch');
});

test('terminal monitor: compact table under 96 columns never exceeds width', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const { stripAnsi } = await import('../../src/runtime/terminal-render.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  const mockAdapter = {
    listProcesses: async () => [
      { name: 'mybot-dashboard', kind: 'dashboard', status: 'online', pid: 100, pm2Id: 0, rss: 100 * 1024 * 1024, uptime: 30000 },
      { name: 'admin', kind: 'main', status: 'online', pid: 102, pm2Id: 2, rss: 100 * 1024 * 1024, uptime: 30000, env: { BOT_MANAGED: 'true', BOT_KEY: 'admin', WEB_PORT: '2000' } },
    ],
  };
  monitor.adapter = mockAdapter;
  monitor.portProbe = async () => true;
monitor.identityFetcher = async () => ({ kind: 'main', botKey: 'admin', liveZaloUid: 'u', pid: 102, listenerConnected: true });
  const withReadiness = await monitor._withReadiness(await monitor._fetchState());
  for (const width of [80, 90]) {
    const lines = monitor._renderTable(withReadiness, { width });
    for (const line of lines) {
      assert.ok(
        stripAnsi(line).length <= width,
        `line must fit ${width} cols: "${stripAnsi(line)}" (${stripAnsi(line).length})`,
      );
    }
    const table = lines.join('\n');
    assert.ok(table.includes('READINESS'), 'compact table keeps readiness');
    assert.ok(!table.includes('UPTIME'), 'compact table drops uptime column');
    assert.ok(!table.includes('RAM'), 'compact table drops RAM column');
  }
});

test('terminal monitor: wide table (>=96 cols) keeps RAM and uptime columns', async () => {
  const { TerminalMonitor } = await import('../../src/runtime/terminal-monitor.js');
  const { stripAnsi } = await import('../../src/runtime/terminal-render.js');
  const monitor = new TerminalMonitor({ projectRoot: '/proj', refreshMs: 60 });
  const mockAdapter = {
    listProcesses: async () => [
      { name: 'admin', kind: 'main', status: 'online', pid: 102, pm2Id: 2, rss: 100 * 1024 * 1024, uptime: 30000, env: { BOT_MANAGED: 'true', BOT_KEY: 'admin', WEB_PORT: '2000' } },
    ],
  };
  monitor.adapter = mockAdapter;
  monitor.portProbe = async () => true;
  monitor.identityFetcher = async () => ({ kind: 'main', botKey: 'admin', liveZaloUid: 'u', pid: 102, listenerConnected: true });
  const withReadiness = await monitor._withReadiness(await monitor._fetchState());
  for (const width of [96, 120]) {
    const lines = monitor._renderTable(withReadiness, { width });
    for (const line of lines) {
      assert.ok(
        stripAnsi(line).length <= width,
        `line must fit ${width} cols: "${stripAnsi(line)}" (${stripAnsi(line).length})`,
      );
    }
    const table = lines.join('\n');
    assert.ok(table.includes('RAM'), `full table keeps RAM at ${width}`);
    assert.ok(table.includes('UPTIME'), `full table keeps uptime at ${width}`);
  }
});

