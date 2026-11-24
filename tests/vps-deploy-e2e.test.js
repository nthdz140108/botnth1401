import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeReleaseWrapper } from '../deploy/release-wrapper.mjs';

test('locked worker applies and rolls back a JS patch with isolated PM2', { skip: process.platform === 'win32' || process.env.MYBOT_PM2_INTEGRATION !== '1', timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-e2e-'));
  const previousPm2Home = process.env.PM2_HOME, home = path.join(root, 'pm2-home'); process.env.PM2_HOME = home;
  let daemon, dashboard, bridge;
  try {
    const base = 'a'.repeat(40), target = 'b'.repeat(40), release = path.join(root, 'releases', base), bin = path.join(root, 'usr-bin'), pkg = path.join(root, 'payload');
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(path.join(root, 'dashboard')); fs.mkdirSync(path.join(root, 'mybot')); fs.mkdirSync(bin);
    fs.mkdirSync(path.join(release, 'src'), { recursive: true }); fs.mkdirSync(path.join(release, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(release, 'bin'));
    fs.mkdirSync(path.join(release, 'dashboard', 'src')); fs.mkdirSync(path.join(release, 'dashboard', 'node_modules'));
    fs.writeFileSync(path.join(release, 'dashboard', 'src', 'main.jsx'), 'old UI source');
    fs.writeFileSync(path.join(release, 'src', 'bootstrap.js'), 'setInterval(() => {}, 1000);'); fs.writeFileSync(path.join(release, 'src', 'a.js'), 'old');
    fs.writeFileSync(path.join(release, 'dashboard', 'dist', 'index.html'), 'dashboard'); fs.copyFileSync('/bin/sleep', path.join(release, 'bin', 'mybotd')); fs.chmodSync(path.join(release, 'bin', 'mybotd'), 0o755);
    fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: base, status: 'ready' }));
    fs.symlinkSync(`releases/${base}`, path.join(root, 'current')); fs.symlinkSync(path.join(root, 'current', 'dashboard', 'dist'), path.join(root, 'dashboard', 'dist'));
    fs.symlinkSync(path.join(root, 'current', 'bin', 'mybotd'), path.join(bin, 'mybotd'));
    fs.writeFileSync(path.join(root, 'src', 'bootstrap.js'), makeReleaseWrapper({ runtimeRoot: root, entry: 'src/bootstrap.js' }));
    fs.writeFileSync(path.join(root, 'mybot', 'state.json'), 'runtime data');
    daemon = spawn(path.join(bin, 'mybotd'), ['120'], { stdio: 'ignore' });
    const fakeBin = path.join(root, 'fake-bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\nprintf 'MainPID=${daemon.pid}\\nActiveState=active\\n'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nif [ "$1" = run ] && [ "$2" = build ]; then printf "new dashboard" > dist/index.html; else exit 1; fi\n', { mode: 0o755 });
    const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    dashboard = http.createServer((req, res) => res.end(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'))));
    bridge = http.createServer((req, res) => { res.statusCode = 401; res.end(); });
    const dashboardPort = await listen(dashboard), bridgePort = await listen(bridge);
    execFileSync('pm2', ['start', path.join(root, 'src', 'bootstrap.js'), '--name', 'live', '--cwd', root], { stdio: 'ignore', timeout: 20000 });
    const bytes = Buffer.from('new'); fs.mkdirSync(path.join(pkg, 'files', 'src'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'files', 'src', 'a.js'), bytes);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target, files: [{ status: 'modify', path: 'src/a.js', mode: '100644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
    const script = fileURLToPath(new URL('../deploy/ubuntu/locked-runner.sh', import.meta.url));
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PM2_HOME: home, MYBOT_DEPLOY_BINARY_DIR: bin, MYBOT_DEPLOY_DASHBOARD_URL: `http://127.0.0.1:${dashboardPort}/`, MYBOT_DEPLOY_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/health` };
    const run = args => new Promise((resolve, reject) => {
      const child = spawn('bash', [script, root, ...args], { env }); let stderr = '';
      child.stderr.on('data', c => { stderr += c; }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
    });
    await run(['apply', pkg, 'c'.repeat(32)]);
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${target}`);
    assert.equal(fs.readFileSync(path.join(root, 'mybot', 'state.json'), 'utf8'), 'runtime data');
    await run(['rollback', 'd'.repeat(32)]);
    assert.equal(fs.readlinkSync(path.join(root, 'current')), `releases/${base}`);
    assert.equal(fs.readFileSync(path.join(root, 'mybot', 'state.json'), 'utf8'), 'runtime data');
    const beforePid = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }))[0].pid;
    const uiTarget = 'e'.repeat(40), uiPkg = path.join(root, 'ui-payload'), ui = Buffer.from('new UI source');
    fs.mkdirSync(path.join(uiPkg, 'files', 'dashboard', 'src'), { recursive: true }); fs.writeFileSync(path.join(uiPkg, 'files', 'dashboard', 'src', 'main.jsx'), ui);
    fs.writeFileSync(path.join(uiPkg, 'manifest.json'), JSON.stringify({ schema: 1, base, target: uiTarget, files: [{ status: 'modify', path: 'dashboard/src/main.jsx', mode: '100644', size: ui.length, sha256: createHash('sha256').update(ui).digest('hex') }] }));
    await run(['apply', uiPkg, 'f'.repeat(32)]);
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'new dashboard');
    assert.equal(JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }))[0].pid, beforePid);
    await run(['rollback', '1'.repeat(32)]);
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'dashboard');
    assert.equal(JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }))[0].pid, beforePid);
  } finally {
    try { execFileSync('pm2', ['kill'], { stdio: 'ignore', timeout: 15000, env: { ...process.env, PM2_HOME: home } }); } catch {}
    daemon?.kill(); if (dashboard) await new Promise(resolve => dashboard.close(resolve)); if (bridge) await new Promise(resolve => bridge.close(resolve));
    if (previousPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previousPm2Home;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
