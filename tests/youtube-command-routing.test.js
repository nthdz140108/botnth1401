import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const readSource = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("youtube service restores the command, reply, and media handlers directly", () => {
  const serviceSource = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");

  assert.match(serviceSource, /export async function handleYoutubeCommand\(api, message, aliasCommand\)/);
  assert.match(serviceSource, /export async function handleYoutubeReply\(api, message\)/);
  assert.match(serviceSource, /export async function handleSendMediaYoutube\(api, message, video, qualityParam, videoPath, isAdminLevelHigh\)/);
  assert.match(serviceSource, /handleSendMediaYoutube\(api, message, videoInfo, typeVideo, null, isAdminLevelHigh\)/);
  assert.doesNotMatch(serviceSource, /runYoutubeCommandWorkflow/);
  assert.doesNotMatch(serviceSource, /runYoutubeReplyWorkflow/);
});
