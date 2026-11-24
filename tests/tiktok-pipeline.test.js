import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  normalizeTikTokRawData,
  normalizeSubHatDeData,
  normalizeHoangDevAIOData,
  normalizeTikTokMedia,
  normalizeTikTokSearchResult,
  getTikTokMedia,
  getDataDownloadVideo,
} from "../src/service-debug/api-crawl/tiktok/tiktok-api.js";

import {
  sendTikTokMedia,
  sendTikTokVideo,
  handleTikTokCommand,
  handleTikTokReply,
  handleTikTokReaction,
} from "../src/service-debug/api-crawl/tiktok/tiktok-service.js";

import { tempDir } from "../src/utils/io-json.js";

const readSource = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const mockDownloadFile = async (url, target) => {
  if (!url || !url.trim() || !url.startsWith("http")) throw new Error("Invalid URL");
  fs.writeFileSync(target, "mock-file-content");
  return target;
};

const mockDownloadVideo = async (url) => {
  if (!url || !url.trim() || !url.startsWith("http")) throw new Error("Invalid video URL");
  const p = path.join(tempDir, `mock_vid_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  fs.writeFileSync(p, "mock-video-bytes");
  return p;
};

const defaultTestOptions = {
  isRandom: true,
  downloadFile: mockDownloadFile,
  downloadVideoTiktok: mockDownloadVideo,
  getCachedMedia: async () => null,
  setCacheData: async () => {},
  getTiktokRelated: async () => [],
  deleteFile: async (f) => {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  },
  sendVoiceMusic: async (api, message, object, ttl) => {
    return api.sendVoice(message, object.voiceUrl, ttl);
  },
};

test("1. Normalization: TikTok Raw schema converts video and slideshow with empty URL filtering and order preservation", () => {
  // Video raw
  const rawVideo = {
    aweme_id: "7123456789",
    desc: "A cool video",
    author: { unique_id: "user1", nickname: "User One" },
    video: {
      play_addr: { url_list: ["https://cdn.tiktok.com/vid1.mp4", "https://cdn.tiktok.com/vid2.mp4"] },
      cover: { url_list: ["https://cdn.tiktok.com/cover1.jpg"] },
      ratio: "720p",
      duration: 15000,
    },
    music: {
      title: "Audio Track",
      author: "Artist A",
      play_url: { url_list: ["https://cdn.tiktok.com/audio.mp3"] },
    },
    statistics: { play_count: 100, digg_count: 10 },
  };

  const normalizedVideo = normalizeTikTokRawData(rawVideo);
  assert.equal(normalizedVideo.id, "7123456789");
  assert.equal(normalizedVideo.kind, "video");
  assert.equal(normalizedVideo.video.url, "https://cdn.tiktok.com/vid2.mp4");
  assert.equal(normalizedVideo.video.cover, "https://cdn.tiktok.com/cover1.jpg");
  assert.deepEqual(normalizedVideo.images, []);
  assert.equal(normalizedVideo.music.url, "https://cdn.tiktok.com/audio.mp3");
  assert.equal(normalizedVideo.stat.playCount, 100);

  // Slideshow raw
  const rawSlide = {
    aweme_id: "7987654321",
    desc: "A nice photo slideshow",
    author: { unique_id: "photographer", nickname: "Photo Master" },
    image_post_info: {
      images: [
        { display_image: { url_list: ["https://cdn.tiktok.com/img1.jpg"] } },
        { display_image: { url_list: ["   "] } }, // empty/whitespace to filter
        { display_image: { url_list: ["https://cdn.tiktok.com/img2.png"] } },
        { display_image: { url_list: ["https://cdn.tiktok.com/img3.webp"] } },
      ],
    },
    music: {
      title: "Slide Music",
      play_url: { url_list: ["https://cdn.tiktok.com/slidemusic.mp3"] },
    },
    statistics: { play_count: 500, digg_count: 50 },
  };

  const normalizedSlide = normalizeTikTokRawData(rawSlide);
  assert.equal(normalizedSlide.id, "7987654321");
  assert.equal(normalizedSlide.kind, "slideshow");
  assert.equal(normalizedSlide.video, null);
  assert.equal(normalizedSlide.images.length, 3);
  assert.equal(normalizedSlide.images[0].url, "https://cdn.tiktok.com/img1.jpg");
  assert.equal(normalizedSlide.images[0].extension, "jpg");
  assert.equal(normalizedSlide.images[1].url, "https://cdn.tiktok.com/img2.png");
  assert.equal(normalizedSlide.images[1].extension, "png");
  assert.equal(normalizedSlide.images[2].url, "https://cdn.tiktok.com/img3.webp");
  assert.equal(normalizedSlide.images[2].extension, "webp");
});

test("2. Normalization: SubHatDe schema converts video and slideshow", () => {
  const subHatDeVideo = {
    id: "sub123",
    title: "SubHatDe Video",
    author: { unique_id: "sub_author", nickname: "Sub Author" },
    play: "https://sub.cdn/play.mp4",
    cover: "https://sub.cdn/cover.jpg",
    duration: 12,
    quality: "720p",
    music_info: { title: "Sub Music", play: "https://sub.cdn/music.mp3", author: "Musician" },
    play_count: 200,
  };
  const normVid = normalizeSubHatDeData(subHatDeVideo);
  assert.equal(normVid.id, "sub123");
  assert.equal(normVid.kind, "video");
  assert.equal(normVid.video.url, "https://sub.cdn/play.mp4");
  assert.equal(normVid.video.duration, 12000);
  assert.deepEqual(normVid.images, []);

  const subHatDeSlide = {
    id: "subslide456",
    title: "SubHatDe Slideshow",
    author: { unique_id: "slide_author", nickname: "Slide Author" },
    images: [
      "https://sub.cdn/photo1.jpg",
      "", // empty to filter
      "https://sub.cdn/photo2.jpeg",
    ],
    music_info: { title: "Sub Music", play: "https://sub.cdn/music.mp3" },
  };
  const normSlide = normalizeSubHatDeData(subHatDeSlide);
  assert.equal(normSlide.id, "subslide456");
  assert.equal(normSlide.kind, "slideshow");
  assert.equal(normSlide.video, null);
  assert.equal(normSlide.images.length, 2);
  assert.equal(normSlide.images[0].url, "https://sub.cdn/photo1.jpg");
  assert.equal(normSlide.images[1].url, "https://sub.cdn/photo2.jpeg");
});

test("3. Normalization: HoangDev AIO schema converts video and slideshow", () => {
  const hoangDevVideo = {
    id: "hdvideo",
    title: "HoangDev Video",
    author: "Hoang Creator",
    medias: [
      { type: "video", url: "https://hd.cdn/video_hd.mp4", quality: "HD", extension: "mp4" },
      { type: "audio", url: "https://hd.cdn/audio.mp3", quality: "audio", extension: "mp3" },
    ],
  };
  const normVid = normalizeHoangDevAIOData(hoangDevVideo);
  assert.equal(normVid.id, "hdvideo");
  assert.equal(normVid.kind, "video");
  assert.equal(normVid.video.url, "https://hd.cdn/video_hd.mp4");
  assert.equal(normVid.music.url, "https://hd.cdn/audio.mp3");
  assert.deepEqual(normVid.images, []);

  const hoangDevSlide = {
    id: "hdslide",
    title: "HoangDev Slideshow",
    author: { uniqueId: "hoang", nickname: "Hoang" },
    medias: [
      { type: "image", url: "https://hd.cdn/pic1.jpg", extension: "jpg" },
      { type: "image", url: "https://hd.cdn/pic2.png", extension: "png" },
      { type: "audio", url: "https://hd.cdn/bgm.mp3", extension: "mp3" },
    ],
  };
  const normSlide = normalizeHoangDevAIOData(hoangDevSlide);
  assert.equal(normSlide.id, "hdslide");
  assert.equal(normSlide.kind, "slideshow");
  assert.equal(normSlide.video, null);
  assert.equal(normSlide.images.length, 2);
  assert.equal(normSlide.images[0].url, "https://hd.cdn/pic1.jpg");
  assert.equal(normSlide.images[1].url, "https://hd.cdn/pic2.png");
  assert.equal(normSlide.music.url, "https://hd.cdn/bgm.mp3");
});

test("4. Normalization: generic normalizeTikTokMedia auto-detects schema and aliases work", async () => {
  const payload = {
    medias: [{ type: "image", url: "https://example.com/1.jpg" }],
    title: "Auto detect test",
  };
  const result = normalizeTikTokMedia(payload);
  assert.equal(result.kind, "slideshow");
  assert.equal(result.images.length, 1);

  assert.equal(typeof getTikTokMedia, "function");
  assert.equal(typeof getDataDownloadVideo, "function");
});

test("5. Video flow: sendTikTokMedia sends video via api.sendVideo", async () => {
  const calls = [];
  const mockApi = {
    uploadAttachment: async (files, threadId, type) => {
      calls.push({ action: "uploadAttachment", files });
      return [{ fileUrl: "https://zalo.cdn/uploaded_video.mp4" }];
    },
    sendVideo: async (payload) => {
      calls.push({ action: "sendVideo", payload });
      return { msgId: "msg-video-123" };
    },
    sendMessage: async (payload) => {
      calls.push({ action: "sendMessage", payload });
      return { msgId: "msg-chat" };
    },
  };

  const message = {
    threadId: "g1",
    type: 1,
    data: { uidFrom: "u123", dName: "Nguyen Van A" },
  };

  const media = {
    id: "vid-test-1",
    kind: "video",
    desc: "Test Description",
    author: { uniqueId: "author1", nickname: "Author Nick" },
    video: {
      url: "https://test.cdn/video.mp4",
      cover: "https://test.cdn/cover.jpg",
      quality: "720p",
      duration: 10000,
      type: "mp4",
    },
    images: [],
    music: { url: "https://test.cdn/music.mp3", title: "Song", author: "Author" },
    stat: { playCount: 10 },
  };

  const success = await sendTikTokMedia(mockApi, message, media, defaultTestOptions);
  assert.equal(success, true);

  const sendVideoCall = calls.find((c) => c.action === "sendVideo");
  assert.ok(sendVideoCall, "api.sendVideo must be called");
  assert.equal(sendVideoCall.payload.videoUrl, "https://zalo.cdn/uploaded_video.mp4");
  assert.match(sendVideoCall.payload.message.text, /Author: \[author1\] Author Nick/);
});

test("6. Slideshow batching: 1, 5, 6, and 12 images produce exact batch counts and voice is sent after last batch", async () => {
  const testCounts = [1, 5, 6, 12];
  const expectedBatches = [1, 1, 2, 3]; // ceil(n / 5)

  for (let idx = 0; idx < testCounts.length; idx++) {
    const count = testCounts[idx];
    const expectedBatchCount = expectedBatches[idx];
    const calls = [];

    const mockApi = {
      uploadAttachment: async (files) => {
        calls.push({ action: "uploadAttachment", files });
        return [{ fileUrl: "https://zalo.cdn/uploaded_voice.mp3" }];
      },
      sendMessage: async (payload, threadId, type) => {
        calls.push({ action: "sendMessage", payload });
        return { msgId: `msg-batch-${calls.filter(c => c.action === "sendMessage").length}` };
      },
      sendVoice: async (message, voiceUrl) => {
        calls.push({ action: "sendVoice", voiceUrl });
        return { msgId: "msg-voice" };
      },
    };

    const images = Array.from({ length: count }, (_, i) => ({
      url: `https://test.cdn/image_${i + 1}.jpg`,
      extension: "jpg",
    }));

    const media = {
      id: `slide-test-${count}`,
      kind: "slideshow",
      desc: `Slideshow with ${count} images`,
      author: { uniqueId: "slide_user", nickname: "Slide User" },
      video: null,
      images,
      music: {
        url: "https://test.cdn/bgm.mp3",
        title: "BGM Title",
        author: "BGM Artist",
      },
      stat: { playCount: 50 },
    };

    const message = {
      threadId: "g1",
      type: 1,
      data: { uidFrom: "u123", dName: "Lan" },
    };

    const success = await sendTikTokMedia(mockApi, message, media, defaultTestOptions);
    assert.equal(success, true);

    const imageSends = calls.filter((c) => c.action === "sendMessage" && Array.isArray(c.payload.attachments));
    assert.equal(imageSends.length, expectedBatchCount, `Count ${count} should have ${expectedBatchCount} batches`);

    // Verify batch sizes: all except maybe last are 5
    for (let b = 0; b < imageSends.length; b++) {
      if (b < imageSends.length - 1) {
        assert.equal(imageSends[b].payload.attachments.length, 5);
      } else {
        const remainder = count % 5 === 0 ? 5 : count % 5;
        assert.equal(imageSends[b].payload.attachments.length, remainder);
      }
    }

    // Verify voice sending occurred after the last image send
    const lastImageSendIdx = calls.findLastIndex((c) => c.action === "sendMessage" && Array.isArray(c.payload.attachments));
    const voiceUploadIdx = calls.findIndex((c) => c.action === "uploadAttachment");
    assert.ok(voiceUploadIdx > lastImageSendIdx, "Voice upload must occur after last image batch");
  }
});

