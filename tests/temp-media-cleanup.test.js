import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { DiskCleanupService, STALE_TEMP_MIN_AGE_MS } from '../src/runtime/disk-cleanup-service.js';
import { DiskCleanupCoordinator } from '../src/runtime/disk-cleanup-guardian.js';

function computeSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('Media temp cleaner: cleans stale MP3/MP4 under temp allowlist and protects media/data', async (t) => {
  const tmpRoot = path.join(os.tmpdir(), `mybot-media-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const tempDir = path.join(tmpRoot, 'assets', 'temp');
  const mediaDir = path.join(tmpRoot, 'media');
  const videoDir = path.join(tmpRoot, 'video');
  const assetsDataDir = path.join(tmpRoot, 'assets', 'data');

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(assetsDataDir, { recursive: true });

  const statusPath = path.join(tmpRoot, 'status.json');
  const observationsPath = path.join(tmpRoot, 'observations.json');

  let currentTime = 1791650000000;
  const now = () => currentTime;

  // Protected files
  const linhcuteFile = path.join(tmpRoot, 'linhcute.mp3');
  fs.writeFileSync(linhcuteFile, 'protected-linhcute-mp3-audio-bytes');
  const linhcuteHash = computeSha256(linhcuteFile);

  const protectedMediaAudio = path.join(mediaDir, 'song.mp3');
  fs.writeFileSync(protectedMediaAudio, 'protected-song-mp3-bytes');
  const mediaHash = computeSha256(protectedMediaAudio);

  const protectedVideo = path.join(videoDir, 'clip.mp4');
  fs.writeFileSync(protectedVideo, 'protected-clip-mp4-bytes');
  const videoHash = computeSha256(protectedVideo);

  const protectedDataAudio = path.join(assetsDataDir, 'sound.mp3');
  fs.writeFileSync(protectedDataAudio, 'protected-data-sound-bytes');
  const dataHash = computeSha256(protectedDataAudio);

  // Cleanable files in temp
  const staleMp3 = path.join(tempDir, 'old_download.mp3');
  fs.writeFileSync(staleMp3, 'stale-temp-download-mp3');
  // Set mtime to 3 hours ago
  const staleMtime = currentTime - (3 * 3600 * 1000);
  fs.utimesSync(staleMp3, staleMtime / 1000, staleMtime / 1000);

  const staleMp4 = path.join(tempDir, 'old_video.mp4');
  fs.writeFileSync(staleMp4, 'stale-temp-download-mp4');
  fs.utimesSync(staleMp4, staleMtime / 1000, staleMtime / 1000);

  const freshMp3 = path.join(tempDir, 'recent.mp3');
  fs.writeFileSync(freshMp3, 'fresh-recent-mp3');
  // mtime is 10 minutes ago (< 2h)
  fs.utimesSync(freshMp3, (currentTime - 600_000) / 1000, (currentTime - 600_000) / 1000);

  const nonMediaTemp = path.join(tempDir, 'debug.txt');
  fs.writeFileSync(nonMediaTemp, 'do-not-delete-in-media-only-mode');

  const service = new DiskCleanupService({
    projectRoot: tmpRoot,
    statusPath,
    observationsPath,
    now,
  });

  const coordinator = new DiskCleanupCoordinator({
    projectRoot: tmpRoot,
    service,
    now,
  });

  // 1. First run: unobserved temp files must be deferred
  const res1 = await coordinator.executeMediaTempWithLock({ dryRun: false });
  assert.equal(res1.status, 'partial', 'First run should be partial because temp files are deferred');
  assert.equal(res1.deletedFiles, 0, 'No files should be deleted on first observation');
  assert.ok(fs.existsSync(staleMp3), 'staleMp3 must still exist after pass 1');
  assert.ok(fs.existsSync(staleMp4), 'staleMp4 must still exist after pass 1');
  assert.ok(fs.existsSync(freshMp3), 'freshMp3 must still exist after pass 1');
  assert.ok(fs.existsSync(nonMediaTemp), 'nonMediaTemp must never be touched');

  // Verify protected files untouched
  assert.equal(computeSha256(linhcuteFile), linhcuteHash);
  assert.equal(computeSha256(protectedMediaAudio), mediaHash);
  assert.equal(computeSha256(protectedVideo), videoHash);
  assert.equal(computeSha256(protectedDataAudio), dataHash);

  // 2. Second run: stale files (>=2 obs, >=2h old) are deleted, fresh is kept
  currentTime += 60_000; // 1 minute later
  const res2 = await coordinator.executeMediaTempWithLock({ dryRun: false });
  assert.equal(res2.deletedFiles, 2, 'Must delete exactly the 2 stale media files (mp3 + mp4)');
  assert.equal(fs.existsSync(staleMp3), false, 'staleMp3 must be deleted');
  assert.equal(fs.existsSync(staleMp4), false, 'staleMp4 must be deleted');
  assert.equal(fs.existsSync(freshMp3), true, 'freshMp3 (<2h old) must remain deferred');
  assert.equal(fs.existsSync(nonMediaTemp), true, 'nonMediaTemp must remain untouched in media-only mode');

  // Verify protected files checksums are 100% identical
  assert.equal(computeSha256(linhcuteFile), linhcuteHash, 'linhcute.mp3 must remain untouched');
  assert.equal(computeSha256(protectedMediaAudio), mediaHash, 'media/song.mp3 must remain untouched');
  assert.equal(computeSha256(protectedVideo), videoHash, 'video/clip.mp4 must remain untouched');
  assert.equal(computeSha256(protectedDataAudio), dataHash, 'assets/data/sound.mp3 must remain untouched');

  // 3. Dry run verification: does not delete anything
  const dryStale = path.join(tempDir, 'dry_stale.mp3');
  fs.writeFileSync(dryStale, 'dry-stale-content');
  fs.utimesSync(dryStale, (currentTime - 4 * 3600 * 1000) / 1000, (currentTime - 4 * 3600 * 1000) / 1000);

  const dryRes = await coordinator.executeMediaTempWithLock({ dryRun: true });
  assert.equal(dryRes.deletedFiles, 0, 'Dry run must not delete files');
  assert.ok(fs.existsSync(dryStale), 'dryStale must remain intact after dry run');

  // Cleanup test tmp
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('CLI scripts/temp-media-cleanup.js rejects arbitrary root options', () => {
  const scriptPath = path.resolve('scripts/temp-media-cleanup.js');

  const res = spawnSync(process.execPath, [scriptPath, '--run', '--root', 'C:\\Windows'], {
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0, 'Must exit with non-zero when arbitrary root is provided');
  assert.match(res.stderr + res.stdout, /arbitrary root/i, 'Must report arbitrary root rejection');
});
