import test from "node:test";
import assert from "node:assert/strict";

import { normalizeEffectPlan } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/effects.js";

test("plan produces fixed pipeline order regardless of user input order", () => {
  const request = {
    source: "media",
    payload: { kind: "media", url: "https://example.com/x.png" },
    effects: {
      spin: true,
      pixel: 8,
      rotate: -45,
      flipHorizontal: true,
      zoom: 1.2,
      cat: true,
      round: 20,
    },
  };
  const plan = normalizeEffectPlan(request);
  assert.deepEqual(plan.steps, [
    "crop",
    "zoom",
    "rotateFlip",
    "pixelate",
    "roundCorners",
    "animation",
    "encode",
  ]);
});

test("plan warns and drops xp for video sources", () => {
  const request = {
    source: "media",
    payload: { kind: "media", url: "https://example.com/x.mp4" },
    effects: { xp: true },
  };
  const plan = normalizeEffectPlan(request);
  assert.equal(plan.meta.removeBackground, false);
  assert.ok(plan.warnings.some((w) => w.includes("xp")));
});

test("plan keeps xp for ai source", () => {
  const request = {
    source: "ai",
    payload: { kind: "ai", prompt: "mèo" },
    effects: { xp: true },
  };
  const plan = normalizeEffectPlan(request);
  assert.equal(plan.meta.removeBackground, true);
});

test("plan only adds animation step when spin/speed present", () => {
  const base = {
    source: "media",
    payload: { kind: "media", url: "https://example.com/x.png" },
    effects: {},
  };
  assert.equal(normalizeEffectPlan(base).steps.includes("animation"), false);
  const withSpin = normalizeEffectPlan({ ...base, effects: { spin: true } });
  assert.equal(withSpin.steps.includes("animation"), true);
  const withSpeed = normalizeEffectPlan({ ...base, effects: { speed: 1.5 } });
  assert.equal(withSpeed.steps.includes("animation"), true);
});

test("plan text path renders text", () => {
  const plan = normalizeEffectPlan({
    source: "text",
    payload: { kind: "text", text: "Xin chào" },
    effects: {},
  });
  assert.deepEqual(plan.steps, ["renderText", "encode"]);
});

test("plan textvd path renders video", () => {
  const plan = normalizeEffectPlan({
    source: "textvd",
    payload: { kind: "textvd", color: "rainbow", text: "Hi" },
    effects: {},
  });
  assert.deepEqual(plan.steps, ["renderTextVideo", "encode"]);
});

test("plan keeps encode last", () => {
  const plan = normalizeEffectPlan({
    source: "media",
    payload: { kind: "media", url: "https://x.png" },
    effects: { pixel: 4, round: 30 },
  });
  assert.equal(plan.steps[plan.steps.length - 1], "encode");
});

test("plan preserves flipHorizontal and flipVertical from parser", () => {
  const plan = normalizeEffectPlan({
    source: "media",
    effects: { flipHorizontal: true, flipVertical: true },
  });
  assert.equal(plan.meta.flipHorizontal, true);
  assert.equal(plan.meta.flipVertical, true);
  assert.ok(plan.steps.includes("rotateFlip"));
});

