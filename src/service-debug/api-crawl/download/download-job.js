import { randomUUID } from 'node:crypto';

// Log only allowlisted fields. Never serialize provider errors, request URLs or headers.
export function logDownloadEvent(event) {
  console.info('[download]', JSON.stringify(event));
}

export function downloadErrorCode(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) return 'AUTH';
  if (Number.isInteger(status)) return `HTTP_${status}`;
  const code = error?.code ?? error?.error_code;
  return /^[A-Z0-9_]{1,40}$/.test(String(code ?? '')) ? code : 'PROVIDER_ERROR';
}

export function createDownloadJob(source, log = logDownloadEvent) {
  let mediaStarted = false;
  const job = {
    id: randomUUID(), source, stage: 'receive',
    event(stage, status, error) {
      log({ jobId: job.id, source: job.source, stage, status, ...(error ? { code: downloadErrorCode(error) } : {}) });
    },
    async run(stage, action) {
      job.stage = stage;
      job.event(stage, 'start');
      try {
        const result = await action();
        job.event(stage, 'ok');
        return result;
      } catch (error) {
        job.event(stage, 'failed', error);
        throw error;
      }
    },
    canFallback: () => !mediaStarted,
    wrapApi(api) {
      return new Proxy(api, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args) => {
            const stage = key === 'uploadAttachment' ? 'upload'
              : ['sendVideo', 'sendVoice', 'sendFile'].includes(key) || (key === 'sendMessage' && args[0]?.attachments?.length) ? 'send' : null;
            if (!stage) return value.apply(target, args);
            mediaStarted = true; // Set BEFORE awaiting: a timeout may already have reached Zalo.
            return job.run(stage, () => value.apply(target, args));
          };
        },
      });
    },
  };
  job.event('receive', 'ok');
  return job;
}

export async function tryDownloadProviders(url, providers, log = logDownloadEvent, jobId = randomUUID()) {
  for (const [source, fetch] of providers) {
    try {
      const media = await fetch(url);
      if (!media?.video?.url && !media?.images?.some(image => image?.url)) {
        throw Object.assign(new Error('Empty provider response'), { code: 'INVALID_RESPONSE' });
      }
      log({ jobId, source, stage: 'source', status: 'ok' });
      return media;
    } catch (error) {
      log({ jobId, source, stage: 'source', status: 'failed', code: downloadErrorCode(error) });
    }
  }
  return null;
}

export function downloadFailureCaption(source, stage, error) {
  if (stage === 'upload') return 'Tải lên media Zalo thất bại. Vui lòng thử lại sau.';
  if (stage === 'send') return 'Không thể gửi media qua Zalo. Vui lòng thử lại sau.';
  const code = downloadErrorCode(error);
  if (code === 'MISSING_DEPENDENCY') return `Nguồn ${source} chưa được cấu hình khóa API.`;
  if (code === 'AUTH') return `Nguồn ${source} từ chối xác thực hoặc quyền truy cập.`;
  if (['ETIMEDOUT', 'ECONNABORTED', 'TIMEOUT'].includes(code)) return `Nguồn ${source} phản hồi quá thời gian cho phép.`;
  return `Không thể tải media từ ${source} (${code}). Vui lòng thử lại sau.`;
}

export async function runPlatformDownload(api, message, url, platform, options = {}) {
  if (platform === 'youtube') {
    const { handleYouTubeAutoDownload } = await import('./youtube-autodownload.js');
    return handleYouTubeAutoDownload(api, message, url, message.data?.uidFrom, message.data?.dName, options);
  }
  const job = createDownloadJob('tiktok', options.log);
  const sendWarning = options.sendWarning || (async caption => api.sendMessage({ msg: caption, quote: message, ttl: 30000 }, message.threadId, message.type));
  try {
    const fetch = options.getTikTokMedia || (await import('../tiktok/tiktok-api.js')).getTikTokMedia;
    const send = options.sendTikTokMedia || (await import('../tiktok/tiktok-service.js')).sendTikTokMedia;
    const media = await job.run('source', () => fetch(url));
    if (!media) throw Object.assign(new Error('All TikTok sources failed'), { code: 'SOURCE_EXHAUSTED' });
    job.stage = 'download';
    return await send(job.wrapApi(api), message, media, { job, typeVideo: options.typeVideo === 'audio' ? 'audio' : media.video?.quality || '540p' });
  } catch (error) {
    if (['upload', 'send'].includes(error?.stage)) job.stage = error.stage;
    job.event(job.stage, 'failed', error);
    try { await sendWarning(downloadFailureCaption('TikTok', job.stage, error)); }
    catch (warningError) { job.event('warning', 'failed', warningError); }
    return false;
  }
}
