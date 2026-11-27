import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { prepareQcContent } from "../src/service-debug/qc/content.js";

const media = "https://cdn.example.test";
const dm = { threadId: "843", type: 0 };
const nativeMethods = ["sendMessage", "sendMessageForward", "sendImage", "sendGif", "sendVideo",
  "sendVoice", "sendSticker", "sendBusinessCard", "sendFile"];

function incoming(msgType, content, data = {}) {
  return { threadId: "991", type: 1, data: { uidFrom: "542", idTo: "991", msgType, content, ...data } };
}

function sdk(onSend = () => ({ msgId: "614" })) {
  const calls = [];
  const api = Object.fromEntries(nativeMethods.map(method => [method, async (...args) => {
    calls.push([method, structuredClone(args)]);
    return onSend(args);
  }]));
  const preparations = [];
  const mediaMetadata = {
    sendImage: { width: 640, height: 480, totalSize: 2048 },
    sendGif: { width: 240, height: 160, thumbUrl: `${media}/gif-thumb.png` },
    sendBusinessCard: `${media}/qr.jpg`,
  };
  for (const [method, metadata] of Object.entries(mediaMetadata)) {
    api[method].prepare = async source => {
      preparations.push([method, source]);
      return structuredClone(metadata);
    };
  }
  return { api, calls, preparations };
}

const fixtures = [
  ["text", incoming("webchat", "  thông báo\nhttps://example.test/abc "),
    "sendMessage", [{ msg: "  thông báo\nhttps://example.test/abc ", linkOn: false, strict: true }, "843", 0]],
  ["link", incoming("chat.recommended", { action: "recommened.link", href: "https://example.test/news", title: "Đọc bài này",
    description: "Bản tin", thumb: `${media}/preview.jpg`, params: '{"mediaTitle":"Tin mới","src":"example.test"}' }),
    "sendMessageForward", [{ msg: "Đọc bài này", link: "https://example.test/news", title: "Tin mới", desc: "Bản tin",
      thumb: `${media}/preview.jpg`, src: "example.test", media: { mediaTitle: "Tin mới" }, strict: true }, "843", 0]],
  ["photo", incoming("chat.photo", { href: `${media}/photo.jpg`, thumb: `${media}/thumb.jpg`, title: "Ảnh kèm chữ" }),
    "sendImage", [`${media}/photo.jpg`, dm, "Ảnh kèm chữ", 0, { width: 640, height: 480, totalSize: 2048 }]],
  ["gif", incoming("chat.gif", { href: `${media}/cat.gif`, title: "GIF kèm chữ" }),
    "sendGif", [`${media}/cat.gif`, dm, "GIF kèm chữ", 0, { width: 240, height: 160, thumbUrl: `${media}/gif-thumb.png` }]],
  ["video", incoming("chat.video.msg", { href: `${media}/clip.mp4`, thumb: `${media}/clip.jpg`, title: "Video kèm chữ",
    params: '{"duration":"3900","width":640,"height":360,"fileSize":"16412"}' }),
    "sendVideo", [{ videoUrl: `${media}/clip.mp4`, threadId: "843", threadType: 0, message: { text: "Video kèm chữ" },
      thumbnail: `${media}/clip.jpg`, duration: 3900, width: 640, height: 360, fileSize: 16412, videoAlreadyUploaded: true }]],
  ["voice", incoming("chat.voice", { href: `${media}/audio.m4a` }), "sendVoice", [dm, `${media}/audio.m4a`]],
  ["sticker", incoming("chat.sticker", { id: "19030", catId: 32, type: 0 }), "sendSticker", [{ id: 19030, cateId: 32, type: 0 }, "843", 0]],
  ["card", incoming("chat.recommended", { action: "recommened.user", params: "7321241836239983721",
    description: '{"phone":"0912345678"}' }), "sendBusinessCard", [null, "7321241836239983721", "0912345678", 0, "843", 0, `${media}/qr.jpg`]],
  ["file", incoming("share.file", JSON.stringify({ title: "Báo cáo.pdf", caption: "Gửi mọi người", href: `${media}/attachment`,
    params: '{"fileSize":"12345","fileExt":"pdf","checksum":"a987bc03ac263a87f262f32068f5c004"}' })), "sendFile",
    [{ ...dm, data: { content: "Gửi mọi người" } }, `${media}/attachment`, 0, "Báo cáo.pdf", 12345, "pdf", "a987bc03ac263a87f262f32068f5c004"]],
];

for (const [kind, message, method, args] of fixtures) {
  test(`QC gửi một tin dạng ${kind} vào chat riêng`, async () => {
    const { api, calls } = sdk();
    const payload = await prepareQcContent(api, message);
    assert.equal(payload.kind, kind);
    assert.deepEqual(await payload.send("843"), { msgId: "614" });
    assert.deepEqual(calls, [[method, args]]);
    await payload.cleanup();
  });
}

