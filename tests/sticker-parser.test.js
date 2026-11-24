import test from "node:test";
import assert from "node:assert/strict";

import { parseStickerArgs, StickerParseError } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/parser.js";

const baseOptions = { hasMediaReference: false };

test("parser rejects empty input without media", () => {
  assert.throws(() => parseStickerArgs("", baseOptions), StickerParseError);
});

test("parser accepts direct URL", () => {
  const result = parseStickerArgs("https://example.com/x.png", baseOptions);
  assert.equal(result.source, "media");
  assert.equal(result.payload.url, "https://example.com/x.png");
});

test("parser accepts reply reference", () => {
  const result = parseStickerArgs("", { hasMediaReference: true });
  assert.equal(result.source, "media");
  assert.equal(result.payload.reference, "reply");
});

test("parser supports text mode with Vietnamese content", () => {
  const result = parseStickerArgs("text Xin chào bạn", baseOptions);
  assert.equal(result.source, "text");
  assert.equal(result.payload.text, "Xin chào bạn");
});

test("parser supports text mode with effects preceding it", () => {
  const result = parseStickerArgs("-r20 z1.2 rot-45 text Hello", baseOptions);
  assert.equal(result.source, "text");
  assert.equal(result.effects.round, 20);
  assert.equal(result.effects.zoom, 1.2);
  assert.equal(result.effects.rotate, -45);
});

test("parser supports textvd with rainbow alias", () => {
  const result = parseStickerArgs("textvd rainbow Xin chào", baseOptions);
  assert.equal(result.source, "textvd");
  assert.equal(result.payload.color, "rainbow");
});

test("parser supports textvd with Vietnamese color alias", () => {
  const result = parseStickerArgs("textvd đỏ Ngày mới", baseOptions);
  assert.equal(result.payload.color, "red");
});

test("parser supports textvd with 'tim' alias", () => {
  const result = parseStickerArgs("textvd tím hồng", baseOptions);
  assert.equal(result.payload.color, "purple");
});

test("parser requires color for textvd", () => {
  assert.throws(() => parseStickerArgs("textvd Xin chào", baseOptions), StickerParseError);
});

test("parser rejects invalid textvd color", () => {
  assert.throws(() => parseStickerArgs("textvd magenta Hello", baseOptions), StickerParseError);
});

test("parser enforces text length limit", () => {
  assert.throws(() => parseStickerArgs("text " + "a".repeat(201), baseOptions), StickerParseError);
});

test("parser accepts ai with prompt", () => {
  const result = parseStickerArgs("ai mèo đội nón", baseOptions);
  assert.equal(result.source, "ai");
  assert.equal(result.payload.prompt, "mèo đội nón");
});

test("parser ai uses default prompt when only reply reference is provided", () => {
  const result = parseStickerArgs("ai", { hasMediaReference: true });
  assert.equal(result.source, "ai");
  assert.equal(result.payload.reference, "reply");
  assert.match(result.payload.prompt, /dễ thương/);
});

test("parser rejects ai without prompt or reference", () => {
  assert.throws(() => parseStickerArgs("ai", baseOptions), StickerParseError);
});

test("parser rejects multiple source modes", () => {
  assert.throws(() => parseStickerArgs("text ai hello", baseOptions), StickerParseError);
});

test("parser accepts bracket notation for -r and z", () => {
  const result = parseStickerArgs("z(1.5) -r(10) text Hi", baseOptions);
  assert.equal(result.effects.zoom, 1.5);
  assert.equal(result.effects.round, 10);
});

test("parser accepts pixel alias with size", () => {
  const result = parseStickerArgs("pixel8 text Hi", baseOptions);
  assert.equal(result.effects.pixel, 8);
});

test("parser accepts pixel bracket notation", () => {
  const result = parseStickerArgs("pixel(16) text Hi", baseOptions);
  assert.equal(result.effects.pixel, 16);
});

test("parser rejects duplicate modifier", () => {
  assert.throws(() => parseStickerArgs("-r10 -r20 text Hi", baseOptions), StickerParseError);
});

test("parser rejects unknown token before source mode", () => {
  assert.throws(() => parseStickerArgs("bogus text Hi", baseOptions), StickerParseError);
});

test("parser enforces -r range", () => {
  assert.throws(() => parseStickerArgs("-r51 text Hi", baseOptions), StickerParseError);
});

test("parser enforces zoom range", () => {
  assert.throws(() => parseStickerArgs("z0.1 text Hi", baseOptions), StickerParseError);
});