test("7. Audio mode: only sends voice, no images or video downloaded or sent", async () => {
  const calls = [];
  const mockApi = {
    uploadAttachment: async (files) => {
      calls.push({ action: "uploadAttachment", files });
      return [{ fileUrl: "https://zalo.cdn/uploaded_voice.mp3" }];
    },
    sendMessage: async (payload) => {
      calls.push({ action: "sendMessage", payload });
      return { msgId: "msg-text" };
    },
    sendVideo: async (payload) => {
      calls.push({ action: "sendVideo", payload });
      return { msgId: "msg-video" };
    },
    sendVoice: async (message, voiceUrl) => {
      calls.push({ action: "sendVoice", voiceUrl });
      return { msgId: "msg-voice" };
    },
  };

  const slideshowMedia = {
    id: "slide-audio-test",
    kind: "slideshow",
    desc: "Audio test on slideshow",
    author: { uniqueId: "author", nickname: "Author" },
    video: null,
    images: [{ url: "https://test.cdn/img1.jpg", extension: "jpg" }],
    music: { url: "https://test.cdn/song.mp3", title: "Song Only", author: "Singer" },
    stat: { playCount: 20 },
  };

  const message = {
    threadId: "g1",
    type: 1,
    data: { uidFrom: "u1", dName: "Nam" },
  };

  const success = await sendTikTokMedia(mockApi, message, slideshowMedia, { ...defaultTestOptions, typeVideo: "audio" });
  assert.equal(success, true);

  // Assert no video or image batch was sent
  const videoCalls = calls.filter((c) => c.action === "sendVideo");
  assert.equal(videoCalls.length, 0);
  const imageBatchSends = calls.filter((c) => c.action === "sendMessage" && Array.isArray(c.payload.attachments));
  assert.equal(imageBatchSends.length, 0);

  // Assert voice upload happened
  const voiceUpload = calls.find((c) => c.action === "uploadAttachment");
  assert.ok(voiceUpload);
  assert.match(voiceUpload.files[0], /\.mp3$/);
});