test("QC lưu nội dung gốc và tạo đối số mới cho từng người", async () => {
  const { api, calls } = sdk(args => {
    args[0].message.text = "SDK mutation";
    return { msgId: "614" };
  });
  const message = structuredClone(fixtures.find(([kind]) => kind === "video")[1]);
  const payload = await prepareQcContent(api, message);
  assert.ok(Object.isFrozen(payload));
  message.threadId = "new-origin";
  message.data.content.title = "new caption";
  await payload.send("843");
  await payload.send("844");
  assert.deepEqual(calls.map(([, [entry]]) => [entry.threadId, entry.threadType, entry.message.text]), [
    ["843", 0, "Video kèm chữ"], ["844", 0, "Video kèm chữ"],
  ]);
});

test("QC chỉ gọi SDK một lần nếu gửi trả lỗi mạng", async () => {
  const error = new Error("socket closed");
  const { api, calls } = sdk(() => { throw error; });
  const payload = await prepareQcContent(api, incoming("chat.text", "Tin nhắn"));
  await assert.rejects(payload.send("843"), candidate => candidate === error);
  assert.deepEqual(calls, [["sendMessage", [{ msg: "Tin nhắn", linkOn: false, strict: true }, "843", 0]]]);
});

test("QC từ chối ngay nếu thiếu phương thức SDK", async () => {
  const { api, calls } = sdk();
  delete api.sendImage;
  await assert.rejects(prepareQcContent(api, incoming("chat.photo", { href: `${media}/photo.jpg` })), /sendImage/);
  assert.deepEqual(calls, []);
});

for (const [kind, source] of [["photo", `${media}/photo.jpg`], ["gif", `${media}/cat.gif`], ["card", "7321241836239983721"]]) {
  test(`QC chuẩn bị ${kind} một lần trước khi gửi vào hai chat riêng`, async () => {
    const { api, calls, preparations } = sdk();
    const [, original, method] = fixtures.find(([fixtureKind]) => fixtureKind === kind);
    const payload = await prepareQcContent(api, original);
    assert.deepEqual(preparations, [[method, source]]);
    assert.deepEqual(calls, []);
    await payload.send("843");
    await payload.send("844");
    assert.deepEqual(preparations, [[method, source]]);
    assert.deepEqual(calls.map(([calledMethod]) => calledMethod), [method, method]);
  });
}

test("QC từ chối ảnh không thể tải trước khi khởi chạy chiến dịch", async () => {
  const { api, calls } = sdk();
  api.sendImage.prepare = async () => { throw new Error("image unavailable"); };
  const [, original] = fixtures.find(([kind]) => kind === "photo");
  await assert.rejects(prepareQcContent(api, original), /không.*chuẩn bị/i);
  assert.deepEqual(calls, []);
});

const unsupported = [
  ["tin định vị", incoming("chat.location.new", { latitude: 21, longitude: 105 })],
  ["nội dung rỗng", incoming("webchat", "   ")],
  ["văn bản có tệp đính kèm không rõ định dạng", incoming("webchat", "Tin nhắn", { attachments: [{}] })],
  ["album", incoming("chat.photo", { href: `${media}/photo.jpg`, photos: [{}, {}] })],
  ["video thiếu ảnh bìa", incoming("chat.video.msg", { href: `${media}/clip.mp4` })],
  ["ảnh chỉ còn bản thu nhỏ", incoming("chat.photo", { thumb: `${media}/thumb.jpg` })],
  ["URL không phải HTTP(S)", incoming("chat.photo", { href: "file:///private/local.txt" })],
  ["danh thiếp không xác định được UID", incoming("chat.recommended", { action: "recommened.user", params: "invalid" })],
  ["tin thoại có caption", incoming("chat.voice", { href: `${media}/audio.m4a`, caption: "Quan trọng" })],
  ["danh thiếp có caption", incoming("chat.recommended", { action: "recommened.user", params: "123456", caption: "Quan trọng" })],
];

for (const [label, message] of unsupported) {
  test(`QC từ chối ${label} trước khi gửi`, async () => {
    const { api, calls } = sdk();
    await assert.rejects(prepareQcContent(api, message), /không|thiếu|hợp lệ/i);
    assert.deepEqual(calls, []);
  });
}

test("QC tải file một lần để tính metadata thiếu và dùng lại cho từng người", async t => {
  let downloads = 0;
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET");
    downloads++;
    res.end("hello");
  });
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/file`;
  const { api, calls } = sdk();
  const payload = await prepareQcContent(api, incoming("share.file", { title: "Gốc.txt", href: url }));
  await payload.send("843");
  await payload.send("844");
  await payload.cleanup();
  assert.equal(downloads, 1);
  assert.deepEqual(calls, [
    ["sendFile", [dm, url, 0, "Gốc.txt", 5, "txt", "5d41402abc4b2a76b9719d911017c592"]],
    ["sendFile", [{ threadId: "844", type: 0 }, url, 0, "Gốc.txt", 5, "txt", "5d41402abc4b2a76b9719d911017c592"]],
  ]);
});
