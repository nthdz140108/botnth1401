import fs from 'node:fs';
import path from 'node:path';
import { withMyBotsTransaction } from '../Manager/qr-provisioning-registry.js';
import { loadMyBotsRegistry } from './mybots-registry.js';

// Evidence is an actual identity handshake/state, never a display name, port or PID.
function accountEvidence(root, key, record) {
  const expected = String(record.accountUid || record.uid || '').trim();
  if (record.accountIdentityStatus === 'verified' && expected && expected !== 'admin'
    && (record.accountUid || expected !== key || /^\d+$/.test(expected))) return expected;
  const file = path.join(root, 'mybot', 'state', `${key}.json`);
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const actual = String(state.liveZaloUid || state.accountUid || state.uid || '').trim();
  const mainLoginProof = (key === 'admin' || record.isMain) && Number.isFinite(Date.parse(state.lastRepairedAt));
  return (state.botKey === key || mainLoginProof) && actual && actual !== 'admin' && actual === expected
    && (state.loggedIn === true || state.listenerConnected === true || mainLoginProof) ? actual : null;
}
export async function migrateBotManagementV4({ root, apply = false, releaseRoots = [] } = {}) {
  const registryPath = path.join(root, 'mybot', 'mybots.json');
  const inspect = registry => {
    const patches = {};
    for (const [key, record] of Object.entries(registry)) {
      if (!record || typeof record !== 'object') throw new Error(`Invalid record ${key}`);
      const accountUid = accountEvidence(root, key, record);
      const patch = {
        botKey: key,
        accountIdentityStatus: accountUid ? 'verified' : 'pending',
        adminBindingStatus: record.adminBindingStatus || (record.identityPending === false && record.resolvedChildAdminUids?.length ? 'verified' : 'pending'),
        desiredStatus: record.desiredStatus || (['running', 'starting'].includes(record.status) ? 'running' : 'stopped'),
        managementSchemaVersion: 4,
        ...(accountUid ? { accountUid } : {}),
      };
      if (Object.entries(patch).some(([field, value]) => record[field] !== value)) patches[key] = patch;
    }
    return patches;
  };
  const releaseReports = releaseRoots.filter(release => path.resolve(release) !== path.resolve(root))
    .filter(release => fs.existsSync(path.join(release, 'mybot', 'mybots.json')))
    .map(release => ({ release, action: 'report-only', registryPresent: true }));
  if (!apply) {
    const patches = inspect(loadMyBotsRegistry(registryPath));
    return { dryRun: true, changed: Object.keys(patches), pendingIdentity: Object.entries(patches).filter(([, patch]) => patch.accountIdentityStatus === 'pending').map(([key]) => key), releaseReports };
  }
  return withMyBotsTransaction({ root, registryPath }, txn => {
    const patches = inspect(txn.readRegistry());
    let backupPath = null;
    if (Object.keys(patches).length) {
      backupPath = path.join(root, 'mybot', 'state', 'backups', `management-v4-${Date.now()}.json`);
      txn.writeJson(backupPath, txn.readRegistry());
      for (const [key, patch] of Object.entries(patches)) txn.patchBot(key, patch);
    }
    return { dryRun: false, changed: Object.keys(patches), backupPath, releaseReports };
  });
}
