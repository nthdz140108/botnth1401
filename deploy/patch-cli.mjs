import { buildPreview } from './patch-preview.mjs';

try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    if (!['--repo', '--base', '--target'].includes(name) || !process.argv[i + 1] || options[name]) throw new Error('Usage: node deploy/patch-cli.mjs --base COMMIT --target COMMIT [--repo PATH]');
    options[name] = process.argv[i + 1];
  }
  if (!options['--base'] || !options['--target']) throw new Error('Both --base and --target are required');
  const preview = buildPreview({ repo: options['--repo'] || process.cwd(), base: options['--base'], target: options['--target'] });
  const paths = preview.files.map(file => file.path);
  const actions = {
    buildRust: paths.some(p => p.startsWith('rust/')),
    buildDashboard: paths.some(p => p.startsWith('dashboard/')),
    installNodeDependencies: paths.some(p => /^(?:dashboard\/)?package(?:-lock)?\.json$/.test(p)),
    restartNode: paths.some(p => /^(?:src\/|scripts\/|index\.js$|bot\.js$|package(?:-lock)?\.json$)/.test(p)),
  };
  console.log(JSON.stringify({ ...preview, totalBytes: preview.files.reduce((n, f) => n + (f.size || 0), 0), actions }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
