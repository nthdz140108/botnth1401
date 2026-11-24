import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function writeDeploymentState(root, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid deployment state');
  const file = path.join(root, '.deploy-context.json'), temp = path.join(root, `.deploy-context-${randomBytes(10).toString('hex')}`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(state)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') { const parent = fs.openSync(root, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
}
export function readDeploymentState(root) {
  const file = path.join(root, '.deploy-context.json');
  try {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid deployment state file');
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid deployment state');
    return result;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
