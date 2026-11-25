import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { planRuntimeActions } from './runtime-actions.mjs';
import { createPm2Driver, selectManagedProcesses, restartManagedProcesses } from './pm2-fleet.mjs';
import { checkRuntimeHealth } from './runtime-health.mjs';
import path from 'node:path';
const execFileAsync = promisify(execFile);
async function restartSystemd() { await execFileAsync('systemctl', ['restart', 'mybot.service'], { timeout: 60000 }); }
async function restartPortalServices(root) {
  if (!fs.existsSync(path.join(root, 'current', 'bin', 'mybot-portal'))) {
    await execFileAsync('systemctl', ['stop', 'mybot-portal-worker.service', 'mybot-portal.service'], {timeout:60000});
    return;
  }
  await execFileAsync('systemctl', ['restart', 'mybot-portal.service', 'mybot-portal-worker.service'], {timeout:60000});
}
async function portalHealth(root) {
  if (!fs.existsSync(path.join(root, 'current', 'bin', 'mybot-portal'))) return true;
  try {
    const result=await execFileAsync('systemctl',['is-active','mybot-portal-worker.service'],{timeout:10000});
    if(result.stdout.trim()!=='active') return false;
    const response=await fetch('http://127.0.0.1:4180/health',{signal:AbortSignal.timeout(5000)});
    return response.status===200;
  } catch {return false;}
}
export async function createRuntimeController({ root, paths, snapshot, force = false, binaryDir = process.env.MYBOT_DEPLOY_BINARY_DIR || '/usr/local/bin', driver = createPm2Driver({ root }), restartService = restartSystemd, restartPortal = () => restartPortalServices(root), checkPortalHealth = () => portalHealth(root), checkHealth = () => checkRuntimeHealth({ root, binaryPath: path.join(binaryDir, 'mybotd'), dashboardUrl: process.env.MYBOT_DEPLOY_DASHBOARD_URL, bridgeUrl: process.env.MYBOT_DEPLOY_BRIDGE_URL }), delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const actions = planRuntimeActions(paths);
  const fleet = snapshot ?? selectManagedProcesses(await driver.getProcesses(), root);
  if (!Array.isArray(fleet) || fleet.some(p => !Number.isSafeInteger(p.id) || p.id < 0 || typeof p.name !== 'string' || !p.name)) throw new Error('Invalid fleet snapshot');
  return {
    snapshot: fleet, actions,
    async restart(target) {
      if (force || actions.restartRust) await restartService();
      if (force || actions.restartNode) await restartManagedProcesses({ runtimeRoot: root, snapshot: fleet, target, ...driver, delay });
      if (actions.restartPortal) await restartPortal(target);
    },
    async health() {
      for (let i = 0; i < 30; i++) { if (await checkHealth() && (!actions.restartPortal || await checkPortalHealth())) return true; await delay(1000); }
      return false;
    },
  };
}
