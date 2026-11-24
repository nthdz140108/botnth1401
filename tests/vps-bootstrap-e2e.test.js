import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('locked bootstrap and rollback preserve real isolated PM2 fleet states', { skip: process.platform === 'win32' || process.env.MYBOT_PM2_INTEGRATION !== '1', timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-bootstrap-e2e-'));
  const previousPm2Home = process.env.PM2_HOME, home = path.join(root, 'pm2-home'); process.env.PM2_HOME = home;
  let daemon, dashboard, bridge;
  try {
    const target = 'a'.repeat(40), release = path.join(root, 'releases', target), bin = path.join(root, 'usr-bin');
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(root, 'src', 'dashboard'), { recursive: true }); fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(root, 'mybot')); fs.mkdirSync(bin);
    fs.mkdirSync(path.join(release, 'src', 'dashboard'), { recursive: true }); fs.mkdirSync(path.join(release, 'dashboard', 'dist'), { recursive: true }); fs.mkdirSync(path.join(release, 'bin'));
    for (const file of [path.join(root, 'src', 'bootstrap.js'), path.join(release, 'src', 'bootstrap.js')]) fs.writeFileSync(file, 'setInterval(() => {}, 1000);');
    fs.writeFileSync(path.join(root, 'src', 'dashboard', 'node-bridge-service.js'), 'legacy bridge'); fs.writeFileSync(path.join(release, 'src', 'dashboard', 'node-bridge-service.js'), 'new bridge');
    fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'legacy dashboard'); fs.writeFileSync(path.join(release, 'dashboard', 'dist', 'index.html'), 'new dashboard');
    fs.writeFileSync(path.join(root, 'mybot', 'state.json'), 'keep runtime data'); fs.copyFileSync('/bin/sleep', path.join(bin, 'mybotd')); fs.copyFileSync('/bin/sleep', path.join(release, 'bin', 'mybotd')); fs.chmodSync(path.join(bin, 'mybotd'), 0o755); fs.chmodSync(path.join(release, 'bin', 'mybotd'), 0o755);
    fs.writeFileSync(path.join(release, '.mybot-release.json'), JSON.stringify({ commit: target, status: 'ready' }));
    daemon = spawn(path.join(bin, 'mybotd'), ['120'], { stdio: 'ignore' });
    const fakeBin = path.join(root, 'fake-bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\nif [ "$1" = show ]; then printf 'MainPID=${daemon.pid}\\nActiveState=active\\n'; fi\n`, { mode: 0o755 });
    const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    dashboard = http.createServer((req, res) => res.end(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'))));
    bridge = http.createServer((req, res) => { res.statusCode = 401; res.end(); });
    const dashboardPort = await listen(dashboard), bridgePort = await listen(bridge);
    for (const name of ['live', 'parked']) execFileSync('pm2', ['start', path.join(root, 'src', 'bootstrap.js'), '--name', name, '--cwd', root, '--force'], { stdio: 'ignore', timeout: 20000 });
    execFileSync('pm2', ['stop', 'parked'], { stdio: 'ignore', timeout: 20000 });
    const script = fileURLToPath(new URL('../deploy/ubuntu/locked-runner.sh', import.meta.url));
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PM2_HOME: home, MYBOT_DEPLOY_BINARY_DIR: bin, MYBOT_DEPLOY_DASHBOARD_URL: `http://127.0.0.1:${dashboardPort}/`, MYBOT_DEPLOY_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/health` };
    const run = args => new Promise((resolve, reject) => { const child = spawn('bash', [script, root, ...args], { env }); let stderr = ''; child.stderr.on('data', c => { stderr += c; }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))); });
    await run(['bootstrap', target, 'b'.repeat(32)]);
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'new dashboard');
    assert.equal(JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' })).find(p => p.name === 'parked').pm2_env.status, 'stopped');
    await run(['rollback', 'c'.repeat(32)]);
    assert.equal(fs.readFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), 'utf8'), 'legacy dashboard');
    assert.equal(fs.readFileSync(path.join(root, 'mybot', 'state.json'), 'utf8'), 'keep runtime data');
    assert.equal(JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' })).find(p => p.name === 'parked').pm2_env.status, 'stopped');
  } finally {
    try { execFileSync('pm2', ['kill'], { stdio: 'ignore', timeout: 15000, env: { ...process.env, PM2_HOME: home } }); } catch {}
    daemon?.kill(); if (dashboard) await new Promise(resolve => dashboard.close(resolve)); if (bridge) await new Promise(resolve => bridge.close(resolve));
    if (previousPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previousPm2Home;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
