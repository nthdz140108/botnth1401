import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
async function systemdInfo() { return (await execFileAsync('systemctl', ['show', 'mybot.service', '-p', 'ActiveState', '-p', 'MainPID'], { timeout: 10000 })).stdout; }
async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function checkRuntimeHealth({ root, binaryPath, dashboardUrl = 'http://127.0.0.1:4173/', bridgeUrl = 'http://127.0.0.1:4174/health', command = systemdInfo, hashFile = digestFile, fetchImpl = fetch }) {
  try {
    const dashboard = new URL(dashboardUrl), bridgeAddress = new URL(bridgeUrl);
    if (dashboard.protocol !== 'http:' || bridgeAddress.protocol !== 'http:' || dashboard.hostname !== '127.0.0.1' || bridgeAddress.hostname !== '127.0.0.1') return false;
    const info = Object.fromEntries((await command()).trim().split(/\r?\n/).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (info.ActiveState !== 'active' || !/^[1-9]\d*$/.test(info.MainPID)) return false;
    if (await hashFile(`/proc/${info.MainPID}/exe`) !== await hashFile(binaryPath)) return false;
    const indexFile = path.join(root, 'dashboard', 'dist', 'index.html');
    const expected = await hashFile(indexFile);
    const page = await fetchImpl(dashboardUrl, { signal: AbortSignal.timeout(5000) });
    if (page.status !== 200) return false;
    const html = Buffer.from(await page.arrayBuffer());
    const actual = createHash('sha256').update(html).digest('hex');
    if (actual !== expected) return false;
    const assets = [...html.toString('utf8').matchAll(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/g)].map(match => match[1]);
    if (assets.length > 100) return false;
    for (const asset of new Set(assets)) {
      if (!/^\/assets\/[A-Za-z0-9._/-]+$/.test(asset) || asset.split('/').includes('..')) return false;
      const disk = path.join(root, 'dashboard', 'dist', ...asset.split('/').filter(Boolean));
      const response = await fetchImpl(new URL(asset, dashboard).href, { signal: AbortSignal.timeout(5000) });
      if (response.status !== 200 || createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== await hashFile(disk)) return false;
    }
    const bridge = await fetchImpl(bridgeUrl, { signal: AbortSignal.timeout(5000) });
    return bridge.status === 200 || bridge.status === 401;
  } catch { return false; }
}
