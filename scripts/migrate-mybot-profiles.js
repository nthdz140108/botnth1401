#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateBotProfiles } from "../src/commands/mybot/System/mybot-profile-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

console.log(`[Migration] Starting MyBot profile migration for root: ${projectRoot}`);

try {
  const migrated = migrateBotProfiles({ root: projectRoot });
  console.log(`[Migration] Successfully checked / migrated ${migrated.length} bot profiles.`);
  for (const p of migrated) {
    console.log(`  - Bot ${p.botId}: server="${p.nameServer}", owner="${p.ownerName}", trialStatus="${p.trialStatus}"`);
  }
  process.exit(0);
} catch (error) {
  console.error(`[Migration] Migration failed:`, error);
  process.exit(1);
}
