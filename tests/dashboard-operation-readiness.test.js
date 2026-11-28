import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotActionService } from '../src/dashboard/bot-action-service.js';

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mybot-op-readiness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'mybot'), { recursive: true });
  await fs.mkdir(path.join(root, 'mybot', 'credentials'), { recursive: true });
  await fs.writeFile(path.join(root, 'mybot', 'credentials', 'child.json'), JSON.stringify({ cookie: { token: 'test' }, imei: 'imei', userAgent: 'ua' }));
  const inventoryPath = path.join(root, 'mybot', 'mybots.json');
  await fs.writeFile(inventoryPath, JSON.stringify({ child: { uid: 'account', ownerUid: 'owner', expiryAt: '-1' } }));
  let running = false;
  const service = createBotActionService({ root,
    registry: { inventoryPath, describe: async (id) => ({ id, uid: 'account', ownerUid: 'owner', enabled: true, webPort: 4567 }) },
    configStore: { writeJson: async (file, value) => fs.writeFile(file, JSON.stringify(value)) },
    auditStore: { append: async () => {} },
    pm2Adapter: { status: async () => ({ running }), start: async () => { running = true; return { success: true, pid: 123 }; }, stop: async () => { running = false; return true; }, ...overrides.pm2Adapter },
    processAdapter: { status: async () => ({ running: false }) },
    readinessProbe: overrides.readinessProbe || (async () => ({ healthy: true, checkedAt: new Date().toISOString() })),
    internalBridgeCaller: async () => ({ success: true }),
  });
  return { root, service };
}

test('operation finishes ws_ready only after readiness evidence', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = await fixture(t, { readinessProbe: async () => { await gate; return { healthy: true }; } });
  const pending = service.start('child');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.getActiveOperation('child').phase, 'connecting');
  release();
  const result = await pending;
  assert.equal(result.phase, 'ws_ready');
  assert.equal(service.getOperation(result.operationId).phase, 'ws_ready');
});

test('failed listener readiness makes operation fail with stage and code', async (t) => {
  const { service } = await fixture(t, { readinessProbe: async () => ({ healthy: false, reason: 'listener-disconnected' }) });
  await assert.rejects(service.start('child'), { code: 'READINESS_FAILED', stage: 'readiness' });
});

test('stop cancels pending start and returns its own stopped operation', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = await fixture(t, { pm2Adapter: { start: async () => { await gate; return true; } } });
  const started = service.start('child');
  const rejection = assert.rejects(started, { code: 'START_CANCELLED' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = service.stop('child');
  release();
  await rejection;
  const result = await stopped;
  assert.equal(result.action, 'stop');
  assert.equal(result.phase, 'stopped');
});
