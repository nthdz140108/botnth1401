import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('preview CLI prints JSON and identifies a JS-only restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-cli-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'command.js'), 'export default 1;');
    git('add', '.'); git('commit', '-qm', 'target');
    const cli = fileURLToPath(new URL('../deploy/patch-cli.mjs', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [cli, '--repo', dir, '--base', base, '--target', 'HEAD'], { encoding: 'utf8' }));
    assert.equal(result.files.length, 1);
    assert.equal(result.actions.restartNode, true);
    assert.equal(result.actions.buildRust, false);
    assert.equal(result.actions.buildDashboard, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('preview CLI can create a package in a new directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-cli-package-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'bot.js'), 'committed');
    git('add', '.'); git('commit', '-qm', 'target');
    const cli = fileURLToPath(new URL('../deploy/patch-cli.mjs', import.meta.url));
    const output = path.join(dir, 'package');
    execFileSync(process.execPath, [cli, '--repo', repo, '--base', base, '--target', 'HEAD', '--output', output], { encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(output, 'files', 'src', 'bot.js'), 'utf8'), 'committed');
    assert.equal(fs.existsSync(path.join(output, 'manifest.json')), true);
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

test('Windows launcher changes do not get deployed to Ubuntu', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-launcher-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'DAY_LEN_VPS.bat'), '@echo off'); git('add', '.'); git('commit', '-qm', 'launcher');
    assert.deepEqual(buildPreview({ repo: dir, base, target: 'HEAD' }).files, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('database migrations require a separate maintenance procedure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-migration-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    const migration = path.join(dir, 'rust', 'crates', 'storage', 'migrations'); fs.mkdirSync(migration, { recursive: true });
    fs.writeFileSync(path.join(migration, '0002.sql'), 'ALTER TABLE data ADD COLUMN value TEXT;');
    git('add', '.'); git('commit', '-qm', 'migration');
    assert.throws(() => buildPreview({ repo: dir, base, target: 'HEAD' }), /migration.*maintenance/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runtime data under source directories requires manual handling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-runtime-data-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    const data = path.join(dir, 'src', 'service-debug', 'anti-service'); fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'list.json'), '[]'); git('add', '.'); git('commit', '-qm', 'data');
    assert.throws(() => buildPreview({ repo: dir, base, target: 'HEAD' }), /manual/i);
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
