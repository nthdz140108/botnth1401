import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STYLE,
  SAFE_COLORS,
  normalizeColor,
  normalizeSize,
  normalizeType,
  validateStyle,
  normalizeStyle,
  buildStyledMessagePayload,
} from "../src/commands/mybot/System/mybot-style.js";

test("style normalization and validation handles colors, sizes, and types", () => {
  // Color normalization
  assert.equal(normalizeColor("#db342e"), "db342e");
  assert.equal(normalizeColor("15a85f"), "15a85f");
  assert.equal(normalizeColor("fff"), "ffffff");
  assert.equal(normalizeColor("invalid_color"), DEFAULT_STYLE.color);

  // Size clamping between 10 and 24
  assert.equal(normalizeSize(8), 10);
  assert.equal(normalizeSize(18), 18);
  assert.equal(normalizeSize(30), 24);
  assert.equal(normalizeSize("invalid", 14), 14);

  // Type normalization
  assert.deepEqual(normalizeType(["bold", "italic"]), ["bold", "italic"]);
  assert.deepEqual(normalizeType("bold,underline"), ["bold", "underline"]);
  assert.deepEqual(normalizeType("none"), ["none"]);

  // Validation
  const valid = validateStyle({
    icon: "🤖",
    color: "db342e",
    size: { nameServer: 18, text: 14 },
    type: { nameServer: ["bold"], text: ["none"] },
  });
  assert.equal(valid.ok, true);

  const invalid = validateStyle({
    icon: "",
    color: "not_a_color",
    size: { nameServer: 5, text: 30 },
    type: { nameServer: ["invalid_type"] },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 4);
});

test("buildStyledMessagePayload renders header and applies styled offsets with plain fallback", () => {
  const customStyle = {
    icon: "👑",
    color: "15a85f",
    size: { nameServer: 20, text: 14 },
    type: { nameServer: ["bold", "underline"], text: ["none"] },
  };

  const payload = buildStyledMessagePayload({
    style: customStyle,
    nameServer: "Server Pro",
    senderName: "Admin",
    isGroup: true,
    text: "Lệnh hoàn tất thành công!",
    stateIcon: "✅✅✅",
  });

  assert.ok(payload.msg.includes("Admin\n👑 Server Pro\nLệnh hoàn tất thành công!\n✅✅✅"));
  assert.ok(payload.style);
  assert.equal(payload.ttl, 60000);

  // Plain fallback
  const plainPayload = buildStyledMessagePayload({
    style: customStyle,
    nameServer: "Server Pro",
    text: "Test plain",
    plain: true,
  });

  assert.equal(plainPayload.style, undefined);
  assert.ok(plainPayload.msg.includes("👑 Server Pro\nTest plain"));
});