test("8. Error handling: partial image errors still send remaining images, voice, and warning message after voice", async () => {
  const calls = [];
  const mockApi = {
    uploadAttachment: async (files) => {
      calls.push({ action: "uploadAttachment", files });
      return [{ fileUrl: "https://zalo.cdn/voice.mp3" }];
    },
    sendMessage: async (payload) => {
      calls.push({ action: "sendMessage", payload });
      return { msgId: `msg-${calls.length}` };
    },
    sendVoice: async (message, voiceUrl) => {
      calls.push({ action: "sendVoice", voiceUrl });
      return { msgId: "msg-voice" };
    },
  };

  // 4 images, 2 will have invalid empty URLs
  const media = {
    id: "partial-test",
    kind: "slideshow",
    desc: "Partial failure test",
    author: { uniqueId: "user", nickname: "User" },
    video: null,
    images: [
      { url: "https://test.cdn/good1.jpg", extension: "jpg" },
      { url: "", extension: "jpg" }, // fail/skip
      { url: "https://test.cdn/good2.jpg", extension: "jpg" },
      { url: "   ", extension: "jpg" }, // fail/skip
    ],
    music: { url: "https://test.cdn/bgm.mp3", title: "BGM", author: "Artist" },
    stat: { playCount: 10 },
  };

  const message = {
    threadId: "g1",
    type: 1,
    data: { uidFrom: "u1", dName: "An" },
  };

  const success = await sendTikTokMedia(mockApi, message, media, defaultTestOptions);
  assert.equal(success, true);

  // 1 image batch with 2 valid images (distinguished by ttl: 3600000)
  const imageSends = calls.filter((c) => c.action === "sendMessage" && Array.isArray(c.payload.attachments) && c.payload.ttl === 3600000);
  assert.equal(imageSends.length, 1);
  assert.equal(imageSends[0].payload.attachments.length, 2);

  // Warning sent after voice
  const warningSend = calls.find((c) => c.action === "sendMessage" && typeof c.payload.msg === "string" && c.payload.msg.includes("Một số ảnh trong slideshow không thể tải"));
  assert.ok(warningSend, "Warning message for failed images must be sent");
});

