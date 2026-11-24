import test from 'node:test';
import assert from 'node:assert/strict';
import { commandRegistry } from '../src/commands/command-registry.js';
import * as runtime from '../src/service-debug/api-crawl/youtube/youtube-runtime.js';
import { YOUTUBE_FORMAT_720, YOUTUBE_AUDIO_FORMAT } from '../src/service-debug/api-crawl/youtube/youtube-core.js';
import { searchTikTokByKeyword } from '../src/service-debug/api-crawl/tiktok/tiktok-api.js';

test('TikTok links and download reach handlers without search or HoangDev keys', () => {
  const registry = commandRegistry;
  for (const name of ['tiktok', 'download']) {
    assert.deepEqual(registry.lookup.get(name)[0].requiredConfig, []);
  }
});

test('YouTube uses Deno while the bot keeps its Node runtime', () => {
  assert.equal(runtime.getYoutubeRuntimeOptions({ binaryPath: process.execPath }).jsRuntimes, `deno:${process.execPath}`);
});

test('TikTok keyword search still reports missing search configuration before contacting providers', async () => {
  const previous = [process.env.TIKTOK_SEARCH_API_URL, process.env.TIKTOK_SEARCH_API_KEY];
  delete process.env.TIKTOK_SEARCH_API_URL;
  delete process.env.TIKTOK_SEARCH_API_KEY;
  try {
    await assert.rejects(() => searchTikTokByKeyword('music', 10, { get: () => assert.fail('must not make a request') }), { code: 'MISSING_DEPENDENCY' });
  } finally {
    for (const [index, key] of ['TIKTOK_SEARCH_API_URL', 'TIKTOK_SEARCH_API_KEY'].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});

test('a video selector containing bestaudio still downloads video and merges MP4', () => {
  assert.equal(typeof runtime.buildYoutubeDownloadOptions, 'function');
  const options = runtime.buildYoutubeDownloadOptions('movie.mp4', YOUTUBE_FORMAT_720, { runtime: { binaryPath: process.execPath }, env: {} });
  assert.equal(options.format, YOUTUBE_FORMAT_720);
  assert.equal(options.mergeOutputFormat, 'mp4');
  assert.equal(options.extractAudio, undefined);
});

test('audio selection extracts the requested M4A file through FFmpeg', () => {
  assert.equal(typeof runtime.buildYoutubeDownloadOptions, 'function');
  const options = runtime.buildYoutubeDownloadOptions('music.m4a', YOUTUBE_AUDIO_FORMAT, { runtime: { binaryPath: process.execPath }, env: {} });
  assert.equal(options.extractAudio, true);
  assert.equal(options.audioFormat, 'm4a');
  assert.equal(options.mergeOutputFormat, undefined);
});