test("parser enforces speed range", () => {
  assert.throws(() => parseStickerArgs("sp5 text Hi", baseOptions), StickerParseError);
});

test("parser enforces pixel range", () => {
  assert.throws(() => parseStickerArgs("pixel1 text Hi", baseOptions), StickerParseError);
  assert.throws(() => parseStickerArgs("pixel80 text Hi", baseOptions), StickerParseError);
});

test("parser normalizes rotation degrees to -180..180", () => {
  const result = parseStickerArgs("rot540 text Hi", baseOptions);
  assert.equal(result.effects.rotate, 180);
});

test("parser handles negative rotation", () => {
  const result = parseStickerArgs("rot-45 text Hi", baseOptions);
  assert.equal(result.effects.rotate, -45);
});

test("parser accepts complex effect combination", () => {
  const result = parseStickerArgs("-r20 z1.2 rot-45 fh pixel8 spin text Hi", baseOptions);
  assert.deepEqual(result.effects, {
    round: 20,
    zoom: 1.2,
    rotate: -45,
    flipHorizontal: true,
    pixel: 8,
    spin: true,
  });
});

test("parser accepts ai with effects before", () => {
  const result = parseStickerArgs("cat -r50 ai mèo đội nón", baseOptions);
  assert.equal(result.source, "ai");
  assert.equal(result.effects.cat, true);
  assert.equal(result.effects.round, 50);
});

test("parser rejects non-finite rotation", () => {
  assert.throws(() => parseStickerArgs("rotNaN text Hi", baseOptions), StickerParseError);
});

test("parser accepts sp without explicit value using default 1", () => {
  assert.throws(() => parseStickerArgs("sp text Hi", baseOptions), StickerParseError);
  const result = parseStickerArgs("sp1.5 text Hi", baseOptions);
  assert.equal(result.effects.speed, 1.5);
});

test("parser accepts textvd with 'hong' alias", () => {
  const result = parseStickerArgs("textvd hồng xinh", baseOptions);
  assert.equal(result.payload.color, "pink");
});

test("parser accepts textvd with 'vang' alias", () => {
  const result = parseStickerArgs("textvd vàng buồn", baseOptions);
  assert.equal(result.payload.color, "yellow");
});

test("parser accepts textvd with 'xanh' alias mapping to blue", () => {
  const result = parseStickerArgs("textvd xanh dương", baseOptions);
  assert.equal(result.payload.color, "blue");
});

test("parser applies -r effect to media reference (reply) without source mode", () => {
  const result = parseStickerArgs("-r", { hasMediaReference: true });
  assert.equal(result.source, "media");
  assert.equal(result.payload.reference, "reply");
  assert.equal(result.effects.round, 50);
});

test("parser applies multiple effects to media reference (reply)", () => {
  const result = parseStickerArgs("-r20 z1.5 fh", { hasMediaReference: true });
  assert.equal(result.source, "media");
  assert.equal(result.effects.round, 20);
  assert.equal(result.effects.zoom, 1.5);
  assert.equal(result.effects.flipHorizontal, true);
});

test("parser applies effects to media URL without source mode", () => {
  const result = parseStickerArgs("-r https://example.com/x.png", { hasMediaReference: false });
  assert.equal(result.source, "media");
  assert.equal(result.payload.url, "https://example.com/x.png");
  assert.equal(result.effects.round, 50);
});

test("parser rejects -r without reply or URL", () => {
  assert.throws(() => parseStickerArgs("-r", { hasMediaReference: false }), StickerParseError);
});

test("parser allows text containing the word 'ai'", () => {
  const result = parseStickerArgs("text Tôi yêu AI", baseOptions);
  assert.equal(result.source, "text");
  assert.equal(result.payload.text, "Tôi yêu AI");
});

test("parser allows ai prompt containing the word 'text'", () => {
  const result = parseStickerArgs("ai tạo chữ text đẹp", baseOptions);
  assert.equal(result.source, "ai");
  assert.equal(result.payload.prompt, "tạo chữ text đẹp");
});

test("parser allows textvd containing the word 'ai'", () => {
  const result = parseStickerArgs("textvd đỏ Tôi thích ai", baseOptions);
  assert.equal(result.source, "textvd");
  assert.equal(result.payload.color, "red");
  assert.equal(result.payload.text, "Tôi thích ai");
});

test("parser allows effects before text containing 'ai'", () => {
  const result = parseStickerArgs("-r(20) text Tôi yêu AI", baseOptions);
  assert.equal(result.source, "text");
  assert.equal(result.effects.round, 20);
  assert.equal(result.payload.text, "Tôi yêu AI");
});
