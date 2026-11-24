const socket = window.socket || io();
let currentPage = "dashboard";
let commandData = [];
let groupSettingsData = {};
let selectedGroups = {};
let selectedFriends = {};
let logs = [];
let botReady = false;
let currentSelectedBotUid = "";
let pendingBotUid = "";
let botGateResolved = false;
let botGateReloaded = sessionStorage.getItem("dashboard_reloaded") === "1";
let modalReturnFocus = null;

function asBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "connected", "running", "success"].includes(value.toLowerCase());
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

function normalizeResponse(data) {
  if (data == null) return { success: false };
  if (typeof data === "string") return { success: true, message: data };
  if (typeof data !== "object") return { success: Boolean(data) };
  return data;
}

function getResponseMessage(data, fallback) {
  const payload = normalizeResponse(data);
  return payload.message || payload.error || fallback;
}

document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
});

function initDashboard() {
  initWorkspaceShell();
  const initializers = [
    initNavigation, setupSocketListeners, initRefreshButton, initRestartBotButton,
    initFullscreenButton, initStopBotButton, initSidebarToggle, initSaveConfigBtn,
    initModalClose, initBotConnectionGate,
    () => (window.MYBOT_WORKSPACES?.initBotsWorkspace || initBotsWorkspaceFallback)({ initBotManagementPage, initBotControlButtons, initRunningBotsPage }),
    () => (window.MYBOT_WORKSPACES?.initAutomationWorkspace || initAutomationWorkspaceFallback)({ initCommandSearch, initCommandFilter, initAutoReplyPage, initChatSettings }),
    () => (window.MYBOT_WORKSPACES?.initMessagingWorkspace || initMessagingWorkspaceFallback)({ initSendButtons, initRecentMessagesPage }),
    () => (window.MYBOT_WORKSPACES?.initGroupsSecurityWorkspace || initGroupsSecurityWorkspaceFallback)({ initSaveGroupSettingsBtn, initAdminManagement, initScanGroups, initMutePage, initWhitelistPage, initAntiPage, initBlockListPage }),
    () => (window.MYBOT_WORKSPACES?.initSystemWorkspace || initSystemWorkspaceFallback)({ initCredentialsManagement, initClearLogsBtn }),
    initPremiumInteractions,
  ];
  initializers.forEach((initializer) => {
    try {
      const result = initializer();
      if (result && typeof result.catch === "function") {
        result.catch((error) => reportDashboardError(initializer.name, error));
      }
    } catch (error) {
      reportDashboardError(initializer.name, error);
    }
  });
}

function runWorkspaceFallback(initializers) {
  Object.values(initializers).forEach((initializer) => initializer?.());
}
const initBotsWorkspaceFallback = runWorkspaceFallback;
const initAutomationWorkspaceFallback = runWorkspaceFallback;
const initMessagingWorkspaceFallback = runWorkspaceFallback;
const initGroupsSecurityWorkspaceFallback = runWorkspaceFallback;
const initSystemWorkspaceFallback = runWorkspaceFallback;

function initWorkspaceShell() {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav) return;
  const workspaces = [
    ["Tổng quan", "dashboard", "fa-chart-pie", "overview"],
    ["Đội bot", "bot-management", "fa-network-wired", "bots"],
    ["Tự động hóa", "commands", "fa-terminal", "automation"],
    ["Tin nhắn", "sender", "fa-paper-plane", "messaging"],
    ["Nhóm & An toàn", "groups", "fa-users-cog", "groups-security"],
    ["Hệ thống", "credentials", "fa-server", "system"],
  ];
  nav.innerHTML = workspaces.map(([name, page, icon, workspace]) => `<a href="#${page}" class="nav-item" data-page="${page}" data-workspace="${workspace}"><i class="fas ${icon}" aria-hidden="true"></i><span>${name}</span></a>`).join("");
  const search = document.getElementById("globalSearch");
  if (search) search.placeholder = "T\u00ECm workspace...";
  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    nav.querySelectorAll(".nav-item").forEach((item) => { item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query); });
  });
}

function reportDashboardError(area, error) {
  if (error instanceof TypeError && /null \(reading 'addEventListener'\)/.test(String(error.message))) return;
  console.error(`[Dashboard] ${area} failed`, error);
  if (typeof showToast === "function" && document.getElementById("toastContainer")) {
     showToast("M\u1ed9t ph\u1ea7n d\u1eef li\u1ec7u ch\u01b0a t\u1ea3i \u0111\u01b0\u1ee3c. Vui l\u00f2ng th\u1eed l\u1ea1i.", "error");
  }
}

window.addEventListener("unhandledrejection", (event) => reportDashboardError("async", event.reason));
window.addEventListener("error", (event) => reportDashboardError("runtime", event.error || event.message));

function initBotConnectionGate() {
  const layout = document.getElementById("dashboardLayout");
  if (!layout) return;
  const waitingEl = document.createElement("div");
  waitingEl.id = "botWaitingScreen";
  waitingEl.className = "bot-waiting-screen";
  waitingEl.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><p id="botWaitingText">Checking bot status...</p>';
  document.body.appendChild(waitingEl);
  const removeWaiting = () => {
    if (waitingEl && waitingEl.isConnected) waitingEl.remove();
  };
  const applyStatus = (status, source) => {
    if (!status || typeof status !== "object") return;
    const isConnected = asBoolean(status.botConnected ?? status.connected ?? status.success);
    botReady = isConnected;
    const statusEl = document.getElementById("botConnectionState");
    if (statusEl && status.botConnected !== undefined) {
      statusEl.textContent = isConnected ? "Đã kết nối" : "Chưa kết nối";
    }
    if (isConnected) {
      botGateResolved = true;
      removeWaiting();
      return;
    }
    if (source === "timeout") {
      botGateResolved = true;
      removeWaiting();
    }
  };
  socket.on("botStatus", (data) => {
    applyStatus(data, "socket");
  });
  socket.on("connect", () => {
    loadRunningBots();
  });
  fetch("/api/bot/status")
    .then((res) => res.json())
    .then((data) => applyStatus(data, "rest"))
    .catch(() => {});
  setTimeout(() => {
    if (!botGateResolved) {
      applyStatus({ botConnected: false }, "timeout");
      loadRunningBots();
    }
  }, 1500);
}

function initNavigation() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
    });
  });
  const initialRoute = window.MYBOT_ROUTER?.resolveRoute(location.hash) || { page: location.hash.slice(1) };
  const initialPage = initialRoute.page;
  if (initialPage && document.getElementById(`page-${initialPage}`)) {
    currentPage = "";
    navigateTo(initialPage);
  }
}

function navigateTo(page) {
  if (!page || !document.getElementById(`page-${page}`)) return;
  if (currentPage === page) return;
  if (currentPage === "bot-management") {
    closeBotDetailPanel();
  }
  currentPage = page;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add("active");
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add("active");
  const titles = {
    dashboard: "Dashboard",
    "bot-info": "Th\u00f4ng s\u1ed1 Bot",
    commands: "Qu\u1ea3n l\u00fd l\u1ec7nh",
    groups: "C\u00e0i \u0111\u1eb7t nh\u00f3m",
    sender: "Gửi tin nhắn",
    logs: "Nh\u1eadt k\u00fd h\u1ec7 th\u1ed1ng",
    "bot-control": "Điều khiển Bot",
    admins: "Qu\u1ea3n l\u00fd Admin",
    credentials: "Th\u00f4ng tin \u0111\u0103ng nh\u1eadp",
    "scan-groups": "Qu\u00e9t nh\u00f3m",
    mute: "Qu\u1ea3n l\u00fd Mute",
    whitelist: "Whitelist",
    anti: "C\u1ea5u h\u00ecnh b\u1ea3o v\u1ec7",
    "auto-reply": "Auto-Reply Rules",
    "block-list": "Danh s\u00e1ch ch\u1eb7n",
    "recent-messages": "Tin nh\u1eafn g\u1ea7n \u0111\u00e2y",
    "chat-settings": "C\u00e0i \u0111\u1eb7t Chat",
    "qr-login": "Th\u00eam Bot b\u1eb1ng QR",
    "bot-management": "Qu\u1ea3n l\u00fd Bot",
  };
  document.getElementById("pageTitle").textContent = titles[page] || page;
  document.title = `${titles[page] || page} | MYBOT`;
  const route = window.MYBOT_ROUTER?.resolveRoute(page)?.route || page;
  history.replaceState(null, "", `#${route}`);
  if (page === "commands") loadCommands();
  if (page === "groups") loadGroups();
  if (page === "bot-info") loadBotInfo();
  if (page === "bot-control") loadBotControlStatus();
  if (page === "admins") loadAdmins();
  if (page === "credentials") loadCredentials();
  if (page === "mute") loadMuteList();
  if (page === "whitelist") loadWhitelist();
  if (page === "anti") loadAntiConfig();
  if (page === "auto-reply") loadAutoReplyRules();
  if (page === "block-list") loadBlockList();
  if (page === "recent-messages") {
    initRecentMessagesPage();
    loadRecentMessages();
  }
  if (page === "chat-settings") loadChatSettings();
  if (page === "qr-login") initQrLoginPage();
  if (page === "bot-management") {
    loadBots();
    if (pendingBotUid) {
      const uid = pendingBotUid;
      pendingBotUid = "";
      const waitForRow = () => {
        const row = document.querySelector(`#botsTableBody tr[data-bot-uid="${escapeHtml(uid)}"]`);
        if (row) {
          openBotDetail(uid);
        } else {
          setTimeout(waitForRow, 100);
        }
      };
      waitForRow();
    }
  }
  if (page === "dashboard") {
    loadRunningBots();
    loadInitialData();
  }
}

function setupSocketListeners() {
  socket.on("connect", () => {
    updateConnectionStatus(true);
    addLog("info", "Connected to dashboard server");
    loadInitialData();
  });

  socket.on("disconnect", () => {
    updateConnectionStatus(false);
    addLog("error", "Disconnected from dashboard server");
  });

  socket.on("commandList", (data) => {
    commandData = Array.isArray(data?.commands) ? data.commands : Array.isArray(data) ? data : [];
    renderCommands();
  });

  socket.on("initialData", (data) => {
    if (data.groupSettings) groupSettingsData = data.groupSettings;
    if (data.selectedGroups) selectedGroups = data.selectedGroups;
    if (data.selectedFriends) selectedFriends = data.selectedFriends;
  });

  socket.on("groupsList", (data) => {
    if (data && typeof data === "object") {
      populateGroupSelect(data);
    }
  });

  socket.on("friendsList", (data) => {
    const list = Array.isArray(data?.friends) ? data.friends : Array.isArray(data) ? data : [];
    addLog("info", `Nhaon ac danh sAch baon bA : ${list.length} ngai`);
  });

  socket.on("messageSent", (data) => {
    const payload = normalizeResponse(data);
    if (payload.success === false) {
      showToast(getResponseMessage(payload, "Gi tin nhn tht bi"), "error");
      return;
    }
    const message = getResponseMessage(payload, "Gi tin nhn thnh cng");
    addLog("success", message);
    showToast(message, "success");
  });

  socket.on("configUpdated", (data) => {
    const payload = normalizeResponse(data);
    if (payload.success) {
      showToast(payload.message || "Cp nht cu hnh thnh cng", "success");
      loadInitialData();
    } else if (payload.message || payload.error) {
      showToast(getResponseMessage(payload, "Li khi lu"), "error");
    }
  });

  socket.on("newMessage", (data) => {
    const sender = data && data.senderName ? data.senderName : "unknown";
    const content = typeof data.content === "string" ? data.content : JSON.stringify(data.content);
    const nameType = data && data.nameType ? data.nameType : "message";
    addLog("message", { nameType, sender, content });
  });

  socket.on("bulkMessageStatus", (status) => {
    const payload = normalizeResponse(status);
    addLog("info", `Bulk message: ${payload.status || payload.message || status}`);
  });

  socket.on("selectedData", (data) => {
    if (data && data.selectedGroups) selectedGroups = data.selectedGroups;
    if (data && data.selectedFriends) selectedFriends = data.selectedFriends;
  });

  socket.on("activeBotStatusUpdated", (data) => {
    addLog("info", `Active bot status updated for group ${data.groupId}: ${data.isActive}`);
  });

  socket.on("commandUpdated", (data) => {
    const payload = normalizeResponse(data);
    if (payload.success) {
      showToast(payload.message || "Cp nht lnh thnh cng", "success");
      loadCommands();
    } else if (payload.error || payload.message) {
      showToast(getResponseMessage(payload, "Li khi cp nht lnh"), "error");
    }
  });

  socket.on("error", (msg) => {
    addLog("error", msg);
    showToast(msg, "error");
  });

  socket.on("botStopped", (msg) => {
    addLog("warning", msg || "Bot A dang");
    showToast(msg || "Bot A dang", "warning");
    document.getElementById("statBotStatus").textContent = "\u0110\u00e3 t\u1eaft";
  });

  socket.on("botActionResult", (data) => {
    if (!data) return;
    if (data.success) {
      showToast(data.message || "AA caop nhaot bot", "success");
    } else {
      showToast(data.error || "Thao tAc bot thaot baoi", "error");
    }
    loadRunningBots();
    if (currentSelectedBotUid) {
      loadBotDetails(currentSelectedBotUid);
    }
  });
}

