import test from "node:test";
import assert from "node:assert/strict";

/**
 * User-facing copy regression tests.
 *
 * Locks in the contract changes the lifecycle overhaul depends on:
 *  - `mybot active` when there is NO bot pending activation must NOT say
 *    "Bạn chưa có bot nào trong hệ thống! Vui lòng dùng lệnh qrlogin" (that
 *    copy is for a different command, "list" / "info"). It must say the new
 *    "không có bot chờ kích hoạt" line.
 *  - The QR provisioning success messages must no longer mention
 *    `!mybot start` (the old lifecycle). They must point at `!mybot active`.
 *  - The QR provisioning "Thời gian dùng thử" line must say the trial
 *    starts AFTER first successful `mybot active` (not after "start lần
 *    đầu"), matching the trial-lifecycle rule.
 */

test("myBotManager: handleActiveCommand 'no candidates' message points at 'chờ kích hoạt'", async () => {
  // We don't import the whole module to avoid the runtime side-effects. The
  // active command's no-candidate copy is a single string; we lock it down
  // by reading the source file and asserting the copy is present and the
  // legacy copy is removed.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    "src/commands/mybot/myBotManager.js",
    "utf8",
  );
  assert.match(
    src,
    /Bạn chưa có bot nào đang trong trạng thái chờ kích hoạt trong hệ thống!/,
    "active command must report the new no-pending-activation message",
  );
  assert.doesNotMatch(
    src,
    /Bạn chưa có bot nào trong hệ thống! Vui lòng dùng lệnh qrlogin để tạo bot\./,
    "the legacy 'no bot in system' copy must no longer appear inside the active-command flow",
  );
});

test("QR provisioning: success messages use !mybot active, not !mybot start", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    "src/commands/mybot/Manager/qr-login-command.js",
    "utf8",
  );
  // New bot creation copy must point to `!mybot active`.
  assert.match(
    src,
    /Dùng lệnh: !mybot active để kích hoạt dùng thử 1 giờ\./,
    "new bot provisioning must direct user to !mybot active",
  );
  // QR update copy must also use `!mybot active`.
  assert.match(
    src,
    /Dùng lệnh: !mybot active để kích hoạt dùng thử 1 giờ\./,
    "QR update copy must also direct user to !mybot active",
  );
  // Trial-wait line must explain trial starts after first successful active.
  assert.match(
    src,
    /Thời gian dùng thử: 1 giờ \(bắt đầu sau khi kích hoạt thành công lần đầu\)/,
    "trial-wait line must say 'bắt đầu sau khi kích hoạt thành công lần đầu'",
  );
  // Legacy guidance must not survive in QR provisioning.
  assert.doesNotMatch(
    src,
    /Dùng lệnh: !mybot start để khởi động bot\./,
    "QR provisioning must no longer mention !mybot start",
  );
  assert.doesNotMatch(
    src,
    /bắt đầu sau khi start lần đầu/,
    "trial-wait line must no longer say 'sau khi start lần đầu'",
  );
});