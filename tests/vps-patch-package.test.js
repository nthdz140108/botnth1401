import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPatchPackage } from '../deploy/patch-package.mjs';

test('package contains only committed changed blobs and manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-pkg-test-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'bot.js'), 'old');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'src', 'bot.js'), 'new'); git('add', '.'); git('commit', '-qm', 'target');
    fs.writeFileSync(path.join(repo, 'src', 'bot.js'), 'uncommitted');
    const output = path.join(dir, 'payload');
    const result = createPatchPackage({ repo, base, target: 'HEAD', output });
    assert.equal(fs.readFileSync(path.join(output, 'files', 'src', 'bot.js'), 'utf8'), 'new');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')), result);
    assert.deepEqual(fs.readdirSync(output).sort(), ['files', 'manifest.json']);
    assert.throws(() => createPatchPackage({ repo, base, target: 'HEAD', output }), /exists/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
