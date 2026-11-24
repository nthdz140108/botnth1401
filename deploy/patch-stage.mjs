import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { validatePatchPackage } from './patch-validate.mjs';

function targetPath(root, name, createParents) {
  const parts = name.split('/'); let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && createParents) fs.mkdirSync(current);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe release path: ${name}`);
  }
  return path.join(current, parts.at(-1));
}
export function stagePatch({ baseDir, packageDir, stageDir }) {
  const manifest = validatePatchPackage(packageDir);
  const baseRoot = fs.realpathSync(baseDir);
  const stageRoot = path.resolve(stageDir);
  if (stageRoot === baseRoot || stageRoot.startsWith(`${baseRoot}${path.sep}`)) throw new Error('Stage cannot be inside base release');
  const marker = path.join(baseRoot, '.mybot-release.json');
  if (!fs.lstatSync(marker).isFile()) throw new Error('Invalid base marker');
  const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (metadata.commit !== manifest.base) throw new Error('Base commit mismatch');
  if (metadata.status !== 'ready') throw new Error('Base release is not ready');
  fs.mkdirSync(stageRoot);
  try {
    const dashboardDeps = path.join(baseRoot, 'dashboard', 'node_modules');
    for (const entry of fs.readdirSync(baseRoot)) {
      if (entry === 'node_modules') continue;
      fs.cpSync(path.join(baseRoot, entry), path.join(stageRoot, entry), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE, filter: source => path.resolve(source) !== dashboardDeps });
    }
    for (const relative of ['node_modules', 'dashboard/node_modules']) {
      const original = path.join(baseRoot, ...relative.split('/'));
      let stat;
      try { stat = fs.lstatSync(original); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`Invalid dependencies: ${relative}`);
      const real = fs.realpathSync(original);
      if (!fs.statSync(real).isDirectory()) throw new Error(`Invalid dependencies: ${relative}`);
      if (relative.startsWith('dashboard/')) {
        const parent = fs.lstatSync(path.join(stageRoot, 'dashboard'));
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe dashboard dependency path');
      }
      fs.symlinkSync(real, path.join(stageRoot, ...relative.split('/')), 'dir');
    }
    for (const file of manifest.files) {
      const dest = targetPath(stageRoot, file.path, file.status === 'add');
      const existing = fs.existsSync(dest) ? fs.lstatSync(dest) : null;
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Unsafe target: ${file.path}`);
      if ((file.status === 'add') === Boolean(existing)) throw new Error(`Unexpected target state: ${file.path}`);
      if (file.status === 'delete') { fs.unlinkSync(dest); continue; }
      const temp = `${dest}.patch-${randomBytes(8).toString('hex')}`;
      fs.copyFileSync(path.join(packageDir, 'files', ...file.path.split('/')), temp, fs.constants.COPYFILE_EXCL);
      const written = fs.readFileSync(temp);
      if (written.length !== file.size || createHash('sha256').update(written).digest('hex') !== file.sha256) throw new Error(`Hash mismatch after copy: ${file.path}`);
      fs.chmodSync(temp, file.mode === '100755' ? 0o755 : 0o644);
      fs.renameSync(temp, dest);
    }
    const markerTemp = path.join(stageRoot, `.release-${randomBytes(8).toString('hex')}`);
    fs.writeFileSync(markerTemp, `${JSON.stringify({ commit: manifest.target, base: manifest.base, status: 'staged', files: manifest.files })}\n`, { flag: 'wx' });
    fs.renameSync(markerTemp, path.join(stageRoot, '.mybot-release.json'));
    return manifest;
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}
