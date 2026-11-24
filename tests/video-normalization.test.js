import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLocalVideoMedia } from '../src/service-debug/chat-zalo/chat-special/send-video/video-media-prepare.js';

test('incompatible video converts once then probes final bytes and extracts first frame', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-video-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.webm');
  await fs.writeFile(source, 'webm bytes');
  const calls = [];
  const runTool = async (binary, args) => {
    calls.push({ binary, args });
    const target = args.at(-1);
    if (binary === 'ffprobe') return { stdout: JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: target === source ? 'vp9' : 'h264', width: 180, height: 320 }, { codec_type: 'audio', codec_name: target === source ? 'opus' : 'aac' }],
      format: { duration: '0.407', format_name: target === source ? 'matroska,webm' : 'mov,mp4', size: '999999' },
    }) };
    await fs.writeFile(target, target.endsWith('.jpg') ? 'jpeg' : 'converted mp4');
    return { stdout: '' };
  };
  const prepared = await prepareLocalVideoMedia(source, { normalize: true, tempDirectory: dir, runTool });
  assert.notEqual(prepared.filePath, source);
  assert.deepEqual(prepared.metadata, { duration: 407, width: 180, height: 320, fileSize: 13 });
  const conversion = calls.find(c => c.args.includes('libx264'));
  assert.ok(conversion.args.includes('aac'));
  assert.ok(conversion.args.includes('+faststart'));
  const frame = calls.find(c => c.args.includes('-vframes'));
  assert.equal(frame.args.includes('-ss'), false);
  assert.equal(frame.args[frame.args.indexOf('-i') + 1], prepared.filePath);
});
