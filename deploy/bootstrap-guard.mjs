export function assertBootstrapTarget(result) {
  if (result === 'versioned') throw new Error('Full installer is disabled on a versioned VPS; use incremental update or a separate rebuild procedure');
  if (result !== 'legacy') throw new Error('Unknown VPS bootstrap state');
}
