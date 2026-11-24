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
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    stagePatch({ baseDir, packageDir: pkg, stageDir: stage });
    assert.equal(fs.readFileSync(path.join(baseDir, 'src', 'a.js'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(stage, 'src', 'a.js'), 'utf8'), 'new');
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, '.mybot-release.json'))).commit, target);
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: 'c'.repeat(40) }));
    assert.throws(() => stagePatch({ baseDir, packageDir: pkg, stageDir: path.join(root, 'bad') }), /base/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staging refuses changes through a shared directory symlink', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-stage-link-'));
  try {
    const baseDir = path.join(root, 'base'), shared = path.join(root, 'shared'), pkg = path.join(root, 'patch');
    fs.mkdirSync(baseDir); fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, 'a.js'), 'original');
    fs.symlinkSync(shared, path.join(baseDir, 'src'));
    const base = 'a'.repeat(40), target = 'b'.repeat(40), data = Buffer.from('new');
    fs.writeFileSync(path.join(baseDir, '.mybot-release.json'), JSON.stringify({ commit: base }));
    fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), data);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }] }));
    assert.throws(() => stagePatch({ baseDir, packageDir: pkg, stageDir: path.join(root, 'staged') }), /unsafe/i);
    assert.equal(fs.readFileSync(path.join(shared, 'a.js'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(root, 'staged')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
