import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { loadMyBotsRegistry, saveMyBotsRegistry } from '../src/commands/mybot/System/mybots-registry.js';
import { withMyBotsTransaction, recoverMyBotsTransactions } from '../src/commands/mybot/Manager/qr-provisioning-registry.js';
import { syncMainBotRegistry } from '../src/commands/mybot/System/mybot-identity.js';

function fixture(t, data = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryPath = path.join(root, 'mybot', 'mybots.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(data));
  return { root, registryPath };
}

test('corrupt registry cannot be interpreted as an empty fleet', t => {
  const { registryPath } = fixture(t);
  fs.writeFileSync(registryPath, '{broken');
  assert.throws(() => loadMyBotsRegistry(registryPath), { code: 'REGISTRY_CORRUPT' });
});
test('Main identity synchronization refuses to overwrite a damaged registry', t => {
  const { root, registryPath } = fixture(t);
  fs.writeFileSync(registryPath, '{broken');
  assert.throws(() => syncMainBotRegistry({ projectRoot: root, adminUid: '1234567890123' }), { code: 'REGISTRY_CORRUPT' });
  assert.equal(fs.readFileSync(registryPath, 'utf8'), '{broken');
});

test('a stale registry snapshot preserves a different bot update', t => {
  const { registryPath } = fixture(t, { a: { status: 'stopped', prefix: '!' }, b: { status: 'stopped' } });
  const first = loadMyBotsRegistry(registryPath);
  const second = loadMyBotsRegistry(registryPath);
  first.a.prefix = '?';
  saveMyBotsRegistry(first, registryPath);
  second.b.status = 'running';
  saveMyBotsRegistry(second, registryPath);
  assert.equal(loadMyBotsRegistry(registryPath).a.prefix, '?');
  assert.equal(loadMyBotsRegistry(registryPath).b.status, 'running');
});

test('failed lock never executes mutation callback', async t => {
  const options = fixture(t);
  const release = await lockfile.lock(options.registryPath);
  t.after(async () => { await release(); });
  let mutated = false;
  await assert.rejects(withMyBotsTransaction({ ...options, lockOptions: { retries: 0 } }, () => { mutated = true; }), { code: 'REGISTRY_BUSY' });
  assert.equal(mutated, false);
});

test('transaction rolls back credential file and bot without touching unrelated changes', async t => {
  const options = fixture(t, { a: { status: 'stopped' }, b: { prefix: '!' } });
  const credential = path.join(options.root, 'mybot', 'credentials', 'a.json');
  fs.mkdirSync(path.dirname(credential), { recursive: true });
  fs.writeFileSync(credential, '{"cookie":"original"}');
  await assert.rejects(withMyBotsTransaction(options, txn => {
    txn.patchBot('a', { status: 'provisioning' });
    txn.writeJson(credential, { cookie: 'new' });
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.equal(JSON.parse(fs.readFileSync(credential)).cookie, 'original');
  assert.deepEqual(loadMyBotsRegistry(options.registryPath), { a: { status: 'stopped' }, b: { prefix: '!' } });
});

test('legacy save inside transaction stays in the same journal and survives final flush', async t => {
  const options = fixture(t, { a: { status: 'stopped', name: 'before' } });
  await withMyBotsTransaction(options, async txn => {
    const registry = loadMyBotsRegistry(options.registryPath);
    registry.a.name = 'after';
    saveMyBotsRegistry(registry, options.registryPath);
    await withMyBotsTransaction(options, nested => nested.patchBot('a', { expiryAt: '-1' }));
    saveMyBotsRegistry(txn._registry, options.registryPath);
  });
  assert.deepEqual(loadMyBotsRegistry(options.registryPath), { a: { status: 'stopped', name: 'after', expiryAt: '-1' } });
});

test('recovery restores only interrupted bot and its files, preserving other bots', async t => {
  const options = fixture(t, { a: { status: 'provisioning' }, b: { prefix: '?' } });
  const dir = path.join(options.root, 'mybot', 'state', 'transactions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'interrupted.json'), JSON.stringify({ id: 'interrupted', state: 'pending', before: { a: { status: 'stopped' } }, files: {} }));
  assert.deepEqual(await recoverMyBotsTransactions(options), ['interrupted']);
  assert.deepEqual(loadMyBotsRegistry(options.registryPath), { a: { status: 'stopped' }, b: { prefix: '?' } });
  assert.deepEqual(await recoverMyBotsTransactions(options), []);
});

test('ordinary registry writes recover an interrupted transaction before a new successful mutation', async t => {
  const options = fixture(t, { a: { status: 'provisioning' }, b: { prefix: '!' } });
  const dir = path.join(options.root, 'mybot', 'state', 'transactions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'interrupted.json'), JSON.stringify({ id: 'interrupted', state: 'pending', before: { a: { status: 'stopped' } }, files: {} }));
  const changed = loadMyBotsRegistry(options.registryPath);
  changed.b.prefix = '?';
  saveMyBotsRegistry(changed, options.registryPath);
  assert.equal(loadMyBotsRegistry(options.registryPath).a.status, 'stopped');
  await withMyBotsTransaction(options, txn => txn.patchBot('a', { prefix: '#' }));
  assert.equal(loadMyBotsRegistry(options.registryPath).b.prefix, '?');
});

test('transaction journal and credential files are private from their initial write', { skip: process.platform === 'win32' }, async t => {
  const options = fixture(t);
  await withMyBotsTransaction(options, txn => {
    const file = path.join(options.root, 'mybot', 'credentials', 'private.json');
    txn.writeJson(file, { cookie: 'fixture' });
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    const directory = path.join(options.root, 'mybot', 'state', 'transactions');
    for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o077, 0);
  });
});
