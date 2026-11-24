import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeReleaseWrapper } from '../deploy/release-wrapper.mjs';
import { createPm2Driver, selectManagedProcesses, restartManagedProcesses } from '../deploy/pm2-fleet.mjs';

test('isolated PM2 restarts a bot onto the selected release', { skip: process.platform === 'win32' || process.env.MYBOT_PM2_INTEGRATION !== '1', timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-pm2-int-'));
  const previousPm2Home = process.env.PM2_HOME;
  const home = path.join(root, 'pm2-home'); process.env.PM2_HOME = home;
  try {
    const base = 'a'.repeat(40), target = 'b'.repeat(40);
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const id of [base, target]) {
      const dir = path.join(root, 'releases', id); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.mybot-release.json'), JSON.stringify({ commit: id, status: 'ready' }));
      fs.writeFileSync(path.join(dir, 'src', 'bootstrap.js'), 'setInterval(() => {}, 1000);');
    }
    fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'bootstrap.js'), makeReleaseWrapper({ runtimeRoot: root, entry: 'src/bootstrap.js' }));
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current'));
    execFileSync('pm2', ['start', path.join(root, 'src', 'bootstrap.js'), '--name', 'mybot-test', '--cwd', root], { stdio: 'ignore', timeout: 20000 });
    const driver = createPm2Driver({ root });
    let snapshot = [];
    for (let i = 0; i < 60; i++) { snapshot = selectManagedProcesses(await driver.getProcesses(), root); if (snapshot.length) break; await new Promise(r => setTimeout(r, 250)); }
    assert.equal(snapshot.length, 1);
    fs.symlinkSync(`releases/${target}`, path.join(root, 'next')); fs.renameSync(path.join(root, 'next'), path.join(root, 'current'));
    const restarted = await restartManagedProcesses({ runtimeRoot: root, snapshot, target, ...driver });
    assert.equal(restarted.length, 1);
  } finally {
    try { execFileSync('pm2', ['kill'], { stdio: 'ignore', timeout: 15000, env: { ...process.env, PM2_HOME: home } }); } catch {}
    if (previousPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previousPm2Home;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
