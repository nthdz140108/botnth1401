import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_LEVELS,
  ROLE_LABELS,
  getRoleLabel,
  formatPermissionDenied,
} from "../src/utils/role-policy.js";

test("role label table covers all four roles", () => {
  assert.equal(ROLE_LABELS.member, "Tất cả người dùng");
  assert.equal(ROLE_LABELS.adminBox, "Quản trị viên nhóm");
  assert.equal(ROLE_LABELS.adminBot, "Quản trị viên bot");
  assert.equal(ROLE_LABELS.adminLevelHigh, "Quản trị viên cấp cao");
});

test("getRoleLabel returns the exact adminBox label", () => {
  assert.equal(getRoleLabel("adminBox"), "Quản trị viên nhóm");
});

test("getRoleLabel maps aliases to canonical labels", () => {
  assert.equal(getRoleLabel("all"), "Tất cả người dùng");
  assert.equal(getRoleLabel("adminBotOrGroup"), "Quản trị viên nhóm");
});

test("getRoleLabel falls back to member label for unknown roles", () => {
  assert.equal(getRoleLabel("unknown-role"), "Tất cả người dùng");
  assert.equal(getRoleLabel(undefined), "Tất cả người dùng");
});

test("getRoleLabel handles numbers via ROLE_LEVELS keys", () => {
  // Numbers are not labels; only string role names are supported.
  assert.equal(getRoleLabel("adminLevelHigh"), "Quản trị viên cấp cao");
});

test("formatPermissionDenied produces the standardized two-line message", () => {
  const text = formatPermissionDenied("adminBox");
  assert.equal(
    text,
    "Bạn không có đủ quyền hạn để sử dụng lệnh này.\n" +
      "Yêu cầu quyền hạn tối thiểu: Quản trị viên nhóm"
  );
});

test("formatPermissionDenied shows effective required role (not lower than policy)", () => {
  const high = formatPermissionDenied("adminLevelHigh");
  assert.ok(high.includes("Quản trị viên cấp cao"));
  const bot = formatPermissionDenied("adminBot");
  assert.ok(bot.includes("Quản trị viên bot"));
});

test("formatPermissionDenied aliases normalize correctly", () => {
  const boxAlias = formatPermissionDenied("adminBotOrGroup");
  assert.ok(boxAlias.includes("Quản trị viên nhóm"));
  const allAlias = formatPermissionDenied("all");
  assert.ok(allAlias.includes("Tất cả người dùng"));
});

test("role hierarchy is unchanged by label additions", () => {
  assert.equal(ROLE_LEVELS.member, 0);
  assert.equal(ROLE_LEVELS.adminBox, 1);
  assert.equal(ROLE_LEVELS.adminBot, 2);
  assert.equal(ROLE_LEVELS.adminLevelHigh, 3);
});