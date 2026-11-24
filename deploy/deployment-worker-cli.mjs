import fs from 'node:fs';
import path from 'node:path';
import { inspectDeployment, runDeployment } from './deployment-worker.mjs';

try {
  const [rootArg, operation, ...args] = process.argv.slice(2);
  if (!rootArg || !path.isAbsolute(rootArg) || !['status', 'apply', 'bootstrap', 'rollback', 'recover'].includes(operation) || (operation === 'status' ? args.length !== 0 : ['apply', 'bootstrap'].includes(operation) ? args.length !== 2 : args.length !== 1)) throw new Error('Usage: locked-runner.sh ROOT status|recover ID|rollback ID|apply PACKAGE ID|bootstrap COMMIT ID');
  const root = fs.realpathSync(rootArg);
  if (operation === 'status') console.log(JSON.stringify(inspectDeployment(root), null, 2));
  else {
    let held, lock;
    try { held = fs.fstatSync(9); lock = fs.statSync(path.join(root, '.deploy.lock')); } catch { throw new Error('Deployment lock is required'); }
    if (!held.isFile() || held.dev !== lock.dev || held.ino !== lock.ino) throw new Error('Deployment lock is required');
    const requestId = args.at(-1);
    if (!/^[a-f0-9]{32}$/.test(requestId)) throw new Error('Invalid deployment request ID');
    const options = { root, operation, requestId, binaryDir: process.env.MYBOT_DEPLOY_BINARY_DIR || '/usr/local/bin' };
    if (operation === 'apply') { if (!path.isAbsolute(args[0])) throw new Error('Package path must be absolute'); options.packageDir = args[0]; }
    if (operation === 'bootstrap') options.target = args[0];
    console.log(JSON.stringify(await runDeployment(options)));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
