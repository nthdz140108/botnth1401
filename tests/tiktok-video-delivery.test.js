import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendTikTokMedia } from '../src/service-debug/api-crawl/tiktok/tiktok-service.js';
import { runPlatformDownload } from '../src/service-debug/api-crawl/download/download-job.js';
import { prepareVideoFixture } from './helpers/prepared-video-fixture.js';

test('old cache misses, 114 ends once without cache, and next job succeeds with full metadata', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sends = 0, uploads = 0, downloads = 0, cacheWrites = 0, warnings = 0;
  const events = [];
  const media = { id: '123', author: {}, video: { url: 'https://source.test/video' } };
  const message = { threadId: 'g', type: 1, data: { uidFrom: 'u', dName: 'User' } };
  const opts = { isRandom: true, prepareMedia: prepareVideoFixture,
    getCachedMedia: async () => ({ fileUrl: 'https://old.test/video', duration: 12 }),
    getTiktokRelated: async () => [],
    downloadVideoTiktok: async () => { const file = path.join(dir, `clip${++downloads}.mp4`); fs.writeFileSync(file, 'fixture'); return file; },
    setCacheData: async (_p, _id, cache) => { cacheWrites++; assert.equal(sends, 2); assert.equal(cache.duration, 400); assert.equal(cache.height, 1280); },
  };
  const api = { uploadAttachment: async files => { uploads++; assert.ok(fs.existsSync(files[0])); return [{ fileUrl: `https://zalo.test/${uploads}` }]; },
    sendVideo: async payload => { sends++; assert.equal(payload.fileSize, 7); assert.equal(payload.duration, 400); if (sends === 1) throw Object.assign(new Error('https://signed.test/?apikey=secret'), { code: 114 }); return { msgId: 'sent' }; } };
  const run = () => runPlatformDownload(api, message, 'https://vt.tiktok.com/abc', 'tiktok', {
    log: e => events.push(e), getTikTokMedia: async () => media,
    sendTikTokMedia: (a, m, v, jobOptions) => sendTikTokMedia(a, m, v, { ...jobOptions, ...opts }),
    sendWarning: async () => { warnings++; },
  });
  assert.equal(await run(), false);
  assert.equal(cacheWrites, 0); assert.equal(sends, 1); assert.equal(uploads, 2); assert.equal(warnings, 1);
  assert.equal(await run(), true);
  assert.equal(cacheWrites, 1); assert.equal(downloads, 2); assert.equal(sends, 2);
  assert.ok(events.some(e => e.stage === 'send' && e.code === 114));
  assert.ok(!JSON.stringify(events).includes('secret'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('complete video cache sends full payload without downloading or uploading', async () => {
  const cache = { fileUrl: 'https://cdn.test/video', thumbnail: 'https://cdn.test/thumb', duration: 400, width: 720, height: 1280, fileSize: 7 };
  let sends = 0;
  await sendTikTokMedia({ uploadAttachment: async () => assert.fail('cache must avoid upload'), sendVideo: async p => { sends++; assert.equal(p.height, 1280); return { msgId: 'sent' }; } },
    { threadId: 'g', type: 1, data: {} }, { id: '123', author: {}, video: {} }, {
      isRandom: true, getCachedMedia: async () => cache, setCacheData: async () => {}, getTiktokRelated: async () => [],
      downloadVideoTiktok: async () => assert.fail('cache must avoid download'),
    });
  assert.equal(sends, 1);
});
