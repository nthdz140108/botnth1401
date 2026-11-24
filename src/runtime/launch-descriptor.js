/**
 * Launch Descriptor: pure function that produces process descriptor
 * (kind, env, args, script, cwd) for launching bot/dashboard/guardian.
 *
 * This is the canonical source for what env vars and args each process type
 * should receive. No actual process is spawned here.
 *
 * IMPORTANT: PM2 process name is always derived from canonical botKey, never
 * from Zalo live UID. Zalo UID is only used for session identity.
 * On VPS, the stable bootstrap launcher pins each process to one release while
 * PROJECT_ROOT continues to identify the shared runtime data directory.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

const HEAP_LIMITS = {
  main: 448,
  child: 256,
  dashboard: 160,
  guardian: 128,
};

const PM2_RSS_LIMITS = {
  main: '512M',
  child: '320M',
  dashboard: '180M',
  guardian: '150M',
};

function resolvePaths(projectRoot, kind, botKey = 'admin', uid = null) {
  const root = path.resolve(projectRoot);
  if (kind === 'dashboard') {
    return {
      script: path.join(root, 'dashboard', 'server.js'),
      cwd: root,
      configPath: '',
      webPort: 4173,
    };
  }
  if (kind === 'guardian') {
    return {
      script: path.join(root, 'src', 'runtime', 'memory-guardian.js'),
      cwd: root,
      configPath: '',
      webPort: 0,
    };
  }
  // main or child
  const effectiveUid = uid || botKey;
  const isMain = kind === 'main' || botKey === 'admin';
  const configPath = isMain
    ? path.join(root, 'assets', 'config.json')
    : path.join(root, 'mybot', 'bots', `${botKey}.json`);
  return {
    script: path.join(root, 'src', 'bootstrap.js'),
    cwd: root,
    configPath,
    webPort: isMain ? 2000 : 0,
    effectiveUid,
  };
}

export function createLaunchDescriptor({
  kind,
  botKey = 'admin',
  uid = null,
  projectRoot = process.cwd(),
  webPort = null,
  env = {},
  commit = null,
} = {}) {
  if (!kind) {
    throw new Error('createLaunchDescriptor: kind is required');
  }
  const normalizedKind = String(kind).toLowerCase();
  const allowed = ['main', 'child', 'dashboard', 'guardian'];
  if (!allowed.includes(normalizedKind)) {
    throw new Error(`createLaunchDescriptor: invalid kind '${kind}' (allowed: ${allowed.join(', ')})`);
  }

  const isBotProcess = normalizedKind === 'main' || normalizedKind === 'child';
  const isMainBot = normalizedKind === 'main';
  const effectiveBotKey = isMainBot ? 'admin' : (botKey || (uid ? `bot-${uid}` : 'unknown'));
  const pm2Name = normalizedKind === 'dashboard'
    ? 'mybot-dashboard'
    : normalizedKind === 'guardian'
      ? 'mybot-guardian'
      : effectiveBotKey;

  const paths = resolvePaths(projectRoot, normalizedKind, effectiveBotKey, uid);
  const heapLimit = HEAP_LIMITS[normalizedKind] || 256;
  const rssLimit = PM2_RSS_LIMITS[normalizedKind] || '320M';
  const sandboxTemp = path.join(paths.cwd, '.runtime', 'temp');

  const nodeArgs = [
    '--expose-gc',
    `--max-old-space-size=${heapLimit}`,
  ];

  const descriptor = {
    kind: normalizedKind,
    isBotProcess,
    isMainBot,
    botKey: effectiveBotKey,
    pm2Name,
    script: paths.script,
    cwd: paths.cwd,
    configPath: paths.configPath,
    webPort: webPort || paths.webPort,
    nodeArgs,
    args: [paths.script, isBotProcess ? (uid || effectiveBotKey) : ''].filter(Boolean),
    pm2MaxMemoryRestart: rssLimit,
    env: {
      ...env,
      NODE_SKIP_PLATFORM_CHECK: '1',
      MYBOT_RESOURCE_PROFILE: env.MYBOT_RESOURCE_PROFILE || process.env.MYBOT_RESOURCE_PROFILE || 'lean',
      MYBOT_INSTANCE_KIND: isMainBot ? 'main' : (normalizedKind === 'child' ? 'child' : normalizedKind),
      BOT_KEY: isBotProcess ? effectiveBotKey : '',
      BOT_UID: isBotProcess ? (uid || effectiveBotKey) : '',
      BOT_NAME: isBotProcess ? effectiveBotKey : '',
      PROJECT_ROOT: paths.cwd,
      CONFIG_PATH: paths.configPath || '',
      WEB_PORT: String(webPort || paths.webPort || ''),
      BOT_MANAGED: 'true',
      TEMP: env.TEMP || sandboxTemp,
      TMP: env.TMP || sandboxTemp,
      ...(env.PM2_HOME || process.env.PM2_HOME ? { PM2_HOME: env.PM2_HOME || process.env.PM2_HOME } : {}),
      // Commit marker: identifies the exact source checkout this descriptor was
      // built from. Reconcile uses it to adopt vs reload stale PM2 apps
      // (replaces the unreliable log-fingerprint guard). Absent when git is
      // unavailable — the marker guard is fail-open on missing marker, but a
      // MISMATCHED marker always forces a reload.
      ...(commit ? { MYBOT_CODE_COMMIT: String(commit) } : {}),
    },
  };

  return descriptor;
}

export function describeLaunchDescriptor(descriptor) {
  return {
    kind: descriptor.kind,
    botKey: descriptor.botKey,
    pm2Name: descriptor.pm2Name,
    script: descriptor.script,
    cwd: descriptor.cwd,
    args: [...descriptor.nodeArgs, ...descriptor.args],
    env: descriptor.env,
  };
}

/**
 * Validate a descriptor's env matches kind expectations.
 * Used for runtime guard: if env was mutated, this fails.
 */
export function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return false;
  if (typeof descriptor.kind !== 'string') return false;
  if (typeof descriptor.botKey !== 'string' || !descriptor.botKey) return false;
  if (typeof descriptor.pm2Name !== 'string' || !descriptor.pm2Name) return false;
  if (typeof descriptor.script !== 'string' || !descriptor.script) return false;
  return true;
}
