const port = Number(process.env.DASHBOARD_PORT || 4173);

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/system/health`);
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
