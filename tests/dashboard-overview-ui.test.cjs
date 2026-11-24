const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const overviewUrl = pathToFileURL(path.join(__dirname, "../dashboard/public/js/workspaces/overview.js")).href;

test("overview renders KPI, health text, priority fleet, activity, and three chart series", async () => {
  const { createOverviewWorkspace } = await import(overviewUrl);
  const dom = new JSDOM("<!doctype html><body><section id='overviewWorkspace'></section></body>");
  const chartCalls = [];
  const fixture = { summary: { onlineBots: 2, totalBots: 3, messages24h: 8, activeGroups: 4, activeCommands: 5, alerts24h: 1, uptime: "2h" }, health: { cpu: { text: "10%" }, memory: { text: "1 GB" }, disk: { text: "20%" }, connection: { text: "Connected" } }, fleet: [{ name: "Online", status: "online" }, { name: "Broken", status: "error" }], recentActivity: [{ type: "bot-status", timestamp: "2026-08-06T00:00:00.000Z" }], series: [{ timestamp: "2026-08-06T00:00:00.000Z", messages: 1, alerts: 0, onlineBots: 2 }] };
  const workspace = createOverviewWorkspace({ document: dom.window.document, fetchImpl: async () => ({ ok: true, json: async () => fixture }), chartFactory: (canvas, config) => (chartCalls.push(config), { destroy() {} }) });
  await workspace.load("24h");
  assert.match(dom.window.document.querySelector("#overviewBots").textContent, /2\s*\/\s*3/);
  assert.equal(dom.window.document.querySelector("#overviewFleet tbody tr").dataset.status, "error");
  assert.equal(chartCalls[0].data.datasets.length, 3);
  dom.window.close();
});

test("overview marks metrics stale after 45 seconds and appends realtime activity", async () => {
  const { createOverviewWorkspace } = await import(overviewUrl);
  const dom = new JSDOM("<!doctype html><body><section id='overviewWorkspace'></section></body>");
  let time = 0;
  const workspace = createOverviewWorkspace({ document: dom.window.document, now: () => time, fetchImpl: async () => ({ ok: true, json: async () => ({ summary: {}, health: {}, fleet: [], recentActivity: [], series: [] }) }), chartFactory: () => ({ destroy() {} }) });
  await workspace.load();
  workspace.applyMetrics({ onlineBots: 1 });
  workspace.applyActivity({ type: "bot-status" });
  time = 45001;
  assert.equal(workspace.checkStale(), true);
  assert.equal(dom.window.document.querySelector("#overviewActivity li").textContent, "bot-status");
  dom.window.close();
});

test("overview provides loading, empty, retryable error, range controls, and a safe fleet drawer", async () => {
  const { createOverviewWorkspace } = await import(overviewUrl);
  const dom = new JSDOM("<!doctype html><body><section id='overviewWorkspace'></section></body>");
  let attempts = 0;
  const workspace = createOverviewWorkspace({
    document: dom.window.document,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return { ok: true, json: async () => ({ summary: {}, health: {}, fleet: [], recentActivity: [], series: [] }) };
    },
    chartFactory: () => ({ destroy() {} }),
  });

  const pending = workspace.load("7d");
  assert.ok(dom.window.document.querySelector("[data-overview-loading]"));
  await pending;
  assert.ok(dom.window.document.querySelector("#overviewRetry"));
  await dom.window.document.querySelector("#overviewRetry").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(dom.window.document.querySelector("#overviewRange").value, "7d");
  assert.match(dom.window.document.querySelector("#overviewFleet").textContent, /Chưa có bot/i);
  assert.match(dom.window.document.querySelector("#overviewActivity").textContent, /Chưa có hoạt động/i);
  dom.window.close();
});

test("overview reports stale data with visible status text and orders error then offline then online", async () => {
  const { createOverviewWorkspace } = await import(overviewUrl);
  const dom = new JSDOM("<!doctype html><body><section id='overviewWorkspace'></section></body>");
  let time = 0;
  const workspace = createOverviewWorkspace({ document: dom.window.document, now: () => time, fetchImpl: async () => ({ ok: true, json: async () => ({ summary: {}, health: {}, recentActivity: [], series: [], fleet: [{ name: "Online", status: "online" }, { name: "Offline", status: "offline" }, { name: "Error", status: "error" }] }) }), chartFactory: () => ({ destroy() {} }) });
  await workspace.load();
  time = 45001;
  assert.equal(workspace.checkStale(), true);
  assert.match(dom.window.document.querySelector("#overviewFreshness").textContent, /Không còn mới/i);
  assert.deepEqual([...dom.window.document.querySelectorAll("#overviewFleet tbody tr")].map((row) => row.dataset.status), ["error", "offline", "online"]);
  dom.window.close();
});

test("overview renders operational text as text rather than executable markup", async () => {
  const { createOverviewWorkspace } = await import(overviewUrl);
  const dom = new JSDOM("<!doctype html><body><section id='overviewWorkspace'></section></body>");
  const workspace = createOverviewWorkspace({ document: dom.window.document, fetchImpl: async () => ({ ok: true, json: async () => ({ summary: {}, health: {}, series: [], fleet: [{ name: "<img src=x onerror=window.pwned=1>", status: "online" }], recentActivity: [{ type: "<b>unsafe</b>" }] }) }), chartFactory: () => ({ destroy() {} }) });
  await workspace.load();
  assert.equal(dom.window.document.querySelector("#overviewFleet img"), null);
  assert.equal(dom.window.document.querySelector("#overviewActivity b"), null);
  assert.match(dom.window.document.querySelector("#overviewFleet").textContent, /<img src=x/);
  dom.window.close();
});
