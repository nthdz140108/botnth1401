import fs from 'node:fs';
import path from 'node:path';
import { readDeploymentState, writeDeploymentState } from './deployment-state.mjs';
import { validatePatchPackage } from './patch-validate.mjs';
import { applyPatchTransaction, recoverPendingTransaction, rollbackReleaseTransaction } from './patch-transaction.mjs';
import { bootstrapRelease, recoverBootstrap, rollbackBootstrap } from './bootstrap-release.mjs';
import { createRuntimeController } from './runtime-controller.mjs';

// Caller must hold the OS-level deployment lock for the whole operation.
export async function runDeployment({ root, operation, packageDir, target, requestId = null, binaryDir = '/usr/local/bin', controllerFactory = createRuntimeController }) {
  root = fs.realpathSync(root);
  if (requestId !== null && !/^[a-f0-9]{32}$/.test(requestId)) throw new Error('Invalid deployment request ID');
  const before = inspectDeployment(root);
  const pending = ['pending', 'recovery_pending'];
  if (operation !== 'recover' && (pending.includes(before.transaction?.status) || pending.includes(before.bootstrap?.status))) throw new Error('A previous deployment requires recovery');
  let paths = [], kind = 'release', manifest = null, snapshot;
  if (operation === 'apply') {
    manifest = validatePatchPackage(packageDir);
    paths = manifest.files.map(f => f.path);
  } else if (operation === 'bootstrap') {
    kind = 'bootstrap';
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target)) throw new Error('Invalid bootstrap target');
  } else if (operation === 'recover') {
    if (!before.state || !['bootstrap', 'release'].includes(before.state.kind) || !Array.isArray(before.state.fleet) || !Array.isArray(before.state.paths)) throw new Error('Missing recovery context');
    ({ kind, paths, fleet: snapshot, binaryDir = '/usr/local/bin' } = before.state);
  } else if (operation === 'rollback') {
    if (before.transaction?.status === 'confirmed' && before.transaction.target === before.current) {
      if (!before.state || !Array.isArray(before.state.paths)) throw new Error('Missing rollback context');
      paths = before.state.paths;
    } else if (before.bootstrap?.status === 'confirmed' && before.bootstrap.target === before.current) {
      kind = 'bootstrap'; binaryDir = before.bootstrap.binaryDir;
    } else throw new Error('No confirmed release available for rollback');
  } else throw new Error('Unknown deployment operation');
  const controller = await controllerFactory({ root, paths, snapshot, force: kind === 'bootstrap', binaryDir });
  const state = { operation, kind, status: 'running', pid: process.pid, requestId, base: manifest?.base ?? before.current, target: manifest?.target ?? target ?? null, paths, fleet: controller.snapshot, binaryDir, startedAt: new Date().toISOString() };
  writeDeploymentState(root, state);
  try {
    let result;
    if (operation === 'bootstrap') result = await bootstrapRelease({ root, binaryDir, target, restart: controller.restart, health: controller.health });
    else if (operation === 'apply' && manifest.files.length === 0) {
      if (before.current !== manifest.base) throw new Error('Base commit mismatch');
      result = { status: 'no_changes', base: manifest.base, target: manifest.target };
    } else if (operation === 'apply') result = await applyPatchTransaction({ root, packageDir, restart: controller.restart, health: controller.health });
    else if (operation === 'recover' && kind === 'bootstrap') { await recoverBootstrap({ root, restart: controller.restart, health: controller.health }); result = { status: 'recovered' }; }
    else if (operation === 'recover') { const id = await recoverPendingTransaction({ root, restart: controller.restart, health: controller.health }); result = { status: 'recovered', target: id }; }
    else if (kind === 'bootstrap') { await rollbackBootstrap({ root, restart: controller.restart, health: controller.health }); result = { status: 'recovered' }; }
    else result = await rollbackReleaseTransaction({ root, restart: controller.restart, health: controller.health });
    writeDeploymentState(root, { ...state, status: result.status, finishedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    writeDeploymentState(root, { ...state, status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
    throw error;
  }
}

function optionalJson(file) {
  try {
    const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw new Error('Invalid status file');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function inspectDeployment(root) {
  let current = null;
  try {
    const link = path.join(root, 'current');
    if (!fs.lstatSync(link).isSymbolicLink()) throw new Error('Current release is not a symlink');
    const match = /^releases\/([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(fs.readlinkSync(link));
    if (!match) throw new Error('Invalid current release link');
    current = match[1];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { current, state: readDeploymentState(root), transaction: optionalJson(path.join(root, '.deploy-transaction.json')), bootstrap: optionalJson(path.join(root, '.bootstrap-transaction.json')) };
}
