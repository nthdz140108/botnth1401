import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { planRuntimeActions } from './runtime-actions.mjs';
import { createPm2Driver, selectManagedProcesses, restartManagedProcesses } from './pm2-fleet.mjs';
import { checkRuntimeHealth } from './runtime-health.mjs';
import path from 'node:path';
const execFileAsync = promisify(execFile);
const portalUnits = ['mybot-portal-worker.service', 'mybot-portal.service'];
async function restartSystemd() { await execFileAsync('systemctl', ['restart', 'mybot.service'], { timeout: 60000 }); }

async function portalUnitLoaded(unit, run) {
  let stdout;
  try { ({ stdout } = await run('systemctl', ['show', unit, '-p', 'LoadState', '--value'], { timeout: 10000 })); }
  catch (error) { if (error.stdout?.trim() === 'not-found') return false; throw error; }
  if (stdout.trim() === 'not-found') return false;
  if (stdout.trim() !== 'loaded') throw new Error(`Cannot reconcile portal service ${unit}: ${stdout.trim()}`);
  return true;
}

// Keep PostgreSQL and shared data intact. Recovery can re-enable the previous release.
export async function reconcilePortalServices({ root, run = execFileAsync }) {
  const restoring = fs.existsSync(path.join(root, 'current', 'bin', 'mybot-portal'));
  for (const unit of portalUnits) {
    if (!await portalUnitLoaded(unit, run)) continue;
    await run('systemctl', [restoring ? 'enable' : 'disable', '--now', unit], { timeout: 60000 });
  }
}

export async function checkPortalServiceHealth({ root, run = execFileAsync }) {
  const restoring = fs.existsSync(path.join(root, 'current', 'bin', 'mybot-portal'));
  try {
    for (const unit of portalUnits) {
      if (!await portalUnitLoaded(unit, run)) { if (restoring) return false; continue; }
      const { stdout } = await run('systemctl', ['show', unit, '-p', 'ActiveState', '--value'], { timeout: 10000 });
      if (restoring ? stdout.trim() !== 'active' : !['inactive', 'failed', ''].includes(stdout.trim())) return false;
    }
    if (!restoring) return true;
    const response = await fetch('http://127.0.0.1:4180/health', { signal: AbortSignal.timeout(5000) });
    return response.status === 200;
  } catch { return false; }
}

export async function createRuntimeController({ root, paths, snapshot, force = false, binaryDir = process.env.MYBOT_DEPLOY_BINARY_DIR || '/usr/local/bin', driver = createPm2Driver({ root }), restartService = restartSystemd, restartPortal = () => reconcilePortalServices({ root }), checkPortalHealth = () => checkPortalServiceHealth({ root }), checkHealth = () => checkRuntimeHealth({ root, binaryPath: path.join(binaryDir, 'mybotd'), dashboardUrl: process.env.MYBOT_DEPLOY_DASHBOARD_URL, bridgeUrl: process.env.MYBOT_DEPLOY_BRIDGE_URL }), delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const actions = planRuntimeActions(paths);
  const fleet = snapshot ?? selectManagedProcesses(await driver.getProcesses(), root);
  if (!Array.isArray(fleet) || fleet.some(p => !Number.isSafeInteger(p.id) || p.id < 0 || typeof p.name !== 'string' || !p.name)) throw new Error('Invalid fleet snapshot');
  return {
    snapshot: fleet, actions,
    async restart(target) {
      if (force || actions.restartRust) await restartService();
      if (force || actions.restartNode) await restartManagedProcesses({ runtimeRoot: root, snapshot: fleet, target, ...driver, delay });
      if (actions.retirePortal) await restartPortal(target);
    },
    async health() {
      for (let i = 0; i < 30; i++) { if (await checkHealth() && (!actions.retirePortal || await checkPortalHealth())) return true; await delay(1000); }
      return false;
    },
  };
}
