#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadProviderEnvironment } from '../src/bootstrap.js';
import dotenv from 'dotenv';

// No Zalo login or sending. Reproduce extraction, worker download and FFmpeg output.
const args = process.argv.slice(2);
// Legacy config discovery interprets argv[2] as a bot ID.
process.argv = process.argv.slice(0, 2);
const envFileIndex = args.indexOf('--env-file');
if (envFileIndex !== -1) dotenv.config({ path: args[envFileIndex + 1], quiet: true });
loadProviderEnvironment();
const { runYoutubeVideoInfo, runYoutubeDownload, YOUTUBE_FORMAT_720, YOUTUBE_AUDIO_FORMAT, classifyYoutubeError } = await import('../src/service-debug/api-crawl/youtube/youtube-core.js');
const { resolveYoutubeDenoBinary } = await import('../src/service-debug/api-crawl/youtube/youtube-runtime.js');
const { getYoutubeAuthOptions } = await import('../src/service-debug/api-crawl/youtube/youtube-auth.js');
let stage = 'runtime';
let dir;
try {
  const input = new URL(args[0]);
  const id = input.hostname === 'youtu.be' ? input.pathname.slice(1) : input.searchParams.get('v') || input.pathname.split('/').at(-1);
  if (!/^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/.test(input.hostname) || !/^[\w-]{11}$/.test(id || '')) throw new Error('Expected a public YouTube video URL');
  const url = `https://www.youtube.com/watch?v=${id}`;
  const denoVersion = execFileSync(resolveYoutubeDenoBinary(), ['--version'], { encoding: 'utf8' }).split('\n')[0];
  console.log(JSON.stringify({ stage, denoVersion, nodeVersion: process.version }));
  stage = 'auth';
  const auth = getYoutubeAuthOptions();
  if (auth.cookies) await fs.access(auth.cookies, fs.constants.R_OK);
  console.log(JSON.stringify({ stage, cookieConfigured: Boolean(auth.cookies || auth.cookiesFromBrowser), cookieReadable: Boolean(auth.cookies) }));
  stage = 'metadata';
  const info = await runYoutubeVideoInfo(url, 90000);
  console.log(JSON.stringify({ stage, status: 'ok', videoId: info.videoId, duration: info.duration }));
  if (args.includes('--download')) {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mybot-download-check-'));
    for (const [kind, format, extension] of [['video', YOUTUBE_FORMAT_720, 'mp4'], ['audio', YOUTUBE_AUDIO_FORMAT, 'm4a']]) {
      stage = `download-${kind}`;
      const output = path.join(dir, `sample.${extension}`);
      await runYoutubeDownload(url, output, format);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', output], { encoding: 'utf8' }));
      const streams = probe.streams.map(s => s.codec_type);
      if (!streams.includes('audio') || (kind === 'video' && !streams.includes('video'))) throw new Error('Downloaded file lacks expected streams');
      console.log(JSON.stringify({ stage, status: 'ok', bytes: (await fs.stat(output)).size, streams: probe.streams }));
    }
  }
} catch (error) {
  const reason = String(error?.cause?.message || error.message).split('ERROR:').at(-1)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/--cookies\s+\S+/g, '--cookies [redacted]')
    .replace(/[\r\n]+/g, ' ').slice(0, 500);
  console.error(JSON.stringify({ stage, status: 'failed', kind: classifyYoutubeError(error), reason }));
  if (dir) console.error(JSON.stringify({ stage: 'artifacts', files: await fs.readdir(dir) }));
  process.exitCode = 1;
} finally {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
}
