#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateVpsConfig, setupAskpass, buildSshAuthArgs } from './vps-deploy-config.mjs';
import { parseIncrementalArgs } from './incremental-args.mjs';
import { orchestrateIncremental } from './incremental-orchestrator.mjs';
import { createRemoteAdapter } from './remote-adapter.mjs';
import { assertBootstrapTarget } from './bootstrap-guard.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function main(args = process.argv.slice(2)) {
  const options = parseIncrementalArgs(args);
  const configPath = path.join(repo, 'deploy', 'vps-deploy.local.json');
  let cfg;
  try { cfg = validateVpsConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))); }
  catch (error) { throw new Error(`Cannot load VPS configuration ${configPath}: ${error.message}`); }
  const helper = setupAskpass(cfg.password);
  try {
    const run = async (command, input) => {
      const result = spawnSync(process.platform === 'win32' ? 'ssh.exe' : 'ssh', ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', ...buildSshAuthArgs(cfg), '-p', String(cfg.port), `${cfg.user}@${cfg.host}`, command], { input, env: helper?.env ?? process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, windowsHide: true });
      if (result.error || result.status !== 0) throw result.error || new Error(`SSH failed (${result.status}): ${(result.stderr || '').trim()}`);
      return result.stdout;
    };
    if (options.mode === 'bootstrap') {
      assertBootstrapTarget((await run('if [ -L /opt/mybot/current ] || [ -e /opt/mybot/current ]; then printf versioned; else printf legacy; fi')).trim());
      const result = spawnSync(process.execPath, [path.join(repo, 'deploy', 'push-to-vps.mjs')], { cwd: repo, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw result.error || new Error(`Full installer failed: ${result.status}`);
      return;
    }
    const archive = async dir => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-tar-'));
      try {
        const target = path.join(temp, 'patch.tar.gz');
        const result = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', target, '-C', dir, '.'], { encoding: 'utf8', windowsHide: true });
        if (result.error || result.status !== 0) throw result.error || new Error(`Cannot create patch archive: ${result.stderr}`);
        return fs.readFileSync(target);
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    };
    const remote = createRemoteAdapter({ run, archive });
    const result = await orchestrateIncremental({ args, repo, remote, onPreview: preview => { console.log('Patch preview:'); console.log(JSON.stringify(preview, null, 2)); } });
    console.log(JSON.stringify(result, null, 2));
  } finally { helper?.cleanup(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
