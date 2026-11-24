import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDownloadZalo } from '../src/service-debug/api-crawl/download/auto-download.js';
import { rememberOutboundMessage } from '../src/api-zalo/outbound-message-registry.js';
import { getGlobalPrefix } from '../src/service-debug/service.js';

test('self/member text and href previews each create one job; disabled, echo and commands create none', async () => {
  const jobs = [];
  const dependencies = { handleReply: async () => false, handleLegacyReply: async () => false,
    sendReaction: async () => {}, runPlatformDownload: async (...args) => { jobs.push(args[2]); return true; } };
  const api = { sendMessage: async () => assert.fail('unexpected warning') };
  const settings = { g: { enableDownload: true } };
  const link = 'https://vt.tiktok.com/abc/';
  for (const self of [true, false]) for (const preview of [true, false]) {
    const message = { threadId: 'g', type: 1, isSelf: self, data: { uidFrom: 'user', msgId: `${self}-${preview}`, content: preview ? { title: 'TikTok', href: link } : link } };
    assert.equal(await handleDownloadZalo(api, message, settings, self, dependencies), true);
    await handleDownloadZalo(api, message, settings, self, dependencies);
  }
  assert.equal(jobs.length, 4);
  const echo = { threadId: 'g', data: { uidFrom: 'user', cliMsgId: 'client-echo', content: link } };
  rememberOutboundMessage('admin', 'g', { clientId: 'client-echo' });
  await handleDownloadZalo(api, echo, settings, true, dependencies);
  for (const content of [link, { title: `${getGlobalPrefix()}tt ${link}`, href: link }]) {
    await handleDownloadZalo(api, { threadId: 'g', data: { msgId: Math.random(), uidFrom: 'user', content } }, { g: { enableDownload: false } }, false, dependencies);
  }
  await handleDownloadZalo(api, { threadId: 'g', data: { msgId: 'cmd', content: { title: `${getGlobalPrefix()}tt ${link}`, href: link } } }, settings, true, dependencies);
  await handleDownloadZalo(api, { threadId: 'g', data: { msgId: 'video-echo', content: { title: link, href: 'https://zalo.cdn/video' } } }, settings, true, dependencies);
  assert.equal(jobs.length, 4);
});
