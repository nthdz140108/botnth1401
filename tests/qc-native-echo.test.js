import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appContext } from '../src/api-zalo/context.js';
import { GroupMessage } from '../src/api-zalo/models/Message.js';
import { decodeAES, encodeAES } from '../src/api-zalo/utils.js';
import { isOutboundMessage } from '../src/api-zalo/outbound-message-registry.js';
import { sendStickerFactory } from '../src/api-zalo/apis/sendSticker.js';
import { sendImageFactory } from '../src/api-zalo/apis/sendImage.js';
import { sendGifFactory } from '../src/api-zalo/apis/sendGif.js';
import { sendVideoFactory } from '../src/api-zalo/apis/sendVideo.js';
import { sendVoiceFactory } from '../src/api-zalo/apis/sendVoice.js';
import { sendFileFactory } from '../src/api-zalo/apis/sendFile.js';
import { sendBusinessCardFactory } from '../src/api-zalo/apis/sendBusinessCard.js';
import { sendMessageForwardFactory } from '../src/api-zalo/apis/sendMessageForward.js';
import { QcSession } from '../src/service-debug/qc/session.js';
import { prepareQcContent } from '../src/service-debug/qc/content.js';

const BOT = '99';
const ORIGIN = 'origin-group';
const KEY = '12345678901234567890123456789012';
const media = 'https://example.test';

async function loopback(t, confirmBeforeReceipt) {
  Object.assign(appContext, { uid: BOT, secretKey: KEY, imei: 'imei', cookie: 'cookie', userAgent: 'test' });
  const checks = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '512' }).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = JSON.parse(decodeAES(KEY, new URLSearchParams(body).get('params')));
      const address = params.toIds?.[0] ?? params.grids?.[0] ?? params;
      const threadId = address.grid ?? address.toId ?? address.toid ?? address.toUid;
      const result = await confirmBeforeReceipt(threadId, String(address.clientId));
      checks.push(result);
      const id = checks.length;
      const receipt = { message: { msgId: `receipt-${id}`, cliMsgId: `server-client-${id}`, clientId: `server-alt-${id}` } };
      res.end(JSON.stringify({ error_code: 0, data: encodeAES(KEY, JSON.stringify({ error_code: 0, data: receipt })) }));
    } catch (error) {
      checks.push(error);
      res.writeHead(422).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, checks, api: { zpwServiceMap: { chat: [base], group: [base], file: [base] } } };
}

test('QC ignores a real native sticker echo from its owning account before the HTTP receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qc-native-echo-'));
  t.after(() => rm(directory, { recursive: true }));
  const sticker = { id: 1, catId: 2, type: 0 };
  const context = (content, properties = {}) => ({
    prefix: '!', permissionLevel: 'adminLevelHigh',
    message: new GroupMessage({ uidFrom: '0', idTo: ORIGIN, msgType: 'webchat', content, ...properties }),
  });
  const { api, checks } = await loopback(t, (threadId, cliMsgId) => session.input(context(sticker, {
    idTo: threadId, cliMsgId, msgType: 'chat.sticker',
  })));
  Object.assign(api, {
    getOwnId: () => BOT,
    getAllGroups: async () => ({ gridVerMap: { 'target-group': 1 } }),
    getGroupInfo: async () => ({ name: 'Target' }),
    sendMessage: async () => ({ message: { msgId: 'qc-notification' } }),
    sendSticker: sendStickerFactory(api),
  });
  let jobs = 0;
  const session = new QcSession({ api, prepare: prepareQcContent, checkpointFile: join(directory, 'campaign.json'),
    broker: { submitBroadcast() { jobs++; assert.fail('A native command echo cannot become an ad'); } },
  });
  await session.command(context('!qc'));
  assert.equal(await session.input(context('1', { msgId: 'manual-selection' })), true);
  assert.equal(session.session.phase, 'content');
  await api.sendSticker({ id: 1, cateId: 2, type: 0 }, ORIGIN, 1);
  assert.deepEqual(checks, [false]);
  assert.equal(jobs, 0);
  assert.equal(session.session.phase, 'content');
});

test('native message factories claim their actual wire ID and nested receipt IDs in the destination chat', async t => {
  const { api, base, checks } = await loopback(t, (threadId, cliMsgId) => ({ threadId,
    registered: isOutboundMessage(BOT, { threadId, data: { cliMsgId } }),
    otherBot: isOutboundMessage('other-bot', { threadId, data: { cliMsgId } }),
    otherChat: isOutboundMessage(BOT, { threadId: 'unrelated', data: { cliMsgId } }),
  }));
  const target = { threadId: '125', type: 0 };
  const recipient = target.threadId;
  const calls = [
    () => sendStickerFactory(api)({ id: 1, cateId: 2, type: 0 }, recipient, 0),
    () => sendImageFactory(api)(`${media}/photo.jpg`, target, 'caption', 0, { width: 500, height: 500, totalSize: 2048 }),
    () => sendGifFactory(api)(`${media}/cat.gif`, target, 'caption', 0, { width: 100, height: 100, thumbUrl: `${media}/thumb.png` }),
    () => sendVideoFactory(api)({ videoUrl: `${media}/video.mp4`, thumbnail: `${media}/thumb.png`, threadId: recipient,
      threadType: 0, videoAlreadyUploaded: true, width: 320, height: 240, duration: 500, fileSize: 5000 }),
    () => sendVoiceFactory(api)(target, `${base}/audio.m4a`),
    () => sendFileFactory(api)(target, `${media}/file.pdf`, 0, 'file.pdf', 1500, 'pdf', '5d41402abc4b2a76b9719d911017c592'),
    () => sendBusinessCardFactory(api)(null, '543', null, 0, recipient, 0, `${media}/qr.png`),
    () => sendMessageForwardFactory(api)({ msg: 'forwarded' }, recipient, 0),
    () => sendMessageForwardFactory(api)({ msg: 'forwarded' }, ORIGIN, 1),
  ];
  for (const send of calls) await send();
  const destinations = [...Array(8).fill(recipient), ORIGIN];
  assert.deepEqual(checks, destinations.map(threadId => ({ threadId, registered: true, otherBot: false, otherChat: false })));
  for (const [index, threadId] of destinations.entries()) {
    const id = index + 1;
    assert.ok(isOutboundMessage(BOT, { threadId, data: { msgId: `receipt-${id}` } }));
    assert.ok(isOutboundMessage(BOT, { threadId, data: { cliMsgId: `server-client-${id}` } }));
    assert.ok(isOutboundMessage(BOT, { threadId, data: { clientId: `server-alt-${id}` } }));
  }
});
