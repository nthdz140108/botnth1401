import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeLoginCredential } from '../src/commands/mybot/System/credential-normalizer.js';
import { verifyLoginCredential } from '../src/commands/mybot/System/login-verification.js';
import { persistVerifiedBot } from '../src/commands/mybot/System/verified-provisioning.js';
import { QrSessionManager } from '../src/dashboard/qr-session.js';
import { createAllRequiredFilesWithCredentials, runQrBootstrap } from '../src/commands/mybot/Manager/qr-login-command.js';
import { createBotConfig } from '../src/commands/mybot/System/pm2-manager.js';

const credential = { imei: 'test-imei', userAgent: 'Test Agent', cookie: { url: 'https://chat.zalo.me', cookies: [{ name: 'zpw_sek', value: 'secret', domain: '.zalo.me' }] } };
test('QR raw cookie jar normalizes into a complete login credential', () => {
  const normalized = normalizeLoginCredential({ imei: 'test-imei', rawCookies: credential.cookie });
  assert.ok(normalized.userAgent);
  assert.equal(normalized.cookie.cookies[0].name, 'zpw_sek');
  assert.throws(() => normalizeLoginCredential({ imei: 'x', cookie: {} }), { code: 'INVALID_CREDENTIAL' });
  assert.throws(() => normalizeLoginCredential({ imei: 'x', cookie: true }), { code: 'INVALID_CREDENTIAL' });
});
test('normalized QR credentials are accepted by the runtime login client', async () => {
  const { Zalo } = await import('../src/api-zalo/zalo.js');
  const normalized = normalizeLoginCredential({ imei: credential.imei, rawCookies: credential.cookie });
  const client = new Zalo(normalized);
  assert.equal(client.parseCookies(normalized.cookie), 'zpw_sek=secret');
});
test('login verification returns authenticated account identity and never trusts input uid', async () => {
  const identity = await verifyLoginCredential({ ...credential, uid: 'sender' }, { runWorker: async () => ({ uid: 'actual', displayName: 'Bot' }) });
  assert.equal(identity.uid, 'actual');
  await assert.rejects(verifyLoginCredential(credential, { runWorker: async () => ({}) }), { code: 'ACCOUNT_IDENTITY_MISSING' });
});
test('isolated verification deadline terminates the worker without producing runtime files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-deadline-'));
  try {
    await assert.rejects(verifyLoginCredential(credential, { root, timeoutMs: 10 }), { code: 'LOGIN_VERIFY_TIMEOUT' });
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('verified provisioning preserves botKey and reauthentication leaves unrelated settings intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verified-bot-'));
  try {
    const initialize = async (key, creds) => { await fs.mkdir(path.join(root, 'mybot', 'credentials'), { recursive: true }); await fs.writeFile(path.join(root, 'mybot', 'credentials', `${key}.json`), JSON.stringify(creds)); };
    const first = await persistVerifiedBot({ root, credential, identity: { uid: 'actual' }, ownerUid: 'owner', initialize });
    assert.match(first.botKey, /^bot_/);
    assert.notEqual(first.botKey, 'actual');
    await fs.writeFile(path.join(root, 'settings.json'), '{"prefix":"?"}');
    const second = await persistVerifiedBot({ root, credential, identity: { uid: 'actual' }, ownerUid: 'owner', initialize: async () => assert.fail('must not initialize existing bot') });
    assert.equal(second.botKey, first.botKey);
    assert.equal(await fs.readFile(path.join(root, 'settings.json'), 'utf8'), '{"prefix":"?"}');
    await assert.rejects(persistVerifiedBot({ root, credential, identity: { uid: 'actual' }, ownerUid: 'intruder', initialize }), { code: 'BOT_OWNER_MISMATCH' });
    const registry = JSON.parse(await fs.readFile(path.join(root, 'mybot', 'mybots.json'), 'utf8'));
    assert.equal(Object.keys(registry).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('dashboard QR verification has a separate deadline and cancellation blocks persistence', async () => {
  let time = 1000;
  let release;
  const writes = [];
  const manager = new QrSessionManager({ now: () => time, timeoutMs: 1000,
    initSession: async () => { time += 500; return {}; }, verifyClient: async s => s,
    generateQr: async () => ['code', {}], readQr: async () => 'qr', waitScan: async () => true,
    waitConfirm: async () => [{ imei: credential.imei }, credential.cookie],
    verifyAccount: async () => new Promise(resolve => { release = resolve; }),
    writeCredential: async (_id, value) => writes.push(value),
  });
  const started = await manager.start('bot_test');
  assert.equal(started.expiresAt, 2500, 'deadline must begin after QR display');
  for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.get('bot_test').state, 'verifying');
  assert.equal(manager.cancel('bot_test'), true);
  release({ uid: 'account' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0);
  assert.equal(manager.get('bot_test').state, 'cancelled');
});
test('QR bootstrap verifies in the requested runtime root without starting a bot launcher', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-runtime-'));
  try {
    const identity = await runQrBootstrap('session', credential, { root, runWorker: async (_credential, options) => { assert.equal(options.root, root); return { uid: 'verified' }; } });
    assert.equal(identity.uid, 'verified');
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Main reauthentication requires its verified account and preserves assets config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'main-credential-'));
  try {
    await fs.mkdir(path.join(root, 'mybot'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'mybot', 'mybots.json'), JSON.stringify({ admin: { name: 'admin', uid: 'main-account', isMain: true, status: 'running' } }));
    await fs.writeFile(path.join(root, 'assets', 'config.json'), JSON.stringify({ prefix: '?', customSetting: 42 }));
    await assert.rejects(persistVerifiedBot({ root, credential, identity: { uid: 'main-account' }, ownerUid: 'owner' }), { code: 'MAIN_ACCOUNT_FORBIDDEN' });
    await persistVerifiedBot({ root, credential, identity: { uid: 'main-account' }, targetBotKey: 'admin', allowAdmin: true, allowMainUpdate: true });
    const config = JSON.parse(await fs.readFile(path.join(root, 'assets', 'config.json'), 'utf8'));
    assert.equal(config.prefix, '?');
    assert.equal(config.customSetting, 42);
    assert.equal(config.accountUid, 'main-account');
    await assert.rejects(persistVerifiedBot({ root, credential, identity: { uid: 'wrong-account' }, targetBotKey: 'admin', allowAdmin: true, allowMainUpdate: true }), { code: 'ACCOUNT_MISMATCH' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('targeted QR refuses a different account for a legacy numeric bot key before credential mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-account-'));
  try {
    await fs.mkdir(path.join(root, 'mybot'), { recursive: true });
    await fs.writeFile(path.join(root, 'mybot', 'mybots.json'), JSON.stringify({ '123456789012': { ownerUid: 'owner', status: 'stopped' } }));
    await assert.rejects(persistVerifiedBot({ root, credential, identity: { uid: 'different' }, ownerUid: 'owner', targetBotKey: '123456789012' }), { code: 'ACCOUNT_MISMATCH' });
    await assert.rejects(fs.access(path.join(root, 'mybot', 'credentials', '123456789012.json')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('QR reinitialization preserves command and group settings and seeds the account UID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-preserve-'));
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = root;
  try {
    await fs.mkdir(path.join(root, 'mybot'), { recursive: true });
    const config = createBotConfig('bot_fixed', 4567);
    await createAllRequiredFilesWithCredentials('bot_fixed', { ...credential, accountUid: 'account' }, config);
    await fs.writeFile(path.join(root, config.commandFilePath), '{"prefix":"?"}');
    await fs.writeFile(path.join(root, config.groupSettingsPath), '{"group":{"active":true}}');
    await createAllRequiredFilesWithCredentials('bot_fixed', { ...credential, accountUid: 'account', imei: 'updated' }, config);
    assert.equal(await fs.readFile(path.join(root, config.commandFilePath), 'utf8'), '{"prefix":"?"}');
    assert.equal(await fs.readFile(path.join(root, config.groupSettingsPath), 'utf8'), '{"group":{"active":true}}');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, config.adminFilePath), 'utf8')), ['account']);
  } finally { if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous; await fs.rm(root, { recursive: true, force: true }); }
});