test("applyStaticEffects: non-square wide, tall, and ultra-wide images with -r succeed and output 512x512", async () => {
  const { applyStaticEffects, STICKER_SIZE } = await import("../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/render.js");
  const sharp = (await import("sharp")).default;

  // 1. Wide image (800x400)
  const wideBuf = await sharp({
    create: { width: 800, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  const widePlan = normalizeEffectPlan({ source: "media", effects: { round: 20 } });
  const wideResult = await applyStaticEffects(wideBuf, widePlan);
  const wideMeta = await sharp(wideResult).metadata();
  assert.equal(wideMeta.width, STICKER_SIZE);
  assert.equal(wideMeta.height, STICKER_SIZE);
  assert.equal(wideMeta.hasAlpha, true);

  // 2. Tall image (300x700)
  const tallBuf = await sharp({
    create: { width: 300, height: 700, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
  }).png().toBuffer();
  const tallPlan = normalizeEffectPlan({ source: "media", effects: { round: 20 } });
  const tallResult = await applyStaticEffects(tallBuf, tallPlan);
  const tallMeta = await sharp(tallResult).metadata();
  assert.equal(tallMeta.width, STICKER_SIZE);
  assert.equal(tallMeta.height, STICKER_SIZE);
  assert.equal(tallMeta.hasAlpha, true);

  // 3. Ultra-wide image (1200x200)
  const ultraWideBuf = await sharp({
    create: { width: 1200, height: 200, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
  }).png().toBuffer();
  const ultraPlan = normalizeEffectPlan({ source: "media", effects: { round: 50, rotate: 45 } });
  const ultraResult = await applyStaticEffects(ultraWideBuf, ultraPlan);
  const ultraMeta = await sharp(ultraResult).metadata();
  assert.equal(ultraMeta.width, STICKER_SIZE);
  assert.equal(ultraMeta.height, STICKER_SIZE);
  assert.equal(ultraMeta.hasAlpha, true);
});

test("applyStaticEffects: proves fh actually flips pixels horizontally", async () => {
  const { applyStaticEffects } = await import("../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/render.js");
  const sharp = (await import("sharp")).default;

  // Create 2x1 image: left pixel is RED (255, 0, 0), right pixel is BLUE (0, 0, 255)
  const rawData = Buffer.from([
    255, 0, 0, 255, // Left: Red
    0, 0, 255, 255, // Right: Blue
  ]);
  const inputBuf = await sharp(rawData, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();

  const plan = normalizeEffectPlan({
    source: "media",
    effects: { cat: true, flipHorizontal: true },
  });
  const flippedBuf = await applyStaticEffects(inputBuf, plan);

  // Inspect raw pixel data of the 512x512 output
  const { data, info } = await sharp(flippedBuf).raw().toBuffer({ resolveWithObject: true });
  // Check left side (x = 50, y = 256) -> should now be Blue (B > R + 150)
  const leftIdx = (256 * info.width + 50) * 4;
  assert.ok(data[leftIdx + 2] > data[leftIdx] + 150, `left side must be dominantly Blue: R=${data[leftIdx]}, B=${data[leftIdx + 2]}`);

  // Check right side (x = 450, y = 256) -> should now be Red (R > B + 150)
  const rightIdx = (256 * info.width + 450) * 4;
  assert.ok(data[rightIdx] > data[rightIdx + 2] + 150, `right side must be dominantly Red: R=${data[rightIdx]}, B=${data[rightIdx + 2]}`);
});

test("applyStaticEffects: proves fv actually flips pixels vertically", async () => {
  const { applyStaticEffects } = await import("../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/render.js");
  const sharp = (await import("sharp")).default;

  // Create 1x2 image: top pixel is GREEN (0, 255, 0), bottom pixel is RED (255, 0, 0)
  const rawData = Buffer.from([
    0, 255, 0, 255,   // Top: Green
    255, 0, 0, 255,   // Bottom: Red
  ]);
  const inputBuf = await sharp(rawData, { raw: { width: 1, height: 2, channels: 4 } }).png().toBuffer();

  const plan = normalizeEffectPlan({
    source: "media",
    effects: { cat: true, flipVertical: true },
  });
  const flippedBuf = await applyStaticEffects(inputBuf, plan);

  const { data, info } = await sharp(flippedBuf).raw().toBuffer({ resolveWithObject: true });
  // Check top side (x = 256, y = 50) -> should now be Red (R > G + 150)
  const topIdx = (50 * info.width + 256) * 4;
  assert.ok(data[topIdx] > data[topIdx + 1] + 150, `top side must be dominantly Red: R=${data[topIdx]}, G=${data[topIdx + 1]}`);

  // Check bottom side (x = 256, y = 450) -> should now be Green (G > R + 150)
  const bottomIdx = (450 * info.width + 256) * 4;
  assert.ok(data[bottomIdx + 1] > data[bottomIdx] + 150, `bottom side must be dominantly Green: G=${data[bottomIdx + 1]}, R=${data[bottomIdx]}`);
});
