import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("phase 4 provider modules do not embed weather credentials", () => {
  const source = read("../src/service-debug/api-crawl/content/weather.js");

  assert.match(source, /process\.env\.OPENWEATHER_API_KEY/);
  assert.match(source, /process\.env\.WEATHERAPI_KEY/);
  assert.match(source, /process\.env\.TOMORROW_API_KEY/);
});

test("phase 4 provider modules read SimSimi and remove.bg credentials from the environment", () => {
  const simsimiSource = read("../src/service-debug/chat-bot/simsimi/simsimi-api.js");
  const removeBackgroundSource = read("../src/service-debug/utilities/remove-background.js");

  assert.match(simsimiSource, /process\.env\.SIMSIMI_API_KEY/);
  assert.doesNotMatch(simsimiSource, /const\s+SIMSIMI_API_KEY\s*=\s*["']/);
  assert.match(removeBackgroundSource, /process\.env\.REMOVE_BG_API_KEY/);
  assert.doesNotMatch(removeBackgroundSource, /const\s+apiKey\s*=\s*["']/);
});

test("legacy provider consumers read credentials from environment", () => {
  const utilitySource = read("../src/utils/util.js");
  const soundcloudSource = read("../src/service-debug/api-crawl/music/soundcloud.js");
  const zingSource = read("../src/service-debug/api-crawl/music/zingmp3.js");
  const dirtyContentSource = read("../src/api-zalo/apis/checkImage.js");
  const providerConfig = fs.readFileSync(new URL("../src/service-debug/api-crawl/config.json", import.meta.url), "utf8");

  assert.match(utilitySource, /process\.env\.INSTAGRAM_APP_ID/);
  assert.match(utilitySource, /process\.env\.IMGUR_CLIENT_ID/);
  assert.match(soundcloudSource, /process\.env\.SOUNDCLOUD_CLIENT_ID/);
  assert.match(zingSource, /process\.env\.ZINGMP3_API_KEY/);
  assert.match(zingSource, /process\.env\.ZINGMP3_SECRET_KEY/);
  assert.match(dirtyContentSource, /process\.env\.ZALO_DIRTYCONTENT_API_KEY/);
  assert.doesNotMatch(providerConfig, /clientId\s*:/);
  assert.doesNotMatch(providerConfig, /apiKey\s*:/);
  assert.doesNotMatch(providerConfig, /secretKey\s*:/);
});

test("phase 4 TikTok module does not embed a session cookie", () => {
  const source = read("../src/service-debug/api-crawl/tiktok/tiktok-service.js");

  assert.match(source, /process\.env\.TIKTOK_COOKIE/);
  assert.doesNotMatch(source, /_ttp=/);
  assert.doesNotMatch(source, /passport_csrf_token/);
});

test("phase 4 Spotify module reads provider secrets from environment", () => {
  const source = read("../src/service-debug/api-crawl/spotify/spotify-downlink.js");

  assert.match(source, /process\.env\.SPOTIFY_CLIENT_ID/);
  assert.match(source, /process\.env\.SPOTIFY_CLIENT_SECRET/);
  assert.match(source, /process\.env\.SPOTIFY_DOWNLOADER_SECRET/);
  assert.match(source, /process\.env\.SPOTIFY_DOWNLOADER_PASSPHRASE/);
});

test("phase 4 provider secrets are documented in the environment template", () => {
  const source = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");

  for (const key of [
    "TOMORROW_API_KEY",
    "TIKTOK_COOKIE",
    "OPENWEATHER_API_KEY",
    "WEATHERAPI_KEY",
    "HOANGDEV_API_KEY",
    "SPOTIFY_DOWNLOADER_SECRET",
    "SPOTIFY_DOWNLOADER_PASSPHRASE",
  ]) {
    assert.match(source, new RegExp(`^${key}=`, "m"), key);
  }
});
