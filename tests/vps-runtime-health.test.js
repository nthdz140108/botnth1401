import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkRuntimeHealth } from '../deploy/runtime-health.mjs';

test('requires the running binary and served dashboard to match disk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-health-'));
  try {
    fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'dashboard');
    const command = async () => 'MainPID=123\nActiveState=active\n';
    const indexHash = createHash('sha256').update('dashboard').digest('hex');
    const hashFile = async file => file.endsWith('index.html') ? indexHash : 'same';
    const fetchImpl = async url => url.endsWith(':4173/') ? { status: 200, arrayBuffer: async () => Buffer.from('dashboard') } : { status: 401 };
    assert.equal(await checkRuntimeHealth({ root, binaryPath: '/bin/mybotd', command, hashFile, fetchImpl }), true);
    assert.equal(await checkRuntimeHealth({ root, binaryPath: '/bin/mybotd', command, hashFile: async file => file === '/proc/123/exe' ? 'old' : 'new', fetchImpl }), false);
    assert.equal(await checkRuntimeHealth({ root, binaryPath: '/bin/mybotd', command, hashFile, fetchImpl: async url => url.endsWith(':4173/') ? { status: 200, arrayBuffer: async () => Buffer.from('stale') } : { status: 401 } }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checks dashboard asset hashes as well as index HTML', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-assets-health-'));
  try {
    const dist = path.join(root, 'dashboard', 'dist'); fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    const html = '<script type="module" src="/assets/app-1.js"></script>';
    fs.writeFileSync(path.join(dist, 'index.html'), html); fs.writeFileSync(path.join(dist, 'assets', 'app-1.js'), 'new asset');
    const hashFile = async file => file.startsWith('/proc/') || file === '/bin/mybotd' ? 'binary' : createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const command = async () => 'MainPID=123\nActiveState=active\n';
    let asset = 'new asset';
    const fetchImpl = async url => ({ status: url.includes(':4174/') ? 401 : 200, arrayBuffer: async () => Buffer.from(url.endsWith('/') ? html : asset) });
    assert.equal(await checkRuntimeHealth({ root, binaryPath: '/bin/mybotd', command, hashFile, fetchImpl }), true);
    asset = 'stale asset';
    assert.equal(await checkRuntimeHealth({ root, binaryPath: '/bin/mybotd', command, hashFile, fetchImpl }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('accepts explicit loopback health endpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-health-urls-'));
  try {
    fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true }); fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'ok');
    const urls = [], digest = createHash('sha256').update('ok').digest('hex');
    const result = await checkRuntimeHealth({ root, binaryPath: '/bin/mybotd', dashboardUrl: 'http://127.0.0.1:14273/', bridgeUrl: 'http://127.0.0.1:14274/health', command: async () => 'MainPID=123\nActiveState=active\n', hashFile: async file => file.endsWith('index.html') ? digest : 'binary', fetchImpl: async url => { urls.push(url); return { status: url.includes('14274') ? 401 : 200, arrayBuffer: async () => Buffer.from('ok') }; } });
    assert.equal(result, true); assert.deepEqual(urls, ['http://127.0.0.1:14273/', 'http://127.0.0.1:14274/health']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
