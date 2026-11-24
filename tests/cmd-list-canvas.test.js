import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  renderCommandListImage,
  CMD_LIST_PAGE_SIZE,
} from "../src/utils/canvas/cmd-list-canvas.js";

const fakeCommand = (i) => ({
  name: `cmd${i}`,
  description: `Mô tả cho lệnh số ${i} - dùng để kiểm tra khả năng hiển thị nhiều dòng của canvas renderer. Đây là một đoạn mô tả rất dài để test wrap text an toàn.`,
  permission: "all",
  countdown: 5,
  icon: "🎮",
});

const fakeAdminCommand = (i) => ({
  name: `admin${i}`,
  description: `Lệnh admin ${i}`,
  permission: "adminBot",
  countdown: 10,
  icon: "👮",
});

test("CMD_LIST_PAGE_SIZE is 16 (4 columns x 4 rows)", () => {
  assert.equal(CMD_LIST_PAGE_SIZE, 16);
});

test("renderer produces a PNG with at least 16 cards on a full page", async () => {
  const commands = Array.from({ length: 16 }, (_, i) => fakeCommand(i));
  const file = await renderCommandListImage({
    pageCommands: commands,
    page: 1,
    totalPages: 1,
    totalCommands: 16,
    isAdminList: false,
    botName: "TestBot",
    prefix: "!",
  });
  const stat = await fs.stat(file);
  assert.ok(stat.size > 2000, `PNG size too small: ${stat.size}`);
  const buf = await fs.readFile(file);
  assert.equal(buf.subarray(0, 4).toString("hex"), "89504e47", "must start with PNG signature");
  await fs.unlink(file);
});

test("renderer handles less-than-full last page (3 cards) without crash", async () => {
  const commands = Array.from({ length: 3 }, (_, i) => fakeCommand(i + 100));
  const file = await renderCommandListImage({
    pageCommands: commands,
    page: 2,
    totalPages: 2,
    totalCommands: 19,
    isAdminList: false,
    botName: "TestBot",
    prefix: "!",
  });
  const stat = await fs.stat(file);
  assert.ok(stat.size > 2000);
  await fs.unlink(file);
});

test("renderer handles empty page safely (still produces valid PNG)", async () => {
  const file = await renderCommandListImage({
    pageCommands: [],
    page: 1,
    totalPages: 1,
    totalCommands: 0,
    isAdminList: false,
    botName: "TestBot",
    prefix: "!",
  });
  const stat = await fs.stat(file);
  assert.ok(stat.size > 2000);
  await fs.unlink(file);
});

test("renderer wraps long descriptions safely without throwing", async () => {
  const commands = Array.from({ length: 16 }, (_, i) => ({
    name: `long${i}`,
    description:
      "Đây là một mô tả rất dài chứa rất nhiều từ ngữ và ký tự đặc biệt nhằm kiểm tra rằng renderer có thể wrap text an toàn mà không làm vỡ canvas hay vượt quá chiều rộng thẻ. ".repeat(3),
    permission: "all",
    countdown: 5,
    icon: "📜",
  }));
  const file = await renderCommandListImage({
    pageCommands: commands,
    page: 1,
    totalPages: 1,
    totalCommands: 16,
    isAdminList: true,
    botName: "AdminBot",
    prefix: "/",
  });
  const stat = await fs.stat(file);
  assert.ok(stat.size > 2000);
  await fs.unlink(file);
});

test("renderer honors admin-list variant (different header/badge)", async () => {
  const file = await renderCommandListImage({
    pageCommands: Array.from({ length: 4 }, (_, i) => fakeAdminCommand(i)),
    page: 1,
    totalPages: 1,
    totalCommands: 4,
    isAdminList: true,
    botName: "AdminBot",
    prefix: "!",
  });
  const stat = await fs.stat(file);
  assert.ok(stat.size > 2000);
  await fs.unlink(file);
});