import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeReleaseWrapper } from '../deploy/release-wrapper.mjs';

test('launcher pins lazy imports to the release it started with', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-wrapper-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const id of ['old', 'new']) {
      const src = path.join(root, 'releases', id, 'src'); fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'bootstrap.js'), 'import {pathToFileURL} from "node:url"; if (import.meta.url !== pathToFileURL(process.argv[1]).href) throw new Error("not main"); console.log("ready"); process.stdin.once("data", async () => { const m = await import("./lazy.js"); console.log(m.value, process.env.PROJECT_ROOT); });');
      fs.writeFileSync(path.join(src, 'lazy.js'), `export const value = ${JSON.stringify(id)};`);
    }
    fs.symlinkSync('releases/old', path.join(root, 'current'));
    const wrapper = path.join(root, 'wrapper.js'); fs.writeFileSync(wrapper, makeReleaseWrapper({ runtimeRoot: root, entry: 'src/bootstrap.js' }));
    const child = spawn(process.execPath, [wrapper], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const first = await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) resolve(); }); child.once('error', reject); child.once('exit', code => { if (code && !output.includes('ready\n')) reject(new Error(errors)); }); });
    void first;
    fs.symlinkSync('releases/new', path.join(root, 'next')); fs.renameSync(path.join(root, 'next'), path.join(root, 'current'));
    child.stdin.end('continue');
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, errors); assert.match(output, new RegExp(`old ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
