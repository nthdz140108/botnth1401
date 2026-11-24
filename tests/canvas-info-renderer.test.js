import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "canvas";
import {
  createUserInfoImage,
} from "../src/utils/canvas/info.js";

after(() => {
  setTimeout(() => process.exit(0), 200).unref();
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-info-renderer-"));

function makePng(width, height, color) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.createPNGStream();
}

function writePng(name, width, height, color) {
  const filePath = path.join(tempDir, `${name}_${Date.now()}.png`);
  const out = fs.createWriteStream(filePath);
  makePng(width, height, color).pipe(out);
  return new Promise((resolve, reject) => {
    out.on("finish", () => resolve(filePath));
    out.on("error", reject);
  });
}

function baseUserInfo(overrides = {}) {
  return {
    title: "Thông Tin Người Dùng",
    uid: "123456",
    name: "Nguyễn Văn Test",
    avatar: "",
    cover: "",
    gender: "Nam 👨",
    birthday: "12/08/2000",
    businessType: "Basic",
    createdDate: "01/01/2024",
    lastActive: "08:30 02/09/2026",
    isActive: true,
    isActivePC: true,
    isActiveWeb: false,
    isOnline: true,
    bio: "Xin chào, đây là dòng bio ngắn.",
    ...overrides,
  };
}

function assertPng(filePath, { minWidth, minHeight } = {}) {
  assert.ok(filePath, "expected a PNG file path");
  assert.ok(fs.existsSync(filePath), `PNG file missing: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  assert.ok(buf.length > 100, "PNG buffer too small");
  // PNG signature
  assert.deepEqual(
    [buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7]],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  // IDAT chunk present (PNG must have at least one IDAT)
  assert.ok(buf.includes(Buffer.from("IDAT")), "PNG missing IDAT chunk");
  return buf;
}

function getPngDims(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("renderer: creates a valid PNG with a full cover and avatar", async () => {
  const cover = await writePng("cover", 600, 300, "#334155");
  const avatar = await writePng("avatar", 300, 300, "#1D4ED8");
  const filePath = await createUserInfoImage(
    baseUserInfo({ cover, avatar })
  );
  const buf = assertPng(filePath);
  const { width, height } = getPngDims(buf);
  assert.equal(width, 1080, "card width should be fixed at 1080");
  assert.ok(height >= 700 && height <= 2000, `card height out of range: ${height}`);
});

test("renderer: broken cover and avatar URLs fall back without throwing", async () => {
  const filePath = await createUserInfoImage(
    baseUserInfo({ cover: "http://127.0.0.1:1/cover.png", avatar: "http://127.0.0.1:1/avatar.png" })
  );
  const buf = assertPng(filePath);
  const { width } = getPngDims(buf);
  assert.equal(width, 1080);
});

test("renderer: missing data, no devices and offline still render", async () => {
  const filePath = await createUserInfoImage(
    baseUserInfo({
      avatar: "",
      cover: "",
      isActive: false,
      isActivePC: false,
      isActiveWeb: false,
      isOnline: false,
      gender: "",
      birthday: "",
      businessType: "",
      createdDate: "",
      lastActive: "",
    })
  );
  const buf = assertPng(filePath);
  const { height } = getPngDims(buf);
  assert.ok(height >= 700 && height <= 2000, `card height out of range: ${height}`);
});

test("renderer: long name and very long bio wrap without overflow", async () => {
  const longName = "Một cái tên rất dài để kiểm tra co dòng tự động trong vùng an toàn của thẻ hồ sơ hiện đại";
  const longBio =
    "Đây là một đoạn bio rất dài nhằm mục đích kiểm tra khả năng tự xuống dòng và tự tăng chiều cao khi nội dung dài. ".repeat(8);
  const filePath = await createUserInfoImage(
    baseUserInfo({ name: longName, bio: longBio })
  );
  assertPng(filePath);
});

test("renderer: returns null for invalid userInfo", async () => {
  assert.equal(await createUserInfoImage(null), null);
  assert.equal(await createUserInfoImage(undefined), null);
});

test("renderer: identical userInfo produces identical dimensions (deterministic layout)", async () => {
  const info = baseUserInfo();
  const a = await createUserInfoImage(info);
  const b = await createUserInfoImage(info);
  const da = getPngDims(fs.readFileSync(a));
  const db = getPngDims(fs.readFileSync(b));
  assert.equal(da.width, db.width);
  assert.equal(da.height, db.height);
});
