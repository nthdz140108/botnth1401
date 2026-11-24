const FIELDS = ["timestamp", "cpuAvg", "cpuMax", "memoryAvg", "diskAvg", "onlineBots", "messages", "alerts"];
function emptyPoint(timestamp) { return { timestamp, cpuAvg: 0, cpuMax: 0, memoryAvg: 0, diskAvg: 0, onlineBots: 0, messages: 0, alerts: 0 }; }
function bucketTimestamp(value, size) { return new Date(Math.floor(new Date(value).getTime() / size) * size).toISOString(); }

export function createObservabilityService({ store, now = () => new Date(), emit, adapters }) {
  async function getOverview(range) {
    if (range !== "24h" && range !== "7d") throw new Error("INVALID_RANGE");
    const duration = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const size = range === "24h" ? 5 * 60 * 1000 : 15 * 60 * 1000;
    const end = now().getTime(); const start = end - duration; const points = new Map();
    for (let value = start; value < end; value += size) points.set(new Date(value).toISOString(), emptyPoint(new Date(value).toISOString()));
    for (const source of store.getState().minuteBuckets || []) {
      const timestamp = bucketTimestamp(source.timestamp, size); const point = points.get(timestamp); if (!point) continue;
      point._count = (point._count || 0) + 1;
      point.cpuAvg += Number(source.cpuAvg) || 0;
      point.memoryAvg += Number(source.memoryAvg) || 0;
      point.diskAvg += Number(source.diskAvg) || 0;
      point.cpuMax = Math.max(point.cpuMax, Number(source.cpuMax) || 0);
      point.onlineBots = Number(source.onlineBots) || 0;
      point.messages += Number(source.messages) || 0;
      point.alerts += Number(source.alerts) || 0;
    }
    for (const point of points.values()) {
      if (point._count) {
        point.cpuAvg /= point._count;
        point.memoryAvg /= point._count;
        point.diskAvg /= point._count;
      }
      delete point._count;
    }
    const [summaryResult, healthResult, fleetResult] = await Promise.allSettled([adapters.getSummary(), adapters.getHealth(), adapters.getFleet()]);
    const warnings = [];
    if (summaryResult.status === "rejected") warnings.push("Dashboard summary temporarily unavailable");
    if (healthResult.status === "rejected") warnings.push("System health temporarily unavailable");
    if (fleetResult.status === "rejected") warnings.push("Bot fleet temporarily unavailable");
    const summary = summaryResult.status === "fulfilled" ? summaryResult.value : {};
    const health = healthResult.status === "fulfilled" ? healthResult.value : {};
    const fleet = fleetResult.status === "fulfilled" ? fleetResult.value : [];
    return { success: true, generatedAt: now().toISOString(), range, summary, health, series: [...points.values()], fleet, recentActivity: (store.getState().activities || []).slice(-100), warnings: [...warnings, ...(health.warnings || [])] };
  }
  async function recordActivity(event) {
    const clean = {
      type: typeof event?.type === "string" && event.type.trim() ? event.type.trim().slice(0, 80) : "system",
      timestamp: new Date(event?.timestamp || now()).toISOString(),
    };
    if (typeof event?.subject === "string" && event.subject.trim()) clean.subject = event.subject.trim().slice(0, 160);
    await store.recordActivity(clean); await store.flush(); emit("dashboard:activity", clean); return clean;
  }
  return { getOverview, recordActivity, start: async () => {}, stop: () => {} };
}
