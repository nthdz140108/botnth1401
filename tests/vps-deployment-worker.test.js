import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectDeployment, runDeployment } from '../deploy/deployment-worker.mjs';
import { createHash } from 'node:crypto';

test('status reports a legacy system without changing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-worker-status-'));
  try {
    assert.deepEqual(inspectDeployment(root), { current: null, state: null, transaction: null, bootstrap: null });
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worker applies a patch and persists its status', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-worker-apply-'));
  const base = 'a'.repeat(40), target = 'b'.repeat(40), bytes = Buffer.from('new');
  try {
    const old = path.join(root, 'releases', base), pkg = path.join(root, 'payload');
    fs.mkdirSync(path.join(old, 'src'), { recursive: true }); fs.writeFileSync(path.join(old, 'src', 'a.js'), 'old');
    fs.writeFileSync(path.join(old, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' })); fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), bytes);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
    const controllerFactory = async () => ({ snapshot: [], restart: async () => {}, health: async () => true });
    const requestId = 'c'.repeat(32);
    const result = await runDeployment({ root, operation: 'apply', packageDir: pkg, controllerFactory, requestId });
    assert.equal(result.status, 'confirmed');
    assert.equal(inspectDeployment(root).state.status, 'confirmed');
    assert.equal(inspectDeployment(root).state.requestId, requestId);
    assert.equal(inspectDeployment(root).current, target);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
