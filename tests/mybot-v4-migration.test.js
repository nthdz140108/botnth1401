import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('migration dry-run keeps keys, owners, trial ledger and files untouched; apply is repeatable', async t => {
  const { migrateBotManagementV4 } = await import('../src/commands/mybot/System/bot-management-migration.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'mybot'), { recursive: true });
  const file = path.join(root, 'mybot', 'mybots.json');
  const original = { oldKey: { uid: '1234567890123', ownerUid: 'owner-main', expiryAt: '2028-01-01', status: 'stopped' }, other: { status: 'running', ownerUid: 'someone' } };
  fs.writeFileSync(file, JSON.stringify(original));
  fs.writeFileSync(path.join(root, 'mybot', 'trial-ledger.json'), 'preserve');
  const report = await migrateBotManagementV4({ root });
  assert.equal(report.dryRun, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), original);
  await migrateBotManagementV4({ root, apply: true });
  const migrated = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(Object.keys(migrated), ['oldKey', 'other']);
  assert.equal(migrated.oldKey.ownerUid, 'owner-main');
  assert.equal(migrated.oldKey.desiredStatus, 'stopped');
  assert.equal(migrated.oldKey.accountIdentityStatus, 'pending');
  assert.equal(migrated.oldKey.expiryAt, '2028-01-01');
  assert.equal(fs.readFileSync(path.join(root, 'mybot', 'trial-ledger.json'), 'utf8'), 'preserve');
  const repeated = await migrateBotManagementV4({ root, apply: true });
  assert.equal(repeated.changed.length, 0);
});

test('Main account normalization is repeatable after the first application and requires identity evidence', async t => {
  const { migrateBotManagementV4 } = await import('../src/commands/mybot/System/bot-management-migration.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'mybot', 'state'), { recursive: true });
  const file = path.join(root, 'mybot', 'mybots.json');
  fs.writeFileSync(file, JSON.stringify({ admin: { uid: '1234567890123', isMain: true, status: 'running' } }));
  fs.writeFileSync(path.join(root, 'mybot', 'state', 'admin.json'), JSON.stringify({ uid: '1234567890123', lastRepairedAt: '2026-11-28T00:00:00.000Z' }));
  await migrateBotManagementV4({ root, apply: true });
  const record = JSON.parse(fs.readFileSync(file)).admin;
  assert.equal(record.accountUid, '1234567890123');
  assert.equal(record.accountIdentityStatus, 'verified');
  assert.deepEqual((await migrateBotManagementV4({ root, apply: true })).changed, []);
});
