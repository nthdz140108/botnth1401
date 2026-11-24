import fs from 'node:fs/promises';
import { getLocalVideoMediaPreparer } from '../../chat-zalo/chat-special/send-video/send-video.js';
import { createDownloadJob } from './download-job.js';

const validUrl = value => typeof value === 'string' && /^https?:\/\//i.test(value);
export function isCompleteVideoCache(cache) {
  return Boolean(validUrl(cache?.fileUrl) && validUrl(cache?.thumbnail) &&
    ['duration', 'width', 'height', 'fileSize'].every(key => Number.isFinite(cache[key]) && cache[key] > 0));
}
function uploadedUrl(result) {
  const first = Array.isArray(result) ? result[0] : result;
  const url = [first?.fileUrl, first?.hdUrl, first?.normalUrl, first?.thumbUrl].find(validUrl);
  if (!url) throw Object.assign(new Error('Invalid upload receipt'), { code: 'INVALID_UPLOAD', stage: 'upload' });
  return url;
}
export async function uploadPreparedVideo(api, message, filePath, options = {}) {
  const job = options.job || createDownloadJob('video');
  const prepare = options.prepareMedia || getLocalVideoMediaPreparer();
  const remove = options.removeFile || (file => fs.unlink(file).catch(() => {}));
  let prepared;
  try {
    prepared = await job.run('prepare', () => prepare(filePath, { normalize: true }));
    const fileUrl = await job.run('upload', async () => uploadedUrl(await api.uploadAttachment([prepared.filePath], message.threadId, message.type)));
    const thumbnail = await job.run('upload', async () => uploadedUrl(await api.uploadAttachment([prepared.thumbnailPath], message.threadId, message.type)));
    return { fileUrl, thumbnail, ...prepared.metadata };
  } catch (error) {
    error.stage = job.stage;
    throw error;
  } finally {
    if (prepared?.thumbnailPath) await remove(prepared.thumbnailPath);
    if (prepared?.filePath && prepared.filePath !== filePath) await remove(prepared.filePath);
  }
}
export function videoPayload(cache) {
  if (!isCompleteVideoCache(cache)) throw Object.assign(new Error('Incomplete video payload'), { code: 'INVALID_VIDEO_METADATA', stage: 'prepare' });
  const { thumbnail, duration, width, height, fileSize } = cache;
  return { videoUrl: cache.fileUrl, thumbnail, duration, width, height, fileSize, videoAlreadyUploaded: true };
}
