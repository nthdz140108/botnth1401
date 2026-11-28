import fs from "node:fs/promises";
import path from "node:path";
import { createBotReadinessService, matchesBotIdentity } from "../runtime/runtime-readiness.js";

export function createChildAdminVerifier({ root, secret, readiness = createBotReadinessService({ root }), fetchFriends } = {}) {
  const readFriends = fetchFriends || (async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/runtime/friends`, {
      headers: { "x-internal-secret": secret }, signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? response.json() : null;
  });
  return async (botKey, uid) => {
    const registry = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    const record = registry[botKey];
    const accountUid = String(record?.accountUid || record?.uid || "");
    const port = Number(record?.webPort);
    if (record?.accountIdentityStatus !== "verified" || !accountUid || !Number.isInteger(port) || port < 1 || port > 65535) return false;
    const descriptor = { kind: "child", botKey, pm2Name: botKey, webPort: port, accountUid };
    const process = await readiness.getProcess(botKey);
    if (!process || process.name !== botKey || !Number.isInteger(Number(process.pid)) || Number(process.pid) <= 0) return false;
    const before = await readiness.probe({ descriptor, process, expectedPid: process.pid });
    if (!before.ready) return false;
    if (uid === accountUid) return true;
    const data = await readFriends({ botKey, port, accountUid, expectedPid: process.pid });
    // A foreign process must not lend its roster to another bot's admin list.
    if (data?.online !== true || data.identity?.listenerConnected !== true
      || !matchesBotIdentity({ descriptor, identity: data.identity, expectedPid: process.pid, supervisorPid: process.pid })
      || !Array.isArray(data.friends) || !data.friends.some((friend) => String(friend.uid) === uid)) return false;
    const latest = await readiness.getProcess(botKey);
    if (!latest || String(latest.pid) !== String(process.pid)) return false;
    return (await readiness.probe({ descriptor, process: latest, expectedPid: process.pid })).ready === true;
  };
}
