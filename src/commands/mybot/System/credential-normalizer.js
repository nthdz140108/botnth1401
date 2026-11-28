import { getZaloRuntimeConfig } from '../../../api-zalo/zalo-config.js';

export function credentialError(code, message, stage = 'credential') {
  const status = code === 'BOT_NOT_FOUND' ? 404 : ['BOT_OWNER_MISMATCH', 'MAIN_ACCOUNT_FORBIDDEN'].includes(code) ? 403 : ['DUPLICATE_ACCOUNT', 'ACCOUNT_MISMATCH'].includes(code) ? 409 : 400;
  return Object.assign(new Error(message), { code, stage, status });
}

/** Produce precisely the forms accepted by Zalo.parseCookies, without trusting caller identity. */
export function normalizeLoginCredential(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw credentialError('INVALID_CREDENTIAL', 'Thông tin đăng nhập không hợp lệ.');
  const imei = String(input.imei || '').trim();
  const userAgent = String(input.userAgent || getZaloRuntimeConfig().userAgent).trim();
  let cookie = input.rawCookies || input.cookie;
  if (typeof cookie === 'string') {
    try { cookie = JSON.parse(cookie); } catch { /* Cookie header is supported by the login client. */ }
  }
  if (cookie && typeof cookie === 'object') {
    const items = Array.isArray(cookie) ? cookie : cookie.cookies;
    if (Array.isArray(items)) {
      const cookies = items.map(item => ({ ...item, name: String(item.name || item.key || '').trim(), value: String(item.value ?? '') }));
      if (!cookies.length || cookies.some(item => !item.name || !item.value || /[;\r\n]/.test(item.name) || /[\r\n]/.test(item.value))) throw credentialError('INVALID_CREDENTIAL', 'Cookie đăng nhập trống hoặc không hợp lệ.');
      cookie = { url: 'https://chat.zalo.me', cookies };
    } else {
      // Legacy browser cookie maps are converted explicitly, never passed as an SDK cookie object.
      const cookies = Object.entries(cookie).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([name, value]) => ({ name, value: String(value), domain: '.zalo.me', path: '/' }));
      if (!cookies.length) throw credentialError('INVALID_CREDENTIAL', 'Cookie đăng nhập trống hoặc không hợp lệ.');
      cookie = { url: 'https://chat.zalo.me', cookies };
    }
  }
  if (!imei || imei === 'unknown' || !userAgent || !cookie || !['string', 'object'].includes(typeof cookie) || (typeof cookie === 'string' && (!/[^=;\s]+=[^;]+/.test(cookie) || /[\r\n]/.test(cookie)))) throw credentialError('INVALID_CREDENTIAL', 'Cần cookie hợp lệ, IMEI và user agent.');
  const { rawCookies: _raw, uid: _uid, userInfo: _info, botUid: _botUid, ...rest } = input;
  return { ...rest, cookie, imei, userAgent };
}
