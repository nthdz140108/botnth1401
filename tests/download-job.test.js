import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = '../src/service-debug/api-crawl/download/download-job.js';
const load = () => import(moduleUrl).catch(() => ({}));

test('provider chain records each failed source and stops at the first valid media', async () => {
  const { tryDownloadProviders } = await load();
  assert.equal(typeof tryDownloadProviders, 'function');
  const events = [];
  const result = await tryDownloadProviders('https://vt.tiktok.com/abc', [
    ['primary', async () => { throw Object.assign(new Error('cookie=secret https://host/?apikey=secret'), { code: 'ETIMEDOUT' }); }],
    ['empty', async () => null],
    ['backup', async () => ({ video: { url: 'https://cdn/video.mp4' } })],
    ['unused', async () => assert.fail('must stop')],
  ], e => events.push(e));
  assert.ok(result.video.url);
  assert.deepEqual(events.map(e => e.source), ['primary', 'empty', 'backup']);
  assert.equal(events[0].code, 'ETIMEDOUT');
  assert.equal(JSON.stringify(events).includes('secret'), false);
});

for (const method of ['uploadAttachment', 'sendVideo', 'sendVoice', 'sendMessage']) {
  test(`a failed ${method} media attempt prohibits fallback`, async () => {
    const { createDownloadJob } = await load();
    assert.equal(typeof createDownloadJob, 'function');
    const job = createDownloadJob('hoangdev', () => {});
    const api = job.wrapApi({ [method]: async () => { throw new Error('failed'); } });
    await assert.rejects(() => api[method](method === 'sendMessage' ? { attachments: ['image.jpg'] } : []));
    assert.equal(job.canFallback(), false);
    assert.equal(job.stage, method === 'uploadAttachment' ? 'upload' : 'send');
  });
}

test('progress text is not treated as an attempted media send', async () => {
  const { createDownloadJob } = await load();
  assert.equal(typeof createDownloadJob, 'function');
  const job = createDownloadJob('hoangdev', () => {});
  await job.wrapApi({ sendMessage: async () => {} }).sendMessage({ msg: 'Loading' });
  assert.equal(job.canFallback(), true);
});

test('all TikTok sources failing sends one warning and the next link still works', async () => {
  const { runPlatformDownload } = await load();
  assert.equal(typeof runPlatformDownload, 'function');
  const warnings = [], sent = [];
  const options = {
    log: () => {},
    getTikTokMedia: async () => null,
    sendTikTokMedia: async (_api, _message, media) => { sent.push(media); return true; },
    sendWarning: async caption => warnings.push(caption),
  };
  assert.equal(await runPlatformDownload({}, {}, 'https://vt.tiktok.com/abc', 'tiktok', options), false);
  assert.equal(warnings.length, 1);
  assert.equal(sent.length, 0);
  options.getTikTokMedia = async () => ({ kind: 'video', video: { url: 'https://cdn/video.mp4' } });
  assert.equal(await runPlatformDownload({}, {}, 'https://vt.tiktok.com/next', 'tiktok', options), true);
  assert.equal(warnings.length, 1);
  assert.equal(sent.length, 1);
});

test('TikTok upload error sends one upload warning without retrying sources', async () => {
  const { runPlatformDownload } = await load();
  assert.equal(typeof runPlatformDownload, 'function');
  let fetches = 0;
  const warnings = [];
  const api = { uploadAttachment: async () => { throw new Error('upload failed'); } };
  const ok = await runPlatformDownload(api, {}, 'https://vt.tiktok.com/abc', 'tiktok', {
    log: () => {},
    getTikTokMedia: async () => { fetches++; return { video: { url: 'cdn' } }; },
    sendTikTokMedia: async wrapped => wrapped.uploadAttachment(['file']),
    sendWarning: async caption => warnings.push(caption),
  });
  assert.equal(ok, false);
  assert.equal(fetches, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Tải lên/);
});