function updateConnectionStatus(connected) {
  const el = document.getElementById("connectionStatus");
  const dot = el.querySelector(".status-dot");
  const text = el.querySelector("span:last-child");
  if (connected) {
    dot.className = "status-dot connected";
    text.textContent = " kt ni";
  } else {
    dot.className = "status-dot disconnected";
    text.textContent = "Cha kt ni";
  }
}

function initRefreshButton() {
  document.getElementById("refreshBtn").addEventListener("click", () => {
    loadInitialData();
    if (currentPage === "commands") loadCommands();
    if (currentPage === "groups") loadGroups();
    if (currentPage === "bot-info") loadBotInfo();
    if (currentPage === "bot-control") loadBotControlStatus();
    if (currentPage === "admins") loadAdmins();
    if (currentPage === "credentials") loadCredentials();
    showToast("\u0110\u00e3 l\u00e0m m\u1edbi d\u1eef li\u1ec7u", "info");
  });
}

function initRestartBotButton() {
  document.getElementById("topbarRestartBotBtn").addEventListener("click", () => {
    if (!confirm("Ban co chac muon khoi ong lai bot khong?")) return;
    try {
      socket.emit("restartBot");
      showToast("Đang khởi động lại Bot...", "warning");
      addLog("warning", "Gui yeu cau khoi ong lai bot");
    } catch (error) {
      showToast("Kh\u00f4ng th\u1ec3 g\u1eedi y\u00eau c\u1ea7u kh\u1edfi \u0111\u1ed9ng l\u1ea1i Bot", "error");
    }
  });
}

function initFullscreenButton() {
  document.getElementById("fullscreenBtn").addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });
}

function initStopBotButton() {
  document.getElementById("stopBotBtn").addEventListener("click", () => {
    const confirmed = confirm("Ban co chac muon tat bot khong? Hanh ong nay se dung toan bo hoat ong cua bot.");
    if (!confirmed) return;
    try {
      socket.emit("stopBot");
      showToast("Đang tắt Bot...", "warning");
      addLog("warning", "Gui yeu cau tat bot");
    } catch (error) {
      showToast("Kh\u00f4ng th\u1ec3 g\u1eedi y\u00eau c\u1ea7u t\u1eaft Bot", "error");
    }
  });
}

function initSidebarToggle() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const mobileButton = document.getElementById("mobileMenuButton");
  const setOpen = (open) => {
    sidebar.classList.toggle("open", open);
    document.body.classList.toggle("nav-open", open);
    mobileButton?.setAttribute("aria-expanded", String(open));
    if (backdrop) backdrop.hidden = !open;
  };
  document.getElementById("sidebarToggle")?.addEventListener("click", () => setOpen(!sidebar.classList.contains("open")));
  mobileButton?.addEventListener("click", () => setOpen(!sidebar.classList.contains("open")));
  backdrop?.addEventListener("click", () => setOpen(false));
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setOpen(false)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
}

function initCommandSearch() {
  document.getElementById("commandSearch").addEventListener("input", (e) => {
    renderCommands(e.target.value.toLowerCase());
  });
}

function initCommandFilter() {
  document.getElementById("commandFilter").addEventListener("change", (e) => {
    renderCommands(document.getElementById("commandSearch").value.toLowerCase(), e.target.value);
  });
}

function initSaveConfigBtn() {
  document.getElementById("saveConfigBtn").addEventListener("click", async () => {
    const prefix = document.getElementById("botPrefix").value;
    const webPort = parseInt(document.getElementById("botWebPort").value, 10);
    if (!prefix || !Number.isFinite(webPort) || webPort <= 0) {
      showToast("Ti\u1ec1n t\u1ed1 ho\u1eb7c c\u1ed5ng kh\u00f4ng h\u1ee3p l\u1ec7", "warning");
      return;
    }
    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, webPort }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.success) {
        showToast(data.message || "Lu cu hnh thnh cng", "success");
        addLog("success", "Cu hnh bot  c cp nht");
        loadInitialData();
      } else {
        showToast((data && (data.error || data.message)) || "Li khi lu", "error");
      }
    } catch (error) {
      showToast("L\u1ed7i k\u1ebft n\u1ed1i m\u00e1y ch\u1ee7", "error");
    }
  });
}

function initSaveGroupSettingsBtn() {
  document.getElementById("saveGroupSettingsBtn").addEventListener("click", async () => {
    const groupId = document.getElementById("groupSelect").value;
    if (!groupId) {
      showToast("Vui l\u00f2ng ch\u1ecdn nh\u00f3m", "warning");
      return;
    }
    const settings = {};
    document.querySelectorAll("#groupSettingsList .setting-item").forEach((item) => {
      const key = item.dataset.setting;
      const toggle = item.querySelector(".toggle-switch input");
      settings[key] = toggle.checked;
    });
    try {
      const res = await fetch("/api/group-settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, settings }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.success) {
        showToast(data.message || "Lu ci t nhm thnh cng", "success");
        addLog("success", `Ci t nhm ${groupId}  c cp nht`);
        loadGroups();
      } else {
        showToast((data && (data.error || data.message)) || "Li khi lu", "error");
      }
    } catch (error) {
      showToast("Li kaot ni server", "error");
    }
  });
}

function initSendButtons() {
  document.getElementById("sendMsgBtn").addEventListener("click", sendMessage);
  document.getElementById("sendBulkMsgBtn").addEventListener("click", sendBulkMessage);
  document.getElementById("sendSelectedBtn").addEventListener("click", sendSelectedMessage);
}

function initClearLogsBtn() {
  document.getElementById("clearLogsBtn").addEventListener("click", () => {
    logs = [];
    const container = document.getElementById("logsContainer");
    container.innerHTML = '<div class="log-entry log-info"><span class="log-message">Logs cleared</span></div>';
  });
}

function initModalClose() {
  document.getElementById("modalClose")?.addEventListener("click", closeModal);
  document.getElementById("modalOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("modalOverlay")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("modalOverlay")?.classList.contains("active")) closeModal();
  });
}

async function loadInitialData() {
  try {
    const [statusRes, configRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/config"),
    ]);
    const status = await statusRes.json();
    const config = await configRes.json();

    const commands = await fetch("/api/commands").then((r) => r.json()).catch(() => ({ commands: [] }));
    const groups = await fetch("/api/group-settings").then((r) => r.json()).catch(() => ({}));

    commandData = commands.commands || [];
    groupSettingsData = groups || {};
    renderCommands();
    populateGroupSelect(groups);
    updateStats(status, config, commands, groups);
    updateBotInfo(config);
    loadBotControlStatus();
    loadAdmins();
    loadCredentials();
    loadRunningBots();
  } catch (error) {
    console.error("Error loading initial data:", error);
  }
}

function updateStats(status, config, commands, groups) {
  const commandCount = Array.isArray(commands && commands.commands) ? commands.commands.length : 0;
  const groupCount = typeof groups === "object" && groups !== null ? Object.keys(groups).length : 0;
  animateCounter(document.getElementById("statCommandCount"), commandCount, 1000);
  animateCounter(document.getElementById("statGroupCount"), groupCount, 1000);
  document.getElementById("statBotStatus").textContent = status && status.botConnected ? "Connected" : "Disconnected";
  document.getElementById("statAdminCount").textContent = "-";
  document.getElementById("infoPrefix").textContent = config && config.prefix ? config.prefix : "!";
  document.getElementById("infoWebPort").textContent = (config && config.webPort) || (status && status.botWebPort) || 8888;
  document.getElementById("infoUptime").textContent = formatUptime(status && status.uptime ? status.uptime : 0);
  document.getElementById("infoMemory").textContent = formatMemory(status && status.memoryUsage ? status.memoryUsage : null);
}

function updateBotInfo(config) {
  document.getElementById("botPrefix").value = config && config.prefix ? config.prefix : "!";
  document.getElementById("botWebPort").value = (config && config.webPort) || 8888;
}

function loadCommands() {
  socket.emit("getCommands");
}

function loadGroups() {
  socket.emit("getAllGroups");
  socket.emit("getInitialData");
}

function loadBotInfo() {
  Promise.all([
    fetch("/api/config").then((res) => res.json()),
    fetch("/api/bot/account").then((res) => res.json()),
  ])
    .then(([config, accountRes]) => {
      updateBotInfo(config);
      const table = document.getElementById("botInfoTable");
      const rows = [
        ["Prefix", config && config.prefix ? config.prefix : "!"],
        ["Web Port", (config && config.webPort) || 8888],
        ["Cookie", config && config.cookie ? "C\u00f3" : "Kh\u00f4ng"],
        ["IMEI", config && config.imei ? String(config.imei).substring(0, 20) + "..." : "Kh\u00f4ng"],
        ["User Agent", config && config.userAgent ? String(config.userAgent).substring(0, 40) + "..." : "Kh\u00f4ng"],
      ];
      if (accountRes && accountRes.success && accountRes.account) {
        const acc = accountRes.account;
        rows.push(["Bot UID", acc.uid || "-"]);
        rows.push(["TAan BOT", acc.name || "-"]);
        rows.push(["Tr\u1ea1ng th\u00e1i", acc.status === "running" ? "\u0110ang ch\u1ea1y" : acc.status || "-"]);
        rows.push(["Web Port", acc.webPort || "-"]);
        if (acc.createdAt) {
          rows.push(["NgA y taoo", new Date(acc.createdAt).toLocaleString("vi-VN")]);
        }
        if (acc.expiryAt) {
          rows.push(["Haot haon", new Date(acc.expiryAt).toLocaleString("vi-VN")]);
        }
      } else {
        rows.push(["T\u00e0i kho\u1ea3n Bot", "Ch\u01b0a c\u00f3 Bot n\u00e0o \u0111ang ch\u1ea1y"]);
      }
      table.innerHTML = rows
        .map(([label, value]) => `<div class="info-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`)
        .join("");
    })
    .catch((err) => console.error("Error loading bot info:", err));
}

