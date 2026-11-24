import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDeploymentState, readDeploymentState } from '../deploy/deployment-state.mjs';

test('persists deployment progress and fleet identities without credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-state-'));
  try {
    const state = { status: 'running', pid: process.pid, base: 'a'.repeat(40), target: 'b'.repeat(40), paths: ['src/bot.js'], fleet: [{ id: 1, name: 'admin' }] };
    writeDeploymentState(root, state);
    assert.deepEqual(readDeploymentState(root), state);
    state.status = 'confirmed'; writeDeploymentState(root, state);
    assert.equal(readDeploymentState(root).status, 'confirmed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
