import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activateBot } from '../src/commands/mybot/System/mybot-activation-service.js';
import { cancelPendingBotStart } from '../src/commands/mybot/System/pm2-manager.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-cross-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'mybot', 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mybot', 'mybots.json'), JSON.stringify({ child: { uid: 'account', ownerUid: 'owner', enabled: true, trialStatus: 'pending', expiryAt: null, webPort: 4567 } }));
  fs.writeFileSync(path.join(root, 'mybot', 'credentials', 'child.json'), JSON.stringify({ cookie: { token: 'test' }, imei: 'i', userAgent: 'u' }));
  return root;
}

test('stop issued by a different Node process invalidates pending activation before trial commit', async (t) => {
  const root = fixture(t);
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = activateBot({ root, botId: 'child', actorUid: 'owner', pm2Adapter: { start: async () => true, stop: async () => true },
    healthProbe: async () => { enter(); await gate; return { healthy: true }; },
  });
  await entered;
  const source = `import { cancelPendingBotStart } from ${JSON.stringify(new URL('../src/commands/mybot/System/pm2-manager.js', import.meta.url).href)}; await cancelPendingBotStart('child', {projectRoot: process.argv[1]});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, root]);
  release();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'START_CANCELLED');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'mybots.json'))).child;
  assert.equal(record.desiredStatus, 'stopped');
  assert.equal(record.expiryAt, null);
  assert.equal(record.trialStartedAt ?? null, null);
});

test('stale activation rollback never replaces a newer lifecycle operation or owner policy', async (t) => {
  const root = fixture(t);
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = activateBot({ root, botId: 'child', actorUid: 'owner', pm2Adapter: { start: async () => true, stop: async () => true },
    healthProbe: async () => { enter(); await gate; return { healthy: true }; },
  });
  await entered;
  await cancelPendingBotStart('child', { projectRoot: root });
  const file = path.join(root, 'mybot', 'mybots.json');
  const registry = JSON.parse(fs.readFileSync(file));
  registry.child.operationId = 'newer-admin-operation';
  registry.child.activationPolicy = { type: 'duration', durationMs: 7200000 };
  fs.writeFileSync(file, JSON.stringify(registry));
  release();
  assert.equal((await pending).success, false);
  const latest = JSON.parse(fs.readFileSync(file)).child;
  assert.equal(latest.operationId, 'newer-admin-operation');
  assert.equal(latest.activationPolicy.durationMs, 7200000);
  assert.equal(latest.desiredStatus, 'stopped');
});

test('stale cleanup leaves a newer running operation untouched', async (t) => {
  const root = fixture(t);
  let stopCalls = 0;
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = activateBot({ root, botId: 'child', actorUid: 'owner', pm2Adapter: { start: async () => true, stop: async () => { stopCalls++; } },
    healthProbe: async () => { enter(); await gate; return { healthy: true }; },
  });
  await entered;
  const file = path.join(root, 'mybot', 'mybots.json');
  const registry = JSON.parse(fs.readFileSync(file));
  registry.child.operationId = 'newer-start';
  registry.child.desiredStatus = 'running';
  fs.writeFileSync(file, JSON.stringify(registry));
  release();
  assert.equal((await pending).code, 'START_CANCELLED');
  assert.equal(stopCalls, 0);
  assert.equal(JSON.parse(fs.readFileSync(file)).child.operationId, 'newer-start');
});
