import test from 'node:test';
import assert from 'node:assert/strict';

const input = await import('../src/service-debug/api-crawl/download/download-input.js').catch(() => ({}));
test('reads body/text/title before href and rejects spoofed platform hosts', () => {
  assert.equal(typeof input.readDownloadLink, 'function');
  for (const data of [ { body: 'https://vt.tiktok.com/abc/' }, { data: { content: { href: 'https://vt.tiktok.com/abc/' } } } ]) {
    assert.equal(input.readDownloadLink(data).platform, 'tiktok');
  }
  assert.equal(input.readDownloadLink({ body: 'https://evil.test/tiktok.com/a' }), null);
  assert.equal(input.readDownloadLink({ body: 'https://tiktok.com.evil.test/a' }), null);
  assert.equal(input.readDownloadLink({ body: 'https://youtu.be/a https://vt.tiktok.com/b' }).platform, 'youtube');
  assert.equal(input.hasCommandPrefix({ data: { content: { title: '!tt https://vt.tiktok.com/a', href: 'https://vt.tiktok.com/a' } } }, '!'), true);
  assert.equal(input.hasCommandPrefix({ data: { content: '@Bot !tt https://vt.tiktok.com/a', mentions: [{ pos: 0, len: 4 }] } }, '!'), true);
});
test('outbound client claim suppresses echo before receipt, message claim is scoped', async () => {
  const echo = await import('../src/api-zalo/outbound-message-registry.js').catch(() => ({}));
  assert.equal(typeof echo.rememberOutboundMessage, 'function');
  echo.rememberOutboundMessage('bot', 'g', { clientId: '123' });
  assert.equal(echo.isOutboundMessage('bot', { threadId: 'g', data: { cliMsgId: '123' } }), true);
  assert.equal(echo.isOutboundMessage('other', { threadId: 'g', data: { cliMsgId: '123' } }), false);
  echo.rememberOutboundMessage('bot', 'g', { clientId: '123', msgId: '999' });
  assert.equal(echo.isOutboundMessage('bot', { threadId: 'g', data: { msgId: '999' } }), true);
  assert.equal(input.claimDownloadMessage('bot', { threadId: 'g', data: { msgId: '77' } }), true);
  assert.equal(input.claimDownloadMessage('bot', { threadId: 'g', data: { msgId: '77' } }), false);
  assert.equal(input.claimDownloadMessage('other', { threadId: 'g', data: { msgId: '77' } }), true);
  assert.equal(input.claimDownloadMessage('bot', { threadId: 'g', data: { cliMsgId: 'early-client' } }), true);
  assert.equal(input.claimDownloadMessage('bot', { threadId: 'g', data: { msgId: 'later-server', cliMsgId: 'early-client' } }), false);
});
