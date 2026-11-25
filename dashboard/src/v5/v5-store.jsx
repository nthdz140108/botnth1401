import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ControlCenterProvider, useControlCenter } from "../v4/store.jsx";
import { normalizeBotRecord } from "../v4/http.js";
import { clearDashboardSession, getDashboardCsrfToken, getDashboardSession, readCookie } from "../app/session.js";

const V5Context = createContext(null);

const READ_NOTIFS_KEY = "mybot_v5_read_notifs";

let portalSessionSnapshot = {
  booting: true,
  authenticated: false,
  user: null,
  csrfToken: "",
  expiresAt: null,
  error: "",
};

function loadReadNotifIds() {
  try {
    const raw = localStorage.getItem(READ_NOTIFS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveReadNotifIds(setObj) {
  try {
    localStorage.setItem(READ_NOTIFS_KEY, JSON.stringify([...setObj].slice(-300)));
  } catch {}
}

function resolveV5CsrfToken(isPrimaryAdmin) {
  if (isPrimaryAdmin) {
    return getDashboardCsrfToken() || readCookie("mybot_csrf") || readCookie("mybot_v5_csrf") || "";
  }
  return (
    portalSessionSnapshot.csrfToken ||
    readCookie("mybot_v5_csrf") ||
    getDashboardCsrfToken() ||
    readCookie("mybot_csrf") ||
    ""
  );
}

function resolveTargetUrl(rawPath, isPrimaryAdmin, isPortalOnly) {
  const clean = String(rawPath || "").trim();
  if (!clean) return isPortalOnly ? "/v5-portal" : "/api/v5";
  if (clean.startsWith("http://") || clean.startsWith("https://")) return clean;
  if (clean.startsWith("/v5-auth") || clean.startsWith("/v5-portal")) return clean;

  if (isPortalOnly) {
    if (clean === "/api/v5") return "/v5-portal";
    if (clean.startsWith("/api/v5/")) {
      return `/v5-portal/${clean.slice("/api/v5/".length)}`;
    }
    if (clean.startsWith("/api/")) {
      return `/v5-portal/${clean.slice("/api/".length)}`;
    }
    return `/v5-portal/${clean.replace(/^\/+/, "")}`;
  }

  if (clean.startsWith("/api/")) return clean;
  return `/api/v5/${clean.replace(/^\/+/, "")}`;
}

async function rawJsonFetch(url, method, headers, body, signal) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { rawText: text };
    }
  }
  return { response, parsed };
}

/**
 * Unified V5 request helper:
 * - Routes via `/v5-portal` when authenticated as non-primary Portal user (`portalSession`),
 *   or via `/api/v5` / direct `/api/*` when authenticated as Primary Admin.
 * - Attaches `X-CSRF-Token` from `mybot_csrf` or `mybot_v5_csrf`.
 */
export async function v5Request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const isPrimaryAdmin = Boolean(getDashboardSession()?.authenticated);
  const isPortalOnly =
    !isPrimaryAdmin &&
    Boolean(portalSessionSnapshot.authenticated || readCookie("mybot_v5_csrf") || readCookie("mybot_v5_session"));

  const headers = new Headers(options.headers || {});
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("X-CSRF-Token")) {
    const csrf = resolveV5CsrfToken(isPrimaryAdmin);
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  let body = options.body;
  if (
    body !== undefined &&
    body !== null &&
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer)
  ) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    body = JSON.stringify(body);
  }

  const targetUrl = resolveTargetUrl(path, isPrimaryAdmin, isPortalOnly);
  let { response, parsed } = await rawJsonFetch(targetUrl, method, headers, body, options.signal);

  // Fallback if portal router mounts full `/v5-portal/api/...` prefix for legacy `/api/*` routes
  if (
    response.status === 404 &&
    isPortalOnly &&
    String(path || "").startsWith("/api/") &&
    !String(path || "").startsWith("/api/v5")
  ) {
    const altUrl = `/v5-portal${path}`;
    if (altUrl !== targetUrl) {
      const retry = await rawJsonFetch(altUrl, method, headers, body, options.signal);
      response = retry.response;
      parsed = retry.parsed;
    }
  }

  if (!response.ok) {
    const errObj = parsed?.error;
    const code =
      typeof errObj === "object" && errObj
        ? errObj.code || ""
        : typeof errObj === "string"
          ? errObj
          : parsed?.code || "";
    const message =
      typeof errObj === "object" && errObj
        ? errObj.message || errObj.code
        : typeof errObj === "string"
          ? errObj
          : parsed?.message || `Yêu cầu thất bại (HTTP ${response.status})`;

    if ((response.status === 401 || code === "AUTH_REQUIRED") && isPrimaryAdmin && String(path || "").startsWith("/api/")) {
      clearDashboardSession("AUTH_REQUIRED");
    }

    const err = new Error(message);
    err.status = response.status;
    err.code = code;
    err.details = parsed?.data || errObj?.details || null;
    throw err;
  }

  if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "data")) {
    return parsed.data;
  }
  return parsed;
}

