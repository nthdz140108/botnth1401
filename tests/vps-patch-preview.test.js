import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildPreview } from '../deploy/patch-preview.mjs';

test('preview uses committed blobs, expands renames and ignores working changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-patch-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'old.js'), 'committed\n');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    git('mv', 'src/old.js', 'src/new.js'); git('commit', '-qm', 'rename'); const target = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'src', 'new.js'), 'uncommitted');
    const preview = buildPreview({ repo: dir, base, target });
    assert.deepEqual(preview.files.map(f => [f.status, f.path]).sort(), [['add', 'src/new.js'], ['delete', 'src/old.js']]);
    const added = preview.files.find(f => f.status === 'add');
    assert.equal(added.size, Buffer.byteLength('committed\n'));
    assert.equal(added.sha256, createHash('sha256').update('committed\n').digest('hex'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('preview rejects symlinks in target commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-link-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: '/etc/passwd', encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `120000,${blob},src/link.js`); git('commit', '-qm', 'link');
    assert.throws(() => buildPreview({ repo: dir, base, target: 'HEAD' }), /symlink/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('documentation-only commit needs no deployment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-docs-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'README.md'), 'documentation'); git('add', '.'); git('commit', '-qm', 'docs');
    assert.deepEqual(buildPreview({ repo: dir, base, target: 'HEAD' }).files, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('preview detects collision with an unchanged target path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-case-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'content', encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `100644,${blob},src/Foo.js`); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `100644,${blob},src/foo.js`); git('commit', '-qm', 'collision');
    assert.throws(() => buildPreview({ repo: dir, base, target: 'HEAD' }), /collision/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