function renderCommands(searchTerm = "", filter = "all") {
  const tbody = document.getElementById("commandTableBody");
  let filtered = commandData;
  if (searchTerm) {
    filtered = filtered.filter(
      (cmd) =>
        String(cmd.name || "").toLowerCase().includes(searchTerm) ||
        (Array.isArray(cmd.alias) && cmd.alias.some((a) => String(a).toLowerCase().includes(searchTerm))) ||
        (cmd.description && String(cmd.description).toLowerCase().includes(searchTerm))
    );
  }
  if (filter === "active") {
    filtered = filtered.filter((cmd) => cmd.active !== false);
  } else if (filter === "inactive") {
    filtered = filtered.filter((cmd) => cmd.active === false);
  }

  const permissionLabels = {
    all: "Tất cả",
    adminBox: "Tr\u01b0\u1edfng/Ph\u00f3 nh\u00f3m",
    adminBot: "QTV Bot",
    adminLevelHigh: "QTV cấp cao",
  };

  tbody.innerHTML = filtered
    .map((cmd) => {
      const aliases = Array.isArray(cmd.alias) && cmd.alias.length
        ? `<br><small class="text-muted">T\u00ean kh\u00e1c: ${cmd.alias.map((alias) => escapeHtml(String(alias))).join(", ")}</small>`
        : "";
      const commandName = escapeHtml(String(cmd.name || ""));
      return `
      <tr>
        <td>${escapeHtml(String(cmd.icon || "-"))}</td>
        <td><strong>${commandName}</strong>${aliases}</td>
        <td>${escapeHtml(cmd.description || "-")}</td>
        <td>
          <input type="text" class="form-input reaction-input" data-cmd="${commandName}" value="${escapeHtml(cmd.reaction || "")}" placeholder="OK hoặc emoji" aria-label="Phản ứng cho lệnh ${commandName}" style="width:110px;padding:4px 8px;" />
          <div class="reaction-preview" data-preview="${escapeHtml(cmd.name)}" style="font-size:1.1rem;margin-top:4px;min-height:1.2em;">${escapeHtml(resolveReactionPreview(cmd.reaction || ""))}</div>
        </td>
        <td>
          <select class="form-select permission-select" data-cmd="${commandName}" aria-label="Quyền hạn cho lệnh ${commandName}" style="font-size:0.8rem;padding:4px 8px;">
            ${Object.entries(permissionLabels)
              .map(([key, label]) => `<option value="${key}" ${cmd.permission === key ? "selected" : ""}>${escapeHtml(label)}</option>`)
              .join("")}
          </select>
        </td>
        <td>
          <input type="number" class="form-input countdown-input" data-cmd="${commandName}" value="${cmd.countdown || 0}" min="0" aria-label="Thời gian chờ cho lệnh ${commandName}" style="width:70px;padding:4px 8px;" />
        </td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" class="active-toggle" data-cmd="${commandName}" aria-label="Bật hoặc tắt lệnh ${commandName}" ${cmd.active !== false ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>
          <div class="action-btns">
            <button class="btn btn-sm btn-secondary save-reaction-btn" data-cmd="${commandName}" type="button" title="Lưu phản ứng" aria-label="Lưu phản ứng cho lệnh ${commandName}"><i class="fas fa-smile" aria-hidden="true"></i></button>
            <button class="btn btn-sm btn-primary save-cmd-btn" data-cmd="${commandName}" type="button" title="L\u01b0u l\u1ec7nh" aria-label="L\u01b0u c\u1ea5u h\u00ecnh l\u1ec7nh ${commandName}"><i class="fas fa-save" aria-hidden="true"></i></button>
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  attachCommandListeners();
}

function attachCommandListeners() {
  document.querySelectorAll(".reaction-input").forEach((input) => {
    input.addEventListener("input", () => {
      const cmdName = input.dataset.cmd;
      const preview = document.querySelector(`[data-preview="${cmdName}"]`);
      if (preview) preview.textContent = resolveReactionPreview(input.value);
    });
  });

  document.querySelectorAll(".save-reaction-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cmdName = btn.dataset.cmd;
      const row = btn.closest("tr");
      const reaction = row.querySelector(".reaction-input").value.trim();
      try {
        const res = await fetch("/api/commands/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commands: commandData.map((cmd) =>
              cmd.name === cmdName ? { ...cmd, reaction } : cmd
            ),
          }),
        });
        const data = await res.json();
        if (data && data.success) {
          showToast(`Đã cập nhật phản ứng cho "${cmdName}"`, "success");
          loadCommands();
        } else {
          showToast((data && data.error) || "Lỗi khi cập nhật phản ứng", "error");
        }
      } catch (error) {
        showToast("Lỗi khi cập nhật phản ứng", "error");
      }
    });
  });

  document.querySelectorAll(".save-cmd-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cmdName = btn.dataset.cmd;
      const row = btn.closest("tr");
      const permission = row.querySelector(".permission-select").value;
      const countdown = parseInt(row.querySelector(".countdown-input").value) || 0;
      const active = row.querySelector(".active-toggle").checked;
      const reaction = row.querySelector(".reaction-input").value.trim();

      try {
        await fetch("/api/commands/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commands: commandData.map((cmd) =>
              cmd.name === cmdName ? { ...cmd, permission, countdown, active, reaction } : cmd
            ),
          }),
        });
        showToast(`Đã cập nhật lệnh "${cmdName}"`, "success");
        addLog("success", `Cập nhật lệnh "${cmdName}": permission=${permission}, countdown=${countdown}, active=${active}, reaction=${reaction || "-"}`);
        loadCommands();
      } catch (error) {
        showToast("Lỗi khi cập nhật lệnh", "error");
      }
    });
  });

  document.querySelectorAll(".permission-select").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const cmdName = select.dataset.cmd;
      const permission = select.value;
      try {
        const res = await fetch("/api/commands/permission", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandName: cmdName, permission }),
        });
        const data = await res.json();
        if (data && data.success) {
          showToast(`Đã thay đổi quyền hạn cho "${cmdName}"`, "success");
        } else if (data && data.error) {
          showToast(data.error, "error");
        }
      } catch (error) {
        showToast("Lỗi khi cập nhật quyền hạn", "error");
      }
    });
  });

  document.querySelectorAll(".countdown-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const cmdName = input.dataset.cmd;
      const countdown = parseInt(input.value) || 0;
      try {
        const res = await fetch("/api/commands/countdown", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandName: cmdName, countdown }),
        });
        const data = await res.json();
        if (data && data.success) {
          showToast(`Đã cập nhật thời gian chờ cho "${cmdName}"`, "success");
        } else if (data && data.error) {
          showToast(data.error, "error");
        }
      } catch (error) {
        showToast("Lỗi khi cập nhật thời gian chờ", "error");
      }
    });
  });

  document.querySelectorAll(".active-toggle").forEach((toggle) => {
    toggle.addEventListener("change", async (e) => {
      const cmdName = toggle.dataset.cmd;
      const active = toggle.checked;
      try {
        const res = await fetch("/api/commands/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandName: cmdName, active }),
        });
        const data = await res.json();
        if (data && data.success) {
          showToast(`Đã ${active ? "bật" : "tắt"} lệnh "${cmdName}"`, "success");
        } else if (data && data.error) {
          showToast(data.error, "error");
        }
      } catch (error) {
        showToast("Lỗi khi cập nhật trạng thái", "error");
      }
    });
  });
}

function populateGroupSelect(groups) {
  const select = document.getElementById("groupSelect");
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- Ch\u1ECDn nh\u00F3m --</option>';
  if (groups && typeof groups === "object") {
    Object.entries(groups).forEach(([groupId, settings]) => {
      const rawName = settings && settings.nameGroup ? String(settings.nameGroup).trim() : "";
      const name = rawName && rawName !== "?" ? rawName : "Nhm khng tn";
      select.innerHTML += `<option value="${escapeHtml(groupId)}" ${currentValue === groupId ? "selected" : ""}>${escapeHtml(name)} (${escapeHtml(groupId)})</option>`;
    });
  }

  const changeHandler = () => {
    const groupId = select.value;
    const form = document.getElementById("groupSettingsForm");
    if (!groupId || !groupSettingsData[groupId]) {
      form.style.display = "none";
      return;
    }
    form.style.display = "block";
    renderGroupSettings(groupId, groupSettingsData[groupId]);
  };

  select.onchange = changeHandler;
}

function populateGroupSelectForElement(selectId, groups, currentValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const val = currentValue || select.value;
  select.innerHTML = '<option value="">-- Ch\u1ECDn nh\u00F3m --</option>';
  if (groups && typeof groups === "object") {
    Object.entries(groups).forEach(([groupId, settings]) => {
      const rawName = settings && settings.nameGroup ? String(settings.nameGroup).trim() : "";
      const name = rawName && rawName !== "?" ? rawName : "Nhm khng tn";
      select.innerHTML += `<option value="${escapeHtml(groupId)}" ${val === groupId ? "selected" : ""}>${escapeHtml(name)} (${escapeHtml(groupId)})</option>`;
    });
  }
}

function renderGroupSettings(groupId, settings) {
  const list = document.getElementById("groupSettingsList");
  const settingsList = [
    { key: "activeBot", label: "Tương tác với thành viên" },
    { key: "activeGame", label: "Tuong tc tr choi" },
    { key: "antiSpam", label: "Chống spam" },
    { key: "removeLinks", label: "Chặn liên kết" },
    { key: "filterBadWords", label: "Lọc từ ngữ không phù hợp" },
    { key: "welcomeGroup", label: "Chào thành viên mới" },
    { key: "byeGroup", label: "Thông báo thành viên rời nhóm" },
    { key: "learnEnabled", label: "Học máy" },
    { key: "replyEnabled", label: "Trả lời tin nhắn nhóm" },
    { key: "onlyText", label: "Chỉ nhận tin nhắn văn bản" },
    { key: "memberApprove", label: "Phê duyệt thành viên mới" },
    { key: "antiNude", label: "Chặn ảnh nhạy cảm" },
    { key: "antiUndo", label: "Chống thu hồi tin nhắn" },
    { key: "sendTask", label: "Gửi nội dung tự động" },
    { key: "sendstk", label: "Gửi sticker tự động" },
    { key: "sendtext", label: "Gửi văn bản theo yêu cầu" },
    { key: "enableDownload", label: "Tự động tải video" },
    { key: "antiJoinLeave", label: "Chặn tham gia/rời nhóm liên tục" },
    { key: "antiKickBlock", label: "Chặn thao tác hàng loạt" },
    { key: "enableAntiBot", label: "Chặn Bot người dùng" },
    { key: "antiPhotoVideo", label: "Chặn ảnh và video" },
    { key: "antiVoice", label: "Chặn tin nhắn thoại" },
    { key: "antiText", label: "Chặn tin nhắn văn bản" },
    { key: "antiFile", label: "Chặn tệp" },
    { key: "blockForward", label: "Chặn chuyển tiếp" },
    { key: "autoJoin", label: "Tự động tham gia nhóm" },
    { key: "antiPhoneNumber", label: "Chặn số điện thoại" },
  ];

  list.innerHTML = settingsList
    .map((s) => {
      const value = settings && settings[s.key] === true;
      return `
      <div class="setting-item" data-setting="${escapeHtml(s.key)}">
        <span>${escapeHtml(s.label)}</span>
        <label class="toggle-switch">
          <input type="checkbox" class="group-setting-toggle" data-setting="${escapeHtml(s.key)}" aria-label="${escapeHtml(s.label)}" ${value ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
    })
    .join("");
}

async function sendMessage() {
  const content = document.getElementById("messageContent").value.trim();
  const target = document.getElementById("msgTarget").value;
  const delay = parseInt(document.getElementById("msgDelay").value) * 1000 || 0;

  if (!content) {
    showToast("Vui lòng nhập nội dung tin nhắn", "warning");
    return;
  }

  try {
    if (target === "all") {
      socket.emit("sendMessageAll", { message: content, messageType: "GroupMessage", delay });
    } else if (target === "friends") {
      socket.emit("sendMessageAll", { message: content, messageType: "DirectMessage", delay });
    } else if (target === "groups") {
      socket.emit("sendMessageAll", { message: content, messageType: "GroupMessage", delay });
    } else if (target === "selected") {
      socket.emit("sendMessageForSelected", { message: content, delay });
    }
    showToast("Đã gửi tin nhắn", "success");
    addLog("success", `Gai tin nhao n: "${content.substring(0, 50)}..." aon ${target}`);
  } catch (error) {
    showToast("Gửi tin nhắn thất bại", "error");
  }
}

async function sendBulkMessage() {
  const content = document.getElementById("messageContent").value.trim();
  const delay = parseInt(document.getElementById("msgDelay").value) * 1000 || 0;

  if (!content) {
    showToast("Vui long nhap noi dung tin nhan", "warning");
    return;
  }

  socket.emit("startBulkMessage", { content, interval: delay });
  showToast("AA bao t aou gai tin nhao n liAan tac", "info");
  addLog("info", `Bao t aou gai tin nhao n liAan tac v:i delay ${delay}ms`);
}

async function sendSelectedMessage() {
  const content = document.getElementById("messageContent").value.trim();
  const delay = parseInt(document.getElementById("msgDelay").value) * 1000 || 0;

  if (!content) {
    showToast("Vui long nhap noi dung tin nhan", "warning");
    return;
  }

  socket.emit("sendMessageForSelected", { message: content, delay });
  showToast("AA gai tin nhao n aon cAc mac A chan", "success");
  addLog("success", "Gai tin nhao n aon cAc mac A chan");
}

function addLog(type, message) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US");
  logs.push({ type, message, time: timeStr });
  if (logs.length > 500) logs.shift();
  renderLogs();
}

function renderLogs() {
  const container = document.getElementById("logsContainer");
  container.innerHTML = logs
    .map((log) => {
      const message = log.type === "message" ? `<span class="log-kind">${escapeHtml(log.message.nameType)} </span><span class="log-sender">${escapeHtml(log.message.sender)}</span><span class="log-content">${escapeHtml(log.message.content)}</span>` : `<span class="log-message">${escapeHtml(log.message)}</span>`;
      return `<div class="log-entry log-${escapeHtml(log.type)}"><span class="log-time">[${escapeHtml(log.time)}]</span>${message}</div>`;
    })
    .join("");
  container.scrollTop = container.scrollHeight;
}

function resolveReactionPreview(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "-";
  const named = {
    OK: "/-ok",
    HEART: "/-heart",
    LIKE: "/-strong",
    DISLIKE: "/-weak",
  };
  return named[trimmed] || trimmed;
}
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatMemory(mem) {
  if (!mem) return "-";
  const mb = mem.heapUsed / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icons = { success: "fa-check-circle", error: "fa-exclamation-circle", warning: "fa-exclamation-triangle", info: "fa-info-circle" };
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${escapeHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function openModal(title, bodyHtml) {
  modalReturnFocus = document.activeElement;
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  const overlay = document.getElementById("modalOverlay");
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    const firstControl = overlay.querySelector("input, select, textarea, button:not(.modal-close)");
    (firstControl || document.getElementById("modalContent"))?.focus();
  });
}

function closeModal() {
  const overlay = document.getElementById("modalOverlay");
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  if (modalReturnFocus && typeof modalReturnFocus.focus === "function") modalReturnFocus.focus();
  modalReturnFocus = null;
}

function initBotControlButtons() {
  const startBtn = document.getElementById("startBotBtn");
  const stopBtn = document.getElementById("stopBotBtn2");
  const restartBtn = document.getElementById("restartBotBtn");

  if (startBtn) {
    startBtn.addEventListener("click", () => {
      socket.emit("startBot");
      addLog("info", "Gui yeu cau khoi ong bot");
      showToast("ang khoi ong bot...", "info");
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (confirm("Baon c chao c mun TaoT BOT khA ng?")) {
        socket.emit("stopBot");
        addLog("warning", "Gai yAau caou tao t bot");
        showToast("Aang tao t bot...", "warning");
      }
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      if (confirm("Ban co chac muon khoi ong lai bot khong?")) {
        socket.emit("restartBot");
        addLog("warning", "Gui yeu cau khoi ong lai bot");
        showToast("ang khoi ong lai bot...", "warning");
      }
    });
  }
}

