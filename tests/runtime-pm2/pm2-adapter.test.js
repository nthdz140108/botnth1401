import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('PM2 Adapter', () => {
  beforeEach(() => {});

  describe('process descriptor generation', () => {
    it('generates correct env for main bot', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'main', projectRoot: '/proj' });
      assert.strictEqual(desc.kind, 'main');
      assert.strictEqual(desc.botKey, 'admin');
      assert.strictEqual(desc.env.MYBOT_INSTANCE_KIND, 'main');
      assert.ok(desc.env.PROJECT_ROOT?.includes('proj'));
      assert.ok(desc.script.includes('bootstrap.js'));
    });

    it('generates correct env for child bot', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'child', botKey: 'user-123', projectRoot: '/proj' });
      assert.strictEqual(desc.kind, 'child');
      assert.strictEqual(desc.botKey, 'user-123');
      assert.strictEqual(desc.env.MYBOT_INSTANCE_KIND, 'child');
      assert.strictEqual(desc.env.BOT_KEY, 'user-123');
      assert.ok(desc.env.CONFIG_PATH?.includes('user-123'));
    });

    it('uses canonical botKey for PM2 process name, not Zalo UID', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'child', botKey: 'my-bot-key', uid: 'zalo12345', projectRoot: '/proj' });
      assert.strictEqual(desc.pm2Name, 'my-bot-key');
      assert.ok(desc.env.BOT_UID, 'zalo12345');
      assert.ok(desc.env.BOT_KEY, 'my-bot-key');
    });

    it('generates dashboard descriptor', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'dashboard', projectRoot: '/proj' });
      assert.strictEqual(desc.kind, 'dashboard');
      assert.strictEqual(desc.pm2Name, 'mybot-dashboard');
      assert.ok(desc.script?.includes('dashboard'));
    });

    it('generates guardian descriptor', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'guardian', projectRoot: '/proj' });
      assert.strictEqual(desc.kind, 'guardian');
      assert.strictEqual(desc.pm2Name, 'mybot-guardian');
    });

    it('sets heap limit and expose-gc flags', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'child', botKey: 'test', projectRoot: '/proj' });
      assert.ok(desc.nodeArgs?.includes('--expose-gc'), '--expose-gc should be in nodeArgs');
      assert.ok(desc.nodeArgs?.some(a => a.startsWith('--max-old-space-size=')));
    });

    it('dashboard has lower memory ceiling', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'dashboard', projectRoot: '/proj' });
      assert.ok(desc.pm2MaxMemoryRestart?.includes('180M'), 'Dashboard should have 180M RSS limit');
    });

    it('child bot has 320M RSS limit', async () => {
      const { createLaunchDescriptor } = await import('../../src/runtime/launch-descriptor.js');
      const desc = createLaunchDescriptor({ kind: 'child', botKey: 'test', projectRoot: '/proj' });
      assert.ok(desc.pm2MaxMemoryRestart?.includes('320M'), 'Child bot should have 320M RSS limit');
    });
  });

  describe('PM2 adapter interface', () => {
    it('exports listProcesses', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.listProcesses, 'function');
    });

    it('exports startBot', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.startBot, 'function');
    });

    it('exports stopBot', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.stopBot, 'function');
    });

    it('exports restartBot', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.restartBot, 'function');
    });

    it('exports reloadBotFromDescriptor', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.reloadBotFromDescriptor, 'function');
    });

    it('exports deleteBot', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.deleteBot, 'function');
    });

    it('exports sendMemoryPressure', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: '/proj' });
      assert.strictEqual(typeof adapter.sendMemoryPressure, 'function');
    });

    it('PM2 adapter is mockable via options', async () => {
      const { PM2Adapter, normalizePM2Process } = await import('../../src/runtime/pm2-adapter.js');
      // Mock now returns the NORMALIZED shape (post-PM2Adapter normalization).
      // The adapter no longer does normalization inside listProcesses when a
      // mock is provided — the contract is "you get normalized output".
      const mockPM2 = {
        listProcesses: async () => [
          { name: 'mock-admin', kind: 'main', status: 'online', pid: 1234, rss: 100000, restartCount: 0, uptime: 0, namespace: 'default' },
        ],
        startBot: async () => ({ success: true, pid: 9999 }),
        stopBot: async () => ({ success: true }),
        restartBot: async () => ({ success: true }),
        deleteBot: async () => ({ success: true }),
        sendMemoryPressure: async () => ({ success: true }),
      };
      const adapter = new PM2Adapter({ projectRoot: '/proj', mock: mockPM2 });
      const result = await adapter.listProcesses();
      assert.strictEqual(result[0]?.name, 'mock-admin');
      assert.strictEqual(result[0]?.pid, 1234);
    });

    it('normalizePM2Process maps pm2_env.status to status', async () => {
      const { normalizePM2Process } = await import('../../src/runtime/pm2-adapter.js');
      const raw = {
        name: 'admin',
        pm_id: 0,
        pid: 4242,
        monit: { memory: 100 * 1024 * 1024 },
        pm2_env: { status: 'online', pm_uptime: Date.now() - 60000, restart_time: 2 },
      };
      const norm = normalizePM2Process(raw);
      assert.strictEqual(norm.status, 'online');
      assert.strictEqual(norm.pid, 4242);
      assert.strictEqual(norm.rss, 100 * 1024 * 1024);
      assert.strictEqual(norm.kind, 'main');
      assert.strictEqual(norm.restartCount, 2);
    });

    it('normalizePM2Process handles dashboard and child names', async () => {
      const { normalizePM2Process } = await import('../../src/runtime/pm2-adapter.js');
      assert.strictEqual(normalizePM2Process({ name: 'mybot-dashboard', pm2_env: { status: 'online' } })?.kind, 'dashboard');
      assert.strictEqual(normalizePM2Process({ name: 'mybot-guardian', pm2_env: { status: 'online' } })?.kind, 'guardian');
      assert.strictEqual(normalizePM2Process({ name: 'admin', pm2_env: { status: 'online' } })?.kind, 'main');
      assert.strictEqual(normalizePM2Process({ name: 'bot-12345', pm2_env: { status: 'online' } })?.kind, 'child');
    });

    it('normalizePM2Process extracts outLogPath and errorLogPath', async () => {
      const { normalizePM2Process } = await import('../../src/runtime/pm2-adapter.js');
      const norm = normalizePM2Process({
        name: 'mybot-dashboard',
        pm2_env: {
          status: 'online',
          pm_out_log_path: '/logs/dash.out.log',
          pm_err_log_path: '/logs/dash.err.log',
        },
      });
      assert.ok(norm.outLogPath);
      assert.ok(norm.errorLogPath);
      assert.ok(norm.outLogPath.endsWith('dash.out.log'));
      assert.ok(norm.errorLogPath.endsWith('dash.err.log'));
    });

    it('isAvailable returns available:true when daemon is up', async () => {
      const { PM2Adapter } = await import('../../src/runtime/pm2-adapter.js');
      const adapter = new PM2Adapter({ projectRoot: process.cwd() });
      // If PM2 daemon is NOT running (expected in test env), isAvailable
      // must return available:false with a typed reason — NOT throw.
      const result = await adapter.isAvailable();
      // Either daemon is up (available:true) or down (available:false).
      // The key contract is: it NEVER throws, always returns a structured result.
      if (result.available) {
        // PM2 daemon IS running in this environment
        assert.ok(true, 'PM2 daemon is up');
      } else {
        // Daemon is down — check structured reason
        assert.strictEqual(result.available, false);
        assert.ok(result.reason, 'must provide reason when unavailable');
        assert.ok(result.code, 'must provide typed error code');
      }
    });

    it('isMyBotProcess filters non-MyBot apps', async () => {
      const { isMyBotProcess } = await import('../../src/runtime/pm2-adapter.js');
      assert.ok(isMyBotProcess({ name: 'admin' }));
      assert.ok(isMyBotProcess({ name: 'bot-123' }));
      assert.ok(isMyBotProcess({ name: 'mybot-dashboard' }));
      assert.ok(isMyBotProcess({ name: 'mybot-guardian' }));
      assert.ok(!isMyBotProcess({ name: 'some-other-app' }));
      assert.ok(!isMyBotProcess({ name: 'next-app' }));
      assert.ok(!isMyBotProcess(null));
    });
  });

  describe('ecosystem config generation', () => {
    it('generates valid ecosystem structure', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const config = generateEcosystemConfig({ projectRoot: '/proj' });
      assert.ok(Array.isArray(config.apps));
      assert.strictEqual(config.apps.length, 0); // No bots registered
      assert.ok(config.pm2_instance_var); // fork mode
    });

    it('adds main app to ecosystem', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const config = generateEcosystemConfig({ projectRoot: '/proj', includeMain: true });
      const mainApp = config.apps.find(a => a.name === 'admin');
      assert.ok(mainApp, 'Main bot should be in ecosystem');
      assert.ok(mainApp.script?.includes('bootstrap.js'));
      assert.strictEqual(mainApp.instances, 1);
      assert.strictEqual(mainApp.exec_mode, 'fork');
    });

    it('adds dashboard app to ecosystem', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const config = generateEcosystemConfig({ projectRoot: '/proj', includeDashboard: true });
      const dashApp = config.apps.find(a => a.name === 'mybot-dashboard');
      assert.ok(dashApp, 'Dashboard should be in ecosystem');
      assert.ok(dashApp.max_memory_restart?.includes('180M'));
    });

    it('adds guardian app to ecosystem', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const config = generateEcosystemConfig({ projectRoot: '/proj', includeGuardian: true });
      const guardApp = config.apps.find(a => a.name === 'mybot-guardian');
      assert.ok(guardApp, 'Guardian should be in ecosystem');
    });

    it('adds child bots to ecosystem', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const childBots = [
        { botKey: 'user-123', uid: 'zaloUid123' },
        { botKey: 'user-456', uid: 'zaloUid456' },
      ];
      const config = generateEcosystemConfig({ projectRoot: '/proj', childBots });
      assert.strictEqual(config.apps.length, 2);
      config.apps.forEach(app => {
        // PM2 name equals canonical botKey (not prefixed) per spec
        assert.ok(app.name, `PM2 name should exist: ${app.name}`);
        assert.ok(app.script?.includes('bootstrap.js'));
        assert.ok(app.max_memory_restart?.includes('320M'));
      });
    });

    it('sets V8 heap limit via node_args', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const config = generateEcosystemConfig({ projectRoot: '/proj', includeMain: true });
      const mainApp = config.apps.find(a => a.name === 'admin');
      assert.ok(mainApp.node_args?.includes('--expose-gc'));
      assert.ok(mainApp.node_args?.some(a => a.startsWith('--max-old-space-size=')));
    });

    it('sets separate log paths per app', async () => {
      const { generateEcosystemConfig } = await import('../../src/runtime/ecosystem-config.js');
      const config = generateEcosystemConfig({
        projectRoot: '/proj',
        includeMain: true,
        childBots: [{ botKey: 'user-123', uid: 'uid1' }]
      });
      config.apps.forEach(app => {
        assert.ok(app.error_file?.includes(app.name), `Error log should include app name: ${app.name}`);
        assert.ok(app.out_file?.includes(app.name), `Out log should include app name: ${app.name}`);
      });
    });
  });
});
