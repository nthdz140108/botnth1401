export function planRuntimeActions(paths) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new Error('Invalid patch paths');
  const portal = paths.some(p => p.startsWith('rust/portal/') || /^deploy\/ubuntu\/(?:(?:build|install|grant)-portal\.sh|mybot-portal(?:-worker)?\.service)$/.test(p));
  const rust = paths.filter(p => p.startsWith('rust/') && !p.startsWith('rust/portal/'));
  const serviceAffected = rust.some(p => !p.startsWith('rust/bins/ws-decode-worker/') && !p.startsWith('rust/bins/mybot-ctl/'));
  return {
    restartNode: paths.some(p => /^(?:src\/|scripts\/|index\.js$|bot\.js$|package(?:-lock)?\.json$|rust\/bins\/ws-decode-worker\/|rust\/crates\/zalo-sdk\/|rust\/\.cargo\/|rust\/rust-toolchain(?:\.toml)?$|rust\/Cargo(?:\.toml|\.lock)$)/.test(p)),
    restartRust: serviceAffected,
    buildDashboard: paths.some(p => p.startsWith('dashboard/')),
    buildRust: rust.length > 0,
    installNodeDependencies: paths.some(p => /^(?:dashboard\/)?package(?:-lock)?\.json$/.test(p)),
    ...(portal ? {restartPortal: true, buildPortal: true} : {}),
  };
}
