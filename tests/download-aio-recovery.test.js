import { prepareVideoFixture } from "./helpers/prepared-video-fixture.js";
import { setLocalVideoMediaPreparer } from "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js";
setLocalVideoMediaPreparer(prepareVideoFixture);
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { handleDownloadCommand } from '../src/service-debug/api-crawl/api-hoangdev/aio-downlink.js';
import { handleDownloadZalo } from '../src/service-debug/api-crawl/download/auto-download.js';
import { getGlobalPrefix } from '../src/service-debug/service.js';
import { getSelectionsMapData, releaseSelectionsMapData } from '../src/service-debug/api-crawl/index.js';
import { clearAllInteractionCountdowns } from '../src/utils/interaction-countdown.js';

const messageFor = url => ({ threadId: 'test-download-room', type: 1, data: { uidFrom: 'test-download-user', dName: 'Test', content: `${getGlobalPrefix()}download ${url}` } });

for (const url of ['https://youtube.com/watch?v=MR6zUAk6ayk', 'https://youtube.com/shorts/MR6zUAk6ayk', 'https://vt.tiktok.com/abc/']) {
  test(`download falls back before upload for ${new URL(url).hostname}${new URL(url).pathname}`, async () => {
    let fallbacks = 0;
    const api = { sendMessage: async () => assert.fail('primary must not warn before fallback') };
    await handleDownloadCommand(api, messageFor(url), 'download', {
      getDataDownloadVideo: async () => { throw Object.assign(new Error('missing key'), { code: 'MISSING_DEPENDENCY' }); },
      runPlatformDownload: async (_api, _message, link, platform) => { fallbacks++; assert.equal(link, url); assert.ok(['youtube', 'tiktok'].includes(platform)); return true; },
    });
    assert.equal(fallbacks, 1);
  });
}

for (const url of ['https://facebook.com/watch/?v=123', 'https://instagram.com/reel/abc/', 'https://www.capcut.com/template-detail/abc']) {
  test(`AIO failure reports once and preserves routing for ${new URL(url).hostname}`, async () => {
    const sent = [];
    await handleDownloadCommand({ sendMessage: async payload => { sent.push(payload); return { msgId: 'warn' }; } }, messageFor(url), 'download', {
      getDataDownloadVideo: async () => { throw Object.assign(new Error('Unauthorized URL?apikey=secret'), { response: { status: 403 } }); },
      runPlatformDownload: async () => assert.fail('AIO platforms must retain their source'),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].msg, /xác thực/);
    assert.equal(JSON.stringify(sent).includes('apikey=secret'), false);
  });
}

test('valid HoangDev YouTube formats retain their quality selection menu', async () => {
  const sent = [];
  const api = { sendMessage: async payload => { sent.push(payload); return { msgId: 'quality-menu' }; } };
  try {
    await handleDownloadCommand(api, messageFor('https://youtube.com/watch?v=MR6zUAk6ayk'), 'download', {
      getDataDownloadVideo: async () => ({ url: 'https://youtube.com/watch?v=MR6zUAk6ayk', title: 'Sample', medias: [
        { url: 'https://cdn/video1.mp4', type: 'video', quality: '360p', extension: 'mp4' },
        { url: 'https://cdn/video2.mp4', type: 'video', quality: '720p', extension: 'mp4' },
      ] }),
      runPlatformDownload: async () => assert.fail('valid source must retain its menu'),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].msg, /360p/);
    assert.match(sent[0].msg, /720p/);
  } finally {
    const record = getSelectionsMapData().get('test-download-user');
    if (record) await releaseSelectionsMapData('test-download-user', { recallPrompt: false });
    clearAllInteractionCountdowns();
  }
});

test('a group with autodownload disabled does not contact any provider or send media', async () => {
  const message = { threadId: 'disabled-room', type: 1, body: 'https://vt.tiktok.com/abc/', data: { uidFrom: 'user', content: 'https://vt.tiktok.com/abc/' } };
  const api = new Proxy({}, { get: () => () => assert.fail('disabled group must stay idle') });
  assert.equal(await handleDownloadZalo(api, message, { 'disabled-room': { enableDownload: false } }, false), false);
});

for (const failsAt of ['download', 'upload']) {
  test(`AIO TikTok ${failsAt} failure uses the correct fallback boundary and cleans files`, async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(failsAt === 'download' ? 503 : 200, { 'Content-Type': 'video/mp4' });
      response.end('fixture-video');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const sent = [];
    let fallbacks = 0, uploads = 0, uploadedPath;
    const api = {
      sendMessage: async payload => { sent.push(payload); return { msgId: String(sent.length), cliMsgId: String(sent.length) }; },
      undoMessage: async () => true,
      uploadAttachment: async files => { uploads++; uploadedPath = files[0]; assert.equal(fs.existsSync(uploadedPath), true); throw new Error('upload rejected'); },
      sendVideo: async () => assert.fail('failed upload must not send'),
    };
    try {
      await handleDownloadCommand(api, messageFor('https://vt.tiktok.com/abc/'), 'download', {
        getDataDownloadVideo: async () => ({ title: 'Fixture', medias: [{ type: 'video', quality: 'HD', extension: 'mp4', url: `http://127.0.0.1:${server.address().port}/video.mp4` }] }),
        runPlatformDownload: async () => { fallbacks++; return true; },
      });
      assert.equal(fallbacks, failsAt === 'download' ? 1 : 0);
      assert.equal(uploads, failsAt === 'upload' ? 1 : 0);
      const errors = sent.filter(payload => payload.msg?.includes('Tải lên media Zalo thất bại'));
      assert.equal(errors.length, failsAt === 'upload' ? 1 : 0);
      if (uploadedPath) assert.equal(fs.existsSync(uploadedPath), false);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