export const v5Fetch = v5Request;

function computeFallbackHealthScore(bot) {
  if (!bot) return 0;
  if (bot.cookieDead || bot.status === "cookie_expired") return 15;
  if (bot.status === "error") return 22;
  if (bot.status === "online" || bot.wsConnected) {
    const uptimeBonus = Math.min(8, Math.floor(Number(bot.uptimeSecs || 0) / 1800));
    return Math.min(100, 92 + uptimeBonus);
  }
  if (bot.status === "hot_standby" || bot.status === "standby") return 82;
  if (bot.status === "connecting") return 65;
  return 48;
}

function isExpiringWithinHours(expiryAt, hours = 72) {
  if (!expiryAt || expiryAt === "Never" || expiryAt === "-1" || expiryAt === -1 || expiryAt === "permanent") {
    return false;
  }
  const ts = typeof expiryAt === "object" && expiryAt.at ? Date.parse(expiryAt.at) : Date.parse(String(expiryAt));
  if (Number.isNaN(ts)) return false;
  const diff = ts - Date.now();
  return diff > -7 * 24 * 3600 * 1000 && diff <= hours * 3600 * 1000;
}

function V5StateBridge({ children }) {
  const v4 = useControlCenter();

  const [portalSession, setPortalSessionState] = useState(() => ({ ...portalSessionSnapshot }));
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notifDrawerOpen, setNotifDrawerOpen] = useState(false);
  const [studioTargetCommand, setStudioTargetCommand] = useState("");

  const [fleetEnrichmentMap, setFleetEnrichmentMap] = useState({});
  const [portalBotsRaw, setPortalBotsRaw] = useState([]);
  const [primaryState, setPrimaryState] = useState(null);
  const [crmSummary, setCrmSummary] = useState(null);
  const [rawNotifications, setRawNotifications] = useState([]);
  const [readNotifIds, setReadNotifIds] = useState(() => loadReadNotifIds());
  const [remoteOps, setRemoteOps] = useState([]);

  const setPortalSession = useCallback((nextOrUpdater) => {
    setPortalSessionState((prev) => {
      const next = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      portalSessionSnapshot = next;
      return next;
    });
  }, []);

  // Boot check for `/v5-auth/session` (Operators, Resellers, Tenant bot_owners)
  const checkPortalSession = useCallback(async () => {
    try {
      const res = await v5Request("/v5-auth/session");
      if (res && (res.authenticated || res.user)) {
        setPortalSession({
          booting: false,
          authenticated: true,
          user: res.user || {
            username: res.username || res.ownerUid || "portal_user",
            role: res.role || "operator",
            allowedBotIds: res.allowedBotIds || [],
            ownerUid: res.ownerUid || "",
          },
          csrfToken: res.csrfToken || readCookie("mybot_v5_csrf") || "",
          expiresAt: res.expiresAt || null,
          error: "",
        });
        return res;
      }
      setPortalSession({
        booting: false,
        authenticated: false,
        user: null,
        csrfToken: "",
        expiresAt: null,
        error: "",
      });
      return null;
    } catch {
      setPortalSession({
        booting: false,
        authenticated: false,
        user: null,
        csrfToken: "",
        expiresAt: null,
        error: "",
      });
      return null;
    }
  }, [setPortalSession]);

  useEffect(() => {
    checkPortalSession();
  }, [checkPortalSession]);

  const portalLogin = useCallback(
    async ({ username, password, totpCode, ownerAccessCode } = {}) => {
      const res = await v5Request("/v5-auth/login", {
        method: "POST",
        body: {
          username: username ? String(username).trim() : undefined,
          password: password || undefined,
          totpCode: totpCode ? String(totpCode).trim() : undefined,
          ownerAccessCode: ownerAccessCode ? String(ownerAccessCode).trim() : undefined,
        },
      });
      const user = res?.user || {
        username: res?.username || username || "portal_user",
        role: res?.role || (ownerAccessCode ? "bot_owner" : "operator"),
        allowedBotIds: res?.allowedBotIds || [],
        ownerUid: res?.ownerUid || "",
      };
      setPortalSession({
        booting: false,
        authenticated: true,
        user,
        csrfToken: res?.csrfToken || readCookie("mybot_v5_csrf") || "",
        expiresAt: res?.expiresAt || null,
        error: "",
      });
      return res;
    },
    [setPortalSession]
  );

  const portalLogout = useCallback(async () => {
    try {
      await v5Request("/v5-auth/logout", { method: "POST", body: {} });
    } catch {}
    setPortalSession({
      booting: false,
      authenticated: false,
      user: null,
      csrfToken: "",
      expiresAt: null,
      error: "",
    });
  }, [setPortalSession]);

  const isAnyAuthenticated = Boolean(v4.session?.authenticated || portalSession.authenticated);

  const refreshCrm = useCallback(async () => {
    if (!isAnyAuthenticated) return null;
    try {
      const data = await v5Request("/api/v5/crm/summary");
      if (data && typeof data === "object") {
        setCrmSummary(data);
      }
      return data;
    } catch {
      return null;
    }
  }, [isAnyAuthenticated]);

  const refreshV5 = useCallback(async () => {
    if (!isAnyAuthenticated) return;
    const [enrichedRes, primaryRes, notifRes, crmRes, opsRes] = await Promise.allSettled([
      v5Request("/api/v5/fleet/enriched"),
      v5Request("/api/system/primary-bot"),
      v5Request("/api/v5/notifications"),
      v5Request("/api/v5/crm/summary"),
      v5Request("/api/v5/operations"),
    ]);

    if (enrichedRes.status === "fulfilled" && enrichedRes.value) {
      const val = enrichedRes.value;
      const list = Array.isArray(val) ? val : Array.isArray(val.bots) ? val.bots : [];
      const nextMap = {};
      for (const item of list) {
        const key = String(item?.id || item?.botId || item?.uid || "");
        if (key) nextMap[key] = item;
      }
      if (val.metaByBot && typeof val.metaByBot === "object") {
        for (const [k, meta] of Object.entries(val.metaByBot)) {
          nextMap[k] = { ...(nextMap[k] || {}), ...meta };
        }
      }
      setFleetEnrichmentMap(nextMap);
      if (list.length > 0) {
        setPortalBotsRaw(list.map(normalizeBotRecord).filter(Boolean));
      }
      if (val.primaryState) {
        setPrimaryState(val.primaryState);
      }
    }

    if (primaryRes.status === "fulfilled" && primaryRes.value) {
      setPrimaryState(primaryRes.value);
    }

    if (notifRes.status === "fulfilled" && notifRes.value) {
      const list = Array.isArray(notifRes.value)
        ? notifRes.value
        : Array.isArray(notifRes.value.notifications)
          ? notifRes.value.notifications
          : Array.isArray(notifRes.value.items)
            ? notifRes.value.items
            : [];
      setRawNotifications(list);
    }

    if (crmRes.status === "fulfilled" && crmRes.value && typeof crmRes.value === "object") {
      setCrmSummary(crmRes.value);
    }

    if (opsRes.status === "fulfilled" && opsRes.value) {
      const list = Array.isArray(opsRes.value)
        ? opsRes.value
        : Array.isArray(opsRes.value.operations)
          ? opsRes.value.operations
          : [];
      setRemoteOps(list);
    }
  }, [isAnyAuthenticated]);

  useEffect(() => {
    if (!isAnyAuthenticated) return undefined;
    refreshV5();
    const timer = setInterval(refreshV5, 8000);
    return () => clearInterval(timer);
  }, [isAnyAuthenticated, refreshV5]);

  // Global Ctrl+K / Cmd+K and Escape handler for V5 Command Palette & Notification Drawer
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape") {
        if (commandPaletteOpen) {
          e.preventDefault();
          setCommandPaletteOpen(false);
          return;
        }
        if (notifDrawerOpen) {
          e.preventDefault();
          setNotifDrawerOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [commandPaletteOpen, notifDrawerOpen]);

  // Merge V4 bots (or portalBotsRaw when logged in via Portal) with V5 enrichment fields
  const enrichedFleet = useMemo(() => {
    const baseList = v4.bots && v4.bots.length > 0 ? v4.bots : portalBotsRaw;
    const primaryBotId =
      primaryState?.adminBotId || primaryState?.primaryBotId || v4.adminBot?.id || "admin";
    const designatedStandbyId =
      primaryState?.designatedStandbyBotId || primaryState?.standbyBotId || "";

    return baseList.map((bot) => {
      const extra = fleetEnrichmentMap[bot.id] || {};
      const tags = Array.isArray(extra.tags)
        ? extra.tags
        : Array.isArray(bot.tags)
          ? bot.tags
          : bot.isMain
            ? ["Nội bộ"]
            : [];
      const healthScore =
        typeof extra.healthScore === "number"
          ? Math.max(0, Math.min(100, Math.round(extra.healthScore)))
          : computeFallbackHealthScore(bot);
      const expiryTarget = extra.expiryAt || bot.expiryAt;

      return {
        ...bot,
        ...extra,
        id: bot.id,
        displayName: extra.displayName || bot.displayName,
        status: bot.status || extra.status,
        isPrimaryAdmin: bot.id === primaryBotId || Boolean(bot.isMain),
        healthScore,
        tags,
        proxyUrl: extra.proxyUrl ?? bot.proxyUrl ?? "",
        proxyLatencyMs: extra.proxyLatencyMs ?? null,
        proxyOk: extra.proxyOk ?? null,
        notes: extra.notes ?? bot.notes ?? "",
        autoFailoverCandidate: Boolean(
          extra.autoFailoverCandidate || bot.id === designatedStandbyId
        ),
        expiringSoon72h: isExpiringWithinHours(expiryTarget, 72),
      };
    });
  }, [v4.bots, v4.adminBot, portalBotsRaw, fleetEnrichmentMap, primaryState]);

  const updateBotV5Meta = useCallback(
    async (botId, patch = {}) => {
      setFleetEnrichmentMap((prev) => ({
        ...prev,
        [botId]: {
          ...(prev[botId] || {}),
          ...patch,
        },
      }));
      try {
        const res = await v5Request(`/api/v5/bots/${encodeURIComponent(botId)}/meta`, {
          method: "PUT",
          body: patch,
        });
        await refreshV5();
        return res;
      } catch (err) {
        // Fallback path if backend exposes `/api/v5/fleet/:id/meta`
        const fallback = await v5Request(`/api/v5/fleet/${encodeURIComponent(botId)}/meta`, {
          method: "PUT",
          body: patch,
        }).catch(() => {
          throw err;
        });
        await refreshV5();
        return fallback;
      }
    },
    [refreshV5]
  );

  // Merge client `v4.operations` + server `remoteOps` deduplicated by id
  const serverOps = useMemo(() => {
    const mergedMap = new Map();
    for (const op of v4.operations || []) {
      const id = String(op.id || op.operationId || "");
      if (id) mergedMap.set(id, { ...op, id, source: op.source || "client" });
    }
    for (const op of remoteOps || []) {
      const id = String(op.id || op.operationId || "");
      if (!id) continue;
      const existing = mergedMap.get(id);
      mergedMap.set(id, {
        ...(existing || {}),
        ...op,
        id,
        botName: op.botName || existing?.botName || op.botId || "Hệ thống",
        startedAt: op.startedAt || op.createdAt || existing?.startedAt || new Date().toISOString(),
        source: existing ? "synced" : "server",
      });
    }
    return [...mergedMap.values()].sort(
      (a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime()
    );
  }, [v4.operations, remoteOps]);

  const recordServerOp = useCallback(async (opPayload) => {
    const entry = {
      id: opPayload?.id || `op_srv_${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      status: "completed",
      phase: "ws_ready",
      ...opPayload,
    };
    setRemoteOps((prev) => [entry, ...prev.slice(0, 99)]);
    try {
      await v5Request("/api/v5/operations", {
        method: "POST",
        body: entry,
      });
    } catch {}
    return entry;
  }, []);

  // Synthesize live alerts + server notifications with persistent read state
  const notifications = useMemo(() => {
    const synthesized = [];

    if (v4.adminNeedsRecovery) {
      synthesized.push({
        id: "sys_admin_cookie_dead",
        severity: "critical",
        title: "Cần khôi phục QR cho Bot Admin Chính",
        message: "Cookie Zalo của Bot Admin đã hết hạn hoặc mất phiên. Quét mã QR trên Web để khôi phục ngay.",
        botId: v4.adminBot?.id || "admin",
        botName: v4.adminBot?.displayName || "Bot Admin Chính",
        actionLabel: "Quét QR Admin",
        actionPage: "admin_qr",
        createdAt: v4.adminBot?.updatedAt || new Date().toISOString(),
      });
    }

    for (const b of enrichedFleet) {
      if (!b.isPrimaryAdmin && (b.cookieDead || b.status === "cookie_expired")) {
        synthesized.push({
          id: `bot_cookie_dead_${b.id}`,
          severity: "critical",
          title: `Cookie hết hạn: ${b.displayName}`,
          message: b.deadReason || "Phiên đăng nhập Zalo đã hết hạn, cần quét QR đăng nhập lại.",
          botId: b.id,
          botName: b.displayName,
          actionLabel: "Quét QR Bot",
          actionPage: "bot_qr",
          createdAt: b.updatedAt || new Date().toISOString(),
        });
      } else if (b.expiringSoon72h) {
        synthesized.push({
          id: `bot_expiring_${b.id}`,
          severity: "warning",
          title: `Sắp hết hạn thuê (<72h): ${b.displayName}`,
          message: `Chủ thuê ${b.ownerUid || "Chưa gán"} cần gia hạn để tránh chuyển sang Chờ Nóng tự động.`,
          botId: b.id,
          botName: b.displayName,
          actionLabel: "Mở SaaS CRM",
          actionPage: "crm",
          createdAt: b.updatedAt || new Date().toISOString(),
        });
      }
    }

    for (const op of serverOps.slice(0, 10)) {
      if (op.status === "failed") {
        synthesized.push({
          id: `op_failed_${op.id}`,
          severity: "critical",
          title: `Thao tác "${op.action}" thất bại`,
          message: op.error || "Tiến trình điều phối gặp sự cố, bấm để xem hướng dẫn khắc phục.",
          botId: op.botId,
          botName: op.botName,
          actionLabel: "Xem Tiến Trình",
          actionPage: "operations",
          createdAt: op.finishedAt || op.startedAt,
        });
      }
    }

    const byId = new Map();
    for (const item of [...rawNotifications, ...synthesized]) {
      if (!item) continue;
      const id = String(item.id || `${item.title}_${item.createdAt}`);
      const isRead = Boolean(item.read || readNotifIds.has(id));
      byId.set(id, {
        ...item,
        id,
        severity: item.severity || item.level || "info",
        createdAt: item.createdAt || item.timestamp || new Date().toISOString(),
        read: isRead,
      });
    }

    return [...byId.values()].sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
  }, [rawNotifications, v4.adminNeedsRecovery, v4.adminBot, enrichedFleet, serverOps, readNotifIds]);

  const unreadNotifCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const markNotifRead = useCallback((id) => {
    if (!id) return;
    setReadNotifIds((prev) => {
      const next = new Set(prev);
      next.add(String(id));
      saveReadNotifIds(next);
      return next;
    });
    v5Request(`/api/v5/notifications/${encodeURIComponent(id)}/read`, {
      method: "POST",
      body: {},
    }).catch(() => {});
  }, []);

  const markAllNotifsRead = useCallback(() => {
    setReadNotifIds((prev) => {
      const next = new Set(prev);
      for (const n of notifications) next.add(String(n.id));
      saveReadNotifIds(next);
      return next;
    });
    v5Request("/api/v5/notifications/read-all", {
      method: "POST",
      body: {},
    }).catch(() => {});
  }, [notifications]);

  const openCommandInStudio = useCallback(
    (commandName) => {
      const clean = String(commandName || "").trim();
      if (!clean) return;
      setStudioTargetCommand(clean);
      try {
        sessionStorage.setItem("mybot_v5_studio_cmd", clean);
        window.dispatchEvent(new CustomEvent("v5:open-studio-command", { detail: { commandName: clean } }));
      } catch {}
      v4.setPage("studio");
    },
    [v4]
  );

  const value = useMemo(
    () => ({
      ...v4,
      bots: enrichedFleet,
      enrichedFleet,
      primaryState,
      portalSession,
      isAnyAuthenticated,
      portalLogin,
      portalLogout,
      checkPortalSession,
      v5Fetch: v5Request,
      v5Request,
      commandPaletteOpen,
      setCommandPaletteOpen,
      notifDrawerOpen,
      setNotifDrawerOpen,
      notifications,
      unreadNotifCount,
      markNotifRead,
      markAllNotifsRead,
      crmSummary,
      refreshCrm,
      serverOps,
      recordServerOp,
      refreshV5,
      updateBotV5Meta,
      studioTargetCommand,
      setStudioTargetCommand,
      openCommandInStudio,
    }),
    [
      v4,
      enrichedFleet,
      primaryState,
      portalSession,
      isAnyAuthenticated,
      portalLogin,
      portalLogout,
      checkPortalSession,
      commandPaletteOpen,
      notifDrawerOpen,
      notifications,
      unreadNotifCount,
      markNotifRead,
      markAllNotifsRead,
      crmSummary,
      refreshCrm,
      serverOps,
      recordServerOp,
      refreshV5,
      updateBotV5Meta,
      studioTargetCommand,
      openCommandInStudio,
    ]
  );

  return <V5Context.Provider value={value}>{children}</V5Context.Provider>;
}

class ControlCenterAutoWrapper extends React.Component {
  constructor(props) {
    super(props);
    this.state = { needsOuterV4: false };
  }

  static getDerivedStateFromError(error) {
    if (error?.message?.includes("ControlCenterProvider")) {
      return { needsOuterV4: true };
    }
    throw error;
  }

  render() {
    if (this.state.needsOuterV4) {
      return (
        <ControlCenterProvider>
          <V5StateBridge>{this.props.children}</V5StateBridge>
        </ControlCenterProvider>
      );
    }
    return <V5StateBridge>{this.props.children}</V5StateBridge>;
  }
}

export function V5Provider({ children }) {
  return <ControlCenterAutoWrapper>{children}</ControlCenterAutoWrapper>;
}

export function useV5() {
  const ctx = useContext(V5Context);
  if (!ctx) throw new Error("useV5 must be used inside V5Provider");
  return ctx;
}
