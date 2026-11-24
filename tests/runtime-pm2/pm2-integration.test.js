import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

/**
 * Real PM2 integration test (smoke only).
 *
 * Verifies that:
 * 1. PM2 binary is locally installed and reachable
 * 2. The adapter can be constructed without throwing
 * 3. pm2 jlist returns something (empty or populated — the key is no crash)
 *
 * Full daemon tests (start/restart/stop/delete) are left to a manual VPS test
 * because PM2 daemon startup is unreliable in Windows CI/test environments due to
 * process isolation, permission restrictions, and the long-lived daemon model.
 * We test the happy path via mock in pm2-adapter.test.js.
 */

const PM2_BIN_WIN = path.resolve('node_modules/.bin/pm2.cmd');
const PM2_BIN_POSIX = path.resolve('node_modules/pm2/bin/pm2');
const PM2_BIN = process.platform === 'win32' ? PM2_BIN_WIN : PM2_BIN_POSIX;

test('PM2 integration: local binary is present', async (t) => {
  if (!fs.existsSync(PM2_BIN)) {
    t.skip('PM2 binary not found');
    return;
  }
  assert.ok(fs.existsSync(PM2_BIN), 'PM2 binary must exist at node_modules/pm2/bin/pm2');
});

test('PM2 integration: adapter can list (even if daemon unreachable)', async (t) => {
  if (!fs.existsSync(PM2_BIN)) {
    t.skip('PM2 binary not found');
    return;
  }
  const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
  const adapter = new PM2Adapter({ projectRoot: process.cwd() });

  // If PM2 daemon is not running, listProcesses must THROW (not return [])
  // This verifies the DAEMON_UNAVAILABLE error code path
  try {
    await adapter.listProcesses();
    // If we got here, PM2 daemon IS running (e.g. from a prior test run)
  } catch (err) {
    // Expected when daemon is not running — must throw with typed code
    assert.strictEqual(err.code, 'daemon_unavailable', `Expected daemon_unavailable, got: ${err.code}`);
    assert.ok(err.message.includes('PM2 daemon'), 'error should mention daemon');
  }
});

