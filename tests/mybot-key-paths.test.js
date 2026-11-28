import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBotPaths, resolveManagedBotTarget } from '../src/commands/mybot/System/mybot-identity.js';
import { matchesBotIdentity } from '../src/runtime/runtime-readiness.js';
import { createBotRuntimeContext } from '../src/utils/bot-runtime-context.js';
import { RuntimeInstanceDescriptor, verifyRuntimeIdentity } from '../src/core/runtime-instance.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeStatusResolver } from '../src/dashboard/runtime-status-resolver.js';
import { BotRegistry } from '../src/dashboard/bot-registry.js';
import { execFileSync } from 'node:child_process';

test('storage paths use management key even when account UID differs', () => {
  const paths = resolveBotPaths({ key: 'bot_stable', uid: '1234567890123' }, process.cwd());
  assert.match(paths.instanceDir, /instances[/\\]bot_stable$/);
  assert.match(paths.credentialPath, /credentials[/\\]bot_stable\.json$/);
  assert.match(paths.statePath, /state[/\\]bot_stable\.json$/);
});
test('readiness rejects correct key with a different logged-in account', () => {
  assert.equal(matchesBotIdentity({
    descriptor: { kind: 'child', botKey: 'bot_stable', accountUid: '1234567890123' },
    identity: { kind: 'child', botKey: 'bot_stable', liveZaloUid: '9999999999999', pid: 42, listenerConnected: true }, expectedPid: 42,
  }), false);
});
test('readiness rejects a foreign management key even if UID equals expected key', () => {
  assert.equal(matchesBotIdentity({ descriptor: { kind: 'child', botKey: 'bot_stable' },
    identity: { kind: 'child', botKey: 'foreign', configuredUid: 'bot_stable', pid: 42, listenerConnected: true }, expectedPid: 42 }), false);
});
test('default selector returns all owned candidates to let caller ask which one', () => {
  const selected = resolveManagedBotTarget({ projectRoot: process.cwd(), callerUid: 'owner',
    registry: { bot_a: { ownerUid: 'owner', uid: '1111111111111' }, bot_b: { ownerUid: 'owner', uid: '2222222222222' } },
  });
  assert.equal(selected.length, 2);
});
test('runtime context prefers explicit botKey over account UID and honors runtime root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = createBotRuntimeContext({ botKey: 'bot_stable', uid: '1234567890123' }, { root });
  assert.equal(context.workspaceRoot, path.join(root, 'mybot', 'instances', 'bot_stable'));
});
test('identity verification writes key state and rejects a different configured account', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = new RuntimeInstanceDescriptor({ kind: 'child', botKey: 'bot_stable', configuredUid: '1234567890123', projectRoot: root });
  assert.equal(verifyRuntimeIdentity(descriptor, '9999999999999').verified, false);
  assert.equal(verifyRuntimeIdentity(descriptor, '1234567890123').verified, true);
  assert.equal(fs.existsSync(path.join(root, 'mybot', 'state', '1234567890123.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'state', 'bot_stable.json'))).uid, '1234567890123');
});

test('dashboard refuses missing listener/PID or a different logged-in account', async () => {
  let identity = { kind: 'child', botKey: 'bot_stable', liveZaloUid: '1234567890123' };
  const resolver = createRuntimeStatusResolver({ testMode: false,
    pm2: { getProcessStatus: async () => ({ available: true, status: 'online', pid: 42, uptime: 120000 }) },
    portProbe: async () => true, identityFetcher: async () => identity,
  });
  const bot = { id: 'bot_stable', port: 4567, accountUid: '1234567890123' };
  assert.notEqual((await resolver.resolveBot(bot)).status, 'running');
  identity = { ...identity, pid: 42, listenerConnected: true, liveZaloUid: '9999999999999' };
  assert.notEqual((await resolver.resolveBot(bot)).status, 'running');
  identity.liveZaloUid = '1234567890123';
  assert.equal((await resolver.resolveBot(bot)).status, 'running');
});

test('dashboard lists registered management keys only and passes verified account to readiness', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-registry-keys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'mybot', 'bots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mybot', 'mybots.json'), JSON.stringify({ bot_stable: { uid: '1234567890123', accountUid: '1234567890123', accountIdentityStatus: 'verified', adminBindingStatus: 'pending', desiredStatus: 'stopped' } }));
  fs.writeFileSync(path.join(root, 'mybot', 'bots', 'orphan.json'), '{}');
  const registry = new BotRegistry({ root });
  const probed = [];
  registry.resolver.resolveBot = async bot => { probed.push(bot); return { status: 'stopped', supervisor: {}, readiness: {} }; };
  const listed = await registry.list();
  assert.deepEqual(listed.map(bot => bot.id).sort(), ['admin', 'bot_stable']);
  assert.equal(probed.find(bot => bot.id === 'bot_stable').accountUid, '1234567890123');
  const child = listed.find(bot => bot.id === 'bot_stable');
  assert.equal(child.accountIdentityStatus, 'verified');
  assert.equal(child.adminBindingStatus, 'pending');
  assert.equal(await registry.describe('orphan'), null);
});

test('handshake and reload helpers resolve runtime root independently of the source release', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-handshake-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'mybot'));
  const script = `import assert from 'node:assert/strict'; import path from 'node:path';
    import { getHandshakePath } from ${JSON.stringify(new URL('../src/commands/mybot/System/identity-handshake.js', import.meta.url).href)};
    import { getReloadRequestPath } from ${JSON.stringify(new URL('../src/commands/mybot/System/reload-request.js', import.meta.url).href)};
    assert.equal(getHandshakePath('session'), path.join(process.argv[1], 'mybot', 'state', 'qr-bootstrap', 'session.json'));
    assert.equal(getReloadRequestPath('bot_stable'), path.join(process.argv[1], 'mybot', 'state', 'reload', 'bot_stable.json'));`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { env: { ...process.env, PROJECT_ROOT: root, ProjectRoot: root }, stdio: 'pipe' });
});
