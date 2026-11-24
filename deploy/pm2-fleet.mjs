import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
async function executePm2(args) {
  const result = await execFileAsync('pm2', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}
export function createPm2Driver({ root, execute = executePm2 }) {
  if (!path.isAbsolute(root) || typeof execute !== 'function') throw new Error('Invalid PM2 driver configuration');
  return {
    async getProcesses() {
      const result = JSON.parse(await execute(['jlist']));
      if (!Array.isArray(result)) throw new Error('Invalid PM2 process list');
      return result;
    },
    async restartProcess(id) {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid PM2 process ID');
      await execute(['restart', String(id)]);
    },
    async markerMatches(pid, commit, uptime) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) || !Number.isFinite(uptime) || uptime <= 0) return false;
      try {
        const marker = JSON.parse(await fs.readFile(path.join(root, '.runtime', 'release-pids', `${pid}.json`), 'utf8'));
        return marker.pid === pid && marker.commit === commit && ['src/bootstrap.js', 'src/dashboard/node-bridge-service.js'].includes(marker.entry) && Number.isFinite(marker.startedAt) && marker.startedAt >= uptime - 5000 && marker.startedAt <= Date.now() + 5000;
      } catch { return false; }
    },
  };
}
export async function restartManagedProcesses({ runtimeRoot, snapshot, target, getProcesses, restartProcess, markerMatches, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 120 }) {
  if (!Array.isArray(snapshot) || (target !== 'legacy' && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target)) || typeof getProcesses !== 'function' || typeof restartProcess !== 'function' || typeof markerMatches !== 'function' || !Number.isInteger(maxPolls) || maxPolls < 1) throw new Error('Invalid fleet restart request');
  const restarted = [];
  for (const expected of snapshot) {
    const before = await getProcesses();
    const matches = before.filter(item => item.name === expected.name && managedPath(item, runtimeRoot));
    if (matches.length !== 1) throw new Error(`PM2 process identity changed: ${expected.name}`);
    const found = matches[0];
    if (!Number.isSafeInteger(found.pm_id) || found.pm_id < 0) throw new Error(`PM2 process identity changed: ${expected.name}`);
    if (found.pm2_env?.status === 'stopped') continue;
    if (!managedPath(found, runtimeRoot) || !['online', 'errored'].includes(found.pm2_env?.status) || !Number.isInteger(found.pid) || found.pid < 0) throw new Error(`PM2 process unavailable: ${expected.name}`);
    const previousPid = found.pid;
    await restartProcess(found.pm_id);
    let ready = false;
    for (let i = 0; i < maxPolls; i++) {
      const current = (await getProcesses()).find(item => item.pm_id === found.pm_id);
      if (!current || current.name !== expected.name) throw new Error(`PM2 process identity changed: ${expected.name}`);
      if (current.pm2_env?.status === 'online' && Number.isInteger(current.pid) && current.pid > 0 && current.pid !== previousPid && selectManagedProcesses([current], runtimeRoot).length && (target === 'legacy' || await markerMatches(current.pid, target, current.pm2_env.pm_uptime))) { ready = true; break; }
      await delay(250);
    }
    if (!ready) throw new Error(`PM2 release marker not ready: ${expected.name}`);
    restarted.push(expected);
  }
  return restarted;
}

export function selectManagedProcesses(processes, runtimeRoot) {
  if (!Array.isArray(processes) || !path.posix.isAbsolute(runtimeRoot)) throw new Error('Invalid PM2 fleet or runtime root');
  const seen = new Set(); const result = [];
  for (const process of processes) {
    const env = process?.pm2_env;
    if (!env || env.status !== 'online' || !managedPath(process, runtimeRoot)) continue;
    if (!Number.isSafeInteger(process.pm_id) || process.pm_id < 0 || typeof process.name !== 'string' || !process.name || seen.has(process.pm_id)) throw new Error('Invalid managed PM2 process');
    seen.add(process.pm_id); result.push({ id: process.pm_id, name: process.name });
  }
  return result;
}
function managedPath(process, runtimeRoot) {
  const root = path.posix.resolve(runtimeRoot);
  return [path.posix.join(root, 'src', 'bootstrap.js'), path.posix.join(root, 'src', 'dashboard', 'node-bridge-service.js')].includes(process?.pm2_env?.pm_exec_path);
}