test('PM2 integration: startBot writes ecosystem config with node_args as array, not CLI flags', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');

  // Use a temp projectRoot so we don't pollute the real .runtime dir
  const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mybot-pm2-eco-'));
  const adapter = new PM2Adapter({ projectRoot });

  const descriptor = {
    kind: 'child',
    botKey: 'eco-test',
    pm2Name: 'eco-test',
    script: path.join(projectRoot, 'app.js'),
    cwd: projectRoot,
    nodeArgs: ['--expose-gc', '--max-old-space-size=512'],
    args: [path.join(projectRoot, 'app.js'), 'eco-test'],
    pm2MaxMemoryRestart: '650M',
    env: {
      MYBOT_INSTANCE_KIND: 'child',
      BOT_KEY: 'eco-test',
      BOT_MANAGED: 'true',
    },
  };

  const require = createRequire(import.meta.url);
  // PM2 7.x only recognizes ecosystem files whose name ends in .config.js/.config.cjs
  // (Common.knonwConfigFileExtensions). A bare .cjs name makes Common.parseConfig()
  // return undefined and PM2 crashes at `if (config.deploy)` in _startJson().
  // Use PM2's own extension detector to guard this contract.
  const pm2Common = require('pm2/lib/Common.js');

  try {
    // startBot will write the ecosystem config before running PM2.
    // It may fail (daemon down / no script) — we only check the config.
    await adapter.startBot(descriptor);

    const configPath = path.join(projectRoot, '.runtime', 'pm2-start-eco-test.config.cjs');
    assert.ok(fs.existsSync(configPath), 'ecosystem config file must be written as *.config.cjs (PM2 7.x only detects .config.cjs)');

    // PM2's own detector must classify the artifact as a JS config file
    assert.strictEqual(pm2Common.isConfigFile(configPath), 'js', "PM2's isConfigFile must recognize the artifact as a JS config");
    assert.strictEqual(pm2Common.isConfigFile(path.basename(configPath)), 'js', "PM2's isConfigFile must recognize the basename as a JS config");

    // Parse exactly the way PM2's _startJson() parses it (Common.parseConfig)
    const config = pm2Common.parseConfig(fs.readFileSync(configPath, 'utf8'), configPath);
    assert.ok(config && typeof config === 'object', 'PM2 parseConfig must return a config object (undefined ⇒ _startJson crashes at config.deploy)');
    assert.ok(Array.isArray(config.apps) && config.apps.length === 1, 'config must contain one app');
    const app = config.apps[0];

    // node_args must be an ARRAY, not a joined string passed as --node-args flag
    assert.ok(Array.isArray(app.node_args), 'node_args must be an array');
    assert.ok(app.node_args.includes('--expose-gc'));
    assert.ok(app.node_args.includes('--max-old-space-size=512'));

    // env must be an OBJECT, not --env KEY=VALUE CLI flags
    assert.strictEqual(typeof app.env, 'object');
    assert.strictEqual(app.env.BOT_KEY, 'eco-test');
    assert.strictEqual(app.env.BOT_MANAGED, 'true');

    // max_memory_restart as config field, not --max-memory-restart flag
    assert.strictEqual(app.max_memory_restart, '650M');

    // fork mode, single instance
    assert.strictEqual(app.exec_mode, 'fork');
    assert.strictEqual(app.instances, 1);
  } finally {
    await fs.promises.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('PM2 integration: sendMemoryPressure writes flag file without daemon', async (t) => {
  if (!fs.existsSync(PM2_BIN)) {
    t.skip('PM2 binary not found');
    return;
  }
  const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
  const adapter = new PM2Adapter({ projectRoot: process.cwd() });
  const tmpDir = path.join(process.cwd(), '.runtime', 'pressure', `test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const result = await adapter.sendMemoryPressure('nonexistent-bot', 'gc');
    // sendMemoryPressure is file-based — it does NOT require the daemon
    assert.ok(result.success, `sendMemoryPressure should succeed: ${result.reason}`);
    assert.ok(result.flagPath?.includes('nonexistent-bot.flag'), 'should return flag path');
    assert.ok(fs.existsSync(result.flagPath), 'flag file must be written');
    // Cleanup
    fs.unlinkSync(result.flagPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PM2 integration: normalizePM2Process works on real PM2 jlist sample', async () => {
  const { normalizePM2Process, isMyBotProcess } = await import('../../src/runtime/pm2-adapter.js');

  // Simulate the actual raw PM2 jlist output format
  const rawPM2Output = [
    {
      name: 'admin',
      pm_id: 0,
      pid: 12345,
      monit: { memory: 100 * 1024 * 1024 },
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 3600000,
        restart_time: 0,
        namespace: 'default',
      },
    },
    {
      name: 'bot-98765',
      pm_id: 1,
      pid: 23456,
      monit: { memory: 200 * 1024 * 1024 },
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 7200000,
        restart_time: 1,
        namespace: 'default',
      },
    },
    {
      name: 'mybot-dashboard',
      pm_id: 2,
      pid: 34567,
      monit: { memory: 50 * 1024 * 1024 },
      pm2_env: {
        status: 'stopped',
        pm_uptime: Date.now() - 86400000,
        restart_time: 0,
        namespace: 'default',
      },
    },
    {
      name: 'random-other-app',
      pm_id: 3,
      pid: 45678,
      monit: { memory: 10 * 1024 * 1024 },
      pm2_env: { status: 'online', pm_uptime: 0, restart_time: 0 },
    },
  ];

  const normalized = rawPM2Output.map(normalizePM2Process);
  const mybotProcs = normalized.filter(isMyBotProcess);

  assert.strictEqual(normalized[0].status, 'online');
  assert.strictEqual(normalized[0].kind, 'main');
  assert.strictEqual(normalized[1].kind, 'child');
  assert.strictEqual(normalized[2].kind, 'dashboard');
  assert.strictEqual(normalized[2].status, 'stopped');
  assert.strictEqual(normalized[3].kind, 'child'); // starts with bot-
  assert.ok(!isMyBotProcess(normalized[3]), 'random app should not be MyBot');
  assert.strictEqual(mybotProcs.length, 3, '3 out of 4 processes belong to MyBot');
});
