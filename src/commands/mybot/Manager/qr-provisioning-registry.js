import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../System/json-state.js';
import { loadMyBotsRegistry } from '../System/mybots-registry.js';
import { withRegistryLock, registryTransactions as transactions } from '../System/registry-lock.js';
import { allocateBindablePortString } from '../../../runtime/port-allocator.js';

import { writePrivateJson as secureWrite, restoreRegistryJournal as restoreJournal, recoverRegistryJournals as recoverLocked } from '../System/registry-recovery.js';

export async function recoverMyBotsTransactions({ root, registryPath } = {}) {
  const resolved = registryPath || path.join(root, 'mybot', 'mybots.json');
  return withRegistryLock(resolved, () => recoverLocked(root, resolved), { recover: false });
}
export async function withMyBotsTransaction({ root, registryPath, lockOptions } = {}, callback) {
  const resolved = registryPath || path.join(root, 'mybot', 'mybots.json');
  const active = transactions.getStore();
  if (active?._registryPath === resolved) return callback(active);
  return withRegistryLock(resolved, async () => {
    recoverLocked(root, resolved);
    const registry = loadMyBotsRegistry(resolved);
    const original = structuredClone(registry);
    const journalPath = path.join(root, 'mybot', 'state', 'transactions', `${crypto.randomUUID()}.json`);
    const journal = { id: path.basename(journalPath, '.json'), state: 'pending', before: {}, files: {} };
    const remember = key => {
      if (!(key in journal.before)) journal.before[key] = original[key] ?? null;
      secureWrite(journalPath, journal);
    };
    const txn = {
      _registry: registry, _registryPath: resolved, _committed: false,
      readRegistry() { return structuredClone(registry); },
      _flush() {
        for (const key of new Set([...Object.keys(original), ...Object.keys(registry)])) {
          if (JSON.stringify(original[key]) !== JSON.stringify(registry[key])) remember(key);
        }
        writeJsonAtomic(resolved, registry);
      },
      patchBot(key, patch) {
        remember(key);
        registry[key] = { ...(registry[key] || {}), ...patch };
        this._flush();
        return registry[key];
      },
      trackFile(file) {
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Transaction path outside runtime root');
        if (!(relative in journal.files)) journal.files[relative] = fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null;
        secureWrite(journalPath, journal);
      },
      writeJson(file, data) {
        this.trackFile(file);
        secureWrite(file, data);
      },
      async reserveProvisionedBot(bot = {}) {
        const uid = String(bot.botKey || bot.uid || '').trim();
        if (!uid) throw new Error('reserveProvisionedBot: botKey is required');
        if (registry[uid]) throw Object.assign(new Error('Bot already exists'), { code: 'BOT_EXISTS', status: 409 });
        const webPort = await allocateBindablePortString({ registry, end: Math.max(6666, Number(process.env.MYBOT_PORT_SCAN_END) || 65000) });
        return this.patchBot(uid, {
          name: uid, uid, botKey: uid, displayName: bot.displayName || uid,
          ownerUid: '', ownerName: '', trialStatus: 'pending', trialStartedAt: null,
          expiryAt: null, pid: null, consolePid: null, database: uid === 'admin' ? 'nthdz' : uid,
          createdAt: new Date().toISOString(), ...bot, webPort,
          desiredStatus: 'stopped', status: 'provisioning', provisioningSessionId: journal.id,
          provisioningStartedAt: new Date().toISOString(),
        });
      },
      finalizeProvisionedBot(uid, patch = {}) {
        if (!registry[uid]) throw new Error(`Bot ${uid} not found`);
        this.patchBot(uid, { ...patch, status: patch.status || 'stopped', lastUpdated: new Date().toISOString() });
        delete registry[uid].provisioningSessionId;
        delete registry[uid].provisioningStartedAt;
        this._flush();
      },
      removeProvisionedBot(uid) { remember(uid); delete registry[uid]; this._flush(); },
    };
    try {
      const result = await transactions.run(txn, () => callback(txn));
      txn._flush();
      journal.state = 'committed';
      secureWrite(journalPath, journal);
      txn._committed = true;
      fs.unlinkSync(journalPath);
      return result;
    } catch (error) {
      try { restoreJournal(journal, resolved, root); fs.rmSync(journalPath, { force: true }); }
      catch (rollbackError) { error.rollbackCode = 'RECOVERY_REQUIRED'; error.cause = rollbackError; }
      throw error;
    }
  }, lockOptions);
}
const uidLockChains = new Map();
export async function acquireActualUidLock({ root, actualUid }, callback) {
  const key = `${path.resolve(root)}:${String(actualUid || '').trim()}`;
  const previous = uidLockChains.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  uidLockChains.set(key, current);
  await previous;
  try { return await callback(); }
  finally { release(); if (uidLockChains.get(key) === current) uidLockChains.delete(key); }
}
