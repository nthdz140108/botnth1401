import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createDashboardSocket } from "../app/socket.js";
import {
  clearDashboardSession,
  getDashboardSession,
  loadDashboardSession,
  loginDashboardSession,
  logoutDashboardSession,
  subscribeDashboardSession,
} from "../app/session.js";
import { normalizeBotRecord, v4Fetch } from "./http.js";

import { awaitBotOperation } from "./operation-state.js";

const ControlCenterContext = createContext(null);

const OPERATIONS_STORAGE_KEY = "mybot_v4_operations";

function loadSavedOperations() {
  try {
    const raw = localStorage.getItem(OPERATIONS_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.slice(0, 50) : [];
  } catch {
    return [];
  }
}

export function ControlCenterProvider({ children }) {
  const [session, setSession] = useState(() => getDashboardSession());
  const [booting, setBooting] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem("mybot_v4_theme") || "dark");
  const [page, setPage] = useState("overview");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [detailBotId, setDetailBotId] = useState("");
  const [showAdminRecovery, setShowAdminRecovery] = useState(false);
  const [createQrTargetBot, setCreateQrTargetBot] = useState(null); // null | { mode: 'create' | 'relogin', botId?: string }
  const [showShortcutsGuide, setShowShortcutsGuide] = useState(false);

  const [overview, setOverview] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [bots, setBots] = useState([]);
  const [logs, setLogs] = useState([]);
  const [adminRecovery, setAdminRecovery] = useState({ state: "idle" });
  const [socketConnected, setSocketConnected] = useState(false);
  const [broadcastProgress, setBroadcastProgress] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [lastSyncAt, setLastSyncAt] = useState(() => new Date());

  // Operations Tracking System
  const [operations, setOperations] = useState(() => loadSavedOperations());
  const [activeOps, setActiveOps] = useState(() => ({})); // key: `${botId}_${action}` -> opId

  const autoPromptedDeadRef = useRef(false);

  // Save operations to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(OPERATIONS_STORAGE_KEY, JSON.stringify(operations.slice(0, 50)));
    } catch {}
  }, [operations]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("mybot_v4_theme", theme);
  }, [theme]);

  const notify = useCallback((message, tone = "info") => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-4), { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4500);
  }, []);

  useEffect(() => subscribeDashboardSession(setSession), []);

  useEffect(() => {
    let cancelled = false;
    loadDashboardSession()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async () => {
    if (!getDashboardSession().authenticated) return;
    try {
      const [ov, mt, rec, telem] = await Promise.all([
        v4Fetch("/api/dashboard/overview").catch(() => null),
        v4Fetch("/api/dashboard/metrics").catch(() => null),
        v4Fetch("/api/system/admin-recovery").catch(() => null),
        v4Fetch("/api/system/telemetry").catch(() => null),
      ]);

      setLastSyncAt(new Date());

      if (ov) {
        setOverview(ov);
        const normalized = Array.isArray(ov.bots) ? ov.bots.map(normalizeBotRecord).filter(Boolean) : [];
        setBots(normalized);
        setSelectedBotId((curr) => {
          if (curr && normalized.some((b) => b.id === curr)) return curr;
          return normalized[0]?.id || "";
        });
      }
      if (mt) setMetrics(mt);
      if (rec && typeof rec === "object") setAdminRecovery(rec);
      if (telem && typeof telem === "object") setTelemetry(telem);
    } catch (err) {
      if (err.status === 401) clearDashboardSession("AUTH_REQUIRED");
    }
  }, []);

  const loadInitialLogs = useCallback(async () => {
    if (!getDashboardSession().authenticated) return;
    try {
      const data = await v4Fetch("/api/logs?limit=150");
      if (Array.isArray(data?.logs)) {
        setLogs(data.logs);
      }
    } catch {
      // ignore initial log error
    }
  }, []);

  useEffect(() => {
    if (!session.authenticated) {
      setSocketConnected(false);
      setBots([]);
      setOverview(null);
      setMetrics(null);
      setTelemetry(null);
      autoPromptedDeadRef.current = false;
      return;
    }

    refreshAll();
    loadInitialLogs();

    const sock = createDashboardSocket({ csrfToken: session.csrfToken });
    sock.on("connect", () => {
      setSocketConnected(true);
      setLastSyncAt(new Date());
    });
    sock.on("disconnect", () => setSocketConnected(false));

    sock.on("dashboard:status", (payload) => {
      if (!payload || typeof payload !== "object") return;
      setLastSyncAt(new Date());
      setOverview((prev) => ({ ...(prev || {}), ...payload }));
      if (Array.isArray(payload.bots)) {
        setBots(payload.bots.map(normalizeBotRecord).filter(Boolean));
      }
    });

    sock.on("dashboard:metrics", (payload) => {
      if (payload && typeof payload === "object") {
        setLastSyncAt(new Date());
        setMetrics(payload);
      }
    });

    sock.on("dashboard:log", (entry) => {
      if (!entry) return;
      setLogs((prev) => [entry, ...prev].slice(0, 500));
    });

    sock.on("dashboard:admin_recovery", (payload) => {
      if (payload && typeof payload === "object") {
        setAdminRecovery(payload);
        if (payload.state === "completed" || payload.state === "success") {
          notify("Khôi phục đăng nhập Bot Admin thành công!", "success");
          refreshAll();
        }
      }
    });

    sock.on("dashboard:admin_alert", (payload) => {
      notify(payload?.message || "Cảnh báo: Cookie Bot Admin đã hết hạn! Hãy quét mã QR để khôi phục.", "error");
      setShowAdminRecovery(true);
      refreshAll();
    });

    sock.on("dashboard:broadcast_progress", (payload) => {
      setBroadcastProgress(payload);
    });

    const interval = setInterval(refreshAll, 4000);
    return () => {
      clearInterval(interval);
      sock.close();
    };
  }, [session.authenticated, session.csrfToken, refreshAll, loadInitialLogs, notify]);

  const adminBot = useMemo(() => {
    return bots.find((b) => b.isMain) || bots.find((b) => b.id === "admin" || b.id === "main") || null;
  }, [bots]);

  const adminNeedsRecovery = useMemo(() => {
    if (!session.authenticated) return false;
    if (bots.length === 0) return false;
    if (!adminBot) return true;
    return Boolean(
      adminBot.cookieDead === true ||
        adminBot.hasCookie === false ||
        adminBot.status === "cookie_dead" ||
        adminBot.status === "cookie_expired" ||
        adminBot.status === "error" ||
        adminBot.status === "identity_mismatch"
    );
  }, [session.authenticated, adminBot, bots.length]);

  // Auto-open Admin QR Recovery modal once per session if Admin cookie is dead or unconfigured on arrival
  useEffect(() => {
    if (session.authenticated && overview !== null && adminNeedsRecovery && !autoPromptedDeadRef.current) {
      autoPromptedDeadRef.current = true;
      setShowAdminRecovery(true);
    }
  }, [session.authenticated, overview, adminNeedsRecovery]);

  // Is stale indicator: not connected or last sync over 10s
  const isStale = useMemo(() => {
    if (!session.authenticated) return false;
    if (!socketConnected) return true;
    return Date.now() - new Date(lastSyncAt).getTime() > 10000;
  }, [session.authenticated, socketConnected, lastSyncAt]);

  // Helper: check if a specific action on a bot is running
  const isActionRunning = useCallback(
    (botId, action) => {
      if (!botId) return false;
      if (action) {
        return activeOps[`${botId}_${action}`] || false;
      }
      return Object.entries(activeOps).some(([k, opId]) => k.startsWith(`${botId}_`) && Boolean(opId));
    },
    [activeOps]
  );

  // Clear completed operations
  const clearOperations = useCallback(() => {
    setOperations((prev) => prev.filter((op) => op.status === "in_progress" || op.status === "pending"));
  }, []);

  // Run single bot action with operation tracking, timeline phases & smart troubleshooting
  const runBotAction = useCallback(
    async (botId, action, extraBody = {}) => {
      const targetBot = bots.find((b) => b.id === botId);
      const botDisplayName = targetBot?.displayName || targetBot?.name || botId;
      const opId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const startTime = Date.now();
      const actionKey = `${botId}_${action}`;

      const initialOp = {
        id: opId,
        botId,
        botName: botDisplayName,
        action,
        status: "in_progress",
        phase: "accepted", // 'accepted' -> 'connecting'/'stopping'/'standby' -> 'ws_ready'/'standby'/'completed'
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        error: null,
        recommendation: null,
        actionType: null,
      };

      setActiveOps((prev) => ({ ...prev, [actionKey]: opId }));
      setOperations((prev) => [initialOp, ...prev.slice(0, 49)]);

      // Phase 2: transition to intermediate phase
      setTimeout(() => {
        setOperations((prev) =>
          prev.map((op) => {
            if (op.id !== opId || op.status !== "in_progress") return op;
            const nextPhase =
              action === "start" || action === "restart"
                ? "connecting"
                : action === "stop" || action === "shutdown"
                  ? "stopping"
                  : action === "hot_standby" || action === "standby"
                    ? "standby"
                    : "connecting";
            return { ...op, phase: nextPhase };
          })
        );
      }, 150);

      try {
        let endpoint = `/api/bots/${encodeURIComponent(botId)}/actions/${encodeURIComponent(action)}`;
        const res = await v4Fetch(endpoint, {
          method: "POST",
          body: extraBody,
        });

        const confirmed = await awaitBotOperation({
          botId, action, response: res, fetchOperation: v4Fetch,
          onProgress: (serverOp) => setOperations((prev) => prev.map((op) => op.id === opId ? { ...op, phase: serverOp.phase || op.phase, operationId: serverOp.operationId } : op)),
        });
        const durationMs = Date.now() - startTime;
        const finalPhase = confirmed.phase;
        const finalStatus = finalPhase === "standby" ? "hot_standby" : "completed";

        setOperations((prev) =>
          prev.map((op) =>
            op.id === opId
              ? {
                  ...op,
                  status: finalStatus,
                  phase: finalPhase,
                  finishedAt: new Date().toISOString(),
                  durationMs,
                }
              : op
          )
        );

        notify(`Đã hoàn tất thao tác "${action}" cho ${botDisplayName} (${durationMs}ms).`, "success");
        await refreshAll();
        return res;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errMsg = err.message || `Thao tác ${action} thất bại`;

        // Smart troubleshooting recommendations
        let recommendation = "Thao tác gặp sự cố. Hãy kiểm tra Live Logs hoặc thử lại.";
        let actionType = "view_logs";

        const lowerErr = errMsg.toLowerCase();
        if (lowerErr.includes("cookie") || lowerErr.includes("hết hạn") || targetBot?.cookieDead) {
          recommendation = "Cookie Zalo đã hết hạn hoặc chưa đăng nhập. 👉 Khắc phục: Quét mã QR để đăng nhập lại.";
          actionType = "qr_login";
        } else if (lowerErr.includes("pm2") || lowerErr.includes("daemon")) {
          recommendation = "Dịch vụ quản lý tiến trình PM2 không phản hồi. 👉 Khắc phục: Kiểm tra PM2 daemon trên máy chủ.";
          actionType = "check_pm2";
        } else if (lowerErr.includes("timeout") || lowerErr.includes("offline") || err.status === 503 || err.status === 504) {
          recommendation = "Bot không phản hồi kết nối sau thời gian chờ. 👉 Khắc phục: Kiểm tra mạng máy chủ hoặc khởi động lại Bot.";
          actionType = "restart";
        }

        setOperations((prev) =>
          prev.map((op) =>
            op.id === opId
              ? {
                  ...op,
                  status: "failed",
                  phase: "error",
                  finishedAt: new Date().toISOString(),
                  durationMs,
                  error: errMsg,
                  recommendation,
                  actionType,
                }
              : op
          )
        );

        notify(errMsg, "error");
        throw err;
      } finally {
        setActiveOps((prev) => {
          const next = { ...prev };
          delete next[actionKey];
          return next;
        });
      }
    },
    [bots, notify, refreshAll]
  );

  // Bulk action with operation tracking
  const runBulkBotAction = useCallback(
    async (action, botIds, extraBody = {}) => {
      const opId = `op_bulk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const startTime = Date.now();
      const count = botIds.length;

      const initialOp = {
        id: opId,
        botId: `bulk_${count}`,
        botName: `Hàng loạt (${count} Bot)`,
        action: `bulk_${action}`,
        status: "in_progress",
        phase: "accepted",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        error: null,
        recommendation: null,
      };

      setOperations((prev) => [initialOp, ...prev.slice(0, 49)]);

      try {
        const res = await Promise.all(botIds.map((id) => runBotAction(id, action, extraBody)));

        const durationMs = Date.now() - startTime;
        setOperations((prev) =>
          prev.map((op) =>
            op.id === opId
              ? {
                  ...op,
                  status: "completed",
                  phase: "completed",
                  finishedAt: new Date().toISOString(),
                  durationMs,
                }
              : op
          )
        );

        notify(`Đã hoàn tất thao tác hàng loạt "${action}" trên ${count} bot.`, "success");
        await refreshAll();
        return res;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        setOperations((prev) =>
          prev.map((op) =>
            op.id === opId
              ? {
                  ...op,
                  status: "failed",
                  phase: "error",
                  finishedAt: new Date().toISOString(),
                  durationMs,
                  error: err.message || "Thao tác hàng loạt thất bại",
                  recommendation: "Kiểm tra lại từng bot trong danh sách xem có bot nào xung đột cookie hoặc port.",
                }
              : op
          )
        );

        notify(err.message || "Thao tác hàng loạt thất bại", "error");
        throw err;
      }
    },
    [notify, refreshAll, runBotAction]
  );

  // Retry operation
  const retryOperation = useCallback(
    async (opId) => {
      const op = operations.find((o) => o.id === opId);
      if (!op || !op.botId || op.botId.startsWith("bulk_")) return;
      return runBotAction(op.botId, op.action);
    },
    [operations, runBotAction]
  );

  const login = useCallback(async ({ username, password }) => {
    await loginDashboardSession({ username, password });
  }, []);

  const logout = useCallback(async () => {
    await logoutDashboardSession();
    setPage("overview");
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger if typing in an input/textarea/select unless Escape
      const tag = e.target?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable;

      if (e.key === "Escape") {
        if (showShortcutsGuide) {
          setShowShortcutsGuide(false);
          return;
        }
        if (detailBotId) {
          setDetailBotId("");
          return;
        }
        if (createQrTargetBot) {
          setCreateQrTargetBot(null);
          return;
        }
        if (showAdminRecovery) {
          setShowAdminRecovery(false);
          return;
        }
      }

      if (isInput) return;

      // 1-8 Page Navigation
      if (e.key >= "1" && e.key <= "8") {
        const navMap = [
          "overview",     // 1: Fleet
          "remote",       // 2: Remote Control
          "groups",       // 3: Groups & Shield
          "studio",       // 4: Studio & Schedule
          "operations",   // 5: Operations Tracker
          "performance",  // 6: Performance & Telemetry
          "logs",         // 7: Live Logs
          "security",     // 8: Security & System
        ];
        const targetPage = navMap[Number(e.key) - 1];
        if (targetPage) {
          e.preventDefault();
          setPage(targetPage);
        }
        return;
      }

      // r / R: Refresh All
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        notify("Đang đồng bộ lại dữ liệu toàn hệ thống...", "info");
        refreshAll();
        return;
      }

      // /: Focus bot search input
      if (e.key === "/") {
        e.preventDefault();
        const searchInput = document.querySelector('input[data-shortcut-search="true"]');
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        } else {
          setPage("overview");
          setTimeout(() => {
            const el = document.querySelector('input[data-shortcut-search="true"]');
            el?.focus();
          }, 100);
        }
        return;
      }

      // ?: Toggle Shortcut Guide
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowShortcutsGuide((prev) => !prev);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    showShortcutsGuide,
    detailBotId,
    createQrTargetBot,
    showAdminRecovery,
    refreshAll,
    notify,
  ]);

  const value = useMemo(
    () => ({
      session,
      booting,
      theme,
      setTheme,
      page,
      setPage,
      selectedBotId,
      setSelectedBotId,
      detailBotId,
      setDetailBotId,
      showAdminRecovery,
      setShowAdminRecovery,
      createQrTargetBot,
      setCreateQrTargetBot,
      showShortcutsGuide,
      setShowShortcutsGuide,
      overview,
      metrics,
      telemetry,
      bots,
      adminBot,
      adminNeedsRecovery,
      logs,
      setLogs,
      adminRecovery,
      setAdminRecovery,
      socketConnected,
      isStale,
      lastSyncAt,
      broadcastProgress,
      setBroadcastProgress,
      operations,
      activeOps,
      isActionRunning,
      clearOperations,
      retryOperation,
      toasts,
      notify,
      refreshAll,
      runBotAction,
      runBulkBotAction,
      login,
      logout,
    }),
    [
      session,
      booting,
      theme,
      page,
      selectedBotId,
      detailBotId,
      showAdminRecovery,
      createQrTargetBot,
      showShortcutsGuide,
      overview,
      metrics,
      telemetry,
      bots,
      adminBot,
      adminNeedsRecovery,
      logs,
      adminRecovery,
      socketConnected,
      isStale,
      lastSyncAt,
      broadcastProgress,
      operations,
      activeOps,
      isActionRunning,
      clearOperations,
      retryOperation,
      toasts,
      notify,
      refreshAll,
      runBotAction,
      runBulkBotAction,
      login,
      logout,
    ]
  );

  return <ControlCenterContext.Provider value={value}>{children}</ControlCenterContext.Provider>;
}

export function useControlCenter() {
  const ctx = useContext(ControlCenterContext);
  if (!ctx) throw new Error("useControlCenter must be used inside ControlCenterProvider");
  return ctx;
}
