#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacyMyBotIdentities } from "../src/commands/mybot/System/mybot-migration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

console.log(`[Migration] Bắt đầu migration chuẩn hóa identity seed và owner cho MyBot tại: ${projectRoot}`);

try {
  const result = await migrateLegacyMyBotIdentities({ projectRoot, backup: true });
  console.log(`[Migration] Hoàn tất!`);
  console.log(`  - Tổng số bot: ${result.totalCount}`);
  console.log(`  - Số record đã sửa / backfill: ${result.repairedCount || result.migratedCount}`);
  console.log(`  - Số record tự sở hữu / chưa có bằng chứng người tạo: ${result.unresolvedCount}`);
  if (result.backupPath) {
    console.log(`  - Backup registry đã lưu tại: ${result.backupPath}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`[Migration] Thất bại:`, error);
  process.exit(1);
}
