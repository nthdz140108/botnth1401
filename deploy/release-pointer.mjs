// Callers MUST hold the same exclusive OS-level deploy lock for every operation.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const isId = id => typeof id === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id);
const suffix = () => randomBytes(12).toString('hex');
function syncDir(root) { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeJournal(root, record) {
  const temp = path.join(root, `.journal-${suffix()}`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, path.join(root, '.deploy-transaction.json')); syncDir(root);
}
function readJournal(root) {
  const file = path.join(root, '.deploy-transaction.json');
  if (!fs.existsSync(file)) return null;
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid transaction journal');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isId(journal.base) || !isId(journal.target) || !['pending', 'confirmed', 'recovered'].includes(journal.status)) throw new Error('Invalid transaction journal');
  return journal;
}
function checkRelease(root, id) {
  if (!isId(id)) throw new Error('Invalid release ID');
  const releaseDir = path.join(root, 'releases');
  if (!fs.lstatSync(releaseDir).isDirectory() || fs.lstatSync(releaseDir).isSymbolicLink()) throw new Error('Invalid releases directory');
  const release = path.join(releaseDir, id);
  if (!fs.lstatSync(release).isDirectory() || fs.lstatSync(release).isSymbolicLink()) throw new Error('Invalid release directory');
  const marker = path.join(release, '.mybot-release.json');
  if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() || JSON.parse(fs.readFileSync(marker, 'utf8')).commit !== id) throw new Error('Release marker mismatch');
}
function currentId(root) {
  const link = path.join(root, 'current');
  if (!fs.lstatSync(link).isSymbolicLink()) throw new Error('Current release is not a symlink');
  const match = /^releases\/([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(fs.readlinkSync(link));
  if (!match) throw new Error('Invalid current release link');
  return match[1];
}
function changeLink(root, id) {
  const temp = path.join(root, `.current-${suffix()}`);
  fs.symlinkSync(`releases/${id}`, temp);
  try { fs.renameSync(temp, path.join(root, 'current')); syncDir(root); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}
export function beginSwitch({ root, base, target }) {
  root = fs.realpathSync(root);
  if (!isId(base) || !isId(target) || base === target) throw new Error('Invalid release IDs');
  if (readJournal(root)?.status === 'pending') throw new Error('A deployment is pending recovery');
  checkRelease(root, base); checkRelease(root, target);
  if (currentId(root) !== base) throw new Error('Base commit mismatch');
  writeJournal(root, { status: 'pending', base, target });
  changeLink(root, target);
}
export function recoverSwitch({ root }) {
  root = fs.realpathSync(root);
  const journal = readJournal(root);
  if (!journal || journal.status !== 'pending') throw new Error('No pending transaction');
  checkRelease(root, journal.base);
  const current = currentId(root);
  if (current !== journal.base && current !== journal.target) throw new Error('Unexpected current release');
  if (current !== journal.base) changeLink(root, journal.base);
  writeJournal(root, { ...journal, status: 'recovered' });
  return journal.base;
}
export function confirmSwitch({ root }) {
  root = fs.realpathSync(root);
  const journal = readJournal(root);
  if (!journal || journal.status !== 'pending') throw new Error('No pending transaction');
  checkRelease(root, journal.target);
  if (currentId(root) !== journal.target) throw new Error('Unexpected current release');
  writeJournal(root, { ...journal, status: 'confirmed' });
}
