function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export class AntiNudeMetrics {
  constructor({ maxSamples = 500 } = {}) {
    this.maxSamples = maxSamples;
    this.timings = {
      queueWait: [],
      download: [],
      frameExtract: [],
      classify: [],
      revoke: [],
      total: [],
    };
    this.counts = {
      scanned: 0,
      violations: 0,
      revoked: 0,
      errors: 0,
      overloads: 0,
      thumbnailsChecked: 0,
      earlyRevoked: 0,
    };
  }

  record(timingData = {}) {
    this.counts.scanned++;
    if (timingData.violation) this.counts.violations++;
    if (timingData.revoked) this.counts.revoked++;
    if (timingData.error) this.counts.errors++;
    if (timingData.overloaded) this.counts.overloads++;
    if (timingData.thumbnailChecked) this.counts.thumbnailsChecked++;
    if (timingData.earlyRevoke) this.counts.earlyRevoked++;

    const keys = ["queueWait", "download", "frameExtract", "classify", "revoke", "total"];
    for (const key of keys) {
      const val = timingData[`${key}Ms`];
      if (typeof val === "number" && !isNaN(val) && val >= 0) {
        this.timings[key].push(val);
        if (this.timings[key].length > this.maxSamples) {
          this.timings[key].shift();
        }
      }
    }
  }

  getStats() {
    const calc = (arr) => {
      if (!arr.length) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0 };
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        p50: Number(percentile(sorted, 50).toFixed(2)),
        p95: Number(percentile(sorted, 95).toFixed(2)),
        p99: Number(percentile(sorted, 99).toFixed(2)),
        min: Number(sorted[0].toFixed(2)),
        max: Number(sorted[sorted.length - 1].toFixed(2)),
        count: sorted.length,
      };
    };

    return {
      counts: { ...this.counts },
      timings: {
        queueWait: calc(this.timings.queueWait),
        download: calc(this.timings.download),
        frameExtract: calc(this.timings.frameExtract),
        classify: calc(this.timings.classify),
        revoke: calc(this.timings.revoke),
        total: calc(this.timings.total),
      },
    };
  }

  reset() {
    for (const key of Object.keys(this.timings)) {
      this.timings[key] = [];
    }
    for (const key of Object.keys(this.counts)) {
      this.counts[key] = 0;
    }
  }
}

export const globalAntiNudeMetrics = new AntiNudeMetrics();
