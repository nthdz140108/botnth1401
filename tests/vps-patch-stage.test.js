import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stagePatch } from '../deploy/patch-stage.mjs';

test('stages new release without modifying base and rejects wrong base', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-stage-'));
  try {
    const baseDir = path.join(root, 'base'), pkg = path.join(root, 'patch'), stage = path.join(root, 'staged');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true }); fs.writeFileSync(path.join(baseDir, 'src', 'a.js'), 'old');
    const base = 'a'.repeat(40), target = 'b'.repeat(40), data = Buffer.from('new');
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    stagePatch({ baseDir, packageDir: pkg, stageDir: stage });
    assert.equal(fs.readFileSync(path.join(baseDir, 'src', 'a.js'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(stage, 'src', 'a.js'), 'utf8'), 'new');
    const marker = JSON.parse(fs.readFileSync(path.join(stage, '.mybot-release.json')));
    assert.equal(marker.commit, target);
    assert.equal(marker.status, 'staged');
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: 'c'.repeat(40) }));
    assert.throws(() => stagePatch({ baseDir, packageDir: pkg, stageDir: path.join(root, 'bad') }), /base/i);
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'staged' }));
    assert.throws(() => stagePatch({ baseDir, packageDir: pkg, stageDir: path.join(root, 'bad') }), /ready/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staging refuses changes through a shared directory symlink', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-stage-link-'));
  try {
    const baseDir = path.join(root, 'base'), shared = path.join(root, 'shared'), pkg = path.join(root, 'patch');
    fs.mkdirSync(baseDir); fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, 'a.js'), 'original');
    fs.symlinkSync(shared, path.join(baseDir, 'src'));
    const base = 'a'.repeat(40), target = 'b'.repeat(40), data = Buffer.from('new');
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    assert.throws(() => stagePatch({ baseDir, packageDir: pkg, stageDir: path.join(root, 'staged') }), /unsafe/i);
    assert.equal(fs.readFileSync(path.join(shared, 'a.js'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(root, 'staged')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staging rejects a payload modified after validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-stage-race-'));
  const originalCopy = fs.copyFileSync;
  try {
    const baseDir = path.join(root, 'base'), pkg = path.join(root, 'patch'), stageDir = path.join(root, 'staged');
    const base = 'a'.repeat(40), target = 'b'.repeat(40), data = Buffer.from('new');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true }); fs.writeFileSync(path.join(baseDir, 'src', 'a.js'), 'old');
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    fs.copyFileSync = (source, dest, flags) => {
      if (String(source).startsWith(path.join(pkg, 'files'))) fs.writeFileSync(source, 'bad');
      return originalCopy(source, dest, flags);
    };
    assert.throws(() => stagePatch({ baseDir, packageDir: pkg, stageDir }), /hash/i);
    assert.equal(fs.existsSync(stageDir), false);
    assert.equal(fs.readFileSync(path.join(baseDir, 'src', 'a.js'), 'utf8'), 'old');
  } finally { fs.copyFileSync = originalCopy; fs.rmSync(root, { recursive: true, force: true }); }
});

test('unchanged dependencies are reused without copying the package tree', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-stage-deps-'));
  try {
    const baseDir = path.join(root, 'base'), pkg = path.join(root, 'patch'), stageDir = path.join(root, 'staged');
    const base = 'a'.repeat(40), target = 'b'.repeat(40), data = Buffer.from('new');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true }); fs.mkdirSync(path.join(baseDir, 'node_modules', 'sample'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'src', 'a.js'), 'old'); fs.writeFileSync(path.join(baseDir, 'node_modules', 'sample', 'index.js'), 'dependency');
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    stagePatch({ baseDir, packageDir: pkg, stageDir });
    assert.equal(fs.lstatSync(path.join(stageDir, 'node_modules')).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(stageDir, 'node_modules')), fs.realpathSync(path.join(baseDir, 'node_modules')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rename stages deletion and addition without changing the previous release', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-stage-rename-'));
  try {
    const baseDir = path.join(root, 'base'), pkg = path.join(root, 'patch'), stageDir = path.join(root, 'staged');
    const base = 'a'.repeat(40), target = 'b'.repeat(40), data = Buffer.from('content');
    fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true }); fs.writeFileSync(path.join(baseDir, 'src', 'old.js'), data);
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'new.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'delete', path: 'src/old.js' }, { status: 'add', path: 'src/new.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    stagePatch({ baseDir, packageDir: pkg, stageDir });
    assert.equal(fs.existsSync(path.join(stageDir, 'src', 'old.js')), false);
    assert.equal(fs.readFileSync(path.join(stageDir, 'src', 'new.js'), 'utf8'), 'content');
    assert.equal(fs.readFileSync(path.join(baseDir, 'src', 'old.js'), 'utf8'), 'content');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
