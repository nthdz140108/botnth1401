import test from "node:test";
import assert from "node:assert/strict";

import { searchTikTokByKeyword } from "../src/service-debug/api-crawl/tiktok/tiktok-api.js";

test("TikTok keyword search retries a transient network failure", async () => {
  const previousUrl = process.env.TIKTOK_SEARCH_API_URL;
  const previousKey = process.env.TIKTOK_SEARCH_API_KEY;
  process.env.TIKTOK_SEARCH_API_URL = "https://tiktok-api6.p.rapidapi.com/search/general/query";
  process.env.TIKTOK_SEARCH_API_KEY = "test-key";

  let attempts = 0;
  const client = {
    async post() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("connect failed");
        error.code = "ECONNRESET";
        throw error;
      }
      return {
        data: {
          videos: [{
            video_id: "video-1",
            description: "Mr Beast",
            author: "mrbeast",
            download_url: "https://cdn.example/video.mp4",
            cover: "https://cdn.example/cover.jpg",
          }],
        },
      };
    },
  };

  try {
    const results = await searchTikTokByKeyword("mr beast", 10, client);
    assert.equal(attempts, 2);
    assert.equal(results[0].id, "video-1");
  } finally {
    if (previousUrl === undefined) delete process.env.TIKTOK_SEARCH_API_URL;
    else process.env.TIKTOK_SEARCH_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.TIKTOK_SEARCH_API_KEY;
    else process.env.TIKTOK_SEARCH_API_KEY = previousKey;
  }
});
