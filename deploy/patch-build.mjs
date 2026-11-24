import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { safePath } from './patch-preview.mjs';

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
function unlinkDependencyLink(dir) {
  try { if (fs.lstatSync(dir).isSymbolicLink()) fs.unlinkSync(dir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function assertDirectoryNotLink(dir, optional = false) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe build directory: ${dir}`);
}
export function prepareRelease({ stageDir, run = runCommand }) {
  assertDirectoryNotLink(stageDir);
  const markerPath = path.join(stageDir, '.mybot-release.json');
  if (!fs.lstatSync(markerPath).isFile()) throw new Error('Invalid stage marker');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.status !== 'staged' || !Array.isArray(marker.files) || marker.files.some(f => !f || typeof f.path !== 'string' || !safePath(f.path))) throw new Error('Invalid staged release');
  const files = marker.files.map(f => f.path);
  if (files.some(p => /^package(?:-lock)?\.json$/.test(p))) {
    unlinkDependencyLink(path.join(stageDir, 'node_modules'));
    run('npm', ['ci', '--omit=dev'], stageDir);
  }
  if (files.some(p => p.startsWith('dashboard/'))) {
    const dashboard = path.join(stageDir, 'dashboard');
    assertDirectoryNotLink(dashboard);
    assertDirectoryNotLink(path.join(dashboard, 'dist'), true);
    if (files.some(p => /^dashboard\/package(?:-lock)?\.json$/.test(p)) || !fs.existsSync(path.join(dashboard, 'node_modules'))) {
      unlinkDependencyLink(path.join(dashboard, 'node_modules'));
      run('npm', ['ci'], dashboard);
    }
    run('npm', ['run', 'build'], dashboard);
  }
  if (files.some(p => p.startsWith('rust/'))) {
    const rust = path.join(stageDir, 'rust');
    assertDirectoryNotLink(rust);
    assertDirectoryNotLink(path.join(stageDir, 'bin'), true);
    run('cargo', ['build', '--release', '--locked', '-p', 'mybotd', '-p', 'mybot-ctl', '-p', 'ws-decode-worker'], rust);
    const bin = path.join(stageDir, 'bin'); fs.mkdirSync(bin, { recursive: true });
    for (const name of ['mybotd', 'mybot-ctl', 'ws-decode-worker']) {
      const dest = path.join(bin, name); const temp = `${dest}.${randomBytes(8).toString('hex')}`;
      fs.copyFileSync(path.join(rust, 'target', 'release', name), temp, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temp, 0o755); fs.renameSync(temp, dest);
    }
  }
  const tmp = path.join(stageDir, `.release-ready-${randomBytes(8).toString('hex')}`);
  fs.writeFileSync(tmp, `${JSON.stringify({ ...marker, status: 'ready' })}\n`, { flag: 'wx' });
  fs.renameSync(tmp, markerPath);
}
