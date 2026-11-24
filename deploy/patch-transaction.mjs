// Caller must hold one exclusive OS-level lock across this entire operation.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { validatePatchPackage } from './patch-validate.mjs';
import { stagePatch } from './patch-stage.mjs';
import { prepareRelease } from './patch-build.mjs';
import { beginSwitch, recoverSwitch, confirmSwitch, confirmRecovery } from './release-pointer.mjs';
export async function recoverPendingTransaction({ root, restart, health }) {
  if (typeof restart !== 'function' || typeof health !== 'function') throw new Error('Restart and health probes are required');
  const base = recoverSwitch({ root });
  await restart(base);
  if (await health(base) !== true) throw new Error('Health check failed for restored release');
  confirmRecovery({ root });
  return base;
}

function verifyReadyRelease(dir, manifest) {
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Unsafe existing release');
  const markerPath = path.join(dir, '.mybot-release.json');
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Unsafe existing release marker');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.status !== 'ready' || marker.commit !== manifest.target || marker.base !== manifest.base || JSON.stringify(marker.files) !== JSON.stringify(manifest.files)) throw new Error('Existing release does not match patch');
  for (const file of manifest.files) {
    let current = dir; const parts = file.path.split('/'); let missing = false;
    for (const [i, part] of parts.entries()) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') { missing = true; break; } throw error; }
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe existing release path: ${file.path}`);
    }
    if (file.status === 'delete') { if (!missing) throw new Error(`Unexpected existing release file: ${file.path}`); continue; }
    if (missing) throw new Error(`Missing existing release file: ${file.path}`);
    const data = fs.readFileSync(current);
    if (data.length !== file.size || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Existing release hash mismatch: ${file.path}`);
  }
}

export async function applyPatchTransaction({ root, packageDir, restart, health }) {
  if (typeof restart !== 'function' || typeof health !== 'function') throw new Error('Restart and health probes are required');
  root = fs.realpathSync(root);
  const manifest = validatePatchPackage(packageDir);
  const releaseDir = path.join(root, 'releases');
  if (!fs.lstatSync(releaseDir).isDirectory() || fs.lstatSync(releaseDir).isSymbolicLink()) throw new Error('Invalid releases directory');
  if (!fs.lstatSync(path.join(root, 'current')).isSymbolicLink()) throw new Error('Current release is not a symlink');
  const current = fs.readlinkSync(path.join(root, 'current'));
  const finalDir = path.join(releaseDir, manifest.target);
  if (current === `releases/${manifest.target}`) {
    const journalPath = path.join(root, '.deploy-transaction.json');
    const info = fs.lstatSync(journalPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid transaction journal');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (journal.status !== 'confirmed' || journal.base !== manifest.base || journal.target !== manifest.target) throw new Error('Target release is not confirmed');
    verifyReadyRelease(finalDir, manifest);
    if (await health(manifest.target) !== true) throw new Error('Health check failed for current release');
    return { base: manifest.base, target: manifest.target, status: 'already_applied' };
  }
  if (current !== `releases/${manifest.base}`) throw new Error('Base commit mismatch');
  if (!fs.existsSync(finalDir)) {
    const stageDir = path.join(releaseDir, `.stage-${randomBytes(12).toString('hex')}`);
    let stageOwned = false;
    try {
      stagePatch({ baseDir: path.join(releaseDir, manifest.base), packageDir, stageDir });
      stageOwned = true;
      prepareRelease({ stageDir });
      fs.renameSync(stageDir, finalDir);
    } catch (error) {
      if (stageOwned && fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
      throw error;
    }
  }
  verifyReadyRelease(finalDir, manifest);
  try {
    beginSwitch({ root, base: manifest.base, target: manifest.target });
    await restart(manifest.target);
    if (await health(manifest.target) !== true) throw new Error('Health check failed for target release');
    confirmSwitch({ root });
  } catch (error) {
    let journal;
    try { journal = JSON.parse(fs.readFileSync(path.join(root, '.deploy-transaction.json'), 'utf8')); } catch {}
    if (journal?.status !== 'pending' || journal.base !== manifest.base || journal.target !== manifest.target) throw error;
    try {
      recoverSwitch({ root });
      await restart(manifest.base);
      if (await health(manifest.base) !== true) throw new Error('Health check failed for restored release');
      confirmRecovery({ root });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Deployment failed and rollback was not verified: ${rollbackError.message}`);
    }
    throw error;
  }
  return { base: manifest.base, target: manifest.target, status: 'confirmed' };
}