function initAdminManagement() {
  const addBtn = document.getElementById("addAdminBtn");
  const input = document.getElementById("adminIdInput");

  if (addBtn && input) {
    addBtn.addEventListener("click", () => {
      const userId = input.value.trim();
      if (!userId) {
        showToast("Vui lA2ng nhaop UID/Zalo ID", "warning");
        return;
      }
      socket.emit("addAdmin", { userId });
      input.value = "";
    });
  }

  socket.on("adminActionResult", (data) => {
    if (data && data.success) {
      showToast(data.message, "success");
      addLog("success", data.message);
      if (data.admins) renderAdminTable(data.admins);
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("adminsList", (data) => {
    if (data && data.success && Array.isArray(data.admins)) {
      renderAdminTable(data.admins);
    }
  });
}

function renderAdminTable(admins) {
  const tbody = document.getElementById("adminTableBody");
  const noAdmins = document.getElementById("noAdmins");
  if (!tbody) return;

  if (!admins || admins.length === 0) {
    tbody.innerHTML = "";
    if (noAdmins) noAdmins.style.display = "flex";
    return;
  }

  if (noAdmins) noAdmins.style.display = "none";
  tbody.innerHTML = admins
    .map((admin, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><strong>${escapeHtml(String(admin))}</strong></td>
        <td>
          <button class="btn btn-sm btn-danger remove-admin-btn" data-user="${escapeHtml(String(admin))}">
            <i class="fas fa-trash"></i> Xa
          </button>
        </td>
      </tr>
    `)
    .join("");

  document.querySelectorAll(".remove-admin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.user;
      if (confirm(`Xa admin ${userId}?`)) {
        socket.emit("removeAdmin", { userId });
      }
    });
  });
}

function initCredentialsManagement() {
  const saveBtn = document.getElementById("saveCredentialsBtn");
  const revealBtn = document.getElementById("revealCredentials");
  const controller = window.MYBOT_CREDENTIALS?.createCredentialsController?.({ document });
  controller?.initialize();
  revealBtn?.addEventListener("click", async () => {
    try {
      await controller?.reveal();
      showToast("Thông tin nhạy cảm đã được hiển thị.", "info");
    } catch (error) {
      showToast("Không thể tải thông tin nhạy cảm.", "error");
    }
  });
  if (!saveBtn) return;

  saveBtn.addEventListener("click", async () => {
    const cookie = document.getElementById("credCookie").value;
    const imei = document.getElementById("credImei").value;
    const userAgent = document.getElementById("credUserAgent").value;
    const phoneNumber = document.getElementById("credPhone").value;
    const zaloId = document.getElementById("credZaloId").value;

    try {
      const res = await fetch("/api/credentials/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie, imei, userAgent, phoneNumber, zaloId }),
      });
      const data = await res.json();
      if (data && data.success) {
        showToast("Caop nhaot credentials thA nh cA ng", "success");
        addLog("success", "Credentials A ac caop nhaot");
      } else {
        showToast((data && data.error) || "Li khi lu", "error");
      }
    } catch (error) {
      showToast("Li kaot ni server", "error");
    }
  });
}

function initScanGroups() {
  const scanBtn = document.getElementById("scanGroupsBtn");
  if (!scanBtn) return;

  scanBtn.addEventListener("click", () => {
    socket.emit("scanGroups");
    addLog("info", "Aang quAt nhm...");
    showToast("Aang quAt nhm...", "info");
  });

  socket.on("groupsScanned", (data) => {
    if (data && Array.isArray(data)) {
      renderScannedGroups(data);
      showToast(`AA quAt ac ${data.length} nhm`, "success");
      addLog("success", `QuAt nhm thA nh cA ng: ${data.length} nhm`);
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("groupMembersDetail", (data) => {
    if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", `Li laoy thA nh viAan: ${data.error}`);
      return;
    }
    if (data && data.success) {
      openModal("ThA nh viAan nhm", renderMembersTable(data.members || [], data.groupName || ""));
    }
  });

  socket.on("leaveGroupResult", (data) => {
    if (data && data.success) {
      showToast(`AA rai nhm ${data.threadId}`, "success");
      addLog("success", `Rai nhm thA nh cA ng: ${data.threadId}`);
    } else {
      showToast(data.error || "KhA ng tha rai nhm", "error");
      addLog("error", `Rai nhm thaot baoi: ${data.error || "unknown"}`);
    }
  });

  socket.on("kickUserResult", (data) => {
    if (data && data.success) {
      showToast(`AA kick thA nh viAan ${data.userId}`, "success");
      addLog("success", `Kick thA nh cA ng: ${data.userId}`);
    } else {
      showToast(data.error || "KhA ng tha kick", "error");
      addLog("error", `Kick thaot baoi: ${data.error || "unknown"}`);
    }
  });

  socket.on("blockUserResult", (data) => {
    if (data && data.success) {
      showToast(`AA block thA nh viAan ${data.userId || ""}`, "success");
      addLog("success", `Block thA nh cA ng: ${data.userId || ""}`);
    } else {
      showToast(data.error || "KhA ng tha block", "error");
      addLog("error", `Block thaot baoi: ${data.error || "unknown"}`);
    }
  });

  socket.on("sendMessageToUserResult", (data) => {
    if (data && data.success) {
      showToast(`AA gai tin nhao n aon ${data.userId || ""}`, "success");
      addLog("success", `Gai tin nhao n thA nh cA ng: ${data.userId || ""}`);
    } else {
      showToast(data.error || "KhA ng tha gai tin nhao n", "error");
      addLog("error", `Gai tin nhao n thaot baoi: ${data.error || "unknown"}`);
    }
  });

  // ========== NEW SOCKET LISTENERS ==========

  socket.on("muteResult", (data) => {
    if (data && data.success) {
      showToast(data.message || "Thao tAc mute thA nh cA ng", "success");
      addLog("success", data.message || "Mute thA nh cA ng");
      const page = document.getElementById("page-mute");
      if (page && page.classList.contains("active")) loadMuteList();
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("muteListUpdated", (data) => {
    const page = document.getElementById("page-mute");
    if (page && page.classList.contains("active")) loadMuteList();
  });

  socket.on("muteList", (data) => {
    if (data && data.success) {
      renderMuteTable(data.mutes);
    }
  });

  socket.on("whitelistResult", (data) => {
    if (data && data.success) {
      showToast(data.message || "Thao tAc whitelist thA nh cA ng", "success");
      addLog("success", data.message || "Whitelist thA nh cA ng");
      const page = document.getElementById("page-whitelist");
      if (page && page.classList.contains("active")) loadWhitelist();
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("whitelistUpdated", (data) => {
    const page = document.getElementById("page-whitelist");
    if (page && page.classList.contains("active")) loadWhitelist();
  });

  socket.on("whitelistList", (data) => {
    if (data && data.success) {
      renderWhitelistTable(data.whitelist);
    }
  });

  socket.on("blockListUpdated", (data) => {
    const page = document.getElementById("page-block-list");
    if (page && page.classList.contains("active")) loadBlockList();
  });

  socket.on("blockList", (data) => {
    if (data && data.success) {
      renderBlockTable(data.blocks);
    }
  });

  socket.on("blockResult", (data) => {
    if (data && data.success) {
      showToast(data.message || "Thao tAc block thA nh cA ng", "success");
      addLog("success", data.message || "Block thA nh cA ng");
      const page = document.getElementById("page-block-list");
      if (page && page.classList.contains("active")) loadBlockList();
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("autoReplyResult", (data) => {
    if (data && data.success) {
      showToast(data.message || "Caop nhaot auto-reply thA nh cA ng", "success");
      addLog("success", data.message || "Auto-reply caop nhaot");
      const page = document.getElementById("page-auto-reply");
      if (page && page.classList.contains("active")) loadAutoReplyRules();
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("autoReplyUpdated", (data) => {
    const page = document.getElementById("page-auto-reply");
    if (page && page.classList.contains("active")) loadAutoReplyRules();
  });

  socket.on("autoReplyRulesList", (data) => {
    if (data && data.success) {
      renderAutoReplyRules(data.rules);
    }
  });

  socket.on("antiUpdateResult", (data) => {
    if (data && data.success) {
      showToast(data.message || "Caop nhaot anti-* thA nh cA ng", "success");
      addLog("success", data.message || "Anti-* caop nhaot");
      const page = document.getElementById("page-anti");
      if (page && page.classList.contains("active")) loadAntiConfig();
    } else if (data && data.error) {
      showToast(data.error, "error");
      addLog("error", data.error);
    }
  });

  socket.on("antiUpdated", (data) => {
    const page = document.getElementById("page-anti");
    if (page && page.classList.contains("active")) loadAntiConfig();
  });

  socket.on("messageLogResult", (data) => {
    if (data && data.success) {
      loadRecentMessages();
    }
  });

  socket.on("messageLogged", (data) => {
    if (data && data.success) {
      const page = document.getElementById("page-recent-messages");
      if (page && page.classList.contains("active")) loadRecentMessages();
    }
  });

  socket.on("messageLogList", (data) => {
    if (data && data.success) {
      renderMessagesTable(data.messages);
    }
  });
}

let currentGroupThreadId = "";

function renderMembersTable(members, groupName) {
  if (!members || members.length === 0) {
    return `<p>Khong co thanh vien nao.</p>`;
  }
  window.__allMembers = members;
  const rows = members
    .map((m, idx) => {
      const phone = escapeHtml(String(m.phone || "ao n"));
      const name = escapeHtml(String(m.zaloName || m.name || "N/A"));
      const uid = escapeHtml(String(m.id || ""));
      const gender = m.gender === 0 ? "Nam" : m.gender === 1 ? "Na " : "ao n";
      const status = m.isOnline ? "xx Online" : (m.isActive ? "x Active" : "a Offline");
      const role = m.isCreator ? "x Cha nhm" : (m.isAdmin ? "a Admin" : "x ThA nh viAan");
      return `
        <tr data-name="${escapeHtml(String(m.zaloName || m.name || ""))}" data-phone="${escapeHtml(String(m.phone || ""))}" data-uid="${uid}">
          <td>${idx + 1}</td>
          <td>${uid}</td>
          <td>${name}</td>
          <td>${phone}</td>
          <td>${gender}</td>
          <td>${escapeHtml(role)}</td>
          <td>${escapeHtml(status)}</td>
          <td>${escapeHtml(String(m.lastActive || "ao n"))}</td>
          <td>
            <button class="btn btn-sm btn-primary msg-user-btn" data-uid="${uid}" data-name="${escapeHtml(String(m.zaloName || m.name || ""))}">
              <i class="fas fa-envelope"></i>
            </button>
            <button class="btn btn-sm btn-warning kick-user-btn" data-uid="${uid}" data-name="${escapeHtml(String(m.zaloName || m.name || ""))}">
              <i class="fas fa-user-times"></i>
            </button>
            <button class="btn btn-sm btn-danger block-user-btn" data-uid="${uid}" data-name="${escapeHtml(String(m.zaloName || m.name || ""))}">
              <i class="fas fa-ban"></i>
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  const html = `
    <div class="members-wrapper">
      <div class="members-toolbar">
        <h4>Danh sAch thA nh viAan nhm: ${escapeHtml(groupName)} (${members.length})</h4>
        <div class="members-actions">
          <input type="text" id="memberSearch" class="form-input search-input" placeholder="TAm tAan / SAT / UID..." />
          <button class="btn btn-sm btn-success" id="exportMembersCsvBtn"><i class="fas fa-file-download"></i> Xuaot CSV</button>
          <button class="btn btn-sm btn-secondary" id="closeMembersBtn"><i class="fas fa-times"></i> Ang</button>
        </div>
      </div>
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>UID</th>
              <th>TAan</th>
              <th>SAT</th>
              <th>Gi:i tAnh</th>
              <th>Vai trA2</th>
              <th>Traong thAi</th>
              <th>Hoaot "ng cui</th>
              <th>Thao tAc</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="members-hint">x Baom nAot x a nhao n tin, ai  a kick, xa a block thA nh viAan.</p>
    </div>
  `;

  setTimeout(() => {
    const searchInput = document.getElementById("memberSearch");
    const tbody = document.querySelector(".members-wrapper .data-table tbody");
    const filterRows = () => {
      const term = (searchInput.value || "").toLowerCase();
      const rows = tbody.querySelectorAll("tr");
      rows.forEach(row => {
        const haystack = [
          row.dataset.name || "",
          row.dataset.phone || "",
          row.dataset.uid || ""
        ].join(" ").toLowerCase();
        row.style.display = haystack.includes(term) ? "" : "none";
      });
    };
    if (searchInput) searchInput.addEventListener("input", filterRows);

    const closeBtn = document.getElementById("closeMembersBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);

    const exportBtn = document.getElementById("exportMembersCsvBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        const list = window.__allMembers || [];
        if (!list.length) {
          showToast("Danh sAch thA nh viAan rng", "warning");
          return;
        }
        const header = ["STT","UID","Ten","SDT","Gioi tinh","Vai tro","Trang thai","Hoat dong cuoi"];
        const rowsCsv = list.map((m, i) => [
          i + 1,
          m.id || "",
          (m.zaloName || m.name || "").replace(/,/g, " "),
          m.phone || "ao n",
          m.gender === 0 ? "Nam" : m.gender === 1 ? "Na " : "ao n",
          m.isCreator ? "Cha nhm" : (m.isAdmin ? "Admin" : "ThA nh viAan"),
          m.isOnline ? "Online" : (m.isActive ? "Active" : "Offline"),
          m.lastActive || "ao n"
        ].join(","));
        const csvContent = "\uFEFF" + [header.join(","), ...rowsCsv].join("\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `thanh_vien_${(groupName || "nhom").replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("AA xuaot CSV", "success");
      });
    }

    document.querySelectorAll(".msg-user-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.dataset.uid;
        const name = btn.dataset.name;
        const msg = prompt(`Nhao n tin aon ${name} (${uid}):`);
        if (msg && msg.trim()) {
          socket.emit("sendMessageToUser", { userId: uid, message: msg.trim() });
        }
      });
    });
    document.querySelectorAll(".kick-user-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.dataset.uid;
        const name = btn.dataset.name;
        if (confirm(`Kick ${name} (${uid}) khai nhm?`)) {
          socket.emit("kickUserFromGroup", { threadId: currentGroupThreadId, userId: uid });
        }
      });
    });
    document.querySelectorAll(".block-user-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.dataset.uid;
        const name = btn.dataset.name;
        if (confirm(`Block ${name} (${uid}) khai nhm?`)) {
          socket.emit("blockUserFromGroup", { threadId: currentGroupThreadId, userId: uid });
        }
      });
    });
  }, 50);

  return html;
}

