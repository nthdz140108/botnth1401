import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRelease } from '../deploy/patch-build.mjs';

test('JS-only patch marks stage ready without dependency or Rust builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-build-'));
  try {
    const stage = path.join(root, 'stage'); fs.mkdirSync(stage);
    const base = 'a'.repeat(40), target = 'b'.repeat(40);
    fs.writeFileSync(path.join(stage, '.mybot-release.json'), JSON.stringify({ commit: target, base, status: 'staged', files: [{ path: 'src/command.js' }] }));
    const calls = [];
    prepareRelease({ stageDir: stage, run: (...args) => calls.push(args) });
    assert.deepEqual(calls, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, '.mybot-release.json'))).status, 'ready');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed build does not mark release ready', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-build-fail-'));
  try {
    const base = 'a'.repeat(40), target = 'b'.repeat(40);
    fs.writeFileSync(path.join(root, '.mybot-release.json'), JSON.stringify({ commit: target, base, status: 'staged', files: [{ path: 'dashboard/src/main.jsx' }] }));
    fs.mkdirSync(path.join(root, 'dashboard'));
    assert.throws(() => prepareRelease({ stageDir: root, run: () => { throw new Error('build failed'); } }), /build failed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.mybot-release.json'))).status, 'staged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dashboard build refuses a shared output directory symlink', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-build-link-'));
  try {
    const stage = path.join(root, 'stage'), shared = path.join(root, 'shared');
    fs.mkdirSync(path.join(stage, 'dashboard'), { recursive: true }); fs.mkdirSync(shared);
    fs.symlinkSync(shared, path.join(stage, 'dashboard', 'dist'));
    fs.writeFileSync(path.join(stage, '.mybot-release.json'), JSON.stringify({ commit: 'b'.repeat(40), base: 'a'.repeat(40), status: 'staged', files: [{ path: 'dashboard/src/main.jsx' }] }));
    assert.throws(() => prepareRelease({ stageDir: stage, run: () => {} }), /unsafe/i);
    assert.equal(fs.readdirSync(shared).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
