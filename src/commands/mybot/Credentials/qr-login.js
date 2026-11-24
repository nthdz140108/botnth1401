import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import QRCode from 'qrcode';
import { openPathInDefaultApp } from '../../../platform/index.js';
import { getZaloRuntimeConfig } from '../../../api-zalo/zalo-config.js';
import {
  QR_LOGIN_EXPIRY_REASON,
  isQrLoginExpiredResponse,
  isQrLoginExpiredSignal,
} from '../../../utils/qr-login-expiry.js';
const FATAL_AUTH_PATTERNS = [
  "cookie is expired or invalid",
  "cookie expired or invalid",
  "cookie sai định dạng",
  "cookie sai dinh dang",
  "invalid cookie",
];
const ZALO_RUNTIME = getZaloRuntimeConfig();
const ZALO_WEB_URL = ZALO_RUNTIME.webUrl;
const ZALO_ID_URL = "https://id.zalo.me";
const ZALO_APP_URL = "https://zalo.me/pc";
const ZALO_USER_AGENT = ZALO_RUNTIME.userAgent;

function isFatalAuthError(text = "") {
  const normalized = text.toLowerCase();
  return FATAL_AUTH_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function waitForQrRetry(signal, delayMs = 5000) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Wraps a fetchWithCookies call with an AbortSignal and a hard deadline race so
 * a Zalo HTTP request that never responds cannot hold the QR flow forever.
 * The signal is passed into the actual fetch, not just checked between polls.
 */
async function fetchWithDeadline(fetchWithCookies, url, options = {}, { signal, expiresAt } = {}) {
  const deadlineReached = () => typeof expiresAt === "number" && expiresAt > 0 && Date.now() >= expiresAt;
  const fetchOptions = { ...options };
  if (signal) {
    fetchOptions.signal = signal;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const result = await Promise.race([
      fetchWithCookies(url, fetchOptions),
      new Promise((_, reject) => {
        const tick = () => {
          if (controller.signal.aborted) {
            reject(new Error("QR request aborted"));
            return;
          }
          if (deadlineReached()) {
            reject(new Error("QR request deadline exceeded"));
            return;
          }
          setTimeout(tick, 250);
        };
        tick();
      }),
    ]);
    return result;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
function generateZaloUUID() {
  const randomUUID = uuidv4();
  const md5Hash = crypto.createHash('md5').update(ZALO_USER_AGENT).digest('hex');
  return `${randomUUID}-${md5Hash}`;
}
async function initSession(options = {}) {
  const cookieJar = new CookieJar();
  const fetchWithCookies = fetchCookie(fetch, cookieJar);
  const headers = {
    "User-Agent": ZALO_USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "sec-ch-ua": "\"Google Chrome\";v=\"135\", \"Not-A.Brand\";v=\"8\", \"Chromium\";v=\"135\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "origin": ZALO_ID_URL,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "Accept-Encoding": "gzip, deflate, br",
    "referer": `${ZALO_ID_URL}/account?continue=${encodeURIComponent(`${ZALO_WEB_URL}/`)}`,
    "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
  };
  const payload = new URLSearchParams({
    'continue': `${ZALO_WEB_URL}/`,
    'v': '5.5.7'
  });

  try {
    const getUrl = `${ZALO_ID_URL}/account?${payload.toString()}`;
    const getResponse = await fetchWithCookies(getUrl, { headers, method: 'GET' });
    if (!getResponse.ok) {
      console.error(`GET /account failed: ${getResponse.status} ${getResponse.statusText}`);
      return null;
    }
    console.log(`Cookies after GET /account: ${getResponse.headers.get('set-cookie') || 'none'}`);

    const loginUrls = [
      `${ZALO_ID_URL}/account/logininfo`,
      `${ZALO_ID_URL}/account/login`
    ];
    let postResponse = null;
    for (const loginUrl of loginUrls) {
      postResponse = await fetchWithCookies(loginUrl, {
        headers,
        method: 'POST',
        body: payload
      });
      if (postResponse.ok) {
        console.log(`POST ${loginUrl} succeeded`);
        break;
      }
      console.error(`POST ${loginUrl} failed: ${postResponse.status} ${postResponse.statusText}`);
    }
    if (!postResponse || !postResponse.ok) {
      return null;
    }
    console.log(`Cookies after POST /logininfo: ${postResponse.headers.get('set-cookie') || 'none'}`);

    return { headers, cookieJar, fetchWithCookies, sessionId: options.sessionId, qrFilePath: options.qrFilePath };
  } catch (e) {
    console.error(`Error in initSession: ${e}`);
    return null;
  }
}


async function verifyClient(session) {
  if (!session) return null;
  const fetchWithCookies = session.fetchWithCookies || fetchCookie(fetch, session.cookieJar || new CookieJar());
  const veriPayload = new URLSearchParams({
    'type': 'device',
    'continue': ZALO_APP_URL,
    'v': '5.5.7'
  });
  const headers = {
    'accept': '*/*',
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8,fr-FR;q=0.7,fr;q=0.6',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': ZALO_ID_URL,
    'priority': 'u=1, i',
    'referer': `${ZALO_ID_URL}/account?continue=${encodeURIComponent(`${ZALO_WEB_URL}/`)}`,
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': ZALO_USER_AGENT,
  };
  try {
    const response = await fetchWithCookies(`${ZALO_ID_URL}/account/verify-client`, {
      headers: { ...session.headers, ...headers },
      method: 'POST',
      body: veriPayload
    });
    if (!response.ok) {
      console.error(`POST /verify-client failed: ${response.status} ${response.statusText}`);
      return null;
    }
    console.log(`Cookies after POST /verify-client: ${response.headers.get('set-cookie') || 'none'}`);
    return session;
  } catch (e) {
    console.error(`Error in verifyClient: ${e}`);
    return null;
  }
}


async function generateQRCode(session, options = {}) {
  if (!session) return [false, null];
  const fetchWithCookies = session.fetchWithCookies || fetchCookie(fetch, session.cookieJar || new CookieJar());
  const qrFilePath = options.qrFilePath || session.qrFilePath || `.cache/qr_code-${options.sessionId || session.sessionId || Date.now()}.png`;
  const persistQrFile = options.persistQrFile !== false;
  const payload = new URLSearchParams({
    'continue': ZALO_APP_URL,
    'v': '5.5.7'
  });
  const headers = {
    'accept': '*/*',
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8,fr-FR;q=0.7,fr;q=0.6',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': ZALO_ID_URL,
    'priority': 'u=1, i',
    'referer': `${ZALO_ID_URL}/account?continue=${encodeURIComponent(`${ZALO_WEB_URL}/`)}`,
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': ZALO_USER_AGENT,
  };
  const maxRetries = 3;
  let retries = 0;
  let currentSession = session;

  while (retries < maxRetries) {
    try {
      const response = await fetchWithCookies(`${ZALO_ID_URL}/account/authen/qr/generate`, {
        headers: { ...currentSession.headers, ...headers },
        method: 'POST',
        body: payload
      });
      if (!response.ok) {
        console.error(`POST /qr/generate failed: ${response.status} ${response.statusText}`);
        const responseText = await response.text();
        console.error(`Response body: ${responseText}`);
        if (isFatalAuthError(responseText)) {
          return [false, null, { fatal: true, reason: "cookie-expired-or-invalid" }];
        }
        retries++;
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (responseText.includes('-1003')) {
          console.log('Received -1003 error, refreshing session...');
          currentSession = await initSession();
          if (!currentSession) {
            console.error('Failed to refresh session');
            return [false, null];
          }
          currentSession = await verifyClient(currentSession);
          if (!currentSession) {
            console.error('Failed to verify client after refresh');
            return [false, null];
          }
        }
        continue;
      }
      const data = await response.json();
      console.log(`QR generate response: ${JSON.stringify(data)}`);
      if (!data || !data.data || !data.data.image) {
        console.error(`Invalid QR code response: ${JSON.stringify(data)}`);
        const responseText = JSON.stringify(data || {});
        if (isFatalAuthError(responseText)) {
          return [false, null, { fatal: true, reason: "cookie-expired-or-invalid" }];
        }
        if (data?.error_code === -1003) {
          console.log('Received -1003 error, refreshing session...');
          currentSession = await initSession();
          if (!currentSession) {
            console.error('Failed to refresh session');
            return [false, null];
          }
          currentSession = await verifyClient(currentSession);
          if (!currentSession) {
            console.error('Failed to verify client after refresh');
            return [false, null];
          }
          retries++;
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        return [false, currentSession];
      }
      const qrCode = data.data.image;
      const code = data.data.code;
      const qrCodeData = qrCode.replace("data:image/png;base64,", "");
      currentSession.qrImage = qrCode;
      if (persistQrFile) {
        const qrCodeBytes = Buffer.from(qrCodeData, 'base64');
        await fs.mkdir(path.dirname(qrFilePath), { recursive: true });
        await fs.writeFile(qrFilePath, qrCodeBytes);
        currentSession.qrFilePath = qrFilePath;
        if (typeof currentSession?.onQrReady === "function") {
          try {
            await currentSession.onQrReady(qrFilePath, data);
          } catch (qrErr) {
            console.error(`[QR] Lỗi handler onQrReady: ${qrErr.message}`);
          }
        }
      }
      console.log(`QR Code: ${code}`);
      return [code, currentSession, { qrImage: qrCode, persisted: persistQrFile }];
    } catch (e) {
      console.error(`Error in generateQRCode: ${e}`);
      retries++;
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Error occurred, refreshing session...');
      currentSession = await initSession();
      if (!currentSession) {
        console.error('Failed to refresh session');
        return [false, null];
      }
      currentSession = await verifyClient(currentSession);
      if (!currentSession) {
        console.error('Failed to verify client after refresh');
        return [false, null];
      }
    }
  }
  console.error(`Failed to generate QR code after ${maxRetries} retries`);
  return [false, currentSession];
}


async function checkSession(session) {
  if (!session) return null;
  const fetchWithCookies = session.fetchWithCookies || fetchCookie(fetch, session.cookieJar || new CookieJar());
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
    "priority": "u=0, i",
    "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "upgrade-insecure-requests": "1",
    "Referer": `${ZALO_ID_URL}/account?continue=${encodeURIComponent(`${ZALO_WEB_URL}/`)}`,
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  try {
    const response = await fetchWithCookies(`${ZALO_ID_URL}/account/checksession?continue=${encodeURIComponent(`${ZALO_WEB_URL}/index.html`)}`, {
      headers: { ...session.headers, ...headers }
    });
    if (!response.ok) {
      console.error(`GET /checksession failed: ${response.status} ${response.statusText}`);
    }
    return response;
  } catch (e) {
    console.error(`Error checking session: ${e}`);
    return null;
  }
}


async function getUserInfo(session) {
  if (!session) return null;
  const fetchWithCookies = session.fetchWithCookies || fetchCookie(fetch, session.cookieJar || new CookieJar());
  const headers = {
    "accept": "*/*",
    "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
    "priority": "u=1, i",
    "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "Referer": `${ZALO_WEB_URL}/`,
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  try {
    const response = await fetchWithCookies("https://jr.chat.zalo.me/jr/userinfo", {
      headers: { ...session.headers, ...headers }
    });
    if (!response.ok) {
      console.error(`GET /userinfo failed: ${response.status} ${response.statusText}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error(`Error getting user info: ${e}`);
    return null;
  }
}


async function waitingConfirm(code, session, options = {}) {
  if (!session || !code) return [null, null];
  const fetchWithCookies = session.fetchWithCookies || fetchCookie(fetch, session.cookieJar || new CookieJar());
  const cookieJar = session.cookieJar || new CookieJar();
  const { signal, prefix = "?", onStatus, expiresAt, onExpired, retryDelayMs = 5000 } = options;
  const hasDeadline = typeof expiresAt === "number" && expiresAt > 0;
  const expire = () => {
    onExpired?.();
    return [null, null, { expired: true, reason: QR_LOGIN_EXPIRY_REASON }];
  };
  const expired = () => isQrLoginExpiredSignal(signal) || (hasDeadline && Date.now() >= expiresAt);
  if (expired()) return expire();
  if (typeof onStatus === "function") onStatus("waiting_confirm");
  const confirmPayload = new URLSearchParams({
    'code': code,
    'gToken': '',
    'gAction': 'CONFIRM_QR',
    'continue': `${ZALO_WEB_URL}/index.html`,
    'v': '5.5.7',
  });
  const headers = {
    'accept': '*/*',
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8,fr-FR;q=0.7,fr;q=0.6',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': ZALO_ID_URL,
    'priority': 'u=1, i',
    'referer': `${ZALO_ID_URL}/account?continue=${encodeURIComponent(`${ZALO_WEB_URL}/`)}`,
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': ZALO_USER_AGENT,
  };
  const maxAttempts = 10;
  let attempts = 0;

  while (true) {
    if (expired()) return expire();
    if (signal?.aborted) {
      return isQrLoginExpiredSignal(signal) ? expire() : [null, null, { cancelled: true }];
    }
    try {
      const response = await fetchWithDeadline(
        fetchWithCookies,
        `${ZALO_ID_URL}/account/authen/qr/waiting-confirm`,
        {
          headers: { ...session.headers, ...headers },
          method: 'POST',
          body: confirmPayload,
        },
        { signal, expiresAt }
      );
      const statusData = await response.json();
      console.log(`Confirm response: ${JSON.stringify(statusData)}`);
      if (isFatalAuthError(JSON.stringify(statusData || {}))) {
        return [null, null, { fatal: true, reason: "cookie-expired-or-invalid" }];
      }
      if (Number(statusData.error_code) === 0) {
        if (expired()) return expire();
        const sessionResponse = await checkSession(session);
        if (!sessionResponse) {
          return [null, null, { fatal: true, reason: "checksession-failed" }];
        }
        console.log("Login confirm successfully!");
        const imei = generateZaloUUID();
        const domains = [ZALO_WEB_URL, 'https://zalo.me', ZALO_ID_URL, 'https://baomoi.com', 'https://zaloapp.com', 'https://zingmp3.vn'];
        let allCookies = [];
        for (const domain of domains) {
          const cookies = await cookieJar.getCookies(domain);
          allCookies = allCookies.concat(cookies);
        }
        console.log(`Cookies in waitingConfirm: ${JSON.stringify(allCookies, null, 2)}`);
        const zpwSekCookie = allCookies.find(cookie => cookie.key === 'zpw_sek')?.value || '';
        const userInfo = await getUserInfo(session);
        const name = userInfo?.data?.info?.name || '';
        const avatar = userInfo?.data?.info?.avatar || '';
        const data = {
          prefix,
          imei,
          cookie: { zpw_sek: zpwSekCookie },
          active: false,
          name,
          avatar,
        };
        const rawCookies = {
          url: ZALO_WEB_URL,
          cookies: allCookies.map(cookie => ({
            domain: cookie.domain,
            expirationDate: cookie.expires instanceof Date && !isNaN(cookie.expires.getTime()) ? Math.floor(cookie.expires.getTime() / 1000) : null,
            hostOnly: !cookie.domain.startsWith('.'),
            httpOnly: cookie.httpOnly,
            name: cookie.key,
            path: cookie.path,
            sameSite: cookie.sameSite || 'unspecified',
            secure: cookie.secure,
            session: !cookie.expires,
            storeId: '0',
            value: cookie.value
          }))
        };
        return [data, rawCookies];
      }
      if (Number(statusData.error_code) === -13) {
        return [null, null, { cancelled: true, reason: "qr-declined" }];
      }
      if (Number(statusData.error_code) === -14 || isQrLoginExpiredResponse(statusData)) {
        if (!hasDeadline) {
          return expire();
        }
      }
      if (expired()) return expire();
      await waitForQrRetry(signal, retryDelayMs);
      attempts++;
    } catch (e) {
      console.error(`Error in waitingConfirm: ${e}`);
      if (expired()) return expire();
      await waitForQrRetry(signal, retryDelayMs);
      attempts++;
    }
  }
}


export function classifyQrScanResponse(statusData) {
  if (!statusData || typeof statusData !== "object") return "waiting";
  if (isFatalAuthError(JSON.stringify(statusData))) return "fatal";

  const errorCode = Number(statusData.error_code);
  const data = statusData.data;

  // Explicit waiting markers must win before the generic truthy-data rule.
  if (data?.data === "not_scanned" || data === "not_scanned" || statusData.status === "not_scanned") {
    return "waiting";
  }
  if (errorCode === 8 && (data === null || data === undefined)) {
    return "waiting";
  }
  if (errorCode === 0 && !data) {
    return "waiting";
  }
  if (data?.status === "scanned" || statusData.status === "scanned") {
    return "scanned";
  }

  // Zalo's current QR contract treats any non-null data returned with
  // error_code 0 as the one-time scan transition. The payload fields can
  // differ by account/session, so requiring a specific identity key can
  // miss the transition and leave the client polling the wrong endpoint.
  if (errorCode === 0 && data) {
    return "scanned";
  }
  if (data?.status === "expired" || statusData.status === "expired") {
    return "expired";
  }

  // 3. Unknown / transient response (e.g. error_code -1003 or -14 before local deadline) -> keep waiting
  return "waiting";
}

async function waitingScan(code, session, signal, options = {}) {
  if (!session || !code) return false;
  const actualOptions = (signal && typeof signal === "object" && !("aborted" in signal)) ? signal : options;
  const actualSignal = (signal && "aborted" in signal) ? signal : actualOptions.signal;
  const { expiresAt, onExpired, retryDelayMs = 5000 } = actualOptions;
  const hasDeadline = typeof expiresAt === "number" && expiresAt > 0;
  const expire = () => {
    onExpired?.();
    return false;
  };
  const expired = () => isQrLoginExpiredSignal(actualSignal) || (hasDeadline && Date.now() >= expiresAt);
  if (expired()) return expire();
  const fetchWithCookies = session.fetchWithCookies || fetchCookie(fetch, session.cookieJar || new CookieJar());
  const checkPayload = new URLSearchParams({
    'code': code,
    'continue': `${ZALO_WEB_URL}/`,
    'v': '5.5.7'
  });
  const headers = {
    'accept': '*/*',
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8,fr-FR;q=0.7,fr;q=0.6',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': ZALO_ID_URL,
    'priority': 'u=1, i',
    'referer': `${ZALO_ID_URL}/account?continue=${encodeURIComponent(`${ZALO_WEB_URL}/`)}`,
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': ZALO_USER_AGENT,
  };
  console.log("Waiting for QR code scan...");
  let attempts = 0;

  while (true) {
    if (expired()) return expire();
    if (actualSignal?.aborted) return false;
    try {
      const response = await fetchWithDeadline(
        fetchWithCookies,
        `${ZALO_ID_URL}/account/authen/qr/waiting-scan`,
        {
          headers: { ...session.headers, ...headers },
          method: 'POST',
          body: checkPayload,
        },
        { signal: actualSignal, expiresAt }
      );
      const statusData = await response.json();
      const classified = classifyQrScanResponse(statusData);
      if (classified !== "waiting") {
        console.log(`Scan response: ${JSON.stringify(statusData)}`);
      }
      if (classified === "fatal") {
        return false;
      }
      if (classified === "expired") {
        return expire();
      }
      if (classified === "scanned") {
        if (expired()) return expire();
        console.log("Đã quét QR code");
        return true;
      }
      if (expired()) return expire();
      await waitForQrRetry(actualSignal, retryDelayMs);
      attempts++;
    } catch (e) {
      console.error(`Error in waitingScan: ${e}`);
      if (expired()) return expire();
      await waitForQrRetry(actualSignal, retryDelayMs);
      attempts++;
    }
  }
}


function openQrImageDefault(filePath) {
  openPathInDefaultApp(path.resolve(filePath), { spawnImpl: spawn });
}

async function authenticateZalo(options = {}) {
  const { onQrReady, onStatus, signal, prefix = "?" } = options;
  const fail = (errorType, errorCode = null, extra = {}) => ({
    success: false,
    session: null,
    resultData: null,
    rawCookies: null,
    errorType,
    errorCode,
    cancelled: Boolean(extra.cancelled),
    ...extra,
  });
  if (typeof onStatus === "function") onStatus("initializing");
  let session = await initSession(options);
  if (!session) {
    console.log("Failed to initialize session");
    return fail("network", "init_session_failed");
  }

  if (signal?.aborted) return fail("cancelled", "cancelled", { cancelled: true });
  if (typeof onStatus === "function") onStatus("generating_qr");
  session = await verifyClient(session);
  if (!session) {
    console.log("Failed to verify client");
    return fail("network", "verify_client_failed");
  }

  session.onQrReady = onQrReady || ((filePath) => openQrImageDefault(filePath));
  const [code, updatedSession, qrMeta] = await generateQRCode(session, options);
  session = updatedSession;
  if (!code) {
    console.log("Failed to generate QR code");
    return fail(qrMeta?.fatal ? "cookie_invalid" : "invalid_response", qrMeta?.reason || "generate_qr_failed");
  }

  if (typeof onStatus === "function") onStatus("waiting_scan");
  const result = await waitingScan(code, session, signal);
  if (!result) {
    console.log("Login Failed: QR code scan not completed");
    if (isQrLoginExpiredSignal(signal)) return fail("expired", "qr_expired", { expired: true });
    return fail(signal?.aborted ? "cancelled" : "timeout", signal?.aborted ? "cancelled" : "scan_timeout", { cancelled: Boolean(signal?.aborted) });
  }

  if (typeof onStatus === "function") onStatus("waiting_confirm");
  const [resultData, rawCookies, confirmMeta] = await waitingConfirm(code, session, { signal, prefix, onStatus });
  if (resultData) {
    console.log("Authentication successful!");
    console.log("IMEI:", resultData.imei);
    const userInfo = await getUserInfo(session);
    if (userInfo) {
      console.log(`User info: ${JSON.stringify(userInfo)}`);
    }
    return {
      success: true,
      session,
      resultData,
      rawCookies,
      errorType: null,
      errorCode: null,
      cancelled: false,
    };
  }

  console.log("Login Failed: QR code confirmation not completed");
  if (confirmMeta?.expired || isQrLoginExpiredSignal(signal)) return fail("expired", "qr_expired", { expired: true });
  if (confirmMeta?.cancelled) return fail("cancelled", "cancelled", { cancelled: true });
  if (confirmMeta?.fatal) return fail("cookie_invalid", confirmMeta.reason || "cookie_invalid");
  return fail("rejected", "confirm_failed");
}

async function authenticateZaloLegacy(options = {}) {
  const result = await authenticateZalo(options);
  return result.success ? [result.session, result.rawCookies, result.resultData] : [null, null, null];
}

export { authenticateZalo, authenticateZaloLegacy, initSession, verifyClient, generateQRCode, waitingScan, waitingConfirm, getUserInfo };
