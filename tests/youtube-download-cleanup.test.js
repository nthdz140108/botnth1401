import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as youtube from '../src/service-debug/api-crawl/youtube/youtube-core.js';

test('failed YouTube merge removes all component files and keeps unrelated media', async () => {
  assert.equal(typeof youtube.withYoutubeDownloadDirectory, 'function');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-cleanup-test-'));
  try {
    await fs.writeFile(path.join(dir, 'unrelated.mp4'), 'keep');
    await assert.rejects(() => youtube.withYoutubeDownloadDirectory(path.join(dir, 'movie.mp4'), async output => {
      await fs.writeFile(`${output}.f136.mp4.part`, 'partial video');
      await fs.writeFile(`${output}.f140.m4a`, 'audio');
      throw new Error('merge failed');
    }), /merge failed/);
    assert.deepEqual(await fs.readdir(dir), ['unrelated.mp4']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('completed YouTube download moves only final media out of its workspace', async () => {
  assert.equal(typeof youtube.withYoutubeDownloadDirectory, 'function');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-cleanup-test-'));
  try {
    const target = path.join(dir, 'movie.mp4');
    await youtube.withYoutubeDownloadDirectory(target, async output => {
      await fs.writeFile(output, 'video+audio');
      await fs.writeFile(`${output}.f140.m4a`, 'unused component');
    });
    assert.equal(await fs.readFile(target, 'utf8'), 'video+audio');
    assert.deepEqual(await fs.readdir(dir), ['movie.mp4']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
