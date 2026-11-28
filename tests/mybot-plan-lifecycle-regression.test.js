import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChildAdminIdentities } from '../src/commands/mybot/System/child-admin-resolver.js';
import { evaluateRestoreCandidate, executeAutoRestore, resolveCredentialFilePath } from '../src/commands/mybot/System/mybot-auto-restore.js';
import { createDefaultProfile, saveProfile, getProfile } from '../src/commands/mybot/System/mybot-profile-service.js';
import { activateBot } from '../src/commands/mybot/System/mybot-activation-service.js';
import { checkBotHealth, createAllRequiredFiles, createBotConfig, cancelPendingBotStart } from '../src/commands/mybot/System/pm2-manager.js';

function fixture(t, record = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-plan-life-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'mybot', 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mybot', 'mybots.json'), JSON.stringify({ bot_fixed: {
    uid: 'account-123', ownerUid: 'main-owner', status: 'stopped', enabled: true, webPort: '4567', ...record,
  } }));
  fs.writeFileSync(path.join(root, 'mybot', 'credentials', 'bot_fixed.json'), JSON.stringify({ cookie: { token: 'x' }, imei: 'imei', userAgent: 'ua' }));
  return root;
}

test('child identity resolution uses management key and never transfers Main ownership', async (t) => {
  const root = fixture(t);
  const result = await resolveChildAdminIdentities({
    botUid: 'account-123', botKey: 'bot_fixed', projectRoot: root,
    seeds: { ownerUsername: 'owner', botAdminUsername: 'main' },
    api: { getOwnId: () => 'account-123', fetchAllFriend: async () => [
      { userId: 'local-owner', username: 'owner' }, { userId: 'local-main', username: 'main' },
    ] },
  });
  assert.equal(result.selfUid, 'account-123');
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'mybots.json')));
  assert.deepEqual(Object.keys(registry), ['bot_fixed']);
  assert.equal(registry.bot_fixed.ownerUid, 'main-owner');
  assert.equal(registry.bot_fixed.childOwnerUid, 'local-owner');
  assert.equal(registry.bot_fixed.adminBindingStatus, 'verified');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'instances', 'bot_fixed', 'data', 'admin-list.json'))).sort(), ['account-123', 'local-main', 'local-owner']);
  assert.equal(fs.existsSync(path.join(root, 'mybot', 'instances', 'account-123')), false);
});

test('manual stop survives reboot even with a valid permanent licence', () => {
  const result = evaluateRestoreCandidate('bot_fixed', { desiredStatus: 'stopped', status: 'stopped', expiryAt: '-1', cookie: 'x', imei: 'i', webPort: 4567 });
  assert.deepEqual(result, { ok: false, reason: 'desired-stopped' });
});

test('restore credential lookup uses botKey before account UID', (t) => {
  const root = fixture(t);
  assert.equal(resolveCredentialFilePath({ botKey: 'bot_fixed', uid: 'account-123' }, root), path.join(root, 'mybot', 'credentials', 'bot_fixed.json'));
});

test('occupied port is never accepted as proof of successful auto restore', async () => {
  let launches = 0;
  const result = await executeAutoRestore({
    registry: { bot_fixed: { desiredStatus: 'running', status: 'stopped', expiryAt: '-1', cookie: 'x', imei: 'i', webPort: 4567 } },
    isPortInUseFn: async () => true,
    launcherFn: async () => { launches++; return { success: false, reason: 'wrong-process' }; },
    logFn: () => {},
  });
  assert.equal(launches, 1);
  assert.deepEqual(result.succeeded, []);
  assert.equal(result.failed[0].reason, 'wrong-process');
});

test('admin duration remains pending until first readiness and never resets on restart', async (t) => {
  const root = fixture(t, { activationPolicy: { type: 'duration', durationMs: 86400000 }, trialStatus: 'pending' });
  saveProfile('bot_fixed', createDefaultProfile('bot_fixed', { ownerUid: 'main-owner', activationPolicy: { type: 'duration', durationMs: 86400000 } }), { root });
  assert.equal(getProfile('bot_fixed', { root }).activationPolicy.durationMs, 86400000);
  const readyAt = '2026-11-28T00:00:00.000Z';
  const adapter = { start: async () => true, stop: async () => true };
  const result = await activateBot({ root, botId: 'bot_fixed', actorUid: 'main-owner', pm2Adapter: adapter, healthProbe: async () => ({ healthy: true, checkedAt: readyAt }) });
  assert.equal(result.success, true);
  assert.equal(result.trialGranted, false);
  assert.equal(result.expiryAt, '2026-11-29T00:00:00.000Z');
  const again = await activateBot({ root, botId: 'bot_fixed', actorUid: 'main-owner', pm2Adapter: adapter, healthProbe: async () => ({ healthy: true, checkedAt: '2026-11-28T01:00:00.000Z' }) });
  assert.equal(again.expiryAt, result.expiryAt);
});

test('health rejects listening foreign process and accepts exact connected runtime', async (t) => {
  const root = fixture(t);
  const adapter = { listMyBotProcesses: async () => [{ name: 'bot_fixed', status: 'online', pid: 123 }] };
  let identity = { kind: 'child', botKey: 'foreign', pid: 123, listenerConnected: true };
  const deps = { adapter, portProbe: async () => true, identityFetcher: async () => identity };
  assert.equal((await checkBotHealth('bot_fixed', 4567, 1, root, deps)).healthy, false);
  identity = { kind: 'child', botKey: 'bot_fixed', liveZaloUid: 'account-123', pid: 123, listenerConnected: true, listenerState: 'connected' };
  assert.equal((await checkBotHealth('bot_fixed', 4567, 1, root, deps)).healthy, true);
});

test('reauth initialization preserves existing commands settings and bot configuration', async (t) => {
  const root = fixture(t);
  const beforeRoot = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = root;
  t.after(() => { if (beforeRoot === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = beforeRoot; });
  const config = createBotConfig('bot_fixed', 4567);
  const settings = path.join(root, config.groupSettingsPath);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{"preserve":"group"}');
  const command = path.join(root, config.commandFilePath);
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, '{"prefix":"#","preserve":"command"}');
  await createAllRequiredFiles('bot_fixed', { cookie: { token: 'new' }, imei: 'imei', userAgent: 'ua', accountUid: 'account-123' }, config, root);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"preserve":"group"}');
  assert.equal(fs.readFileSync(command, 'utf8'), '{"prefix":"#","preserve":"command"}');
});

test('stop while activation awaits readiness never consumes trial or restores running intent', async (t) => {
  const root = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = activateBot({ root, botId: 'bot_fixed', actorUid: 'main-owner',
    pm2Adapter: { start: async () => true, stop: async () => true },
    healthProbe: async () => { entered(); await gate; return { healthy: true }; },
  });
  await ready;
  await cancelPendingBotStart('bot_fixed', { projectRoot: root });
  release();
  const result = await pending;
  assert.equal(result.success, false);
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'mybots.json')));
  assert.equal(registry.bot_fixed.desiredStatus, 'stopped');
  assert.equal(registry.bot_fixed.expiryAt, null);
});
