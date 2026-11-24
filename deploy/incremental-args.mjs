export function parseIncrementalArgs(args) {
  let mode = null, target = null, base = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--apply', '--dry-run', '--status', '--rollback', '--recover', '--bootstrap'].includes(arg)) {
      if (mode) throw new Error('Only one mode is allowed');
      mode = arg.slice(2);
    } else if (['--target', '--base'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--target') { if (target) throw new Error('Duplicate target'); target = value; }
      else { if (base) throw new Error('Duplicate base'); base = value; }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  mode ||= 'apply';
  if (!['apply', 'dry-run'].includes(mode) && (target || base)) throw new Error('Target/base not allowed in this mode');
  return { mode, target: ['apply', 'dry-run'].includes(mode) ? target || 'HEAD' : null, base };
}
