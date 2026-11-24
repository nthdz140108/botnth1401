/**
 * Runtime Web Port Allocator
 *
 * The bot that reported `port-closed` was running with a port taken from
 * mybots.json that was NOT actually bindable on this machine (a foreign
 * process, a stale port, or a leftover listener). The old allocators only
 * scanned mybots.json and silently fell back to 4444, so two children could
 * get the same port and the second one silently lost its bridge (EADDRINUSE
 * swallowed), then PM2 kept it "online" with a closed port.
 *
 * This module allocates a port only when it is BOTH:
 *   1. not already claimed by another bot in the registry, AND
 *   2. genuinely bindable on 127.0.0.1 right now.
 *
 * It never silently falls back to a hard-coded port. If nothing is free it
 * throws a structured error so the caller can surface the real cause instead
 * of faking a `running` state.
 */

import net from "node:net";

export const PORT_SCAN_START = 4444;
export const PORT_SCAN_END = 6666;

/**
 * Probe whether a port can be bound on the given host.
 *
 * @param {number} port
 * @param {string} [host] default 127.0.0.1
 * @param {number} [timeoutMs] default 500
 * @returns {Promise<boolean>} true if bindable, false if occupied/unbindable
 */
export function canBindPort(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const numericPort = Number(port);
    if (!Number.isFinite(numericPort) || numericPort <= 0) return resolve(false);

    const server = net.createServer();
    let settled = false;
    let timer = null;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.removeAllListeners();
      try { server.close(); } catch {}
      resolve(ok);
    };

    timer = setTimeout(() => done(false), timeoutMs);

    server.once("error", () => done(false));
    server.once("listening", () => {
      // Successfully bound: close and report immediately.
      try {
        server.close(() => done(true));
      } catch {
        done(true);
      }
    });

    try {
      server.listen(numericPort, host);
    } catch {
      done(false);
    }
  });
}

/**
 * The set of ports already claimed by other bots in a registry object.
 *
 * @param {object} registry mybots.json (or similar) keyed by uid/botKey
 * @returns {Set<number>}
 */
export function usedRegistryPorts(registry) {
  const used = new Set();
  if (!registry || typeof registry !== "object") return used;
  for (const value of Object.values(registry)) {
    const port = Number(parseInt(value?.webPort, 10) || value?.webPort);
    if (Number.isFinite(port) && port > 0) used.add(port);
  }
  return used;
}

/**
 * Allocate the first bindable port in [start, end] that is also not claimed by
 * another bot in the registry.
 *
 * @param {object} options
 * @param {object} [options.registry] registry to avoid clashing with
 * @param {number} [options.start] default PORT_SCAN_START
 * @param {number} [options.end] default PORT_SCAN_END
 * @param {string} [options.host] default 127.0.0.1
 * @param {Function} [options.canBind] async (port, host) => boolean (test hook)
 * @returns {Promise<number>} the allocated port
 * @throws {Error} with code NO_BINDABLE_PORT when nothing is free
 */
export async function allocateBindablePort({
  registry = {},
  start = PORT_SCAN_START,
  end = Number(process.env.MYBOT_PORT_SCAN_END) > PORT_SCAN_START
    ? Number(process.env.MYBOT_PORT_SCAN_END)
    : PORT_SCAN_END,
  host = "127.0.0.1",
  canBind = canBindPort,
} = {}) {
  const used = usedRegistryPorts(registry);
  for (let port = start; port <= end; port++) {
    if (used.has(port)) continue;
    // A port in use by a foreign process is treated as used; also skip it
    // rather than letting the child silently lose its bridge.
    if (await canBind(port, host)) return port;
  }
  const error = new Error(`No bindable web port in range ${start}-${end}`);
  error.code = "NO_BINDABLE_PORT";
  throw error;
}

/**
 * Reserve a new bindable port for a bot and return it as a string (matching
 * the mybots.json `webPort` string format). Convenience wrapper.
 *
 * @param {object} options see allocateBindablePort
 * @returns {Promise<string>}
 */
export async function allocateBindablePortString(options) {
  const port = await allocateBindablePort(options);
  return String(port);
}
