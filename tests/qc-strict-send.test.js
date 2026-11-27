import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendMessageFactory } from '../src/api-zalo/apis/sendMessage.js';
import { sendMessageForwardFactory } from '../src/api-zalo/apis/sendMessageForward.js';
import { sendImageFactory } from '../src/api-zalo/apis/sendImage.js';
import { sendGifFactory } from '../src/api-zalo/apis/sendGif.js';
import { sendBusinessCardFactory } from '../src/api-zalo/apis/sendBusinessCard.js';
import { appContext } from '../src/api-zalo/context.js';
import { wrapWithLimiter } from '../src/api-zalo/transport-limiter.js';
import { decodeAES, encodeAES, request } from '../src/api-zalo/utils.js';
import { prepareQcContent } from '../src/service-debug/qc/content.js';

async function transport(t, { error = false, respond, serveMedia } = {}) {
  const key='12345678901234567890123456789012';
  Object.assign(appContext,{secretKey:key,imei:'test-imei',cookie:'test-cookie',userAgent:'test-agent'});
  const requests=[];
  const server=http.createServer((req,res)=>{ if (req.method === 'GET' && serveMedia) return serveMedia(req,res);
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    requests.push(JSON.parse(decodeAES(key,new URLSearchParams(body).get('params'))));
    if (respond) return respond(req, res, requests.at(-1));
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({error_code:0,data:encodeAES(key,JSON.stringify(error?{error_code:403,error_message:'denied'}:{error_code:0,data:{msgId:'123'}}))}));
  }); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  return {requests, api:{zpwServiceMap:{chat:[url],group:[url],file:[url]}}};
}

test('strict QC text makes exactly one attempt after an API refusal', async(t)=>{
  const {api,requests}=await transport(t,{error:true});
  await assert.rejects(sendMessageFactory(api)({msg:'ad',strict:true,linkOn:false},'11',0));
  assert.equal(requests.length,1);
});

test('strict QC attachment rejects lossy caption splitting before any send', async(t)=>{
  const {api,requests}=await transport(t);
  await assert.rejects(sendMessageFactory(api)({msg:'caption',attachments:['file.pdf'],strict:true},'11',0),/strict|nguyên dạng/i);
  assert.equal(requests.length,0);
});

test('strict QC photo failure never falls back to caption text', async(t)=>{
  const {api,requests}=await transport(t);
  api.uploadAttachment=async()=>{throw new Error('upload denied');};
  await assert.rejects(sendMessageFactory(api)({msg:'caption',attachments:['photo.jpg'],strict:true},'11',0));
  assert.equal(requests.length,0);
});

test('strict link forwarding preserves original metadata without re-parsing',async(t)=>{
  const {api,requests}=await transport(t);
  api.parseLink=async()=>assert.fail('strict link must use original metadata');
  await sendMessageForwardFactory(api)({strict:true,msg:'caption',link:'https://example.com/a',title:'Original',desc:'Description',thumb:'https://example.com/a.jpg',media:{mediaTitle:'media'}},'11',0);
  assert.equal(requests.length,1);
  assert.equal(requests[0].toIds[0].toUid,'11');
  const info=JSON.parse(requests[0].msgInfo);
  assert.equal(info.linkTitle,'Original');assert.equal(info.message,'caption');assert.equal(JSON.parse(info.extData).mediaTitle,'media');
});

function prepareText(api) {
  api.sendMessage = sendMessageFactory(api);
  return prepareQcContent(api, { data: { msgType: 'webchat', content: 'original' } });
}

test('QC does not replay a POST after an HTTP 503', async t => {
  const { api, requests } = await transport(t, { respond(_req, res) { res.writeHead(503).end(); } });
  const payload = await prepareText(api);
  await assert.rejects(payload.send('11'), { code: 503, status: 503 });
  assert.equal(requests.length, 1);
});

test('QC does not replay a POST after the server receives it and closes the socket', async t => {
  const { api, requests } = await transport(t, { respond(req) { req.socket.destroy(); } });
  const payload = await prepareText(api);
  await assert.rejects(payload.send('11'), { code: 'HTTP_REQUEST_FAILED' });
  assert.equal(requests.length, 1);
});

test('QC does not follow a redirect that would send another POST', async t => {
  const { api, requests } = await transport(t, { respond(req, res) {
    if (req.url === '/redirected') res.writeHead(503).end();
    else res.writeHead(307, { location: '/redirected' }).end();
  } });
  const payload = await prepareText(api);
  await assert.rejects(payload.send('11'));
  assert.equal(requests.length, 1);
});

