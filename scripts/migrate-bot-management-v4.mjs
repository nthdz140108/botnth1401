import path from 'node:path';
import { getProjectRoot } from '../src/utils/env.js';
import { migrateBotManagementV4 } from '../src/commands/mybot/System/bot-management-migration.js';
import { recoverMyBotsTransactions } from '../src/commands/mybot/Manager/qr-provisioning-registry.js';

const args = process.argv.slice(2);
const index = args.indexOf('--root');
const root = index >= 0 ? path.resolve(args[index + 1]) : getProjectRoot();
try {
  if (args.includes('--recover')) console.log(JSON.stringify({ recovered: await recoverMyBotsTransactions({ root }) }));
  console.log(JSON.stringify(await migrateBotManagementV4({ root, apply: args.includes('--apply'), releaseRoots: args.filter(arg => arg.startsWith('--release=')).map(arg => arg.slice(10)) }), null, 2));
} catch (error) { console.error(JSON.stringify({ code: error.code || 'MIGRATION_FAILED', message: error.message })); process.exitCode = 1; }