let currentScannedGroups = [];

function renderScannedGroups(groups) {
  currentScannedGroups = groups || [];
  const tbody = document.getElementById("scannedGroupsBody");
  const noGroups = document.getElementById("noScannedGroups");
  const searchInput = document.getElementById("scanGroupSearch");
  const countLabel = document.getElementById("scanGroupCount");
  if (!tbody) return;

  if (!groups || groups.length === 0) {
    tbody.innerHTML = "";
    if (noGroups) noGroups.style.display = "flex";
    if (countLabel) countLabel.textContent = "";
    return;
  }

  if (noGroups) noGroups.style.display = "none";
  if (countLabel) countLabel.textContent = `${groups.length} nhm`;

  const filterGroups = (searchTerm) => {
    const term = (searchTerm || "").toLowerCase();
    return groups.filter((g) => {
      const name = String(g.name || g.nameGroup || "").toLowerCase();
      const id = String(g.id || g.groupId || "").toLowerCase();
      return name.includes(term) || id.includes(term);
    });
  };

  const render = (filteredGroups) => {
    tbody.innerHTML = filteredGroups
      .map((group, index) => {
        const groupId = String(group.id || group.groupId || "");
        const groupName = String(group.name || group.nameGroup || "N/A");
        const memberCount = group.memberCount || group.totalMember || group.memVerList?.length || 0;
        return `
        <tr>
          <td><strong>${escapeHtml(groupId)}</strong></td>
          <td>${escapeHtml(groupName)}</td>
          <td><span class="badge badge-info">${memberCount}</span></td>
          <td>
            <div class="action-btns-group">
              <button class="btn btn-sm btn-primary view-group-btn" data-group='${escapeHtml(JSON.stringify(group))}'>
                <i class="fas fa-eye"></i> Members
              </button>
              <button class="btn btn-sm btn-success msg-group-btn" data-group-id="${escapeHtml(groupId)}" data-group-name="${escapeHtml(groupName)}">
                <i class="fas fa-envelope"></i> Nhao n
              </button>
              <button class="btn btn-sm btn-danger leave-group-btn" data-group-id="${escapeHtml(groupId)}" data-group-name="${escapeHtml(groupName)}">
                <i class="fas fa-sign-out-alt"></i> Rai
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join("");

    attachScanGroupListeners();
  };

  render(groups);

  if (searchInput) {
    searchInput.removeEventListener("input", searchInput._handler);
    searchInput._handler = () => {
      const term = searchInput.value.toLowerCase();
      const filtered = filterGroups(term);
      render(filtered);
      if (countLabel) countLabel.textContent = `${filtered.length}/${groups.length} nhm`;
    };
    searchInput.addEventListener("input", searchInput._handler);
  }
}

function attachScanGroupListeners() {
  document.querySelectorAll(".view-group-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = JSON.parse(btn.dataset.group);
      const threadId = String(group.id || group.groupId || "");
      const groupName = String(group.name || group.nameGroup || "");
      if (!threadId) {
        showToast("KhA ng c groupId", "error");
        return;
      }
      currentGroupThreadId = threadId;
      socket.emit("getGroupMembersDetail", { threadId, groupId: threadId });
      showToast(`Aang taoi thA nh viAan nhm ${groupName}...`, "info");
      addLog("info", `YAau caou laoy thA nh viAan nhm: ${threadId}`);
    });
  });

  document.querySelectorAll(".msg-group-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.groupId;
      const groupName = btn.dataset.groupName;
      navigateTo("sender");
      setTimeout(() => {
        const targetSelect = document.getElementById("msgTarget");
        if (targetSelect) {
          targetSelect.value = "groups";
        }
        showToast(`AA chuyan aon trang gai tin nhao n. Ch\u1EB7n nhm "${groupName}" a nhao n.`, "info");
      }, 300);
    });
  });

  document.querySelectorAll(".leave-group-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.groupId;
      const groupName = btn.dataset.groupName;
      if (confirm(`Baon c chao c mun rai nhm "${groupName}" (${groupId}) khA ng?`)) {
        socket.emit("leaveGroup", groupId);
        showToast(`Aang rai nhm ${groupId}...`, "info");
        addLog("info", `Gai yAau caou rai nhm: ${groupId}`);
      }
    });
  });
}

function loadCredentials() {
  if (window.MYBOT_CREDENTIALS?.createCredentialsController) return;
  fetch("/api/credentials")
    .then((res) => res.json())
    .then((data) => {
      if (data) {
        document.getElementById("credCookie").value = data.cookie || "";
        document.getElementById("credImei").value = data.imei || "";
        document.getElementById("credUserAgent").value = data.userAgent || "";
        document.getElementById("credPhone").value = data.phoneNumber || "";
        document.getElementById("credZaloId").value = data.zaloId || "";
      }
    })
    .catch((err) => console.error("Error loading credentials:", err));
}

function loadBotControlStatus() {
  fetch("/api/bot/status")
    .then((res) => res.json())
    .then((status) => {
      if (status) {
        document.getElementById("botControlStatus").textContent = status.botConnected ? "AA kaot ni" : "Cha kaot ni";
        document.getElementById("botControlUptime").textContent = formatUptime(status.uptime || 0);
        document.getElementById("botControlMemory").textContent = formatMemory(status.memoryUsage || null);
      }
    })
    .catch((err) => console.error("Error loading bot status:", err));
}

function loadAdmins() {
  socket.emit("getAdmins");
}

socket.on("botStatus", (data) => {
  addLog("info", `Bot status: ${data.message || JSON.stringify(data)}`);
  if (currentPage === "bot-control") {
    loadBotControlStatus();
  }
  const statusEl = document.getElementById("botControlStatus");
  if (statusEl && data.botConnected !== undefined) {
    statusEl.textContent = data.botConnected ? "AA kaot ni" : "Cha kaot ni";
  }
});

socket.on("credentialsUpdated", (data) => {
  if (data && data.success) {
    showToast(data.message || "Caop nhaot credentials thA nh cA ng", "success");
    addLog("success", data.message || "Credentials A ac caop nhaot");
    loadCredentials();
  } else if (data && data.error) {
    showToast(data.error, "error");
    addLog("error", data.error);
  }
});

socket.on("chatSettingsUpdated", (data) => {
  if (!data) return;
  const privateToggle = document.getElementById("chatPrivateToggle");
  const groupToggle = document.getElementById("chatGroupToggle");
  if (privateToggle) privateToggle.checked = !!data.privateEnabled;
  if (groupToggle) groupToggle.checked = !!data.groupEnabled;
  showToast("CA i aot chat A ac caop nhaot", "success");
});

// ==================== MUTE PAGE ====================

let muteGroupId = "";

function initMutePage() {
  const groupSelect = document.getElementById("muteGroupSelect");
  const addBtn = document.getElementById("addMuteBtn");

  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      muteGroupId = groupSelect.value;
      if (muteGroupId) loadMuteList();
    });
  }

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (!muteGroupId) {
        showToast("Vui lA2ng chan nhm", "warning");
        return;
      }
      openModal("Thêm thành viên bị tắt tiếng", `
        <div class="form-group">
          <label>User ID</label>
          <input type="text" id="muteUserId" class="form-input" placeholder="Nhập UID/Zalo ID..." />
        </div>
        <div class="form-group">
          <label>L do</label>
          <input type="text" id="muteReason" class="form-input" placeholder="Nhập lý do..." />
        </div>
        <div class="form-group">
          <label>Thời gian (giây, 0 = vĩnh viễn)</label>
          <input type="number" id="muteDuration" class="form-input" value="0" min="0" />
        </div>
        <button class="btn btn-primary" id="confirmMuteBtn"><i class="fas fa-ban"></i> Tắt tiếng</button>
      `);
      setTimeout(() => {
        const confirmBtn = document.getElementById("confirmMuteBtn");
        if (confirmBtn) {
          confirmBtn.addEventListener("click", () => {
            const userId = document.getElementById("muteUserId").value.trim();
            const reason = document.getElementById("muteReason").value.trim();
            const duration = parseInt(document.getElementById("muteDuration").value) || 0;
            if (!userId) {
              showToast("Vui lòng nhập User ID", "warning");
              return;
            }
            socket.emit("muteUser", { groupId: muteGroupId, userId, reason, duration });
            closeModal();
          });
        }
      }, 50);
    });
  }

  fetch("/api/group-settings")
    .then((res) => res.json())
    .then((groups) => {
      populateGroupSelectForElement("muteGroupSelect", groups, muteGroupId);
    })
    .catch((err) => console.error("Error loading groups for mute:", err));
}

function loadMuteList() {
  if (!muteGroupId) return;
  socket.emit("getMuteList", { groupId: muteGroupId });
}

function renderMuteTable(mutes) {
  const tbody = document.getElementById("muteTableBody");
  const noMutes = document.getElementById("noMutes");
  if (!tbody) return;

  if (!mutes || mutes.length === 0) {
    tbody.innerHTML = "";
    if (noMutes) noMutes.style.display = "flex";
    return;
  }

  if (noMutes) noMutes.style.display = "none";
  tbody.innerHTML = mutes
    .map((m) => {
      const date = new Date(m.mutedAt || Date.now());
      const timeStr = date.toLocaleString("vi-VN");
      return `
        <tr>
          <td><strong>${escapeHtml(String(m.userId))}</strong></td>
          <td>${escapeHtml(m.reason || "-")}</td>
          <td>${m.duration > 0 ? m.duration + "s" : "VAnh vi&n"}</td>
          <td>${timeStr}</td>
          <td>
            <button class="btn btn-sm btn-danger unmute-btn" data-userid="${escapeHtml(String(m.userId))}">
              <i class="fas fa-unlink"></i> Ba mute
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll(".unmute-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.userid;
      if (confirm(`Ba mute cho user ${userId}?`)) {
        socket.emit("unmuteUser", { groupId: muteGroupId, userId });
      }
    });
  });
}

// ==================== WHITELIST PAGE ====================

let whitelistGroupId = "";

function initWhitelistPage() {
  const groupSelect = document.getElementById("whitelistGroupSelect");
  const addBtn = document.getElementById("addWhitelistBtn");

  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      whitelistGroupId = groupSelect.value;
      if (whitelistGroupId) loadWhitelist();
    });
  }

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (!whitelistGroupId) {
        showToast("Vui lA2ng chan nhm", "warning");
        return;
      }
      openModal("Thêm vào danh sách tin cậy", `
        <div class="form-group">
          <label>User ID</label>
          <input type="text" id="whitelistUserId" class="form-input" placeholder="Nhập UID/Zalo ID..." />
        </div>
        <div class="form-group">
          <label>L do</label>
          <input type="text" id="whitelistReason" class="form-input" placeholder="Nhập lý do..." />
        </div>
        <button class="btn btn-primary" id="confirmWhitelistBtn"><i class="fas fa-shield-alt"></i> Thm</button>
      `);
      setTimeout(() => {
        const confirmBtn = document.getElementById("confirmWhitelistBtn");
        if (confirmBtn) {
          confirmBtn.addEventListener("click", () => {
            const userId = document.getElementById("whitelistUserId").value.trim();
            const reason = document.getElementById("whitelistReason").value.trim();
            if (!userId) {
              showToast("Vui lA2ng nhaop User ID", "warning");
              return;
            }
            socket.emit("addToWhitelist", { groupId: whitelistGroupId, userId, reason });
            closeModal();
          });
        }
      }, 50);
    });
  }

  fetch("/api/group-settings")
    .then((res) => res.json())
    .then((groups) => {
      populateGroupSelectForElement("whitelistGroupSelect", groups, whitelistGroupId);
    })
    .catch((err) => console.error("Error loading groups for whitelist:", err));
}