test('QC propagates a top-level Zalo refusal even when HTTP succeeded', async t => {
  const { api, requests } = await transport(t, { respond(_req, res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error_code: 401, error_message: 'Session expired' }));
  } });
  api.sendMessageForward = sendMessageForwardFactory(api);
  const payload = await prepareQcContent(api, { data: {
    msgType: 'chat.recommended', content: { action: 'recommened.link', href: 'https://example.com/a' },
  } });
  await assert.rejects(payload.send('11'), { code: 401, status: 200, message: 'Session expired' });
  assert.equal(requests.length, 1);
});

test('QC does not change transport retries for a concurrent unrelated request', async t => {
  const { api, requests } = await transport(t, { respond(_req, res) { res.writeHead(503).end(); } });
  const payload = await prepareText(api);
  const otherPost = request(api.zpwServiceMap.chat[0], { method: 'POST', retry: 1,
    body: new URLSearchParams({ params: encodeAES(appContext.secretKey, JSON.stringify({ message: 'other' })) }),
  });
  await assert.rejects(payload.send('11'), { code: 503 });
  assert.equal((await otherPost).status, 503);
  assert.deepEqual(requests.map(item => item.message).sort(), ['original', 'other', 'other']);
});

test('QC retains its request policy when an unrelated send occupied the limiter', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { api, requests } = await transport(t, { async respond(_req, res, body) {
    if (body.message !== 'blocker') return res.writeHead(503).end();
    entered.resolve();
    await release.promise;
    return res.writeHead(200).end();
  } });
  api.sendMessage = sendMessageFactory(api);
  wrapWithLimiter(api, { maxConcurrent: 1, minTime: 0 });
  const payload = await prepareQcContent(api, { data: { msgType: 'webchat', content: 'original' } });
  const blockingSend = api.sendMessage({ msg: 'blocker', strict: true }, '12', 0);
  await entered.promise;
  const queuedSend = assert.rejects(payload.send('11'), { code: 503 });
  release.resolve();
  await Promise.all([blockingSend, queuedSend]);
  assert.deepEqual(requests.map(item => item.message), ['blocker', 'original']);
});

test('QC reuses prepared image and GIF metadata through the real transport limiter', async t => {
  const sharp = (await import('sharp')).default;
  const photo = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'red' } })
    .png({ compressionLevel: 0 }).toBuffer();
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const downloads = [];
  const { api, requests } = await transport(t, { serveMedia(req, res) {
    downloads.push(req.url);
    res.end(req.url === '/photo.png' ? photo : gif);
  } });
  const base = api.zpwServiceMap.file[0];
  let uploaded = 0;
  api.uploadThumbnail = async () => {
    uploaded++;
    return { url: `${base}/thumb.png` };
  };
  api.sendImage = sendImageFactory(api);
  api.sendGif = sendGifFactory(api);
  wrapWithLimiter(api, { minTime: 0 });
  for (const [msgType, resource] of [['chat.photo', 'photo.png'], ['chat.gif', 'image.gif']]) {
    const payload = await prepareQcContent(api, { data: { msgType, content: { href: `${base}/${resource}`, title: 'caption' } } });
    await payload.send('11');
    await payload.send('12');
  }
  assert.deepEqual(downloads, ['/photo.png', '/image.gif']);
  assert.equal(uploaded, 1);
  assert.deepEqual(requests.map(p => [p.toid ?? p.toId, p.desc ?? p.msg, p.width, p.height]), [
    ['11', 'caption', 40, 40], ['12', 'caption', 40, 40],
    ['11', 'caption', 1, 1], ['12', 'caption', 1, 1],
  ]);
});

test('QC sends the same card and phone after one native QR lookup', async t => {
  const { api, requests } = await transport(t);
  const qrCodeUrl = 'https://example.com/qr.png';
  let lookups = 0;
  api.getQRLink = async uid => {
    lookups++;
    assert.equal(uid, '345');
    return { '345': qrCodeUrl };
  };
  api.sendBusinessCard = sendBusinessCardFactory(api);
  const payload = await prepareQcContent(api, { data: { msgType: 'chat.recommended', content: {
    action: 'recommened.user', params: '345', description: '{"phone":"0912345678"}',
  } } });
  assert.equal(lookups, 1);
  assert.equal(requests.length, 0);
  await payload.send('11');
  await payload.send('12');
  assert.equal(lookups, 1);
  assert.deepEqual(requests.map(p => [p.toId, JSON.parse(p.msgInfo)]), [
    ['11', { contactUid: '345', qrCodeUrl, phone: '0912345678' }],
    ['12', { contactUid: '345', qrCodeUrl, phone: '0912345678' }],
  ]);
});
