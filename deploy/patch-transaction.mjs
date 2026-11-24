// Caller must hold one exclusive OS-level lock across this entire operation.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validatePatchPackage } from './patch-validate.mjs';
import { stagePatch } from './patch-stage.mjs';
import { prepareRelease } from './patch-build.mjs';
import { beginSwitch, recoverSwitch, confirmSwitch, confirmRecovery } from './release-pointer.mjs';

export async function applyPatchTransaction({ root, packageDir, restart, health }) {
  if (typeof restart !== 'function' || typeof health !== 'function') throw new Error('Restart and health probes are required');
  root = fs.realpathSync(root);
  const manifest = validatePatchPackage(packageDir);
  const releaseDir = path.join(root, 'releases');
  if (!fs.lstatSync(releaseDir).isDirectory() || fs.lstatSync(releaseDir).isSymbolicLink()) throw new Error('Invalid releases directory');
  if (!fs.lstatSync(path.join(root, 'current')).isSymbolicLink() || fs.readlinkSync(path.join(root, 'current')) !== `releases/${manifest.base}`) throw new Error('Base commit mismatch');
  const finalDir = path.join(releaseDir, manifest.target);
  if (fs.existsSync(finalDir)) throw new Error('Target release already exists');
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
