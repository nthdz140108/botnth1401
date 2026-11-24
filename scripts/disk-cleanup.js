#!/usr/bin/env node

/**
 * Admin CLI script for automated SSD disk cleanup.
 *
 * Usage:
 *   node scripts/disk-cleanup.js --dry-run
 *   node scripts/disk-cleanup.js --run
 *   node scripts/disk-cleanup.js --status
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCleanupService, getDiskUsage } from '../src/runtime/disk-cleanup-service.js';
import { PM2Adapter } from '../src/runtime/pm2-adapter.js';
import { DiskCleanupCoordinator } from '../src/runtime/disk-cleanup-guardian.js';
import { evaluateCleanupHealth, readGuardianHeartbeat } from '../src/runtime/disk-cleanup-heartbeat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function formatBytes(bytes = 0) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function printSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isRun = args.includes('--run');
  const isStatus = args.includes('--status');

  if (!isDryRun && !isRun && !isStatus) {
    console.log(`
Usage:
  node scripts/disk-cleanup.js --dry-run   Scan and simulate disk cleanup without deleting files
  node scripts/disk-cleanup.js --run       Execute disk cleanup according to allowlist
  node scripts/disk-cleanup.js --status    Show last cleanup status and SSD metrics
`);
    process.exit(0);
  }

  const adapter = new PM2Adapter({ projectRoot: PROJECT_ROOT });
  const service = new DiskCleanupService({
    projectRoot: PROJECT_ROOT,
    adapter,
  });

  const coordinator = new DiskCleanupCoordinator({
    projectRoot: PROJECT_ROOT,
    service,
  });

  if (isStatus) {
    printSection('DISK CLEANUP STATUS');
    const st = service.status();
    const disk = await getDiskUsage(PROJECT_ROOT);
    const hb = readGuardianHeartbeat({ projectRoot: PROJECT_ROOT });
    const health = evaluateCleanupHealth({ status: st, heartbeat: hb, nowMs: Date.now() });

    console.log(`Health Evaluation   : ${health.toUpperCase()}`);
    console.log(`Current SSD Usage   : ${disk.usedPercent}% (Free: ${formatBytes(disk.free)} / Total: ${formatBytes(disk.total)})`);
    console.log(`Guardian Heartbeat  : ${hb?.guardianHeartbeatAt || st.guardianHeartbeatAt || 'None'}`);
    console.log(`Last Cleanup Run    : ${st.lastRun || 'Never'}`);
    console.log(`Last Daily Success  : ${st.lastDailySuccessAt || 'Never'}`);
    console.log(`Last Hourly Success : ${st.lastHourlySuccessAt || 'Never'}`);
    console.log(`Trigger Reason      : ${st.trigger || 'N/A'}`);
    console.log(`Status Result       : ${st.status || 'N/A'}`);
    console.log(`Inventory Complete  : ${st.inventoryComplete ?? 'N/A'}`);
    console.log(`Next Daily Run      : ${st.nextDailyRunAt || st.nextScheduledRun || '23:55 (Asia/Ho_Chi_Minh)'}`);
    console.log(`Total Bytes Freed   : ${formatBytes(st.bytesFreedTotal || 0)}`);
    console.log(`Total Files Freed   : ${st.filesFreedTotal || 0}`);

    if (st.bytesFreedByGroup) {
      console.log('\nBytes Freed By Group:');
      for (const [group, bytes] of Object.entries(st.bytesFreedByGroup)) {
        console.log(`  - ${group.padEnd(16)}: ${formatBytes(bytes)} (${st.filesFreedByGroup?.[group] || 0} files)`);
      }
    }

    if (st.warning) {
      console.log(`\n\x1b[33m[WARNING] ${st.warning}\x1b[0m`);
    }
    return;
  }

  if (isDryRun) {
    printSection('DISK CLEANUP SCAN (DRY RUN)');
    const disk = await getDiskUsage(PROJECT_ROOT);
    console.log(`Current SSD Usage   : ${disk.usedPercent}% (Free: ${formatBytes(disk.free)} / Total: ${formatBytes(disk.total)})`);

    const scan = await service.scan({ trigger: 'manual_dry_run', dryRun: true });
    console.log(`\nScan Candidates Found: ${scan.candidateFiles} files (${formatBytes(scan.candidateBytes)})`);

    console.log('\nCandidate Breakdown By Group:');
    for (const [group, bytes] of Object.entries(scan.candidateBytesByGroup)) {
      console.log(`  - ${group.padEnd(16)}: ${formatBytes(bytes)} (${scan.candidateFilesByGroup?.[group] || 0} files)`);
    }

    // Top 5 largest candidates
    const sorted = [...scan.candidates].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 5);
    if (sorted.length > 0) {
      console.log('\nTop Largest Cleanable Files:');
      for (const item of sorted) {
        const rel = path.relative(PROJECT_ROOT, item.path);
        console.log(`  - ${formatBytes(item.size).padStart(10)} : ${rel.length > 60 ? '...' + rel.slice(-57) : rel}`);
      }
    }

    console.log('\n[DRY RUN] No files were deleted or truncated.');
    return;
  }

  if (isRun) {
    printSection('EXECUTING DISK CLEANUP');
    const result = await coordinator.executeWithLock({
      trigger: 'manual_run',
      deadlineMs: 290_000,
    });

    if (!result.success && result.reason === 'lock_held') {
      console.log(`\x1b[31m[ERROR] Disk cleanup already running under PID ${result.pid}. Aborting.\x1b[0m`);
      process.exit(1);
    }

    console.log(`\nResult Status       : ${result.status}`);
    console.log(`Execution Duration  : ${result.durationMs}ms`);
    console.log(`SSD Before Cleanup  : ${result.diskBefore?.usedPercent}% (${formatBytes(result.diskBefore?.free)} free)`);
    console.log(`SSD After Cleanup   : ${result.diskAfter?.usedPercent}% (${formatBytes(result.diskAfter?.free)} free)`);
    console.log(`Total Bytes Freed   : ${formatBytes(result.bytesFreedTotal)}`);
    console.log(`Total Files Freed   : ${result.filesFreedTotal}`);
    console.log(`Locked/Deferred     : ${result.lockedFiles?.length || 0} locked, ${result.deferredFiles?.length || 0} deferred, ${result.skipped || 0} skipped`);
    console.log(`Errors Count        : ${result.errors?.length || 0}`);

    if (result.bytesFreedByGroup) {
      console.log('\nBytes Freed By Group:');
      for (const [group, bytes] of Object.entries(result.bytesFreedByGroup)) {
        console.log(`  - ${group.padEnd(16)}: ${formatBytes(bytes)} (${result.filesFreedByGroup?.[group] || 0} files)`);
      }
    }

    if (result.warning) {
      console.log(`\n\x1b[33m[WARNING] ${result.warning}\x1b[0m`);
    }

    if (result.status === 'error' || result.status === 'timed_out') {
      console.log(`\n\x1b[31m[FAILED] Disk cleanup ended with status '${result.status}'.\x1b[0m`);
      process.exit(1);
    } else if (result.status === 'partial') {
      console.log('\n\x1b[33m[PARTIAL] Disk cleanup completed with deferred or locked files.\x1b[0m');
      process.exit(0);
    } else {
      console.log('\n\x1b[32m[SUCCESS] Disk cleanup completed successfully.\x1b[0m');
      process.exit(0);
    }
  }
}

main().catch((err) => {
  console.error('[FATAL] Disk cleanup script failed:', err);
  process.exit(1);
});
