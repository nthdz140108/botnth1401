import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import lockfile from 'proper-lockfile';
import { recoverRegistryJournals } from './registry-recovery.js';

const heldLocks = new AsyncLocalStorage();
export const registryTransactions = new AsyncLocalStorage();
function prepare(file) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try { fs.writeFileSync(resolved, '{}', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return resolved;
}
function busy(cause) {
  return Object.assign(new Error('Registry is busy; retry the operation', { cause }), { code: 'REGISTRY_BUSY', stage: 'registry-lock', status: 409 });
}
export function withRegistryLockSync(file, callback) {
  const resolved = prepare(file);
  if (heldLocks.getStore()?.has(resolved)) return callback();
  let release;
  try { release = lockfile.lockSync(resolved, { stale: 30_000, realpath: false }); }
  catch (error) { throw busy(error); }
  try { return heldLocks.run(new Set([...(heldLocks.getStore() || []), resolved]), () => {
    if (path.basename(resolved) === 'mybots.json') recoverRegistryJournals(path.resolve(path.dirname(resolved), '..'), resolved);
    return callback();
  }); }
  finally { release(); }
}
export async function withRegistryLock(file, callback, { recover = true, ...options } = {}) {
  const resolved = prepare(file);
  if (heldLocks.getStore()?.has(resolved)) return callback();
  let release;
  try { release = await lockfile.lock(resolved, { stale: 30_000, realpath: false, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 }, ...options }); }
  catch (error) { throw busy(error); }
  try { return await heldLocks.run(new Set([...(heldLocks.getStore() || []), resolved]), () => {
    if (recover && path.basename(resolved) === 'mybots.json') recoverRegistryJournals(path.resolve(path.dirname(resolved), '..'), resolved);
    return callback();
  }); }
  finally { await release(); }
}
