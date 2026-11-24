import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planRuntimeActions } from './runtime-actions.mjs';
import { createPm2Driver, selectManagedProcesses, restartManagedProcesses } from './pm2-fleet.mjs';
import { checkRuntimeHealth } from './runtime-health.mjs';
import path from 'node:path';
const execFileAsync = promisify(execFile);
async function restartSystemd() { await execFileAsync('systemctl', ['restart', 'mybot.service'], { timeout: 60000 }); }
export async function createRuntimeController({ root, paths, snapshot, force = false, binaryDir = process.env.MYBOT_DEPLOY_BINARY_DIR || '/usr/local/bin', driver = createPm2Driver({ root }), restartService = restartSystemd, checkHealth = () => checkRuntimeHealth({ root, binaryPath: path.join(binaryDir, 'mybotd'), dashboardUrl: process.env.MYBOT_DEPLOY_DASHBOARD_URL, bridgeUrl: process.env.MYBOT_DEPLOY_BRIDGE_URL }), delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const actions = planRuntimeActions(paths);
  const fleet = snapshot ?? selectManagedProcesses(await driver.getProcesses(), root);
  if (!Array.isArray(fleet) || fleet.some(p => !Number.isSafeInteger(p.id) || p.id < 0 || typeof p.name !== 'string' || !p.name)) throw new Error('Invalid fleet snapshot');
  return {
    snapshot: fleet, actions,
    async restart(target) {
      if (force || actions.restartRust) await restartService();
      if (force || actions.restartNode) await restartManagedProcesses({ runtimeRoot: root, snapshot: fleet, target, ...driver, delay });
    },
    async health() {
      for (let i = 0; i < 30; i++) { if (await checkHealth()) return true; await delay(1000); }
      return false;
    },
  };
}
