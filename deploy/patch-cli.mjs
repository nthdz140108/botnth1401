import { buildPreview } from './patch-preview.mjs';
import { createPatchPackage } from './patch-package.mjs';
import { planRuntimeActions } from './runtime-actions.mjs';

try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    if (!['--repo', '--base', '--target', '--output'].includes(name) || !process.argv[i + 1] || options[name]) throw new Error('Usage: node deploy/patch-cli.mjs --base COMMIT --target COMMIT [--repo PATH] [--output NEW_DIRECTORY]');
    options[name] = process.argv[i + 1];
  }
  if (!options['--base'] || !options['--target']) throw new Error('Both --base and --target are required');
  const args = { repo: options['--repo'] || process.cwd(), base: options['--base'], target: options['--target'] };
  const preview = options['--output'] ? createPatchPackage({ ...args, output: options['--output'] }) : buildPreview(args);
  const paths = preview.files.map(file => file.path);
  const actions = planRuntimeActions(paths);
  console.log(JSON.stringify({ ...preview, totalBytes: preview.files.reduce((n, f) => n + (f.size || 0), 0), actions }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
