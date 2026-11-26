import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPreview } from '../deploy/patch-preview.mjs';
import { createPatchPackage } from '../deploy/patch-package.mjs';
import { validatePatchPackage } from '../deploy/patch-validate.mjs';
import { prepareRelease } from '../deploy/patch-build.mjs';
import { planRuntimeActions } from '../deploy/runtime-actions.mjs';
import { orchestrateIncremental } from '../deploy/incremental-orchestrator.mjs';
import { createRemoteAdapter } from '../deploy/remote-adapter.mjs';
import * as runtime from '../deploy/runtime-controller.mjs';

const migration = 'rust/portal/crates/server/migrations/0001_portal.sql';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-web-retirement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (name, text) => { const dest = path.join(repo, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  write('rust/portal/Cargo.toml', '[workspace]\n'); write(migration, 'CREATE TABLE tenants(id int);\n');
  git('add', '.'); git('commit', '-qm', 'portal'); const base = git('rev-parse', 'HEAD');
  return { root, repo, git, write, base };
}

test('a complete portal removal packages migration source deletions without running SQL', t => {
  const f = fixture(t); f.git('rm', '-r', 'rust/portal'); f.git('commit', '-qm', 'retire');
  const preview = buildPreview({ repo: f.repo, base: f.base, target: 'HEAD' });
  assert.equal(preview.files.find(f => f.path === migration)?.status, 'delete');
  const output = path.join(f.root, 'package');
  createPatchPackage({ repo: f.repo, base: f.base, target: 'HEAD', output });
  assert.deepEqual(validatePatchPackage(output).files, preview.files);
  assert.equal(fs.existsSync(path.join(output, 'files', migration)), false);
});

test('portal migration edits and partial removals still require maintenance', t => {
  const f = fixture(t); f.write(migration, 'DROP TABLE tenants;\n'); f.git('add', '.'); f.git('commit', '-qm', 'edit');
  assert.throws(() => buildPreview({ repo: f.repo, base: f.base, target: 'HEAD' }), /migration.*maintenance/i);
  f.git('rm', migration); f.git('commit', '-qm', 'partial removal');
  assert.throws(() => buildPreview({ repo: f.repo, base: f.base, target: 'HEAD' }), /migration.*maintenance/i);
});

test('package validation rejects a new retired portal SQL migration payload', t => {
  const f = fixture(t), output = path.join(f.root, 'package'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schema: 1, base: f.base, target: 'b'.repeat(40), files: [{ path: migration, status: 'add' }] }));
  assert.throws(() => validatePatchPackage(output), /patch path/i);
});

test('portal removal does not request a Rust build or restart by itself', () => {
  const actions = planRuntimeActions([migration, 'rust/portal/Cargo.toml']);
  assert.equal(actions.buildRust, false); assert.equal(actions.restartRust, false);
  assert.equal(actions.retirePortal, true);
});

test('retirement removes copied portal artifacts and preserves runtime data', t => {
  const f = fixture(t), stage = path.join(f.root, 'stage'); fs.mkdirSync(stage);
  fs.mkdirSync(path.join(stage, 'bin')); fs.mkdirSync(path.join(stage, 'portal-site'));
  fs.writeFileSync(path.join(stage, 'bin', 'mybot-portal'), 'old');
  fs.writeFileSync(path.join(stage, 'bin', 'mybot-portal-worker'), 'old');
  fs.writeFileSync(path.join(stage, 'bin', 'mybotd'), 'keep daemon');
  fs.writeFileSync(path.join(stage, 'portal-site', 'index.html'), 'old');
  fs.mkdirSync(path.join(stage, 'shared')); fs.writeFileSync(path.join(stage, 'shared', 'wallet.db'), 'keep data');
  fs.writeFileSync(path.join(stage, '.mybot-release.json'), JSON.stringify({ status: 'staged', files: [{ path: migration, status: 'delete' }, { path: 'rust/portal/Cargo.toml', status: 'delete' }] }));
  prepareRelease({ stageDir: stage, run: () => assert.fail('portal removal must not compile Rust or execute SQL') });
  assert.equal(fs.existsSync(path.join(stage, 'bin', 'mybot-portal')), false);
  assert.equal(fs.existsSync(path.join(stage, 'bin', 'mybot-portal-worker')), false);
  assert.equal(fs.existsSync(path.join(stage, 'portal-site')), false);
  assert.equal(fs.readFileSync(path.join(stage, 'bin', 'mybotd'), 'utf8'), 'keep daemon');
  assert.equal(fs.readFileSync(path.join(stage, 'shared', 'wallet.db'), 'utf8'), 'keep data');
});