function loadWhitelist() {
  if (!whitelistGroupId) return;
  socket.emit("getWhitelist", { groupId: whitelistGroupId });
}

function renderWhitelistTable(whitelist) {
  const tbody = document.getElementById("whitelistTableBody");
  const noWhitelist = document.getElementById("noWhitelist");
  if (!tbody) return;

  if (!whitelist || whitelist.length === 0) {
    tbody.innerHTML = "";
    if (noWhitelist) noWhitelist.style.display = "flex";
    return;
  }

  if (noWhitelist) noWhitelist.style.display = "none";
  tbody.innerHTML = whitelist
    .map((w) => {
      const date = new Date(w.addedAt || Date.now());
      const timeStr = date.toLocaleString("vi-VN");
      return `
        <tr>
          <td><strong>${escapeHtml(String(w.userId))}</strong></td>
          <td>${escapeHtml(w.reason || "-")}</td>
          <td>${timeStr}</td>
          <td>
            <button class="btn btn-sm btn-danger remove-whitelist-btn" data-userid="${escapeHtml(String(w.userId))}">
              <i class="fas fa-trash"></i> Xa
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll(".remove-whitelist-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.userid;
      if (confirm(`Xa ${userId} khai whitelist?`)) {
        socket.emit("removeFromWhitelist", { groupId: whitelistGroupId, userId });
      }
    });
  });
}

// ==================== ANTI-* PAGE ====================

let antiGroupId = "";

function initAntiPage() {
  const groupSelect = document.getElementById("antiGroupSelect");
  const saveBtn = document.getElementById("saveAntiConfigBtn");

  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      antiGroupId = groupSelect.value;
      if (antiGroupId) loadAntiConfig();
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      if (!antiGroupId) {
        showToast("Vui lA2ng chan nhm", "warning");
        return;
      }
      const settings = {};
      document.querySelectorAll("#antiSettingsGrid .anti-setting-item").forEach((item) => {
        const key = item.dataset.setting;
        const toggle = item.querySelector(".toggle-switch input");
        settings[key] = toggle.checked;
      });
      socket.emit("antiUpdate", { groupId: antiGroupId, settings });
      showToast("AA lu caou hAnh anti-*", "success");
      addLog("success", `Caop nhaot caou hAnh anti-* cho nhm ${antiGroupId}`);
    });
  }

  fetch("/api/group-settings")
    .then((res) => res.json())
    .then((groups) => {
      populateGroupSelectForElement("antiGroupSelect", groups, antiGroupId);
    })
    .catch((err) => console.error("Error loading groups for anti:", err));
}

function loadAntiConfig() {
  if (!antiGroupId) return;
  fetch(`/api/anti/config?groupId=${encodeURIComponent(antiGroupId)}`)
    .then((res) => res.json())
    .then((data) => {
      if (data && data.success) {
        const groupSettings = data.config.groupSettings || {};
        const antiKeys = [
          "antiSpam", "removeLinks", "filterBadWords", "antiNude", "antiUndo",
          "antiJoinLeave", "antiKickBlock", "enableAntiBot", "antiPhotoVideo",
          "antiVoice", "antiText", "antiFile", "blockForward", "antiPhoneNumber"
        ];
        const antiLabels = {
          antiSpam: "Chống spam",
          removeLinks: "Chặn liên kết",
          filterBadWords: "Lọc từ ngữ không phù hợp",
          antiNude: "Chặn ảnh nhạy cảm",
          antiUndo: "Chống thu hồi tin nhắn",
          antiJoinLeave: "Chặn tham gia/rời nhóm liên tục",
          antiKickBlock: "Chặn thao tác hàng loạt",
          enableAntiBot: "Chặn Bot người dùng",
          antiPhotoVideo: "Chặn ảnh và video",
          antiVoice: "Chặn tin nhắn thoại",
          antiText: "Chặn tin nhắn văn bản",
          antiFile: "Chặn tệp",
          blockForward: "Chặn chuyển tiếp",
          antiPhoneNumber: "Chặn số điện thoại",
        };
        const grid = document.getElementById("antiSettingsGrid");
        if (grid) {
          grid.innerHTML = antiKeys
            .map((key) => {
              const label = antiLabels[key] || key;
              const value = groupSettings[key] === true;
              return `
                <div class="anti-setting-item" data-setting="${escapeHtml(key)}">
                  <span>${escapeHtml(label)}</span>
                  <label class="toggle-switch">
                    <input type="checkbox" class="anti-toggle" data-setting="${escapeHtml(key)}" aria-label="${escapeHtml(label)}" ${value ? "checked" : ""} />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              `;
            })
            .join("");
        }
      }
    })
    .catch((err) => console.error("Error loading anti config:", err));
}

// ==================== AUTO-REPLY PAGE ====================

let autoReplyGroupId = "";

function initAutoReplyPage() {
  const groupSelect = document.getElementById("autoReplyGroupSelect");
  const addBtn = document.getElementById("addAutoReplyRuleBtn");

  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      autoReplyGroupId = groupSelect.value;
      if (autoReplyGroupId) loadAutoReplyRules();
    });
  }

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (!autoReplyGroupId) {
        showToast("Vui lA2ng chan nhm", "warning");
        return;
      }
      openModal("Thêm quy tắc trả lời tự động", `
        <div class="form-group">
          <label>Từ khóa kích hoạt</label>
          <input type="text" id="ruleTrigger" class="form-input" placeholder="Nhập từ khóa..." />
        </div>
        <div class="form-group">
          <label>Nội dung phản hồi</label>
          <textarea id="ruleResponse" rows="3" class="form-input" placeholder="Nhập nội dung phản hồi..."></textarea>
        </div>
        <button class="btn btn-primary" id="confirmAddRuleBtn"><i class="fas fa-plus"></i> Thêm quy tắc</button>
      `);
      setTimeout(() => {
        const confirmBtn = document.getElementById("confirmAddRuleBtn");
        if (confirmBtn) {
          confirmBtn.addEventListener("click", () => {
            const trigger = document.getElementById("ruleTrigger").value.trim();
            const response = document.getElementById("ruleResponse").value.trim();
            if (!trigger || !response) {
              showToast("Vui lA2ng nhaop cao trigger vA  phaon hi", "warning");
              return;
            }
            addAutoReplyRule(autoReplyGroupId, trigger, response);
            closeModal();
          });
        }
      }, 50);
    });
  }
}

function addAutoReplyRule(groupId, trigger, response) {
  fetch("/api/auto-reply/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId, rules: [{ trigger, response, createdAt: Date.now() }] }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.success) {
        showToast("AA thAam rule auto-reply", "success");
        addLog("success", "ThAam rule auto-reply thA nh cA ng");
        loadAutoReplyRules();
      } else {
        showToast((data && data.error) || "Li khi thAam rule", "error");
      }
    })
    .catch((err) => console.error("Error adding auto-reply rule:", err));
}

function loadAutoReplyRules() {
  if (!autoReplyGroupId) return;
  socket.emit("getAutoReplyRules", { groupId: autoReplyGroupId });
}

function renderAutoReplyRules(rules) {
  const list = document.getElementById("autoReplyRulesList");
  const noRules = document.getElementById("noAutoReplyRules");
  if (!list) return;

  if (!rules || rules.length === 0) {
    list.innerHTML = "";
    if (noRules) noRules.style.display = "flex";
    return;
  }

  if (noRules) noRules.style.display = "none";
  list.innerHTML = rules
    .map((rule, index) => {
      const date = new Date(rule.createdAt || Date.now());
      const timeStr = date.toLocaleString("vi-VN");
      return `
        <div class="rule-card">
          <div class="rule-header">
            <strong>Trigger:</strong> ${escapeHtml(rule.trigger)}
            <span class="rule-index">#${index + 1}</span>
          </div>
          <div class="rule-body">
            <strong>Phaon hi:</strong> ${escapeHtml(rule.response)}
          </div>
          <div class="rule-footer">
            <span class="text-muted">${timeStr}</span>
            <button class="btn btn-sm btn-danger remove-rule-btn" data-index="${index}">
              <i class="fas fa-trash"></i> Xa
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  document.querySelectorAll(".remove-rule-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = parseInt(btn.dataset.index);
      if (confirm(`Xa rule #${index + 1}?`)) {
        removeAutoReplyRule(autoReplyGroupId, index);
      }
    });
  });
}

function removeAutoReplyRule(groupId, index) {
  fetch("/api/auto-reply/rules", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId, ruleIndex: index }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.success) {
        showToast("AA xa rule auto-reply", "success");
        addLog("success", "Xa rule auto-reply thA nh cA ng");
        loadAutoReplyRules();
      } else {
        showToast((data && data.error) || "Li khi xa rule", "error");
      }
    })
    .catch((err) => console.error("Error removing auto-reply rule:", err));
}

// ==================== BLOCK LIST PAGE ====================

let blockGroupId = "";

function initBlockListPage() {
  const groupSelect = document.getElementById("blockGroupSelect");
  const addBtn = document.getElementById("addBlockBtn");

  if (groupSelect) {
    groupSelect.addEventListener("change", () => {
      blockGroupId = groupSelect.value;
      if (blockGroupId) loadBlockList();
    });
  }

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (!blockGroupId) {
        showToast("Vui lA2ng chan nhm", "warning");
        return;
      }
      openModal("Thêm người dùng bị chặn", `
        <div class="form-group">
          <label>User ID</label>
          <input type="text" id="blockUserId" class="form-input" placeholder="Nhập UID/Zalo ID..." />
        </div>
        <div class="form-group">
          <label>L do</label>
          <input type="text" id="blockReason" class="form-input" placeholder="Nhập lý do..." />
        </div>
        <button class="btn btn-primary" id="confirmBlockBtn"><i class="fas fa-ban"></i> Chặn</button>
      `);
      setTimeout(() => {
        const confirmBtn = document.getElementById("confirmBlockBtn");
        if (confirmBtn) {
          confirmBtn.addEventListener("click", () => {
            const userId = document.getElementById("blockUserId").value.trim();
            const reason = document.getElementById("blockReason").value.trim();
            if (!userId) {
              showToast("Vui lA2ng nhaop User ID", "warning");
              return;
            }
            socket.emit("blockUserFromGroup", { groupId: blockGroupId, userId, reason });
            closeModal();
          });
        }
      }, 50);
    });
  }
}

function loadBlockList() {
  if (!blockGroupId) return;
  socket.emit("getBlockList", { groupId: blockGroupId });
}

function renderBlockTable(blocks) {
  const tbody = document.getElementById("blockTableBody");
  const noBlocks = document.getElementById("noBlocks");
  if (!tbody) return;

  if (!blocks || blocks.length === 0) {
    tbody.innerHTML = "";
    if (noBlocks) noBlocks.style.display = "flex";
    return;
  }

  if (noBlocks) noBlocks.style.display = "none";
  tbody.innerHTML = blocks
    .map((b) => {
      const date = new Date(b.blockedAt || Date.now());
      const timeStr = date.toLocaleString("vi-VN");
      return `
        <tr>
          <td><strong>${escapeHtml(String(b.userId))}</strong></td>
          <td>${escapeHtml(b.reason || "-")}</td>
          <td>${timeStr}</td>
          <td>
            <button class="btn btn-sm btn-danger unblock-btn" data-userid="${escapeHtml(String(b.userId))}">
              <i class="fas fa-unlink"></i> Ba block
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll(".unblock-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.userid;
      if (confirm(`Ba block cho user ${userId}?`)) {
        socket.emit("unblockUserFromGroup", { groupId: blockGroupId, userId });
      }
    });
  });
}

// ==================== RECENT MESSAGES PAGE ====================

function initRecentMessagesPage() {
  const refreshBtn = document.getElementById("refreshMessagesBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      loadRecentMessages();
    });
  }
}

function loadRecentMessages() {
  const groupId = document.getElementById("msgGroupSelect")?.value || "";
  const limit = document.getElementById("msgLimit")?.value || "50";
  const params = new URLSearchParams();
  if (groupId) params.set("groupId", groupId);
  params.set("limit", limit);

  fetch(`/api/messages/recent?${params.toString()}`)
    .then((res) => res.json())
    .then((data) => {
      if (data && data.success) {
        renderMessagesTable(data.messages);
      }
    })
    .catch((err) => console.error("Error loading recent messages:", err));
}

function renderMessagesTable(messages) {
  const tbody = document.getElementById("messagesTableBody");
  const noMessages = document.getElementById("noMessages");
  if (!tbody) return;

  if (!messages || messages.length === 0) {
    tbody.innerHTML = "";
    if (noMessages) noMessages.style.display = "flex";
    return;
  }

  if (noMessages) noMessages.style.display = "none";
  tbody.innerHTML = messages
    .map((msg, idx) => {
      const date = new Date(msg.loggedAt || Date.now());
      const timeStr = date.toLocaleString("vi-VN");
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(msg.groupId || "-")}</td>
          <td>${escapeHtml(String(msg.userId || "-"))}</td>
          <td>${escapeHtml(msg.userName || "-")}</td>
          <td class="msg-content">${escapeHtml(content.substring(0, 200))}${content.length > 200 ? "..." : ""}</td>
          <td>${timeStr}</td>
        </tr>
      `;
    })
    .join("");
}

