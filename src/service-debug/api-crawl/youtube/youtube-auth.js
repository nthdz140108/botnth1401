import path from "node:path";

export function getYoutubeAuthOptions(env = process.env) {
  const cookieFile = env.YOUTUBE_COOKIES_FILE?.trim();
  if (cookieFile) {
    return { cookies: path.resolve(cookieFile) };
  }

  const browser = env.YOUTUBE_COOKIES_FROM_BROWSER?.trim();
  if (browser) {
    return { cookiesFromBrowser: browser };
  }

  return {};
}
