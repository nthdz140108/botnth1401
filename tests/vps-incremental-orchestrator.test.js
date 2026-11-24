import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { orchestrateIncremental } from '../deploy/incremental-orchestrator.mjs';

test('preview sends nothing and apply uploads only committed changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-orchestrator-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'old'); git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'committed'); git('add', '.'); git('commit', '-qm', 'target'); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'dirty');
    let uploads = 0, launches = 0;
    const remote = {
      status: async () => ({ current: base }),
      upload: async pkg => { uploads++; assert.equal(fs.readFileSync(path.join(pkg, 'files', 'src', 'a.js'), 'utf8'), 'committed'); return '/tmp/payload'; },
      launch: async () => { launches++; },
      wait: async () => ({ status: 'confirmed' }),
    };
    const preview = await orchestrateIncremental({ args: ['--dry-run'], repo: dir, remote });
    assert.equal(preview.files.length, 1); assert.equal(uploads, 0);
    const result = await orchestrateIncremental({ args: ['--apply'], repo: dir, remote });
    assert.equal(result.status, 'confirmed'); assert.equal(uploads, 1); assert.equal(launches, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reports how to check a deployment when the connection is lost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-orchestrator-lost-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD'); fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'new'); git('add', '.'); git('commit', '-qm', 'target');
    const remote = { status: async () => ({ current: base }), upload: async () => '/tmp/payload', launch: async () => {}, wait: async () => { throw new Error('connection lost'); } };
    await assert.rejects(orchestrateIncremental({ args: ['--apply'], repo: dir, remote }), /--status/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
