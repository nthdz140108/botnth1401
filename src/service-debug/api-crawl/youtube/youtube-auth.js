import path from "node:path";
import fs from 'node:fs';

export function getYoutubeAuthOptions(env = process.env) {
  const cookieFile = env.YOUTUBE_COOKIES_FILE?.trim();
  if (cookieFile) {
    const configured = path.resolve(cookieFile);
    const persistent = !path.isAbsolute(cookieFile) && env.MYBOT_DATA_DIR && /^mybot[\\/]/.test(cookieFile)
      ? path.resolve(env.MYBOT_DATA_DIR, cookieFile.slice(6)) : null;
    return { cookies: persistent && fs.existsSync(persistent) ? persistent : configured };
  }

  const browser = env.YOUTUBE_COOKIES_FROM_BROWSER?.trim();
  if (browser) {
    return { cookiesFromBrowser: browser };
  }

  return {};
}
