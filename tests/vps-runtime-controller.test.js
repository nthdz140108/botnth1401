import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeController } from '../deploy/runtime-controller.mjs';

test('UI-only update probes health without restarting Node or systemd', async () => {
  const root = '/opt/mybot'; let restarts = 0;
  const entries = [{ name: 'admin', pm_id: 1, pid: 10, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } }];
  const controller = await createRuntimeController({ root, paths: ['dashboard/src/main.jsx'], driver: { getProcesses: async () => entries, restartProcess: async () => restarts++, markerMatches: async () => true }, restartService: async () => restarts++, checkHealth: async () => true });
  await controller.restart('a'.repeat(40));
  assert.equal(await controller.health('a'.repeat(40)), true);
  assert.equal(restarts, 0);
});

test('JS change restarts the active fleet but does not restart systemd', async () => {
  const root = '/opt/mybot'; let serviceRestarts = 0, botRestarts = 0;
  const entries = [{ name: 'admin', pm_id: 1, pid: 10, pm2_env: { status: 'online', pm_exec_path: `${root}/src/bootstrap.js` } }];
  const controller = await createRuntimeController({ root, paths: ['src/commands/a.js'], driver: { getProcesses: async () => entries, restartProcess: async () => { botRestarts++; entries[0].pid++; }, markerMatches: async () => true }, restartService: async () => serviceRestarts++, checkHealth: async () => true, delay: async () => {} });
  await controller.restart('a'.repeat(40));
  assert.equal(botRestarts, 1); assert.equal(serviceRestarts, 0);
});
