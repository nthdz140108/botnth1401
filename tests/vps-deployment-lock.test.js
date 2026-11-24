import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a second deployment cannot acquire the lock', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-lock-'));
  const script = fileURLToPath(new URL('../deploy/ubuntu/locked-runner.sh', import.meta.url));
  const holder = spawn('flock', ['-x', path.join(root, '.deploy.lock'), 'sh', '-c', 'echo ready; sleep 3'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
    const result = spawnSync('bash', [script, root, 'recover', 'a'.repeat(32)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 75);
    assert.match(result.stderr, /deployment.*running/i);
  } finally {
    if (holder.exitCode === null) await new Promise(resolve => holder.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker refuses mutating operations when invoked without the lock wrapper', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-unlocked-'));
  try {
    const cli = fileURLToPath(new URL('../deploy/deployment-worker-cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, root, 'recover', 'a'.repeat(32)], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /lock/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lock wrapper passes the lock descriptor to the worker', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-locked-'));
  try {
    const script = fileURLToPath(new URL('../deploy/ubuntu/locked-runner.sh', import.meta.url));
    const result = spawnSync('bash', [script, root, 'recover', 'a'.repeat(32)], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /missing recovery context/i); assert.doesNotMatch(result.stderr, /lock is required/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
