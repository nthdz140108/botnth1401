import test from 'node:test';
import assert from 'node:assert/strict';
import { probeBotReadiness, waitForBotReadiness, matchesBotIdentity } from '../../src/runtime/runtime-readiness.js';

const MAIN_DESC = { kind: 'main', botKey: 'admin', webPort: 2000, pm2Name: 'admin' };
const CHILD_DESC = { kind: 'child', botKey: 'user-123', webPort: 3001, pm2Name: 'user-123' };

// Online process snapshots (normalized PM2 shape).
const ONLINE_MAIN = { name: 'admin', kind: 'main', botKey: 'admin', status: 'online', pid: 102, uptime: 30000, restartCount: 0, env: { BOT_MANAGED: 'true', BOT_KEY: 'admin', WEB_PORT: '2000' } };
const ONLINE_CHILD = { name: 'user-123', kind: 'child', botKey: 'user-123', status: 'online', pid: 103, uptime: 20000, restartCount: 0, env: { BOT_MANAGED: 'true', BOT_KEY: 'user-123', WEB_PORT: '3001' } };

// Valid identity payloads (matching /internal/runtime/identity shape).
const IDENTITY_MAIN = { success: true, kind: 'main', botKey: 'admin', configuredUid: 'admin', pid: 102, webPort: 2000, listenerConnected: true, listenerState: 'connected' };
const IDENTITY_CHILD = { success: true, kind: 'child', botKey: 'user-123', configuredUid: 'user-123', pid: 103, webPort: 3001, listenerConnected: true, listenerState: 'connected' };

test('matchesBotIdentity: accepts matching kind/key/pid', () => {
  assert.equal(matchesBotIdentity({ descriptor: MAIN_DESC, identity: IDENTITY_MAIN, expectedPid: 102 }), true);
  assert.equal(matchesBotIdentity({ descriptor: CHILD_DESC, identity: IDENTITY_CHILD, expectedPid: 103 }), true);
});

test('matchesBotIdentity: rejects wrong kind, key, or pid', () => {
  // Wrong kind (child identity for main bot)
  assert.equal(matchesBotIdentity({ descriptor: MAIN_DESC, identity: { ...IDENTITY_CHILD, botKey: 'admin', pid: 102 }, expectedPid: 102 }), false);
  // Wrong botKey — override the key fields so configuredUid/liveZaloUid cannot
  // mask the mismatch.
  assert.equal(matchesBotIdentity({ descriptor: CHILD_DESC, identity: { ...IDENTITY_CHILD, botKey: 'OTHER', configuredUid: 'OTHER', liveZaloUid: 'OTHER' }, expectedPid: 103 }), false);
  // Wrong pid
  assert.equal(matchesBotIdentity({ descriptor: MAIN_DESC, identity: { ...IDENTITY_MAIN, pid: 999 }, expectedPid: 102 }), false);
});

test('matchesBotIdentity: payload missing pid/listener fields is never ready', () => {
  // Missing pid — old/foreign process must not fake readiness.
  const noPid = { kind: 'main', botKey: 'admin', listenerConnected: true };
  assert.equal(matchesBotIdentity({ descriptor: MAIN_DESC, identity: noPid }), false);
  // Missing listenerConnected boolean.
  const noListener = { kind: 'main', botKey: 'admin', pid: 102 };
  assert.equal(matchesBotIdentity({ descriptor: MAIN_DESC, identity: noListener }), false);
  // Missing botKey.
  const noKey = { kind: 'main', pid: 102, listenerConnected: true };
  assert.equal(matchesBotIdentity({ descriptor: MAIN_DESC, identity: noKey }), false);
});

test('probeBotReadiness: ready only when all four layers pass', async () => {
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    portProbe: async () => true,
    identityFetcher: async () => IDENTITY_MAIN,
  });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'running');
  assert.equal(result.reason, 'ready');
});

test('probeBotReadiness: pm2-stopped when process not online', async () => {
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: { ...ONLINE_MAIN, status: 'stopped' },
    portProbe: async () => true,
    identityFetcher: async () => IDENTITY_MAIN,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'pm2-stopped');
});

test('probeBotReadiness: port-closed when port does not answer', async () => {
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    portProbe: async () => false,
    identityFetcher: async () => IDENTITY_MAIN,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'port-closed');
});

test('probeBotReadiness: identity-unavailable when endpoint missing', async () => {
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    portProbe: async () => true,
    identityFetcher: async () => null,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'identity-unavailable');
});

test('probeBotReadiness: pid-mismatch when a stale PID occupies the port', async () => {
  // PM2 reports online pid 102 but the process actually serving on the port is
  // a different (old) bot with pid 999 — must not be ready.
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: { ...ONLINE_MAIN, pid: 102 },
    expectedPid: 102,
    portProbe: async () => true,
    identityFetcher: async () => ({ ...IDENTITY_MAIN, pid: 999 }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'pid-mismatch');
});

test('probeBotReadiness: identity-mismatch for a different bot on the port', async () => {
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    portProbe: async () => true,
    identityFetcher: async () => ({ ...IDENTITY_CHILD, botKey: 'user-123', pid: 102 }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'identity-mismatch');
});

test('probeBotReadiness: listener-disconnected when the Zalo listener is down', async () => {
  const result = await probeBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    portProbe: async () => true,
    identityFetcher: async () => ({ ...IDENTITY_MAIN, listenerConnected: false, listenerState: 'retrying' }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'listener-disconnected');
});

test('waitForBotReadiness: returns ready once identity arrives', async () => {
  let served = 0;
  const result = await waitForBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    timeoutMs: 5000,
    intervalMs: 10,
    portProbe: async () => true,
    identityFetcher: async () => {
      served += 1;
      return IDENTITY_MAIN;
    },
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.ok(served >= 1);
});

test('waitForBotReadiness: times out with readiness-timeout and detects stopping', async () => {
  const result = await waitForBotReadiness({
    descriptor: MAIN_DESC,
    process: ONLINE_MAIN,
    timeoutMs: 50,
    intervalMs: 10,
    portProbe: async () => false,
    identityFetcher: async () => null,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 20); })(),
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'readiness-timeout');
});

test('waitForBotReadiness: passes pm2Name to supervisor and aborts early on crash-loop', async () => {
  const observedNames = [];
  let restarts = 0;
  const result = await waitForBotReadiness({
    descriptor: MAIN_DESC,
    process: { ...ONLINE_MAIN, restartCount: 0 },
    supervisor: async (pm2Name) => {
      observedNames.push(pm2Name);
      restarts += 1;
      return { ...ONLINE_MAIN, restartCount: restarts };
    },
    timeoutMs: 165_000,
    intervalMs: 10,
    portProbe: async () => false,
    identityFetcher: async () => null,
    sleep: async () => {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'crash-loop');
  assert.deepEqual(observedNames, ['admin', 'admin', 'admin']);
});
