/**
 * Memory Guardian — background RAM monitor for VPS 2 vCPU / 4 GB.
 *
 * Runs under PM2. Checks system RAM every 15 seconds.
 *
 * Warning level (RAM >= 80% OR free < 800 MB):
 *   - Select bot with highest RSS
 *   - Send GC request via pressure flag
 *   - 5-minute cooldown per bot
 *
 * Critical level (after cleanup still >= 90% OR free < 400 MB):
 *   - Restart heaviest bot, one at a time
 *   - Wait for RAM to stabilize before next
 *   - Priority: child > main > dashboard
 *
 * All thresholds are configurable via env vars.
 *
 * Metrics (heap, RSS, external, free RAM, GC time) are logged to system log.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MemoryGuardian, getSystemMemory, formatBytes } from './memory-guardian-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

async function main() {
  const guardian = new MemoryGuardian({ projectRoot: PROJECT_ROOT });
  console.log(`[GUARDIAN] Memory & Disk guardian started (RAM check every ${guardian.checkIntervalMs / 1000}s)`);
  console.log(`  RAM: warn=${guardian.warnPercent}%/${formatBytes(guardian.warnFreeMB)} free, critical=${guardian.criticalPercent}%/${formatBytes(guardian.criticalFreeMB)} free`);
  console.log(`  GC cooldown: ${guardian.gcCooldownMs / 1000}s per bot`);
  if (guardian.diskCoordinator) {
    console.log(`  SSD Cleanup: warn=${guardian.diskCoordinator.warnPercent}%, critical=${guardian.diskCoordinator.criticalPercent}%, daily session=23:55 (Asia/Ho_Chi_Minh)`);
  }

  const shutdown = () => {
    guardian.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  guardian.start();

  // Keep alive
  await new Promise(() => {});
}

// Only run main() if this is the entry point (not imported for tests)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('memory-guardian.js') ||
  process.argv[1].endsWith('memory-guardian-core.js')
);
if (isMain) {
  main().catch(err => {
    console.error('[GUARDIAN] Fatal:', err.message);
    process.exit(1);
  });
}

export { MemoryGuardian, getSystemMemory, formatBytes };
