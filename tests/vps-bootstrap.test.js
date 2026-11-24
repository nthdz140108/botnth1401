import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapRelease, rollbackBootstrap } from '../deploy/bootstrap-release.mjs';

test('failed first switch restores launchers, dashboard and binary without changing runtime data', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-bootstrap-'));
  const id = 'a'.repeat(40);
  try {
    const release = path.join(root, 'releases', id), bin = path.join(root, 'usr-bin');
    fs.mkdirSync(path.join(root, 'src', 'dashboard'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'mybot'), { recursive: true }); fs.mkdirSync(bin);
    fs.mkdirSync(path.join(release, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(release, 'bin'));
    fs.mkdirSync(path.join(release, 'src', 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(release, 'src', 'bootstrap.js'), 'new bootstrap');
    fs.writeFileSync(path.join(release, 'src', 'dashboard', 'node-bridge-service.js'), 'new bridge');
    fs.writeFileSync(path.join(root, 'src', 'bootstrap.js'), 'legacy bootstrap');
    fs.writeFileSync(path.join(root, 'src', 'dashboard', 'node-bridge-service.js'), 'legacy bridge');
    fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'old ui');
    fs.writeFileSync(path.join(root, 'mybot', 'state.json'), 'unchanged');
    fs.writeFileSync(path.join(bin, 'mybotd'), 'old binary');
    fs.writeFileSync(path.join(release, 'dashboard', 'dist', 'index.html'), 'new ui');
    fs.writeFileSync(path.join(release, 'bin', 'mybotd'), 'new binary');
    fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: id, status: 'ready' }));
    const restarts = [];
    await assert.rejects(bootstrapRelease({ root, binaryDir: bin, target: id, restart: async value => restarts.push(value), health: async value => value === 'legacy' }), /health/i);
    assert.deepEqual(restarts, [id, 'legacy']);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'bootstrap.js'), 'utf8'), 'legacy bootstrap');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'dashboard', 'node-bridge-service.js'), 'utf8'), 'legacy bridge');
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'old ui');
    assert.equal(fs.readFileSync(path.join(bin, 'mybotd'), 'utf8'), 'old binary');
    assert.equal(fs.readFileSync(path.join(root, 'mybot', 'state.json'), 'utf8'), 'unchanged');
    assert.equal(fs.existsSync(path.join(root, 'current')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bootstrap refuses an incomplete release before modifying live files', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-bootstrap-incomplete-'));
  const id = 'a'.repeat(40);
  try {
    const release = path.join(root, 'releases', id), bin = path.join(root, 'usr-bin');
    fs.mkdirSync(path.join(root, 'src', 'dashboard'), { recursive: true }); fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(release, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(release, 'bin')); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'src', 'bootstrap.js'), 'old'); fs.writeFileSync(path.join(root, 'src', 'dashboard', 'node-bridge-service.js'), 'old bridge');
    fs.writeFileSync(path.join(bin, 'mybotd'), 'old binary'); fs.writeFileSync(path.join(release, 'bin', 'mybotd'), 'new binary');
    fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: id, status: 'ready' }));
    await assert.rejects(bootstrapRelease({ root, binaryDir: bin, target: id, restart: async () => {}, health: async () => true }));
    assert.equal(fs.readFileSync(path.join(root, 'src', 'bootstrap.js'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(root, 'current')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('successful bootstrap keeps runtime data and retains a legacy backup', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-bootstrap-success-'));
  const id = 'b'.repeat(40);
  try {
    const release = path.join(root, 'releases', id), bin = path.join(root, 'usr-bin');
    fs.mkdirSync(path.join(root, 'src', 'dashboard'), { recursive: true }); fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(root, 'mybot')); fs.mkdirSync(bin);
    fs.mkdirSync(path.join(release, 'src', 'dashboard'), { recursive: true }); fs.mkdirSync(path.join(release, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(release, 'bin'));
    fs.writeFileSync(path.join(root, 'src', 'bootstrap.js'), 'old'); fs.writeFileSync(path.join(root, 'src', 'dashboard', 'node-bridge-service.js'), 'old bridge');
    fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'old ui'); fs.writeFileSync(path.join(root, 'mybot', 'state.json'), 'bot state');
    fs.writeFileSync(path.join(release, 'src', 'bootstrap.js'), 'new'); fs.writeFileSync(path.join(release, 'src', 'dashboard', 'node-bridge-service.js'), 'new bridge');
    fs.writeFileSync(path.join(release, 'dashboard', 'dist', 'index.html'), 'new ui'); fs.writeFileSync(path.join(release, 'bin', 'mybotd'), 'new binary');
    fs.writeFileSync(path.join(bin, 'mybotd'), 'old binary'); fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: id, status: 'ready' }));
    const result = await bootstrapRelease({ root, binaryDir: bin, target: id, restart: async () => {}, health: async () => true });
    assert.equal(result.status, 'confirmed');
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${id}`);
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'new ui');
    assert.equal(fs.readFileSync(path.join(bin, 'mybotd'), 'utf8'), 'new binary');
    assert.equal(fs.readFileSync(path.join(root, 'mybot', 'state.json'), 'utf8'), 'bot state');
    const j = JSON.parse(fs.readFileSync(path.join(root, '.bootstrap-transaction.json')));
    assert.equal(fs.readFileSync(path.join(root, '.bootstrap-backups', j.backupId, 'dist', 'index.html'), 'utf8'), 'old ui');
    await rollbackBootstrap({ root, restart: async () => {}, health: async () => true });
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'old ui');
    assert.equal(fs.readFileSync(path.join(bin, 'mybotd'), 'utf8'), 'old binary');
    assert.equal(fs.readFileSync(path.join(root, 'mybot', 'state.json'), 'utf8'), 'bot state');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
