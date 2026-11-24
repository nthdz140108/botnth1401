#!/usr/bin/env node

/**
 * CLI script for automated cleanup of temporary MP3 and MP4 media files.
 *
 * Uses the shared DiskCleanupCoordinator and DiskCleanupService observation store.
 * Does NOT accept arbitrary root options — strictly bounded by the project temp allowlist.
 *
 * Usage:
 *   node scripts/temp-media-cleanup.js --dry-run
 *   node scripts/temp-media-cleanup.js --run
 *   node scripts/temp-media-cleanup.js --dry-run --json
 *   node scripts/temp-media-cleanup.js --run --json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCleanupService } from '../src/runtime/disk-cleanup-service.js';
import { DiskCleanupCoordinator } from '../src/runtime/disk-cleanup-guardian.js';
import { PM2Adapter } from '../src/runtime/pm2-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function formatBytes(bytes = 0) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isRun = args.includes('--run');
  const isJson = args.includes('--json');

  // Reject arbitrary root options
  const hasArbitraryRoot = args.some((arg) => (
    /^--(root|path|dir|folder)(=|$)/i.test(arg) ||
    arg === '-r' ||
    arg === '-d'
  ));

  if (hasArbitraryRoot) {
    const errorMsg = 'Arbitrary root options are not permitted. Only predefined temp allowlist roots are processed.';
    if (isJson) {
      console.log(JSON.stringify({ status: 'error', error: errorMsg, inventoryComplete: false }));
    } else {
      console.error(`\x1b[31m[ERROR] ${errorMsg}\x1b[0m`);
    }
    process.exit(1);
  }

  if (!isDryRun && !isRun) {
    if (isJson) {
      console.log(JSON.stringify({ error: 'Missing --dry-run or --run flag' }));
    } else {
      console.log(`
Usage:
  node scripts/temp-media-cleanup.js --dry-run [--json]   Scan and report eligible temp MP3/MP4 files
  node scripts/temp-media-cleanup.js --run [--json]       Delete eligible stale temp MP3/MP4 files (>=2h, >=2 observations)
`);
    }
    process.exit(1);
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

  const result = await coordinator.executeMediaTempWithLock({
    dryRun: isDryRun,
    deadlineMs: 60_000,
  });

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n' + '='.repeat(60));
    console.log(`  TEMP MEDIA CLEANUP (${isDryRun ? 'DRY RUN' : 'EXECUTION'})`);
    console.log('='.repeat(60));
    console.log(`Status Result        : ${result.status}`);
    console.log(`Inventory Complete   : ${result.inventoryComplete}`);
    console.log(`Candidate Files      : ${result.candidateFiles} (${formatBytes(result.candidateBytes)})`);
    console.log(`Deleted Files        : ${result.deletedFiles} (${formatBytes(result.deletedBytes)})`);
    console.log(`Deferred Files       : ${result.deferred?.length || 0}`);
    console.log(`Protected Skipped    : ${result.protectedSkipped || 0}`);
    console.log(`Errors Count         : ${result.errors?.length || 0}`);
    console.log(`Started At           : ${result.startedAt}`);
    console.log(`Finished At          : ${result.finishedAt}`);

    if (result.deferred?.length > 0) {
      console.log('\nDeferred Files Breakdown:');
      for (const item of result.deferred.slice(0, 10)) {
        const rel = path.relative(PROJECT_ROOT, item.path);
        console.log(`  - [${item.reason}] ${rel}`);
      }
      if (result.deferred.length > 10) {
        console.log(`  ... and ${result.deferred.length - 10} more`);
      }
    }

    if (result.errors?.length > 0) {
      console.log('\nErrors:');
      for (const err of result.errors) {
        console.log(`  - ${err.error || err.message || JSON.stringify(err)}`);
      }
    }
  }

  // Exit code: non-zero for error, timed_out, or incomplete inventory
  if (result.status === 'error' || result.status === 'timed_out' || !result.inventoryComplete) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL] Temp media cleanup failed:', err);
  process.exit(1);
});
