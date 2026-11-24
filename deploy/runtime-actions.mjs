export function planRuntimeActions(paths) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new Error('Invalid patch paths');
  const rust = paths.filter(p => p.startsWith('rust/'));
  const workerOnly = rust.length > 0 && rust.every(p => p.startsWith('rust/bins/ws-decode-worker/'));
  return {
    restartNode: paths.some(p => /^(?:src\/|scripts\/|index\.js$|bot\.js$|package(?:-lock)?\.json$|rust\/bins\/ws-decode-worker\/|rust\/crates\/zalo-sdk\/|rust\/Cargo(?:\.toml|\.lock)$)/.test(p)),
    restartRust: rust.length > 0 && !workerOnly,
    buildDashboard: paths.some(p => p.startsWith('dashboard/')),
    buildRust: rust.length > 0,
    installNodeDependencies: paths.some(p => /^(?:dashboard\/)?package(?:-lock)?\.json$/.test(p)),
  };
}
