import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatchTransaction, recoverPendingTransaction } from '../deploy/patch-transaction.mjs';

test('health failure restores old release and leaves data untouched', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-tx-'));
  const base = 'a'.repeat(40), target = 'b'.repeat(40), content = Buffer.from('new');
  try {
    const oldDir = path.join(root, 'releases', base), pkg = path.join(root, 'package');
    fs.mkdirSync(path.join(oldDir, 'src'), { recursive: true }); fs.writeFileSync(path.join(oldDir, 'src', 'a.js'), 'old');
    fs.writeFileSync(path.join(oldDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    fs.writeFileSync(path.join(root, 'runtime.json'), 'unchanged');
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), content);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }));
    const restarted = [];
    await assert.rejects(applyPatchTransaction({ root, packageDir: pkg, restart: async id => restarted.push(id), health: async id => id === base }), /health/i);
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${base}`);
    assert.deepEqual(restarted, [target, base]);
    assert.equal(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'), 'unchanged');
    assert.equal(fs.readFileSync(path.join(oldDir, 'src', 'a.js'), 'utf8'), 'old');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.deploy-transaction.json'))).status, 'recovered');
    const retry = await applyPatchTransaction({ root, packageDir: pkg, restart: async () => {}, health: async () => true });
    assert.equal(retry.status, 'confirmed');
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${target}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('healthy JS patch switches exactly one release and confirms journal', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-tx-success-'));
  const base = 'a'.repeat(40), target = 'b'.repeat(40), content = Buffer.from('new');
  try {
    const oldDir = path.join(root, 'releases', base), pkg = path.join(root, 'package');
    fs.mkdirSync(path.join(oldDir, 'src'), { recursive: true }); fs.writeFileSync(path.join(oldDir, 'src', 'a.js'), 'old');
    fs.writeFileSync(path.join(oldDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), content);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }));
    const result = await applyPatchTransaction({ root, packageDir: pkg, restart: async () => {}, health: async () => true });
    assert.equal(result.status, 'confirmed');
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${target}`);
    assert.equal(fs.readFileSync(path.join(root, 'current', 'src', 'a.js'), 'utf8'), 'new');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.deploy-transaction.json'))).status, 'confirmed');
    const again = await applyPatchTransaction({ root, packageDir: pkg, restart: async () => { throw new Error('must not restart'); }, health: async () => true });
    assert.equal(again.status, 'already_applied');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed rollback health remains pending for operator recovery', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-tx-unhealthy-'));
  const base = 'a'.repeat(40), target = 'b'.repeat(40), content = Buffer.from('new');
  try {
    const oldDir = path.join(root, 'releases', base), pkg = path.join(root, 'package');
    fs.mkdirSync(path.join(oldDir, 'src'), { recursive: true }); fs.writeFileSync(path.join(oldDir, 'src', 'a.js'), 'old');
    fs.writeFileSync(path.join(oldDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), content);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }));
    await assert.rejects(applyPatchTransaction({ root, packageDir: pkg, restart: async () => {}, health: async () => false }), /rollback was not verified/i);
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${base}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.deploy-transaction.json'))).status, 'recovery_pending');
    const recovered = await recoverPendingTransaction({ root, restart: async () => {}, health: async () => true });
    assert.equal(recovered, base);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.deploy-transaction.json'))).status, 'recovered');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
