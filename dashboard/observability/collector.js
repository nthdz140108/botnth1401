export function createMetricsCollector({ store, collectHealth, collectSnapshot, emit, intervalMs = 15000, flushEveryTicks = 4, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer = null;
  let tickCount = 0;
  async function collectNow({ forceFlush = false } = {}) {
    const [healthResult, snapshotResult] = await Promise.allSettled([collectHealth(), collectSnapshot()]);
    const health = healthResult.status === "fulfilled" ? healthResult.value : {};
    const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : {};
    const sample = { timestamp: new Date().toISOString(), cpu: health.cpu, memory: health.memory, disk: health.disk, onlineBots: snapshot.onlineBots, messages: snapshot.messages, alerts: snapshot.alerts };
    await store.recordSample(sample);
    tickCount += 1;
    if (forceFlush || tickCount === 1 || tickCount % flushEveryTicks === 0) {
      await store.flush();
    }
    emit("dashboard:metrics", sample);
    return sample;
  }
  return {
    async start() {
      await collectNow({ forceFlush: true });
      timer = setIntervalFn(() => collectNow({ forceFlush: false }), intervalMs);
    },
    stop() {
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      Promise.resolve(store.flush?.()).catch(() => {});
    },
    collectNow,
  };
}
