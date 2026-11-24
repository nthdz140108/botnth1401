// Caller must hold the deployment lock. The bootstrap journal supports recovery.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { makeReleaseWrapper } from './release-wrapper.mjs';

const entries = ['src/bootstrap.js', 'src/dashboard/node-bridge-service.js'];
const binaries = ['mybotd', 'mybot-ctl', 'ws-decode-worker'];
export async function rollbackBootstrap({ root, restart, health }) {
  root = fs.realpathSync(root);
  const journal = journalRead(root);
  if (journal.status !== 'confirmed') throw new Error('Bootstrap is not confirmed');
  const current = path.join(root, 'current');
  if (!fs.lstatSync(current).isSymbolicLink() || fs.readlinkSync(current) !== `releases/${journal.target}`) throw new Error('Roll back later releases before restoring legacy');
  journal.status = 'pending'; journalWrite(root, journal);
  await recoverBootstrap({ root, restart, health });
}
const token = () => randomBytes(10).toString('hex');
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function ordinary(p, type) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || !(type === 'file' ? s.isFile() : s.isDirectory())) throw new Error(`Unsafe bootstrap path: ${p}`);
  return s;
}
function atomicFile(dest, bytes, mode) {
  const tmp = path.join(path.dirname(dest), `.mybot-${token()}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dest);
  const dir = fs.openSync(path.dirname(dest), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function journalWrite(root, journal) { atomicFile(path.join(root, '.bootstrap-transaction.json'), `${JSON.stringify(journal)}\n`, 0o600); }
function journalRead(root) {
  const file = path.join(root, '.bootstrap-transaction.json'); ordinary(file, 'file');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(j.target) || !/^[a-f0-9]{20}$/.test(j.backupId) || !path.isAbsolute(j.binaryDir) || !Array.isArray(j.binaries) || j.binaries.some(x => !binaries.includes(x)) || !['pending', 'recovery_pending', 'recovered', 'confirmed'].includes(j.status)) throw new Error('Invalid bootstrap journal');
  return j;
}
function exists(p) { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function saveFile(src, dst) { const info = ordinary(src, 'file'); fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); fs.chmodSync(dst, info.mode & 0o777); const fd = fs.openSync(dst, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function restoreFile(src, dst, generated) {
  ordinary(src, 'file');
  if (exists(dst)) {
    const info = fs.lstatSync(dst);
    if (info.isSymbolicLink()) {
      if (fs.readlinkSync(dst) !== generated) throw new Error(`Unexpected bootstrap symlink: ${dst}`);
    } else {
      ordinary(dst, 'file');
      const h = hash(dst);
      if (h !== hash(src) && (typeof generated !== 'string' || createHash('sha256').update(generated).digest('hex') !== h)) throw new Error(`Bootstrap file changed unexpectedly: ${dst}`);
    }
  }
  atomicFile(dst, fs.readFileSync(src), fs.statSync(src).mode & 0o777);
}
export async function recoverBootstrap({ root, restart, health }) {
  root = fs.realpathSync(root);
  if (typeof restart !== 'function' || typeof health !== 'function') throw new Error('Restart and health probes are required');
  const j = journalRead(root);
  if (!['pending', 'recovery_pending'].includes(j.status)) throw new Error('No pending bootstrap');
  const backup = path.join(root, '.bootstrap-backups', j.backupId); ordinary(backup, 'dir');
  j.status = 'recovery_pending'; journalWrite(root, j);
  for (const [index, entry] of entries.entries()) restoreFile(path.join(backup, `entry-${index}`), path.join(root, entry), makeReleaseWrapper({ runtimeRoot: root, entry }));
  for (const name of j.binaries) restoreFile(path.join(backup, `bin-${name}`), path.join(j.binaryDir, name), path.join(root, 'current', 'bin', name));
  const dist = path.join(root, 'dashboard', 'dist'), savedDist = path.join(backup, 'dist');
  if (exists(savedDist)) {
    ordinary(savedDist, 'dir');
    if (exists(dist)) {
      if (!fs.lstatSync(dist).isSymbolicLink() || fs.readlinkSync(dist) !== path.join(root, 'current', 'dashboard', 'dist')) throw new Error('Dashboard output changed unexpectedly');
      fs.unlinkSync(dist);
    }
    fs.renameSync(savedDist, dist);
  } else ordinary(dist, 'dir');
  const current = path.join(root, 'current');
  if (exists(current)) {
    if (!fs.lstatSync(current).isSymbolicLink() || fs.readlinkSync(current) !== `releases/${j.target}`) throw new Error('Current release changed unexpectedly');
    fs.unlinkSync(current);
  }
  await restart('legacy');
  if (await health('legacy') !== true) throw new Error('Legacy health check failed');
  j.status = 'recovered'; journalWrite(root, j);
}
export async function bootstrapRelease({ root, binaryDir, target, restart, health }) {
  root = fs.realpathSync(root); binaryDir = fs.realpathSync(binaryDir);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target) || typeof restart !== 'function' || typeof health !== 'function') throw new Error('Invalid bootstrap request');
  if (exists(path.join(root, 'current'))) throw new Error('Current release already exists');
  if (exists(path.join(root, '.bootstrap-transaction.json'))) {
    const old = journalRead(root); if (['pending', 'recovery_pending'].includes(old.status)) throw new Error('Bootstrap recovery is pending');
  }
  const release = path.join(root, 'releases', target); ordinary(path.join(root, 'releases'), 'dir'); ordinary(release, 'dir');
  const marker = path.join(release, '.mybot-release.json'); ordinary(marker, 'file');
  const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (meta.commit !== target || meta.status !== 'ready') throw new Error('Release is not ready');
  ordinary(path.join(root, 'src'), 'dir'); ordinary(path.join(root, 'src', 'dashboard'), 'dir'); ordinary(path.join(root, 'dashboard'), 'dir'); ordinary(path.join(root, 'dashboard', 'dist'), 'dir');
  ordinary(path.join(release, 'dashboard', 'dist'), 'dir'); ordinary(path.join(release, 'bin'), 'dir');
  ordinary(path.join(release, 'dashboard', 'dist', 'index.html'), 'file');
  ordinary(path.join(release, 'src'), 'dir'); ordinary(path.join(release, 'src', 'dashboard'), 'dir');
  for (const entry of entries) ordinary(path.join(release, entry), 'file');
  const presentBinaries = binaries.filter(name => exists(path.join(binaryDir, name)));
  if (!presentBinaries.includes('mybotd')) throw new Error('Missing legacy mybotd');
  for (const name of presentBinaries) { ordinary(path.join(binaryDir, name), 'file'); ordinary(path.join(release, 'bin', name), 'file'); }
  const backupRoot = path.join(root, '.bootstrap-backups');
  if (!exists(backupRoot)) fs.mkdirSync(backupRoot);
  ordinary(backupRoot, 'dir');
  const backupId = token(), backup = path.join(backupRoot, backupId);
  fs.mkdirSync(backup);
  for (const [index, entry] of entries.entries()) saveFile(path.join(root, entry), path.join(backup, `entry-${index}`));
  for (const name of presentBinaries) saveFile(path.join(binaryDir, name), path.join(backup, `bin-${name}`));
  const journal = { target, backupId, binaryDir, binaries: presentBinaries, status: 'pending' };
  journalWrite(root, journal);
  try {
    fs.symlinkSync(`releases/${target}`, path.join(root, 'current'));
    for (const [index, entry] of entries.entries()) atomicFile(path.join(root, entry), makeReleaseWrapper({ runtimeRoot: root, entry }), fs.statSync(path.join(backup, `entry-${index}`)).mode & 0o777);
    const dist = path.join(root, 'dashboard', 'dist'); fs.renameSync(dist, path.join(backup, 'dist')); fs.symlinkSync(path.join(root, 'current', 'dashboard', 'dist'), dist);
    for (const name of presentBinaries) {
      const temp = path.join(binaryDir, `.mybot-${token()}`); fs.symlinkSync(path.join(root, 'current', 'bin', name), temp); fs.renameSync(temp, path.join(binaryDir, name));
    }
    await restart(target);
    if (await health(target) !== true) throw new Error('Bootstrap health check failed');
    journal.status = 'confirmed'; journalWrite(root, journal);
  } catch (error) {
    try { await recoverBootstrap({ root, restart, health }); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], `Bootstrap failed and rollback was not verified: ${rollbackError.message}`); }
    throw error;
  }
  return { status: 'confirmed', target };
}