// ==================== QR LOGIN PAGE ====================

function initQrLoginPage() {
  const startBtn = document.getElementById("startQrLoginBtn");
  const cancelBtn = document.getElementById("cancelQrLoginBtn");

  if (startBtn) {
    startBtn.addEventListener("click", () => {
      socket.emit("startQrLogin");
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      socket.emit("cancelQrLogin");
    });
  }
}

socket.on("qrLoginStatus", (data) => {
  if (!data) return;
  const status = data.status;
  const startView = document.getElementById("qrLoginStart");
  const workingView = document.getElementById("qrLoginWorking");
  const resultView = document.getElementById("qrLoginResult");
  const statusIcon = document.getElementById("qrStatusIcon");
  const statusTitle = document.getElementById("qrStatusTitle");
  const statusMessage = document.getElementById("qrStatusMessage");
  const qrImageWrapper = document.getElementById("qrImageWrapper");
  const qrImage = document.getElementById("qrImage");

  if (startView) startView.style.display = "none";
  if (resultView) resultView.style.display = "none";
  if (workingView) workingView.style.display = "block";

  if (status === "initializing" || status === "generating_qr") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-spinner fa-spin fa-2x"></i>';
    if (statusTitle) statusTitle.textContent = "Đang khởi tạo...";
    if (statusMessage) statusMessage.textContent = "Vui lA2ng cha trong giAy lAt";
    if (qrImageWrapper) qrImageWrapper.style.display = "none";
  } else if (status === "waiting_scan") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-qrcode fa-2x"></i>';
    if (statusTitle) statusTitle.textContent = "Đang tạo mã QR...";
    if (statusMessage) statusMessage.textContent = "Mx app Zalo vA  quAt mA QR bAan d:i";
    if (qrImageWrapper) {
      qrImageWrapper.style.display = "block";
      if (qrImage) qrImage.src = "/api/qr-login/image?" + Date.now();
    }
  } else if (status === "scanned") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-check-circle fa-2x"></i>';
    if (statusTitle) statusTitle.textContent = "D qut m QR";
    if (statusMessage) statusMessage.textContent = data.message || "Vui lA2ng xAc nhaon trAan thiaot b9";
    if (qrImageWrapper) qrImageWrapper.style.display = "none";
  } else if (status === "success") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-check-circle fa-2x" style="color:#10b981;"></i>';
    if (statusTitle) statusTitle.textContent = "AAng nhaop thA nh cA ng!";
    if (statusMessage) statusMessage.textContent = data.message || "Đang tạo Bot...";
    if (qrImageWrapper) qrImageWrapper.style.display = "none";
  } else if (status === "failed") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-times-circle fa-2x" style="color:#ef4444;"></i>';
    if (statusTitle) statusTitle.textContent = "Thaot baoi";
    if (statusMessage) statusMessage.textContent = data.error || "QR login thaot baoi";
    if (qrImageWrapper) qrImageWrapper.style.display = "none";
    addLog("error", `QR login thaot baoi: ${data.error || "unknown"}`);
    showToast(data.error || "QR login thaot baoi", "error");
  } else if (status === "cancelled") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-ban fa-2x"></i>';
    if (statusTitle) statusTitle.textContent = "Đã hủy";
    if (statusMessage) statusMessage.textContent = "Baon A hay QR login";
    if (qrImageWrapper) qrImageWrapper.style.display = "none";
  } else if (status === "completed") {
    if (statusIcon) statusIcon.innerHTML = '<i class="fas fa-check-circle fa-2x" style="color:#10b981;"></i>';
    if (statusTitle) statusTitle.textContent = "HoA n taot";
    if (statusMessage) statusMessage.textContent = "PhiAan QR login A kaot thAoc";
    if (qrImageWrapper) qrImageWrapper.style.display = "none";
  }
});

socket.on("qrLoginStarted", (data) => {
  if (!data) return;
  if (data.qrImageUrl) {
    const qrImageWrapper = document.getElementById("qrImageWrapper");
    const qrImage = document.getElementById("qrImage");
    if (qrImageWrapper) qrImageWrapper.style.display = "block";
    if (qrImage) qrImage.src = data.qrImageUrl + "?" + Date.now();
  }
});

socket.on("qrLoginBotCreated", (data) => {
  if (!data) return;
  const workingView = document.getElementById("qrLoginWorking");
  const resultView = document.getElementById("qrLoginResult");
  const resultBox = document.getElementById("qrResultBox");
  const resultMessage = document.getElementById("qrResultMessage");
  const userInfo = document.getElementById("qrUserInfo");

  if (workingView) workingView.style.display = "none";
  if (resultView) resultView.style.display = "block";

  if (data.success) {
    if (resultBox) resultBox.className = "qr-result-box qr-result-success";
    if (resultMessage) resultMessage.textContent = data.message || "Bot A ac taoo thA nh cA ng";
    if (userInfo) {
      userInfo.innerHTML = `
        <div class="qr-user-detail"><strong>UID:</strong> ${escapeHtml(String(data.uidFrom || "-"))}</div>
        <div class="qr-user-detail"><strong>TAan:</strong> ${escapeHtml(String(data.dName || "-"))}</div>
        <div class="qr-user-detail"><strong>Port:</strong> ${escapeHtml(String(data.webPort || "-"))}</div>
      `;
    }
    addLog("success", `QR login taoo bot thA nh cA ng: ${data.dName || data.uidFrom}`);
    showToast(data.message || "Taoo bot thA nh cA ng", "success");
  } else {
    if (resultBox) resultBox.className = "qr-result-box qr-result-failure";
    if (resultMessage) resultMessage.textContent = data.error || "Taoo bot thaot baoi";
    if (userInfo) userInfo.innerHTML = "";
    addLog("error", `QR login taoo bot thaot baoi: ${data.error || "unknown"}`);
    showToast(data.error || "Taoo bot thaot baoi", "error");
  }
});

socket.on("qrLoginUserInfo", (data) => {
  if (!data || !data.userInfo) return;
  const userInfo = document.getElementById("qrUserInfo");
  if (!userInfo) return;

  const info = data.userInfo;
  const name = info?.data?.info?.name || info?.name || "-";
  const id = info?.data?.info?.id || info?.id || "-";

  userInfo.innerHTML = `
    <div class="qr-user-detail"><strong>TAan:</strong> ${escapeHtml(String(name))}</div>
    <div class="qr-user-detail"><strong>ID:</strong> ${escapeHtml(String(id))}</div>
  `;
});

// ==================== END QR LOGIN ====================

// ==================== BOT MANAGEMENT ====================
function initBotManagementPage() {
  const refreshBtn = document.getElementById("refreshBotsBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadBots);
  }

  const closeBtn = document.getElementById("closeBotPanelBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeBotDetailPanel);
  }
}

async function loadBots() {
  try {
    const response = await fetch("/api/bots", { headers: { Accept: "application/json" } });
    const payload = await response.json();
     if (!response.ok || !payload.success) throw new Error(getResponseMessage(payload, "Could not load the bot list."));
    const bots = Array.isArray(payload.data?.bots) ? payload.data.bots : Array.isArray(payload.bots) ? payload.bots : [];
    renderBotsTable(bots);
    renderRunningBotsCards(bots.filter((bot) => String(bot.status).toLowerCase() === "running"));
  } catch (error) {
    reportDashboardError("loadBots", error);
  }
}

function initRunningBotsPage() {
  loadRunningBots();
}

function loadRunningBots() {
  return loadBots();
}

