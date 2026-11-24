import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { categoryDownload } from '../src/service-debug/api-crawl/api-hoangdev/aio-downlink.js';
import { setLocalVideoMediaPreparer } from '../src/service-debug/chat-zalo/chat-special/send-video/send-video.js';

test('AIO declared audio in webm keeps audio upload and never enters video preparation', async t => {
  const server = http.createServer((_req, res) => res.end('audio fixture'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { setLocalVideoMediaPreparer(null); server.close(); });
  let videoPrepares = 0;
  setLocalVideoMediaPreparer(async () => { videoPrepares++; throw new Error('not a video'); });
  const result = await categoryDownload({ uploadAttachment: async () => [{ fileUrl: 'https://cdn.test/audio' }] },
    { threadId: 'g', type: 1 }, 'instagram', 'audio-fixture',
    { type: 'audio', extension: 'webm', url: `http://127.0.0.1:${server.address().port}/audio` }, 'audio');
  assert.equal(videoPrepares, 0);
  assert.equal(result.videoUrl, 'https://cdn.test/audio');
  await fs.unlink(result.tempFilePath);
});
