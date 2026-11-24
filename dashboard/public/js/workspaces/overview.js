export function createOverviewWorkspace({ document, fetchImpl = fetch, chartFactory = (canvas, config) => new Chart(canvas, config), now = () => Date.now() }) {
  const root = document.getElementById("overviewWorkspace");
  let chart;
  let lastMetricsAt = now();
  function text(value, fallback = "-") { return value === undefined || value === null || value === "" ? fallback : String(value); }
  function escapeHtml(value, fallback) {
    return text(value, fallback).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }
  function renderLoading() {
    root.innerHTML = '<div data-overview-loading class="overview-loading" role="status">Đang đồng bộ dữ liệu vận hành...</div>';
  }
  function renderError(range) {
    root.innerHTML = `<section class="overview-error" role="alert"><p>Không thể tải dữ liệu tổng quan.</p><button id="overviewRetry" type="button">Thử lại</button></section>`;
    root.querySelector("#overviewRetry").addEventListener("click", () => load(range));
  }
  function fleetRows(fleet) {
    const priority = { error: 0, offline: 1, stopped: 1, online: 2 };
    const ordered = [...fleet].sort((a, b) => (priority[a.status] ?? 1) - (priority[b.status] ?? 1));
    if (!ordered.length) return '<tr class="overview-empty"><td colspan="2">Chưa có bot để hiển thị</td></tr>';
    return ordered.map((bot) => `<tr tabindex="0" data-status="${escapeHtml(bot.status, "offline")}" data-bot-name="${escapeHtml(bot.name || bot.uid, "Bot")}"><td>${escapeHtml(bot.name || bot.uid, "Bot")}</td><td>${escapeHtml(bot.status, "offline")}</td></tr>`).join("");
  }
  function render(data, range) {
    const summary = data.summary || {};
    const activities = data.recentActivity || [];
    root.innerHTML = `<section class="overview-toolbar"><label for="overviewRange">Khoảng thời gian</label><select id="overviewRange"><option value="24h">24 giờ</option><option value="7d">7 ngày</option></select><span id="overviewFreshness" role="status">Dữ liệu mới</span></section><div class="overview-kpis"><strong id="overviewBots">${escapeHtml(summary.onlineBots || 0)} / ${escapeHtml(summary.totalBots || 0)}</strong><span>${escapeHtml(summary.messages24h || 0)}</span><span>${escapeHtml(summary.activeGroups || 0)}</span><span>${escapeHtml(summary.activeCommands || 0)}</span><span>${escapeHtml(summary.alerts24h || 0)}</span><span>${escapeHtml(summary.uptime || "-")}</span></div><div id="overviewHealth">${Object.values(data.health || {}).filter((item) => item && typeof item === "object").map((item) => `<span>${escapeHtml(item.text)}</span>`).join("") || "<span>Chưa có dữ liệu sức khỏe hệ thống</span>"}</div><section id="overviewTrafficPanel"><canvas id="overviewTraffic" height="220"></canvas></section><table id="overviewFleet"><tbody>${fleetRows(data.fleet || [])}</tbody></table><ol id="overviewActivity">${activities.length ? activities.map((activity) => `<li>${escapeHtml(activity.type, "activity")}</li>`).join("") : "<li class=\"overview-empty\">Chưa có hoạt động</li>"}</ol><aside id="overviewBotDrawer" role="dialog" aria-label="Chi tiết bot" hidden></aside>`;
    root.querySelector("#overviewRange").value = range;
    root.querySelector("#overviewRange").addEventListener("change", (event) => load(event.target.value));
    root.querySelectorAll("#overviewFleet tbody tr[data-bot-name]").forEach((row) => row.addEventListener("click", () => {
      const drawer = root.querySelector("#overviewBotDrawer");
      drawer.textContent = `Bot: ${row.dataset.botName} | Trạng thái: ${row.dataset.status}`;
      drawer.hidden = false;
    }));
    chart?.destroy();
    chart = chartFactory(root.querySelector("canvas"), { type: "line", data: { labels: (data.series || []).map((point) => point.timestamp), datasets: ["messages", "alerts", "onlineBots"].map((key) => ({ label: key, data: (data.series || []).map((point) => point[key] || 0) })) } });
  }
  async function load(range = "24h") {
    renderLoading();
    try {
      const response = await fetchImpl(`/api/dashboard/overview?range=${range}`);
      if (!response.ok) throw new Error("Overview request failed");
      render(await response.json(), range);
      lastMetricsAt = now();
    } catch (error) {
      renderError(range);
    }
  }
  return {
    load,
    applyMetrics() { lastMetricsAt = now(); root.dataset.stale = "false"; },
    applyActivity(activity) { const item = document.createElement("li"); item.textContent = activity?.type || "activity"; root.querySelector("#overviewActivity")?.prepend(item); },
    checkStale() { const stale = now() - lastMetricsAt > 45000; root.dataset.stale = String(stale); const freshness = root.querySelector("#overviewFreshness"); if (freshness) freshness.textContent = stale ? "Dữ liệu không còn mới" : "Dữ liệu mới"; return stale; },
    destroy: () => chart?.destroy(),
  };
}
