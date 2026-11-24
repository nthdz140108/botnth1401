const DEFAULT_ZALO_WEB_URL = "https://chat.zalo.me";
const DEFAULT_ZALO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function readEnvValue(env, key) {
  return String(env?.[key] ?? "").trim();
}

export function getZaloRuntimeConfig(env = process.env) {
  return {
    webUrl: readEnvValue(env, "ZALO_WEB_URL") || DEFAULT_ZALO_WEB_URL,
    origin: readEnvValue(env, "ZALO_ORIGIN") || DEFAULT_ZALO_WEB_URL,
    referer: readEnvValue(env, "ZALO_REFERER") || `${DEFAULT_ZALO_WEB_URL}/`,
    userAgent: readEnvValue(env, "ZALO_USER_AGENT") || DEFAULT_ZALO_USER_AGENT,
  };
}

export function getZaloCookiePayload(rawCookies, env = process.env) {
  const { webUrl } = getZaloRuntimeConfig(env);
  return {
    url: webUrl,
    cookies: rawCookies?.cookies || [],
  };
}
