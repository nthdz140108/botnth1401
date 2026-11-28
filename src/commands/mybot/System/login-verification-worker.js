// This process imports only the SDK. Never import bootstrap/index or start a listener/scheduler.
process.once('message', async ({ credential } = {}) => {
  try {
    const { Zalo } = await import('../../../api-zalo/zalo.js');
    const { extractUsernameFromUserInfo } = await import('./mybot-identity.js');
    const zalo = new Zalo(credential, { selfListen: false, checkUpdate: false });
    const api = await zalo.login();
    const uid = String(api.getOwnId() || '').trim();
    if (!uid) throw new Error('missing identity');
    const userInfo = await api.getUserInfo(uid);
    const info = userInfo?.changed_profiles?.[uid] || userInfo?.data?.changed_profiles?.[uid] || userInfo?.data?.info || userInfo?.info || {};
    process.send?.({ type: 'verified', identity: { uid, displayName: info.displayName || info.zaloName || info.name || '', avatar: info.avatar || '', canonicalUsername: extractUsernameFromUserInfo(userInfo, uid) || '' } }, () => process.exit(0));
  } catch {
    process.send?.({ type: 'failed' }, () => process.exit(1));
  }
});
