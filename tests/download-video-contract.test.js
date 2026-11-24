import test from 'node:test';
import assert from 'node:assert/strict';
const media = await import('../src/service-debug/api-crawl/download/video-delivery.js').catch(() => ({}));
test('video preparation uploads video and JPEG and returns measured payload', async () => {
  assert.equal(typeof media.uploadPreparedVideo, 'function');
  const removed = [], uploaded = [];
  const result = await media.uploadPreparedVideo({ uploadAttachment: async files => {
    uploaded.push(files[0]); return [{ fileUrl: `https://cdn.test/${files[0]}` }];
  } }, { threadId: 'g', type: 1 }, 'input.mp4', {
    prepareMedia: async () => ({ filePath: 'input.mp4', thumbnailPath: 'frame.jpg', metadata: { duration: 280, width: 720, height: 1280, fileSize: 12345 } }),
    removeFile: async file => removed.push(file),
  });
  assert.deepEqual(uploaded, ['input.mp4', 'frame.jpg']);
  assert.deepEqual(removed, ['frame.jpg']);
  assert.equal(result.duration, 280);
  assert.equal(result.height, 1280);
  assert.equal(result.thumbnail, 'https://cdn.test/frame.jpg');
  assert.equal(media.isCompleteVideoCache(result), true);
  assert.equal(media.isCompleteVideoCache({ fileUrl: result.fileUrl, duration: 10 }), false);
});
test('thumbnail upload failure cleans prepared files and preserves Zalo code', async () => {
  assert.equal(typeof media.uploadPreparedVideo, 'function');
  let uploads = 0; const removed = [];
  await assert.rejects(() => media.uploadPreparedVideo({ uploadAttachment: async () => {
    if (++uploads === 2) throw Object.assign(new Error('secret signed URL'), { code: 114 });
    return [{ fileUrl: 'https://cdn.test/video' }];
  } }, { threadId: 'g', type: 1 }, 'source.webm', {
    prepareMedia: async () => ({ filePath: 'converted.mp4', thumbnailPath: 'frame.jpg', metadata: { duration: 200, width: 10, height: 20, fileSize: 80 } }),
    removeFile: async f => removed.push(f),
  }), { code: 114, stage: 'upload' });
  assert.deepEqual(removed.sort(), ['converted.mp4', 'frame.jpg']);
});
