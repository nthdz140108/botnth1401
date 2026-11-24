import test from 'node:test';
import assert from 'node:assert/strict';
import { planRuntimeActions } from '../deploy/runtime-actions.mjs';

test('selects only the components affected by a patch', () => {
  assert.deepEqual(planRuntimeActions(['src/commands/a.js']), { restartNode: true, restartRust: false, buildDashboard: false, buildRust: false, installNodeDependencies: false });
  assert.deepEqual(planRuntimeActions(['dashboard/src/main.jsx']), { restartNode: false, restartRust: false, buildDashboard: true, buildRust: false, installNodeDependencies: false });
  assert.deepEqual(planRuntimeActions(['rust/bins/ws-decode-worker/src/main.rs']), { restartNode: true, restartRust: false, buildDashboard: false, buildRust: true, installNodeDependencies: false });
  assert.deepEqual(planRuntimeActions(['rust/crates/mybot-dashboard/src/lib.rs']), { restartNode: false, restartRust: true, buildDashboard: false, buildRust: true, installNodeDependencies: false });
  assert.equal(planRuntimeActions(['rust/.cargo/config.toml']).restartNode, true);
  assert.deepEqual(planRuntimeActions(['rust/bins/mybot-ctl/src/main.rs']), { restartNode: false, restartRust: false, buildDashboard: false, buildRust: true, installNodeDependencies: false });
});
