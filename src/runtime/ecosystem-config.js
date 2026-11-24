/**
 * Ecosystem config generator: produces PM2 ecosystem config object.
 *
 * Each process is a separate fork-mode app with:
 * - PM2 process name = canonical botKey (or mybot-dashboard/mybot-guardian)
 * - explicit node_args (--expose-gc + --max-old-space-size)
 * - per-app memory ceiling (max_memory_restart)
 * - per-app log paths
 *
 * Output is plain JSON-serializable object (no methods).
 */

import path from 'node:path';
import fs from 'node:fs';
import { createLaunchDescriptor } from './launch-descriptor.js';

export function logFile(projectRoot, name, kind) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (kind === 'dashboard') {
    return {
      out: path.join(projectRoot, 'logs', 'pm2-dashboard.out.log'),
      err: path.join(projectRoot, 'logs', 'pm2-dashboard.err.log'),
    };
  }
  if (kind === 'guardian') {
    return {
      out: path.join(projectRoot, 'logs', 'pm2-guardian.out.log'),
      err: path.join(projectRoot, 'logs', 'pm2-guardian.err.log'),
    };
  }
  return {
    out: path.join(projectRoot, 'logs', `pm2-${safe}.out.log`),
    err: path.join(projectRoot, 'logs', `pm2-${safe}.err.log`),
  };
}

export const resolveLogPaths = logFile;

function buildApp(descriptor, projectRoot) {
  const files = logFile(projectRoot, descriptor.pm2Name, descriptor.kind);
  const env = { ...descriptor.env };
  return {
    name: descriptor.pm2Name,
    script: descriptor.script,
    cwd: descriptor.cwd,
    args: descriptor.args?.slice(1) || [], // exclude script path (PM2 takes it as separate arg)
    node_args: descriptor.nodeArgs,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: descriptor.pm2MaxMemoryRestart,
    env,
    out_file: files.out,
    error_file: files.err,
    merge_logs: false,
    time: true,
  };
}

export function generateEcosystemConfig({
  projectRoot = process.cwd(),
  includeMain = false,
  includeDashboard = false,
  includeGuardian = false,
  childBots = [],
} = {}) {
  const root = path.resolve(projectRoot);
  const apps = [];

  if (includeMain) {
    const desc = createLaunchDescriptor({ kind: 'main', projectRoot: root });
    apps.push(buildApp(desc, root));
  }

  if (includeDashboard) {
    const desc = createLaunchDescriptor({ kind: 'dashboard', projectRoot: root });
    apps.push(buildApp(desc, root));
  }

  if (includeGuardian) {
    const desc = createLaunchDescriptor({ kind: 'guardian', projectRoot: root });
    apps.push(buildApp(desc, root));
  }

  for (const child of childBots) {
    if (!child || !child.botKey) continue;
    const desc = createLaunchDescriptor({
      kind: 'child',
      botKey: child.botKey,
      uid: child.uid || child.botKey,
      projectRoot: root,
    });
    apps.push(buildApp(desc, root));
  }

  return {
    pm2_instance_var: 'NODE_APP_INSTANCE',
    apps,
  };
}

export function writeEcosystemConfig(config, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `module.exports = ${JSON.stringify(config, null, 2)};\n`, 'utf8');
}
