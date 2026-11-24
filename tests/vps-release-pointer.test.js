import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginSwitch, recoverSwitch, confirmSwitch } from '../deploy/release-pointer.mjs';

test('unconfirmed switch recovers the previous release and confirmed switch stays', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-pointer-'));
  const base = 'a'.repeat(40), target = 'b'.repeat(40);
  try {
    for (const id of [base, target]) {
      const release = path.join(root, 'releases', id); fs.mkdirSync(release, { recursive: true });
      fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: id }));
    }
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    beginSwitch({ root, base, target });
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${target}`);
    assert.throws(() => beginSwitch({ root, base, target }), /pending/i);
    recoverSwitch({ root });
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${base}`);
    beginSwitch({ root, base, target }); confirmSwitch({ root });
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${target}`);
    assert.throws(() => recoverSwitch({ root }), /pending/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recovery handles interruption before link change and refuses unrelated current', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-pointer-recover-'));
  const base = 'a'.repeat(40), target = 'b'.repeat(40), other = 'c'.repeat(40);
  try {
    for (const id of [base, target, other]) {
      const release = path.join(root, 'releases', id); fs.mkdirSync(release, { recursive: true });
      fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: id }));
    }
    const journal = path.join(root, '.deploy-transaction.json');
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    fs.writeFileSync(journal, JSON.stringify({ status: 'pending', base, target }));
    assert.equal(recoverSwitch({ root }), base);
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${base}`);
    fs.unlinkSync(path.join(root, 'current')); fs.symlinkSync(`releases/${other}`, path.join(root, 'current'));
    fs.writeFileSync(journal, JSON.stringify({ status: 'pending', base, target }));
    assert.throws(() => recoverSwitch({ root }), /unexpected/i);
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${other}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
