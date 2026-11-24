import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendMessageFactory } from '../src/api-zalo/apis/sendMessage.js';
import { sendLinkFactory } from '../src/api-zalo/apis/sendLink.js';
import { appContext } from '../src/api-zalo/context.js';
import { decodeAES, encodeAES } from '../src/api-zalo/utils.js';
import { isOutboundMessage } from '../src/api-zalo/outbound-message-registry.js';

test('text and preview HTTP requests claim clientId before receipt and msgId afterwards', async t => {
  const secretKey = '12345678901234567890123456789012';
  Object.assign(appContext, { uid: 'echo-bot', secretKey, imei: 'imei', cookie: 'cookie', userAgent: 'test' });
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = JSON.parse(decodeAES(secretKey, new URLSearchParams(body).get('params')));
      requests++;
      // Server has not returned a receipt yet, matching the early listener echo.
      assert.equal(isOutboundMessage('echo-bot', { threadId: 'g', data: { cliMsgId: params.clientId } }), true);
      res.end(JSON.stringify({ error_code: 0, data: encodeAES(secretKey, JSON.stringify({ error_code: 0, data: { msgId: `receipt-${requests}` } })) }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = { zpwServiceMap: { chat: [base], group: [base], file: [base] },
    parseLink: async () => ({ data: { href: 'https://vt.tiktok.com/abc/', media: {} } }) };
  await sendMessageFactory(api)({ msg: 'https://vt.tiktok.com/abc/' }, 'g', 1);
  await sendLinkFactory(api)('', 'https://vt.tiktok.com/abc/', 'g', 1);
  assert.equal(requests, 2);
  for (const msgId of ['receipt-1', 'receipt-2']) assert.equal(isOutboundMessage('echo-bot', { threadId: 'g', data: { msgId } }), true);
});
