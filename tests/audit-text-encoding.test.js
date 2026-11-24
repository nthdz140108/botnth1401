import test from "node:test";
import assert from "node:assert/strict";
import { scanText, scanBuffer } from "../scripts/audit-text-encoding.js";

test("scanner detects single-layer mojibake (double-encoded Ã´ng)", () => {
  const result = scanText('console.log("Ã´ng tÃ¡c");');
  assert.ok(result.length >= 1, "should detect double-encoded Ã´ng");
  assert.equal(result[0].type, "DOUBLE_ENCODE");
});

test("scanner detects multi-layer mojibake (Lá»‡nh+Ã¡+á»‹+á»«)", () => {
  const result = scanText('const msg = `Lá»‡nh "${x}" chÆ°a cÃ³ chÃ­nh sÃ¡ch quyá»n`;');
  assert.ok(result.length >= 1, "should detect multi-layer mojibake");
  assert.equal(result[0].type, "DOUBLE_ENCODE");
});

test("scanner detects U+FFFD replacement character", () => {
  const result = scanText("Kh\u00F3ng th\u00FD d\uFFFD li\u00EAu h\u1EE3p l\u00E9.");
  assert.ok(result.length >= 1, "should detect U+FFFD");
  assert.equal(result[0].type, "U+FFFD");
});

test("scanner detects lossy ?-replacement (multiple mid-word ?)", () => {
  const result = scanText("L?i khi t?i video t? API");
  assert.ok(result.length >= 1, "should detect lossy ? replacement");
  assert.equal(result[0].type, "LOSSY_?");
});

test("scanner does NOT flag valid Vietnamese", () => {
  const valid = [
    "Âm lịch hôm nay trời đẹp",
    "ĐÃ HOÀN THÀNH công việc",
    "HÃY cùng nhau học tập",
    "Chào bạn, tôi là bot!",
    "Tỉ lệ thắng: 50%",
    "Kết quả Chẵn Lẻ không hợp lệ.",
    "Lỗi khi tải video từ API",
  ];
  for (const text of valid) {
    const result = scanText(text);
    assert.equal(
      result.length, 0,
      `should not flag valid Vietnamese: "${text}" got ${JSON.stringify(result)}`
    );
  }
});

test("scanner does NOT flag URL query strings", () => {
  const urls = [
    "const url = 'https://api.example.com/search?q=test';",
    "const url = `https://example.com/watch?v=${id}&list=pl`;",
    "const url = 'https://api.com/valuation?sdt=123';",
    "const url = 'https://hoangdev.io.vn/media/lamnet?input_url=xxx';",
    "const url = 'https://music.nhaccuatui.com/flash/xml?html5=true&key1=abc';",
    "const regex = /\\.(jpe?g|png|webp)$/i;",
  ];
  for (const text of urls) {
    const result = scanText(text);
    assert.equal(
      result.length, 0,
      `should not flag URL query string: "${text}" got ${JSON.stringify(result)}`
    );
  }
});

test("scanner detects BOM", () => {
  const text = "\uFEFFconst x = 1;";
  const result = scanText(text);
  assert.ok(result.some((v) => v.type === "BOM"), "should detect BOM");
});

test("scanner detects invalid UTF-8 bytes", () => {
  const buf = Buffer.from([0xff, 0xfe, 0x00, 0x68, 0x69]); // UTF-16LE BOM as UTF-8
  const result = scanBuffer(buf);
  assert.ok(result.length >= 1, "should detect invalid UTF-8");
  assert.equal(result[0].type, "INVALID_UTF8");
});

test("scanner does NOT flag empty string", () => {
  assert.equal(scanText("").length, 0);
});

test("scanner does NOT flag ASCII-only string", () => {
  assert.equal(scanText("hello world").length, 0);
});