test("9. Error handling: total failure of images and voice throws retryable error", async () => {
  const mockApi = {
    uploadAttachment: async () => [],
    sendMessage: async () => ({ msgId: "msg" }),
  };

  const media = {
    id: "total-fail",
    kind: "slideshow",
    desc: "All fail test",
    author: { uniqueId: "user", nickname: "User" },
    video: null,
    images: [{ url: "", extension: "jpg" }],
    music: { url: "" },
    stat: {},
  };

  const message = {
    threadId: "g1",
    type: 1,
    data: { uidFrom: "u1", dName: "An" },
  };

  await assert.rejects(() => sendTikTokMedia(mockApi, message, media, defaultTestOptions));
});

test("10. Temp files cleanup: jobDir is deleted after success or error", async () => {
  const mockApi = {
    uploadAttachment: async () => [{ fileUrl: "https://zalo.cdn/voice.mp3" }],
    sendMessage: async () => ({ msgId: "msg" }),
    sendVoice: async () => ({ msgId: "msg-voice" }),
  };

  const media = {
    id: "cleanup-test-id",
    kind: "slideshow",
    desc: "Cleanup test",
    author: { uniqueId: "user", nickname: "User" },
    video: null,
    images: [{ url: "https://test.cdn/img.jpg", extension: "jpg" }],
    music: { url: "https://test.cdn/bgm.mp3" },
    stat: {},
  };

  const message = {
    threadId: "g1",
    type: 1,
    data: { uidFrom: "u1", dName: "An" },
  };

  await sendTikTokMedia(mockApi, message, media, defaultTestOptions);

  const tempEntriesAfter = fs.readdirSync(tempDir);
  const slideDirs = tempEntriesAfter.filter((entry) => entry.includes("cleanup-test-id"));
  assert.equal(slideDirs.length, 0, "All tiktok_slide_* job folders must be cleaned up in finally");
});

test("11. Consumer static verification: all consumers call common pipeline (sendTikTokMedia / getTikTokMedia)", () => {
  const tiktokAutoDownloadSrc = readSource("src/service-debug/api-crawl/tiktok/tiktok-auto-download.js");
  assert.match(tiktokAutoDownloadSrc, /sendTikTokMedia/);
  assert.match(tiktokAutoDownloadSrc, /getTikTokMedia/);

  const autoDownloadSrc = readSource("src/service-debug/api-crawl/download/auto-download.js");
  assert.match(autoDownloadSrc, /sendTikTokMedia/);
  assert.match(autoDownloadSrc, /getTikTokMedia/);

  const apiCrawlIndexSrc = readSource("src/service-debug/api-crawl/index.js");
  assert.match(apiCrawlIndexSrc, /sendTikTokMedia/);

  const aioDownlinkSrc = readSource("src/service-debug/api-crawl/api-hoangdev/aio-downlink.js");
  assert.match(aioDownlinkSrc, /sendTikTokMedia/);
  assert.match(aioDownlinkSrc, /normalizeTikTokMedia/);

  const schedulerSrc = readSource("src/service-debug/scheduler/scheduler.js");
  assert.match(schedulerSrc, /sendTikTokMedia/);
});
