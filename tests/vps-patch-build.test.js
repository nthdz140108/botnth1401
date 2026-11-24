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

test('worker-only change builds and replaces only the worker binary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-worker-build-'));
  try {
    const target = 'b'.repeat(40), base = 'a'.repeat(40), calls = [];
    fs.writeFileSync(path.join(root, '.mybot-release.json'), JSON.stringify({ commit: target, base, status: 'staged', files: [{ path: 'rust/bins/ws-decode-worker/src/main.rs' }] }));
    fs.mkdirSync(path.join(root, 'rust', 'target', 'release'), { recursive: true }); fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'rust', 'target', 'release', 'ws-decode-worker'), 'new worker');
    fs.writeFileSync(path.join(root, 'bin', 'mybotd'), 'old daemon'); fs.writeFileSync(path.join(root, 'bin', 'ws-decode-worker'), 'old worker');
    prepareRelease({ stageDir: root, run: (cmd, args) => calls.push([cmd, args]) });
    assert.deepEqual(calls, [['cargo', ['build', '--release', '--locked', '-p', 'ws-decode-worker']]]);
    assert.equal(fs.readFileSync(path.join(root, 'bin', 'mybotd'), 'utf8'), 'old daemon');
    assert.equal(fs.readFileSync(path.join(root, 'bin', 'ws-decode-worker'), 'utf8'), 'new worker');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dashboard Rust change does not rebuild the worker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-rust-build-'));
  try {
    const target = 'b'.repeat(40), base = 'a'.repeat(40), calls = [];
    fs.writeFileSync(path.join(root, '.mybot-release.json'), JSON.stringify({ commit: target, base, status: 'staged', files: [{ path: 'rust/crates/mybot-dashboard/src/lib.rs' }] }));
    fs.mkdirSync(path.join(root, 'rust', 'target', 'release'), { recursive: true }); fs.mkdirSync(path.join(root, 'bin'));
    for (const name of ['mybotd', 'mybot-ctl']) fs.writeFileSync(path.join(root, 'rust', 'target', 'release', name), `new ${name}`);
    fs.writeFileSync(path.join(root, 'bin', 'ws-decode-worker'), 'old worker');
    prepareRelease({ stageDir: root, run: (cmd, args) => calls.push([cmd, args]) });
    assert.deepEqual(calls, [['cargo', ['build', '--release', '--locked', '-p', 'mybotd', '-p', 'mybot-ctl']]]);
    assert.equal(fs.readFileSync(path.join(root, 'bin', 'ws-decode-worker'), 'utf8'), 'old worker');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Rust build can use a shared cargo target cache outside releases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-cargo-cache-'));
  try {
    const stage = path.join(root, 'stage'), cache = path.join(root, 'cache'), calls = [];
    fs.mkdirSync(path.join(stage, 'rust'), { recursive: true }); fs.mkdirSync(path.join(stage, 'bin')); fs.mkdirSync(path.join(cache, 'release'), { recursive: true });
    fs.writeFileSync(path.join(stage, '.mybot-release.json'), JSON.stringify({ commit: 'b'.repeat(40), base: 'a'.repeat(40), status: 'staged', files: [{ path: 'rust/bins/ws-decode-worker/src/main.rs' }] }));
    fs.writeFileSync(path.join(cache, 'release', 'ws-decode-worker'), 'cached build');
    prepareRelease({ stageDir: stage, cargoTargetDir: cache, run: (cmd, args, cwd, env) => calls.push(env) });
    assert.equal(calls[0].CARGO_TARGET_DIR, cache);
    assert.equal(fs.readFileSync(path.join(stage, 'bin', 'ws-decode-worker'), 'utf8'), 'cached build');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dependency install never removes the previous release dependencies', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-deps-build-'));
  try {
    const stage = path.join(root, 'stage'), shared = path.join(root, 'shared'); fs.mkdirSync(stage); fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'keep'), 'old dependencies'); fs.symlinkSync(shared, path.join(stage, 'node_modules'));
    fs.writeFileSync(path.join(stage, '.mybot-release.json'), JSON.stringify({ commit: 'b'.repeat(40), base: 'a'.repeat(40), status: 'staged', files: [{ path: 'package-lock.json' }] }));
    prepareRelease({ stageDir: stage, run: (cmd, args, cwd) => { assert.equal(fs.existsSync(path.join(cwd, 'node_modules')), false); fs.mkdirSync(path.join(cwd, 'node_modules')); } });
    assert.equal(fs.readFileSync(path.join(shared, 'keep'), 'utf8'), 'old dependencies');
    assert.equal(fs.lstatSync(path.join(stage, 'node_modules')).isSymbolicLink(), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
