import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canContinueReply } from "../src/service-debug/reply-access.js";

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("public reply state accepts a different sender", () => {
  assert.equal(
    canContinueReply(
      { replyAccess: "public", userRequest: "user-a", threadId: "group-1" },
      "admin",
      "group-1"
    ),
    true
  );
});

test("public reply state rejects a different group", () => {
  assert.equal(
    canContinueReply(
      { replyAccess: "public", userRequest: "user-a", threadId: "group-1" },
      "admin",
      "group-2"
    ),
    false
  );
});

test("owner-only reply state rejects a different sender", () => {
  assert.equal(canContinueReply({ userRequest: "user-a" }, "admin"), false);
});

test("owner-only state accepts senderId-backed workflows for the owner", () => {
  assert.equal(canContinueReply({ senderId: "user-a" }, "user-a"), true);
});

test("group reply dispatch uses pre-command message eligibility", () => {
  const source = readSource("src/automations/event-send-msg.js");

  assert.match(source, /const canProcessReply = handleChat &&/);
  assert.match(source, /if \(canProcessReply \|\| \(callerIsBotAdmin && !protectionHandled && !muted\)\) \{/);
  assert.match(source, /const replyHandled = await (?:eventSendMsgHooks\.)?handleOnReplyFromUser/);
});

const publicWorkflowFiles = [
  "src/service-debug/api-crawl/music/soundcloud.js",
  "src/service-debug/api-crawl/music/zingmp3.js",
  "src/service-debug/api-crawl/music/nhaccuatui.js",
  "src/service-debug/api-crawl/youtube/youtube-service.js",
  "src/service-debug/api-crawl/tiktok/tiktok-service.js",
  "src/service-debug/api-crawl/api-hoangdev/aio-downlink.js",
  "src/service-debug/api-crawl/download/aio-downlink.js",
  "src/service-debug/api-crawl/spotify/spotify-downlink.js",
  "src/service-debug/api-crawl/capcut/capcut-service.js",
];

for (const file of publicWorkflowFiles) {
  test(`${file} marks its selection state public and uses the shared policy`, () => {
    const source = readSource(file);
    assert.match(source, /replyAccess: "public"/);
    assert.match(source, /canContinueReply\(/);
  });
}

test("administrative reply workflows remain owner-bound", () => {
  const scanSource = readSource("src/commands/bot-manager/scan-group.js");
  const remoteActionSource = readSource("src/commands/bot-manager/remote-action-group.js");

  assert.match(scanSource, /scanData\.userRequest !== message\.data\.uidFrom/);
  assert.match(remoteActionSource, /dataReply\.message\.data\.uidFrom !== senderId/);
  assert.doesNotMatch(scanSource, /replyAccess: "public"/);
  assert.doesNotMatch(remoteActionSource, /replyAccess: "public"/);
});
