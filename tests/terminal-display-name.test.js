import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("normalizePM2Process preserves name/botKey and copies displayName/Zalo name from env-ish fields", async () => {
  const { normalizePM2Process } = await import("../src/runtime/pm2-adapter.js");
  const raw = {
    name: "631936345633",
    pm_id: 5,
    pid: 4321,
    pm2_env: { status: "online", env: { BOT_KEY: "631936345633", WEB_PORT: "4444", BOT_MANAGED: "true" } },
  };
  const proc = normalizePM2Process(raw);
  assert.equal(proc.name, "631936345633");
  assert.equal(proc.botKey, "631936345633");
  assert.equal(proc.kind, "child");
  // displayName should be absent from a bare raw process (no registry context)
  assert.equal(proc.displayName, undefined);
});

test("TerminalMonitor enriches child snapshot displayName from mybots.json by botKey", async () => {
  const { TerminalMonitor } = await import("../src/runtime/terminal-monitor.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-terminal-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      admin: { name: "admin", displayName: "Hẹn", isMain: true },
      "631936345633": { name: "631936345633", displayName: "Hẹn", ownerUid: "owner-1", status: "stopped" },
    }),
  );

  // Build a monitor instance pointing at the fixture root and force lightweight
  // probes so no real network/PM2 is touched.
  const monitor = new TerminalMonitor({ projectRoot: root });
  // Stub adapter so we never touch real PM2.
  monitor.adapter = {
    listManagedProcesses: async () => [
      { name: "631936345633", botKey: "631936345633", kind: "child", status: "online", pid: 4321, rss: 1000, uptime: 5000, env: { WEB_PORT: "4444" } },
      { name: "admin", botKey: "admin", kind: "main", status: "online", pid: 1234, rss: 2000, uptime: 9000, env: { WEB_PORT: "2000" } },
    ],
  };
  // Always-ready probes: port open + identity matches.
  monitor.portProbe = async () => true;
  monitor.identityFetcher = async () => ({
    pid: 4321, botKey: "631936345633", kind: "child", listenerConnected: true,
  });

  const procs = await monitor._fetchState();
  assert.equal(procs.length, 2);

  // Resolve readiness + enrich display name.
  const withReadiness = await monitor._withReadiness(procs);
  // Build the displayName lookup table manually using the same enrichment the
  // implementer must wire in. We assert the enrichment helper directly.
  const enrich = await monitor._enrichDisplayName(withReadiness);
  const childRow = enrich.find((p) => p.botKey === "631936345633");
  assert.equal(childRow.displayName, "Hẹn", "child must show the Zalo name, not the UID");
  assert.equal(childRow.name, "631936345633", "PM2 name / key stays as the internal id");

  const adminRow = enrich.find((p) => p.botKey === "admin");
  assert.equal(adminRow.displayName, "Hẹn", "main bot shows the Zalo name");
});

test("_renderRow uses displayName fallback to 'Chưa có tên Zalo' and keeps pid", async () => {
  const { TerminalMonitor } = await import("../src/runtime/terminal-monitor.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-terminal2-"));
  const monitor = new TerminalMonitor({ projectRoot: root });

  const rowWithName = monitor._renderRow(
    { name: "631936345633", botKey: "631936345633", displayName: "Hẹn", status: "online", pid: 4321, readiness: "ready" },
    { compact: true, width: 100 },
  );
  assert.ok(rowWithName.includes("Hẹn"), "row shows Zalo display name");
  // The raw internal UID/id must not appear in the BOT column when a display
  // name is present (the UID may still show elsewhere as the pid/status, but
  // the rendered BOT cell should carry the Zalo name).
  const botCell = rowWithName.split("|")[0];
  assert.ok(!botCell.includes("631936345633"), "raw UID must not appear in the BOT column");

  // Missing displayName -> placeholder, never the raw UID.
  const rowNoName = monitor._renderRow(
    { name: "999", botKey: "999", status: "online", pid: 5, readiness: "ready" },
    { compact: true, width: 100 },
  );
  assert.ok(rowNoName.includes("Chưa có tên Zalo"), "fallback placeholder shown when no name");
});