test('an updater change prepares target control before uploading and leaves previews read only', async t => {
  const f = fixture(t); f.write('deploy/runtime-actions.mjs', 'export const version = 2;'); f.git('add', '.'); f.git('commit', '-qm', 'control');
  const calls = [], remote = {
    status: async () => ({ current: f.base }),
    prepareDeploymentControl: async target => calls.push(['control', target]),
    upload: async () => { calls.push(['upload']); return '/tmp/payload'; },
    launch: async () => calls.push(['launch']), wait: async () => ({ status: 'confirmed' }),
  };
  await orchestrateIncremental({ args: ['--dry-run'], repo: f.repo, remote }); assert.deepEqual(calls, []);
  await orchestrateIncremental({ args: ['--apply'], repo: f.repo, remote });
  assert.deepEqual(calls, [['control', f.git('rev-parse', 'HEAD')], ['upload'], ['launch']]);
});

test('remote launch uses a validated commit-addressed deployment control runner', async () => {
  const commands = [], remote = createRemoteAdapter({ run: async command => { commands.push(command); return ''; }, archive: async () => Buffer.alloc(0) });
  const runner = `/opt/mybot/deploy-control/releases/${'a'.repeat(40)}/deploy/ubuntu/locked-runner.sh`;
  assert.equal(typeof remote.setControlRunner, 'function'); remote.setControlRunner(runner);
  await remote.launch('apply', '/opt/mybot/.runtime/deploy-upload.abcdefgh', 'b'.repeat(32));
  assert.ok(commands[0].includes(runner));
  assert.throws(() => remote.setControlRunner(`${runner}; reboot`), /control runner/i);
});

test('retirement reconciles services on both update and rollback and checks their health', async () => {
  const targets = []; let healthy = false;
  const controller = await runtime.createRuntimeController({ root: '/opt/mybot', paths: ['rust/portal/Cargo.toml'], snapshot: [], restartPortal: async target => targets.push(target), checkPortalHealth: async () => healthy, checkHealth: async () => true, delay: async () => {} });
  await controller.restart('new'); assert.equal(await controller.health(), false);
  healthy = true; assert.equal(await controller.health(), true);
  await controller.restart('old'); assert.deepEqual(targets, ['new', 'old']);
});

test('service retirement disables installed units and rollback enables them again', async t => {
  const f = fixture(t), root = f.root, calls = [];
  assert.equal(typeof runtime.reconcilePortalServices, 'function');
  const run = async (command, args) => { calls.push([command, args]); return { stdout: 'loaded\n' }; };
  await runtime.reconcilePortalServices({ root, run });
  assert.equal(calls.filter(([, args]) => args[0] === 'disable' && args.includes('--now')).length, 2);
  calls.length = 0; fs.mkdirSync(path.join(root, 'current', 'bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'current', 'bin', 'mybot-portal'), 'old');
  await runtime.reconcilePortalServices({ root, run });
  assert.equal(calls.filter(([, args]) => args[0] === 'enable' && args.includes('--now')).length, 2);
});

test('retirement tolerates portal units that were never installed', async t => {
  const f = fixture(t);
  const run = async (_command, args) => {
    assert.equal(args[0], 'show');
    throw Object.assign(new Error('Unit not found'), { code: 1, stdout: 'not-found\n', stderr: '' });
  };
  await runtime.reconcilePortalServices({ root: f.root, run });
});

test('retirement health accepts missing units and detects an installed unit still running', async t => {
  const f = fixture(t);
  assert.equal(typeof runtime.checkPortalServiceHealth, 'function');
  const absent = async (_command, args) => {
    assert.equal(args[3], 'LoadState');
    throw Object.assign(new Error('Unit not found'), { code: 1, stdout: 'not-found\n' });
  };
  assert.equal(await runtime.checkPortalServiceHealth({ root: f.root, run: absent }), true);
  const active = async (_command, args) => ({ stdout: args[3] === 'LoadState' ? 'loaded\n' : 'active\n' });
  assert.equal(await runtime.checkPortalServiceHealth({ root: f.root, run: active }), false);
  const stopped = async (_command, args) => ({ stdout: args[3] === 'LoadState' ? 'loaded\n' : 'inactive\n' });
  assert.equal(await runtime.checkPortalServiceHealth({ root: f.root, run: stopped }), true);
});
