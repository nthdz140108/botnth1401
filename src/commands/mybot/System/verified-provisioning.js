import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withMyBotsTransaction } from '../Manager/qr-provisioning-registry.js';
import { normalizeLoginCredential, credentialError } from './credential-normalizer.js';
import { writeJsonAtomic } from './json-state.js';

export async function persistVerifiedBot({ root, credential: input, identity, ownerUid, ownerName = '', targetBotKey, allowAdmin = false, allowMainUpdate = false, initialize, profilePatch = {}, signal } = {}) {
  const credential = normalizeLoginCredential(input);
  const accountUid = String(identity?.uid || '').trim();
  if (!accountUid) throw credentialError('ACCOUNT_IDENTITY_MISSING', 'Cần xác minh tài khoản trước khi lưu.', 'verify');
  return withMyBotsTransaction({ root }, async txn => {
    if (signal?.aborted) throw credentialError('LOGIN_CANCELLED', 'Phiên đăng nhập đã bị hủy.', 'persist');
    const registry = txn._registry;
    const main = registry.admin || Object.values(registry).find(record => record?.isMain);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(root, 'mybot', 'state', 'admin.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const mainUpdate = Boolean(allowMainUpdate && allowAdmin && targetBotKey && (targetBotKey === 'admin' || registry[targetBotKey]?.isMain));
    const mainUid = String(main?.accountUid || (main?.uid !== 'admin' ? main?.uid : '') || state.uid || '').trim();
    if (mainUpdate && (!mainUid || mainUid !== accountUid)) throw credentialError('ACCOUNT_MISMATCH', 'Tài khoản vừa quét không đúng tài khoản Main đã lưu.', 'identity');
    if (!mainUpdate && [main?.uid, main?.accountUid, state.uid].some(uid => uid && String(uid) === accountUid)) throw credentialError('MAIN_ACCOUNT_FORBIDDEN', 'Không thể dùng tài khoản Main để tạo bot con.', 'identity');
    const matches = Object.entries(registry).filter(([key, record]) => key !== 'admin' && String(record?.accountUid || record?.uid || key) === accountUid);
    if (matches.length > 1) throw credentialError('DUPLICATE_ACCOUNT', 'Tài khoản trùng nhiều bot; cần đối chiếu dữ liệu trước.', 'identity');
    let botKey = targetBotKey || matches[0]?.[0];
    let existing = botKey ? registry[botKey] : null;
    if (targetBotKey && !existing) throw credentialError('BOT_NOT_FOUND', 'Không tìm thấy bot cần cập nhật.', 'identity');
    if (!mainUpdate && (targetBotKey === 'admin' || existing?.isMain)) throw credentialError('MAIN_ACCOUNT_FORBIDDEN', 'Không cập nhật Main qua luồng bot con.', 'identity');
    if (existing && String(existing.accountUid || existing.uid || botKey) !== accountUid && (existing.accountIdentityStatus === 'verified' || existing.accountUid || (existing.uid && existing.uid !== botKey) || /^\d{10,}$/.test(botKey))) throw credentialError('ACCOUNT_MISMATCH', 'Tài khoản vừa quét không đúng tài khoản bot.', 'identity');
    if (matches.length && botKey && matches[0][0] !== botKey) throw credentialError('DUPLICATE_ACCOUNT', 'Tài khoản đã được dùng bởi bot khác.', 'identity');
    if (existing && !allowAdmin && String(existing.ownerUid || existing.createdByUid || '') !== String(ownerUid || '')) throw credentialError('BOT_OWNER_MISMATCH', 'Bạn không phải chủ quản lý bot này.', 'authorize');
    if (!existing && !String(ownerUid || '').trim()) throw credentialError('OWNER_REQUIRED', 'Cần chọn chủ quản lý bot.', 'authorize');
    const created = !existing;
    if (created) {
      botKey = `bot_${randomUUID()}`;
      existing = await txn.reserveProvisionedBot({ uid: botKey, name: botKey, accountUid, ownerUid, createdByUid: ownerUid, ownerName, displayName: identity.displayName || ownerName });
    }
    const record = { ...existing, botKey, uid: accountUid, accountUid, accountIdentityStatus: 'verified', adminBindingStatus: existing.adminBindingStatus || 'pending', displayName: identity.displayName || existing.displayName || ownerName, avatar: identity.avatar || existing.avatar || '', canonicalUsername: identity.canonicalUsername || existing.canonicalUsername || '', desiredStatus: existing.desiredStatus || 'stopped', lastUpdated: new Date().toISOString(), cookieUpdatedAt: new Date().toISOString(), ...profilePatch };
    const stored = { ...credential, accountUid, accountIdentityStatus: 'verified' };
    if (created) {
      if (typeof initialize !== 'function') throw credentialError('INITIALIZER_REQUIRED', 'Thiếu bước khởi tạo dữ liệu bot.', 'persist');
      await initialize(botKey, stored, record, txn);
    } else {
      const file = mainUpdate ? path.join(root, 'assets', 'config.json') : path.join(root, 'mybot', 'credentials', `${botKey}.json`);
      let previous = {};
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const next = { ...previous, ...stored };
      if (txn.writeJson) txn.writeJson(file, next); else writeJsonAtomic(file, next);
    }
    if (created) txn.finalizeProvisionedBot(botKey, { ...record, status: 'stopped' });
    else if (txn.patchBot) txn.patchBot(botKey, record);
    else { txn._registry[botKey] = record; txn._flush(); }
    return { botKey, record: { ...record, status: created ? 'stopped' : record.status }, created, restartRequired: !created };
  });
}