function renderRunningBotsCards(bots) {
  const container = document.getElementById("runningBotsGrid");
  if (!container) return;

  if (!bots || !bots.length) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-robot"></i>
        <p>Chưa có Bot nào đang chạy</p>
        <button class="btn btn-primary" onclick="navigateTo('qr-login')"><i class="fas fa-qrcode"></i> ThAam BOT baong QR</button>
      </div>
    `;
    return;
  }

  container.innerHTML = bots
    .map((bot) => {
      const statusClass = getBotStatusClass(bot.health?.status || bot.status);
      const statusText = getBotStatusText(bot.health?.status || bot.status);
      return `
        <div class="running-bot-card" data-bot-uid="${escapeHtml(String(bot.uid || ""))}">
          <div class="running-bot-card-header">
            <div>
              <div class="running-bot-name">${escapeHtml(String(bot.displayName || bot.name || bot.uid || "-"))}</div>
              <div class="running-bot-uid">${escapeHtml(String(bot.uid || ""))}</div>
            </div>
            <span class="running-bot-status ${statusClass}"><i class="fas fa-circle" style="font-size:8px;"></i> ${statusText}</span>
          </div>
          <div class="running-bot-port">
            <i class="fas fa-network-wired"></i> Port: ${escapeHtml(String(bot.webPort || "-"))}
            ${bot.health && bot.health.lastSeen ? `<div style="opacity:.8;font-size:12px;margin-top:4px;">Last seen: ${escapeHtml(new Date(bot.health.lastSeen).toLocaleString("vi-VN"))}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".running-bot-card").forEach((card) => {
    card.addEventListener("click", () => {
      const uid = card.dataset.botUid;
      if (uid) {
        pendingBotUid = uid;
        navigateTo("bot-management");
      }
    });
  });
}

socket.on("botsList", (data) => {
  const payload = normalizeResponse(data);
  if (payload.success === false) {
    showToast(payload.error || "Không thể tải danh sách Bot", "error");
    return;
  }
  const bots = Array.isArray(payload.data?.bots) ? payload.data.bots : Array.isArray(payload.bots) ? payload.bots : [];
  const activeBots = bots.filter((bot) => String(bot.status).toLowerCase() === "running");
  renderBotsTable(bots);
  if (document.getElementById("page-dashboard")?.classList.contains("active")) {
    renderRunningBotsCards(activeBots);
  }
});

function renderBotsTable(bots) {
  const tbody = document.getElementById("botsTableBody");
  const noBots = document.getElementById("noBots");
  if (!tbody) return;

  if (!bots.length) {
    tbody.innerHTML = "";
    if (noBots) noBots.style.display = "flex";
    closeBotDetailPanel();
    return;
  }

  if (noBots) noBots.style.display = "none";
  tbody.innerHTML = bots
    .map(
      (bot, index) => {
        const statusClass = getBotStatusClass(bot.status);
        const statusText = getBotStatusText(bot.status);
  const created = bot.createdAt ? new Date(bot.createdAt).toLocaleString("vi-VN") : "-";
  const isSelected = bot.uid === currentSelectedBotUid;
  const healthStatus = bot.health?.status || bot.status;
        return `
          <tr class="${isSelected ? "bot-row-selected" : ""}" data-bot-uid="${escapeHtml(String(bot.uid || ""))}">
            <td>${index + 1}</td>
            <td><strong>${escapeHtml(String(bot.uid || bot.name || "-"))}</strong></td>
            <td>${escapeHtml(String(bot.displayName || "-"))}</td>
            <td><span class="bot-status-badge ${getBotStatusClass(healthStatus)}"><i class="fas fa-circle" style="font-size:8px;"></i> ${getBotStatusText(healthStatus)}</span></td>
            <td>${escapeHtml(String(bot.webPort || "-"))}</td>
            <td>${created}</td>
            <td>
              <div class="table-actions">
                <button class="bot-action-btn start" ${bot.enabled === false || bot.status === "disabled" ? "disabled" : ""} onclick="event.stopPropagation(); window.startBot('${escapeHtml(String(bot.uid || ""))}')"><i class="fas fa-play"></i> Start</button>
                <button class="bot-action-btn stop" onclick="event.stopPropagation(); window.stopBot('${escapeHtml(String(bot.uid || ""))}')"><i class="fas fa-stop"></i> Stop</button>
                ${bot.status === "disabled" ? `<button class="bot-action-btn start" onclick="event.stopPropagation(); window.enableBot('${escapeHtml(String(bot.uid || ""))}')"><i class="fas fa-unlock"></i> Enable</button>` : `<button class="bot-action-btn stop" ${bot.uid === "admin" ? "disabled" : ""} onclick="event.stopPropagation(); window.disableBot('${escapeHtml(String(bot.uid || ""))}')"><i class="fas fa-ban"></i> Disable</button>`}
                <button class="bot-action-btn delete" ${bot.uid === "admin" ? "disabled" : ""} onclick="event.stopPropagation(); window.deleteBot('${escapeHtml(String(bot.uid || ""))}', '${escapeHtml(String(bot.displayName || bot.uid || ""))}')"><i class="fas fa-trash"></i> Delete</button>
              </div>
            </td>
          </tr>
        `;
      }
    )
    .join("");

  document.querySelectorAll("#botsTableBody tr[data-bot-uid]").forEach((row) => {
    row.addEventListener("click", () => {
      const uid = row.dataset.botUid;
      if (uid) openBotDetail(uid);
    });
  });
}

function getBotStatusClass(status) {
  if (!status) return "bot-status-unknown";
  const s = String(status).toLowerCase();
  if (s === "running" || s === "online") return "bot-status-running";
  if (s === "stopped" || s === "stopping") return "bot-status-stopped";
  return "bot-status-unknown";
}

function getBotStatusText(status) {
  if (!status) return "Unknown";
  const s = String(status).toLowerCase();
  if (s === "running" || s === "online") return "Running";
  if (s === "stopped" || s === "stopping") return "Stopped";
  return status;
}

function openBotDetail(uid) {
  currentSelectedBotUid = uid;
  loadBotDetails(uid);
}

function closeBotDetailPanel() {
  currentSelectedBotUid = "";
  const panel = document.getElementById("selectedBotPanel");
  if (panel) panel.style.display = "none";
  document.querySelectorAll("#botsTableBody tr.bot-row-selected").forEach((row) => row.classList.remove("bot-row-selected"));
}

async function loadBotDetails(uid) {
  const panel = document.getElementById("selectedBotPanel");
  const nameEl = document.getElementById("selectedBotName");
  const detailsEl = document.getElementById("selectedBotDetails");
  const actionsEl = document.getElementById("selectedBotActions");

  if (!panel || !nameEl || !detailsEl || !actionsEl) return;

  panel.style.display = "block";
  nameEl.textContent = uid;
  detailsEl.innerHTML = '<p style="color:var(--text-muted)">Loading bot details...</p>';
  actionsEl.innerHTML = "";

  document.querySelectorAll("#botsTableBody tr.bot-row-selected").forEach((row) => row.classList.remove("bot-row-selected"));
  const row = document.querySelector(`#botsTableBody tr[data-bot-uid="${escapeHtml(uid)}"]`);
  if (row) row.classList.add("bot-row-selected");

  fetch(`/api/bots/${encodeURIComponent(uid)}`, { headers: { Accept: "application/json" } })
    .then((response) => response.json().then((payload) => ({ response, payload })))
    .then(({ response, payload }) => {
      if (!response.ok || !payload.success) throw new Error(getResponseMessage(payload, "Could not load bot details."));
       const bot = payload.data?.bot || payload.bot || payload.data;
       if (bot?.uid === currentSelectedBotUid || bot?.id === currentSelectedBotUid) renderSelectedBotDetails(bot);
    })
    .catch((error) => reportDashboardError("loadBotDetails", error));
}

function renderSelectedBotDetails(bot) {
  const detailsEl = document.getElementById("selectedBotDetails");
  const actionsEl = document.getElementById("selectedBotActions");
  const nameEl = document.getElementById("selectedBotName");
  if (!detailsEl || !actionsEl || !nameEl) return;

  nameEl.textContent = bot.displayName || bot.name || bot.uid || "-";

  const credentials = bot.credentials || {};
  const config = bot.config || {};

  detailsEl.innerHTML = `
    <div class="bot-detail-section-title">Basic information</div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Bot UID</span>
      <span class="bot-detail-value">${escapeHtml(String(bot.uid || "-"))}</span>
    </div>
    <div class="bot-detail-item">
       <span class="bot-detail-label">Display name</span>
      <input type="text" class="bot-detail-form-input" id="editDisplayName" value="${escapeHtml(String(bot.displayName || ""))}" />
    </div>
    <div class="bot-detail-item">
       <span class="bot-detail-label">Status</span>
      <span class="bot-detail-readonly">${escapeHtml(String(bot.status || "-"))}</span>
    </div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Web Port</span>
      <input type="text" class="bot-detail-form-input" id="editWebPort" value="${escapeHtml(String(bot.webPort || ""))}" />
    </div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Database</span>
      <span class="bot-detail-readonly">${escapeHtml(String(bot.database || "-"))}</span>
    </div>
    <div class="bot-detail-item">
       <span class="bot-detail-label">Created</span>
      <span class="bot-detail-readonly">${bot.createdAt ? new Date(bot.createdAt).toLocaleString("vi-VN") : "-"}</span>
    </div>
    <div class="bot-detail-item">
       <span class="bot-detail-label">Last updated</span>
      <span class="bot-detail-readonly">${bot.lastUpdated ? new Date(bot.lastUpdated).toLocaleString("vi-VN") : "-"}</span>
    </div>

    <div class="bot-detail-section-title">Credentials</div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">IMEI</span>
      <span class="bot-detail-readonly">${escapeHtml(String(credentials.imei || "-"))}</span>
    </div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">User Agent</span>
      <span class="bot-detail-readonly">${escapeHtml(String(credentials.userAgent || "-"))}</span>
    </div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Cookie</span>
       <span class="bot-detail-readonly">${credentials.cookie && credentials.cookie.cookies && credentials.cookie.cookies.length ? "Yes" : "No"}</span>
    </div>

    <div class="bot-detail-section-title">Config Paths</div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Web Config</span>
      <span class="bot-detail-readonly">${escapeHtml(String(config.WEB_CONFIG_PATH || "-"))}</span>
    </div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Log Dir</span>
      <span class="bot-detail-readonly">${escapeHtml(String(config.logDir || "-"))}</span>
    </div>
    <div class="bot-detail-item">
      <span class="bot-detail-label">Resource Dir</span>
      <span class="bot-detail-readonly">${escapeHtml(String(config.resourceDir || "-"))}</span>
    </div>

    <details class="bot-detail-credentials">
       <summary>View full bot configuration</summary>
      <pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre>
    </details>
  `;

  actionsEl.innerHTML = `
    <button class="btn btn-primary" id="saveBotDetailsBtn"><i class="fas fa-save"></i> Lưu thay đổi</button>
    <button class="btn btn-success" onclick="window.startBot('${escapeHtml(String(bot.uid || ""))}')"><i class="fas fa-play"></i> Start</button>
    <button class="btn btn-danger" onclick="window.stopBot('${escapeHtml(String(bot.uid || ""))}')"><i class="fas fa-stop"></i> Stop</button>
    <button class="btn btn-danger" ${bot.uid === "admin" ? "disabled" : ""} onclick="window.deleteBot('${escapeHtml(String(bot.uid || ""))}', '${escapeHtml(String(bot.displayName || bot.uid || ""))}')"><i class="fas fa-trash"></i> Delete</button>
  `;

  const saveBtn = document.getElementById("saveBotDetailsBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveSelectedBotDetails);
  }
}

async function saveSelectedBotDetails() {
  if (!currentSelectedBotUid) return;
  const displayName = document.getElementById("editDisplayName")?.value?.trim();
  const webPort = document.getElementById("editWebPort")?.value?.trim();

  if (!displayName && !webPort) {
    showToast("Khong co thay oi e luu", "warning");
    return;
  }

  socket.emit("updateBotInfo", { uid: currentSelectedBotUid, displayName, webPort });
}

socket.on("botDetails", (data) => {
  if (!currentSelectedBotUid) return;
  if (!data || !data.success) {
    showToast(data?.error || "Không thể tải chi tiết Bot", "error");
    return;
  }
  if (data.bot && data.bot.uid === currentSelectedBotUid) {
    renderSelectedBotDetails(data.bot);
  }
});

socket.on("botUpdated", (data) => {
  if (!currentSelectedBotUid && botActionsInFlight.size === 0) return;
  if (!data || !data.success) {
    showToast(data?.error || "Caop nhaot bot thaot baoi", "error");
    return;
  }
  showToast(data.message || "AA caop nhaot bot", "success");
  addLog("success", data.message || "Bot updated");
  loadBots();
  if (currentSelectedBotUid) {
    loadBotDetails(currentSelectedBotUid);
  }
});

window.closeBotPanel = function () {
  closeBotDetailPanel();
};

window.updateBotInfo = function (uid) {
  if (!uid) return;
  const displayName = document.getElementById("editDisplayName")?.value?.trim();
  const webPort = document.getElementById("editWebPort")?.value?.trim();
  socket.emit("updateBotInfo", { uid, displayName, webPort });
};

const botActionsInFlight = new Set();

async function requestBotAction(uid, action, payload = {}) {
  if (!uid || !/^[^\\/\0]{1,128}$/.test(uid)) {
    showToast("Invalid bot UID.", "error");
    return null;
  }
  const key = `${action}:${uid}`;
  if (botActionsInFlight.has(key)) return null;
  botActionsInFlight.add(key);
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(uid)}/actions/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const payload = await response.json().catch(() => ({ success: false, error: "The server returned invalid data." }));
    if (!response.ok || !payload.success) throw new Error(getResponseMessage(payload, "Bot action failed."));
    showToast(payload.message || "Bot updated.", "success");
    addLog("success", payload.message || `${action} bot ${uid}`);
    loadBots();
    if (action === "delete") closeBotDetailPanel();
    else if (currentSelectedBotUid === uid) loadBotDetails(uid);
    return payload;
  } catch (error) {
    console.error(`[Dashboard] ${action} Bot ${uid} failed`, error);
    showToast(error.message || "Bot action failed.", "error");
    return null;
  } finally {
    botActionsInFlight.delete(key);
  }
}

window.startBot = function startBot(uid) {
  return requestBotAction(uid, "start");
};

window.stopBot = function stopBot(uid) {
  if (!window.confirm("Stop this bot?")) return Promise.resolve(null);
  return requestBotAction(uid, "stop");
};

window.enableBot = function enableBot(uid) {
  return requestBotAction(uid, "enable");
};

window.disableBot = function disableBot(uid) {
  if (!window.confirm("Tắt bot này?")) return Promise.resolve(null);
  return requestBotAction(uid, "disable", { reason: "legacy dashboard" });
};

window.deleteBot = function deleteBot(uid, displayName = uid) {
  if (window.prompt("Nhập DELETE_SELECTED_BOTS để xác nhận xóa bot:") !== "DELETE_SELECTED_BOTS") return Promise.resolve(null);
  return requestBotAction(uid, "delete", { confirm: "DELETE_SELECTED_BOTS", confirmId: uid, confirmName: displayName });
};
// ==================== END BOT MANAGEMENT ====================

// ==================== CHAT SETTINGS ====================
function initChatSettings() {
  const saveBtn = document.getElementById("saveChatSettingsBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveChatSettings);
  }
}

async function loadChatSettings() {
  try {
    const res = await fetch("/api/chat-settings");
    const data = await res.json();
    if (data && data.success) {
      const privateToggle = document.getElementById("chatPrivateToggle");
      const groupToggle = document.getElementById("chatGroupToggle");
      if (privateToggle) privateToggle.checked = !!data.settings.privateEnabled;
      if (groupToggle) groupToggle.checked = !!data.settings.groupEnabled;
    }
  } catch (error) {
    console.error("Error loading chat settings:", error);
  }
}

async function saveChatSettings() {
  const privateEnabled = document.getElementById("chatPrivateToggle").checked;
  const groupEnabled = document.getElementById("chatGroupToggle").checked;
  try {
    const res = await fetch("/api/chat-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privateEnabled, groupEnabled }),
    });
    const data = await res.json();
    if (data && data.success) {
      showToast("Lu cA i aot chat thA nh cA ng", "success");
      addLog("success", "CA i aot chat A ac caop nhaot");
    } else {
      showToast((data && data.error) || "Li khi lu", "error");
    }
  } catch (error) {
    showToast("Li kaot ni server", "error");
  }
}
// ==================== END CHAT SETTINGS ====================

// ==================== PREMIUM INTERACTIONS ====================

function initPremiumInteractions() {
  initRippleEffect();
  initSmoothScroll();
  initKeyboardShortcuts();
  initIntersectionObserver();
}

function initRippleEffect() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn");
    if (!btn) return;
    const ripple = document.createElement("span");
    ripple.className = "ripple-effect";
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  });
}

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.querySelector(anchor.getAttribute("href"));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const shortcuts = {
      "r": () => { loadInitialData(); showToast("AA lA m m:i da  li!u", "info"); },
      "f": () => { const btn = document.getElementById("fullscreenBtn"); if (btn) btn.click(); },
      "s": () => { const btn = document.getElementById("sidebarToggle"); if (btn) btn.click(); },
      "1": () => navigateTo("dashboard"),
      "2": () => navigateTo("commands"),
      "3": () => navigateTo("bot-control"),
      "4": () => navigateTo("bot-management"),
      "5": () => navigateTo("groups"),
      "6": () => navigateTo("logs"),
    };
    const fn = shortcuts[e.key.toLowerCase()];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}

function initIntersectionObserver() {
  if (!("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("animate-in");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
  );
  document.querySelectorAll(".stat-card, .card, .running-bot-card").forEach((el) => {
    el.classList.add("observe-animate");
    observer.observe(el);
  });
}

function animateCounter(element, target, duration = 1200) {
  if (!element || isNaN(target)) return;
  const start = 0;
  const startTime = performance.now();
  const isFloat = !Number.isInteger(target);
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (target - start) * eased;
    element.textContent = isFloat ? current.toFixed(1) : Math.floor(current);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ==================== END PREMIUM INTERACTIONS ====================










