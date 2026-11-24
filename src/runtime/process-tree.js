/**
 * Process Tree RSS Measurement.
 *
 * Computes the full process-tree RSS for a given root PID (PM2 process)
 * including all child workers (NSFW, canvas, ffmpeg, media workers).
 */

import si from "systeminformation";

let mockProcessesList = null;

export function setMockProcessesListForTest(list) {
  mockProcessesList = list;
}

export async function getFleetProcessTreeRss(rootPids = []) {
  const result = new Map();
  const pids = rootPids.map(Number).filter((p) => !isNaN(p) && p > 0);
  if (pids.length === 0) return result;

  try {
    let list = [];
    if (mockProcessesList) {
      list = mockProcessesList;
    } else {
      const procData = await si.processes();
      list = procData?.list || [];
    }

    // Map pid -> memRss (in bytes; si memRss is in KB)
    const rssMap = new Map();
    // Map parentPid -> Array of childPids
    const childrenMap = new Map();

    for (const p of list) {
      const pid = Number(p.pid);
      const ppid = Number(p.parentPid);
      // si.processes() returns memRss in KB; mock or raw may be in bytes if > 100MB
      const rawRss = Number(p.memRss || p.rss || 0);
      const rssBytes = rawRss > 10 * 1024 * 1024 ? rawRss : rawRss * 1024;
      rssMap.set(pid, rssBytes);

      if (!childrenMap.has(ppid)) {
        childrenMap.set(ppid, []);
      }
      childrenMap.get(ppid).push(pid);
    }

    for (const rootPid of pids) {
      let totalRss = rssMap.get(rootPid) || 0;
      const queue = [...(childrenMap.get(rootPid) || [])];
      const visited = new Set([rootPid]);

      while (queue.length > 0) {
        const childPid = queue.shift();
        if (visited.has(childPid)) continue;
        visited.add(childPid);

        totalRss += rssMap.get(childPid) || 0;
        const grandChildren = childrenMap.get(childPid) || [];
        for (const g of grandChildren) {
          if (!visited.has(g)) queue.push(g);
        }
      }

      result.set(rootPid, totalRss);
    }
  } catch {
    // Best-effort: on error, callers will fallback to root process RSS
  }

  return result;
}

export async function getProcessTreeRss(rootPid, fallbackRss = 0) {
  const pid = Number(rootPid);
  if (!pid || isNaN(pid)) return fallbackRss;
  const fleet = await getFleetProcessTreeRss([pid]);
  return fleet.get(pid) || fallbackRss;
}
