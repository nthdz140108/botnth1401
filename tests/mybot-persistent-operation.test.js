import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activateBot } from '../src/commands/mybot/System/mybot-activation-service.js';
import { cancelPendingBotStart } from '../src/commands/mybot/System/pm2-manager.js';
import { updateProfile, getProfile } from '../src/commands/mybot/System/mybot-profile-service.js';
import { getTrialLedgerPath, saveTrialLedger, loadTrialLedger } from '../src/commands/mybot/System/mybot-trial-ledger.js';

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

test('failed readiness preserves concurrent owner profile policy and expiry updates with the same lifecycle token', async (t) => {
  const root = fixture(t);
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = activateBot({ root, botId: 'child', actorUid: 'owner', pm2Adapter: { start: async () => true, stop: async () => true },
    healthProbe: async () => { enter(); await gate; return { healthy: false, error: 'listener failed' }; },
  });
  await entered;
  const expiryAt = '2099-01-01T00:00:00.000Z';
  updateProfile('child', { ownerUid: 'new-owner', enabled: false, expiryAt, activationPolicy: { type: 'duration', durationMs: 7200000 }, nameServer: 'New profile' }, { root });
  release();
  assert.equal((await pending).success, false);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'mybots.json'))).child;
  assert.equal(record.ownerUid, 'new-owner');
  assert.equal(record.enabled, false);
  assert.equal(record.expiryAt, expiryAt);
  assert.equal(record.activationPolicy.durationMs, 7200000);
  assert.equal(record.displayName, 'New profile');
  assert.equal(getProfile('child', { root }).expiryAt, expiryAt);
});

test('failure after trial claim rolls back only finalized ledger profile and bot fields', async (t) => {
  const root = fixture(t);
  saveTrialLedger({ ledger: { unrelated: { '2026-W01': { botId: 'other' } } } }, { root });
  const previousLedger = fs.readFileSync(getTrialLedgerPath(root), 'utf8');
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && String(to).endsWith(`${path.sep}profile.json`)) {
      failed = true;
      throw Object.assign(new Error('injected profile storage failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  const result = await activateBot({ root, botId: 'child', actorUid: 'owner', pm2Adapter: { start: async () => true, stop: async () => true }, healthProbe: async () => ({ healthy: true }) });
  assert.equal(failed, true);
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(getTrialLedgerPath(root), 'utf8'), previousLedger);
  assert.equal(loadTrialLedger({ root }).ledger.owner, undefined);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'mybots.json'))).child;
  assert.equal(record.ownerUid, 'owner');
  assert.equal(record.expiryAt, null);
  assert.equal(record.trialStatus, 'pending');
  assert.equal(fs.existsSync(path.join(root, 'mybot', 'instances', 'child', 'data', 'profile.json')), false);
});
