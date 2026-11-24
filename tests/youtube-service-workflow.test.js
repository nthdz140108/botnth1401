import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const readSource = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("youtube reply flow delegates terminal cleanup to the shared selection store", () => {
  const source = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");

  // Reply là adapter mỏng: claim/thu hồi/xóa map/dọn temp do dispatcher chung
  // (checkReplySelectionsMapData) và các bước chuyển trạng thái của store lo.
  assert.match(source, /checkReplySelectionsMapData\(api, message\)/);
  assert.match(source, /findSelectionRecordForMessage\(/);
  assert.match(source, /canContinueReply\(/, "cleanup must use the session owner policy, not the current replier");
  assert.doesNotMatch(source, /videoSelectionsMap/, "provider-local selection maps are replaced by the shared store");
  assert.match(source, /ownedTempPaths/, "preview temp must be owned by the selection record");
  assert.match(source, /resendPrompt/, "failed sends must be able to reopen the menu");
  assert.match(source, /if \(kind === "unavailable"\)/);
  assert.match(source, /if \(kind === "auth"\)/);
  assert.match(source, /if \(kind === "runtime"\)/);
  assert.match(source, /if \(kind === "timeout"\)/);
});

test("youtube service keeps the shared metadata model and direct send contract", () => {
  const source = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");

  assert.match(source, /normalizeYoutubeUrl/);
  assert.match(source, /getYoutubeVideoInfo/);
  assert.match(source, /handleSendMediaYoutube/);
  assert.match(source, /ensureUploadResult/);
  assert.match(source, /getCachedMedia/);
  assert.match(source, /videoAlreadyUploaded: true/);
  assert.match(source, /normalizeYoutubeWorkflowError\("send", error\)/);
  assert.match(source, /error\?\.stage === "upload"/);
  assert.match(source, /buildYoutubeProcessingCaption/);
  assert.match(source, /buildYoutubeVideoCaption/);
  assert.doesNotMatch(source, /Dang xu ly du lieu tu link/);
});
