import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectManagedProcesses, restartManagedProcesses, createPm2Driver } from '../deploy/pm2-fleet.mjs';

test('selects only online MyBot processes from the expected runtime root', () => {
  const root = '/opt/mybot';
  const items = [
    { name: 'admin', pm_id: 1, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } },
    { name: 'child', pm_id: 2, pm2_env: { status: 'stopped', pm_exec_path: `${root}/src/bootstrap.js` } },
    { name: 'mybot-bridge', pm_id: 3, pm2_env: { status: 'online', pm_exec_path: `${root}/src/dashboard/node-bridge-service.js` } },
    { name: 'other', pm_id: 4, pm2_env: { status: 'online', pm_exec_path: '/opt/other/app.js' } },
  ];
  assert.deepEqual(selectManagedProcesses(items, root), [{ id: 1, name: 'admin' }, { id: 3, name: 'mybot-bridge' }]);
});

test('PM2 driver checks PID, commit and process start time in the release marker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-marker-'));
  try {
    const dir = path.join(root, '.runtime', 'release-pids'); fs.mkdirSync(dir, { recursive: true });
    const commit = 'a'.repeat(40), startedAt = Date.now();
    fs.writeFileSync(path.join(dir, '123.json'), JSON.stringify({ pid: 123, commit, startedAt, entry: 'src/bootstrap.js' }));
    const driver = createPm2Driver({ root, execute: async () => '[]' });
    assert.equal(await driver.markerMatches(123, commit, startedAt), true);
    assert.equal(await driver.markerMatches(123, 'b'.repeat(40), startedAt), false);
    assert.equal(await driver.markerMatches(123, commit, startedAt + 6000), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not restart a process that the operator stopped after the snapshot', async () => {
  const root = '/opt/mybot', target = 'b'.repeat(40), calls = [];
  const initial = [{ name: 'child', pm_id: 7, pid: 12, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } }];
  const snapshot = selectManagedProcesses(initial, root);
  initial[0].pm2_env.status = 'stopped';
  await restartManagedProcesses({ runtimeRoot: root, snapshot, target, getProcesses: async () => initial, restartProcess: async id => calls.push(id), markerMatches: async () => true });
  assert.deepEqual(calls, []);
});

test('restarts only selected online processes and checks their new release marker', async () => {
  const root = '/opt/mybot', target = 'a'.repeat(40), restarted = [];
  const entries = [
    { name: 'admin', pm_id: 1, pid: 10, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } },
    { name: 'stopped', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_exec_path: `${root}/src/bootstrap.js` } },
    { name: 'unrelated', pm_id: 3, pid: 20, pm2_env: { status: 'online', pm_exec_path: '/opt/other/index.js' } },
  ];
  const snapshot = selectManagedProcesses(entries, root);
  await restartManagedProcesses({ runtimeRoot: root, snapshot, target, getProcesses: async () => entries, restartProcess: async id => { restarted.push(id); entries.find(p => p.pm_id === id).pid += 100; }, markerMatches: async (pid, commit) => pid === 110 && commit === target, delay: async () => {} });
  assert.deepEqual(restarted, [1]);
  assert.equal(entries[1].pm2_env.status, 'stopped');
});

test('legacy recovery restarts the same fleet without expecting release markers', async () => {
  const root = '/opt/mybot';
  const entries = [{ name: 'admin', pm_id: 1, pid: 10, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } }];
  const snapshot = selectManagedProcesses(entries, root);
  const result = await restartManagedProcesses({ runtimeRoot: root, snapshot, target: 'legacy', getProcesses: async () => entries, restartProcess: async () => { entries[0].pid = 11; }, markerMatches: async () => { throw new Error('legacy has no marker'); }, delay: async () => {} });
  assert.equal(result.length, 1);
});

test('recovery can restart a previously running bot that crashed during deployment', async () => {
  const root = '/opt/mybot';
  const entry = { name: 'admin', pm_id: 1, pid: 0, pm2_env: { status: 'errored', pm_exec_path: `${root}/src/bootstrap.js` } };
  const result = await restartManagedProcesses({ runtimeRoot: root, snapshot: [{ id: 1, name: 'admin' }], target: 'legacy', getProcesses: async () => [entry], restartProcess: async () => { entry.pid = 11; entry.pm2_env.status = 'online'; }, markerMatches: async () => false, delay: async () => {} });
  assert.equal(result.length, 1);
});

test('recovery identifies a bot by name after PM2 assigns a new ID', async () => {
  const root = '/opt/mybot', calls = [];
  const entry = { name: 'admin', pm_id: 42, pid: 12, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } };
  await restartManagedProcesses({ runtimeRoot: root, snapshot: [{ id: 1, name: 'admin' }], target: 'legacy', getProcesses: async () => [entry], restartProcess: async id => { calls.push(id); entry.pid = 13; }, markerMatches: async () => false, delay: async () => {} });
  assert.deepEqual(calls, [42]);
});
