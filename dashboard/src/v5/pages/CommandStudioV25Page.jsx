import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatDateVi, v4Fetch } from "../../v4/http.js";

async function callV5(v5Fetch, subPath, options = {}) {
  const cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  if (typeof v5Fetch === "function") {
    try {
      return await v5Fetch(cleanSub, options);
    } catch (err) {
      if (err && err.status === 404 && !err.code) {
        return v4Fetch(`/api/v5${cleanSub}`, options);
      }
      throw err;
    }
  }
  return v4Fetch(`/api/v5${cleanSub}`, options);
}

const TEMPLATE_VAR_CHIPS = [
  "{senderName}",
  "{commandName}",
  "{cooldownLeft}",
  "{prefix}",
  "{user}",
  "{userId}",
  "{thread}",
  "{remaining}",
  "{reason}",
];

const PROVENANCE_BADGE = {
  default: { label: "mặc định", cls: "neutral" },
  global: { label: "global", cls: "info" },
  bot: { label: "bot", cls: "warning" },
  group: { label: "group", cls: "success" },
};

const TIME_GROUPS = [
  {
    id: "morning",
    title: "🌅 Buổi Sáng (05:00-10:59)",
    hours: [5, 6, 7, 8, 9, 10],
  },
  {
    id: "afternoon",
    title: "☀️ Buổi Trưa & Chiều (11:00-17:59)",
    hours: [11, 12, 13, 14, 15, 16, 17],
  },
  {
    id: "evening",
    title: "🌆 Buổi Tối (18:00-21:59)",
    hours: [18, 19, 20, 21],
  },
  {
    id: "night",
    title: "🌙 Đêm Khuya (22:00-04:59)",
    hours: [22, 23, 0, 1, 2, 3, 4],
  },
];

const VIP_FLAG_META = {
  "vip.ai": {
    title: "🤖 Nhóm Lệnh Trí Tuệ Nhân Tạo (AI & Vision)",
    desc: "Các lệnh hỏi đáp Gemini/GPT, phân tích hình ảnh, tóm tắt hội thoại và sáng tạo nội dung",
  },
  "vip.utility": {
    title: "🧰 Nhóm Lệnh Tiện Ích & Giải Trí Đa Năng",
    desc: "Tra cứu thời tiết, lịch âm, tải nhạc/video TikTok, ZingMP3 và tương tác cộng đồng",
  },
  "vip.highRisk": {
    title: "⚠️ Nhóm Lệnh Nhạy Cảm & Tác Động Cao (High-Risk)",
    desc: "Các lệnh tác động hàng loạt, quét dữ liệu lớn hoặc yêu cầu kiểm soát quyền nghiêm ngặt",
  },
};

function parseHourFromSlot(slot, fallbackIdx = 0) {
  if (slot?.id && /^hour-(\d{1,2})$/.test(slot.id)) {
    return Number(slot.id.split("-")[1]);
  }
  if (slot?.time && /^\d{1,2}:\d{2}/.test(slot.time)) {
    return Number(slot.time.split(":")[0]);
  }
  if (slot?.cron) {
    const parts = String(slot.cron).trim().split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) return Number(parts[1]);
  }
  return fallbackIdx % 24;
}

function formatSlotClock(slot, hour) {
  if (slot?.time) return slot.time;
  if (slot?.cron) {
    const parts = String(slot.cron).trim().split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      return `${String(Number(parts[1])).padStart(2, "0")}:${String(Number(parts[0])).padStart(2, "0")}`;
    }
  }
  return `${String(hour).padStart(2, "0")}:05`;
}

function buildFallback24Schedules() {
  return Array.from({ length: 24 }, (_, h) => ({
    id: `hour-${String(h).padStart(2, "0")}`,
    enabled: h >= 6 && h <= 22,
    cron: `5 ${h} * * *`,
    timezone: "Asia/Ho_Chi_Minh",
    kind: h % 3 === 0 ? "girl-video" : h % 3 === 1 ? "tiktok-search" : "zing-chart",
    category: "default",
    queryTemplate: "nhạc chill cảnh đẹp {{timestamp}}",
    fallbackKind: "girl-video",
    fallbackCategory: "default",
    caption: `> SendTask ${String(h).padStart(2, "0")}:05 <\nChúc cả nhóm khung giờ vui vẻ và tràn đầy năng lượng!`,
    ttlMinutes: 60,
  }));
}

export default function CommandStudioV25Page() {
  const {
    bots = [],
    enrichedFleet = [],
    selectedBotId,
    setSelectedBotId,
    studioTargetCommand,
    setStudioTargetCommand,
    notify,
    v5Fetch,
  } = useV5();

  const botList = enrichedFleet?.length ? enrichedFleet : bots;
  const activeBot = useMemo(
    () => botList.find((b) => b.id === selectedBotId) || botList[0] || null,
    [botList, selectedBotId]
  );

  const [mainTab, setMainTab] = useState("studio");

  // =========================================================================
  // SUB-TAB 1: 218-COMMAND SCHEMA-DRIVEN STUDIO STATE
  // =========================================================================
  const [catalog, setCatalog] = useState([]);
  const [coverageMap, setCoverageMap] = useState({});
  const [cmdMetaMap, setCmdMetaMap] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [coverageFilter, setCoverageFilter] = useState("ALL");
  const [permissionFilter, setPermissionFilter] = useState("ALL");
  const [selectedCmdName, setSelectedCmdName] = useState("menu");

  const [scope, setScope] = useState("global"); // 'global' | 'bot' | 'group'
  const [groupThreadId, setGroupThreadId] = useState("");
  const [botGroups, setBotGroups] = useState([]);
  const [editorMode, setEditorMode] = useState("visual"); // 'visual' | 'json'

  const [contract, setContract] = useState(null);
  const [activeContractTab, setActiveContractTab] = useState("operation");
  const [effectiveValues, setEffectiveValues] = useState({});
  const [provenance, setProvenance] = useState({});
  const [revisions, setRevisions] = useState({ global: 0 });
  const [layerPatch, setLayerPatch] = useState({});
  const [jsonText, setJsonText] = useState("{}");
  const [draftInfo, setDraftInfo] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [reloadAck, setReloadAck] = useState(null);
  const [busyStudio, setBusyStudio] = useState(false);

  // =========================================================================
  // SUB-TAB 2: VISUAL 24H SENDTASK SCHEDULER STATE
  // =========================================================================
  const [sendtaskScope, setSendtaskScope] = useState("global");
  const [sendtaskRevision, setSendtaskRevision] = useState(0);
  const [sendtaskEnabled, setSendtaskEnabled] = useState(true);
  const [scheduleSlots, setScheduleSlots] = useState([]);
  const [testTargetGroupId, setTestTargetGroupId] = useState("");
  const [savingSendtask, setSavingSendtask] = useState(false);
  const [testingSlotId, setTestingSlotId] = useState("");

  // =========================================================================
  // SUB-TAB 3: COMMAND SIMULATOR SANDBOX STATE
  // =========================================================================
  const [simBotId, setSimBotId] = useState("");
  const [simThreadId, setSimThreadId] = useState("");
  const [simRole, setSimRole] = useState("member");
  const [simSenderUid, setSimSenderUid] = useState("1000888999");
  const [simSenderName, setSimSenderName] = useState("Nguyễn Văn A");
  const [simCommand, setSimCommand] = useState("menu");
  const [simArgs, setSimArgs] = useState("");
  const [simResult, setSimResult] = useState(null);
  const [runningSim, setRunningSim] = useState(false);

  // =========================================================================
  // SUB-TAB 4: VIP FEATURE FLAGS STATE
  // =========================================================================
  const [vipFlags, setVipFlags] = useState({});
  const [vipCatalog, setVipCatalog] = useState([]);
  const [vipMigrationPreview, setVipMigrationPreview] = useState(null);
  const [savingVip, setSavingVip] = useState(false);

  // Load initial catalog, coverage & commands metadata
  const loadStudioCatalog = useCallback(async () => {
    const [catRes, covRes, cmdsRes] = await Promise.all([
      v4Fetch("/api/command-studio/catalog").catch(() => null),
      v4Fetch("/api/command-studio/coverage").catch(() => null),
      v4Fetch("/api/commands").catch(() => null),
    ]);

    if (catRes?.commands) {
      setCatalog(catRes.commands);
      if (catRes.commands.length > 0) {
        setSelectedCmdName((curr) =>
          catRes.commands.some((c) => c.commandName === curr) ? curr : catRes.commands[0].commandName
        );
      }
    }
    if (covRes?.rows) {
      const cMap = {};
      for (const r of covRes.rows) cMap[r.commandName] = r.coverage || "FULL";
      setCoverageMap(cMap);
    }
    const rawCmds = Array.isArray(cmdsRes)
      ? cmdsRes
      : Array.isArray(cmdsRes?.commands)
        ? cmdsRes.commands
        : [];
    const mMap = {};
    for (const c of rawCmds) {
      const k = String(c.name || c.id || "").toLowerCase();
      if (k) mMap[k] = c;
    }
    setCmdMetaMap(mMap);
  }, []);

  // Load groups for activeBot (used in group-scope selector, sendtask test, simulator)
  const loadGroupsForBot = useCallback(async (botId) => {
    if (!botId) return;
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(botId)}/groups`);
      const list = Array.isArray(res) ? res : Array.isArray(res?.groups) ? res.groups : [];
      setBotGroups(list);
      if (list.length > 0) {
        const firstGid = String(list[0].threadId || list[0].id);
        setGroupThreadId((curr) => curr || firstGid);
        setTestTargetGroupId((curr) => curr || firstGid);
        setSimThreadId((curr) => curr || firstGid);
      }
    } catch {
      setBotGroups([]);
    }
  }, []);

  useEffect(() => {
    loadStudioCatalog();
  }, [loadStudioCatalog]);

  useEffect(() => {
    if (studioTargetCommand) {
      setMainTab("studio");
      setSelectedCmdName(studioTargetCommand);
      setStudioTargetCommand?.("");
    }
  }, [studioTargetCommand, setStudioTargetCommand]);

  useEffect(() => {
    const onStudioJump = (ev) => {
      const cmd = ev?.detail?.commandName;
      if (cmd) {
        setMainTab("studio");
        setSelectedCmdName(String(cmd));
      }
    };
    window.addEventListener("v5:open-studio-command", onStudioJump);
    return () => window.removeEventListener("v5:open-studio-command", onStudioJump);
  }, []);

  useEffect(() => {
    const bid = activeBot?.id || "admin";
    setSimBotId((curr) => curr || bid);
    loadGroupsForBot(bid);
  }, [activeBot?.id, loadGroupsForBot]);

  // Load single command contract, config, layer overrides, draft & history
  const loadCommandDetail = useCallback(
    async (cmdName, targetScope, botId, threadId) => {
      if (!cmdName) return;
      if (targetScope === "group" && (!botId || !threadId)) return;
      if (targetScope === "bot" && !botId) return;

      const qs = new URLSearchParams();
      if (targetScope !== "global" && botId) qs.set("botId", botId);
      if (targetScope === "group" && threadId) qs.set("threadId", threadId);

      const draftQs = new URLSearchParams({ scope: targetScope });
      if (targetScope !== "global" && botId) draftQs.set("botId", botId);
      if (targetScope === "group" && threadId) draftQs.set("threadId", threadId);

      try {
        const [contractRes, cfgRes, layersRes, draftRes, histRes] = await Promise.all([
          v4Fetch(`/api/command-studio/commands/${encodeURIComponent(cmdName)}/contract`),
          v4Fetch(`/api/command-studio/commands/${encodeURIComponent(cmdName)}/config?${qs.toString()}`),
          v4Fetch(`/api/command-studio/layers?${qs.toString()}`).catch(() => null),
          v4Fetch(`/api/command-studio/commands/${encodeURIComponent(cmdName)}/draft?${draftQs.toString()}`).catch(() => null),
          v4Fetch(`/api/command-studio/commands/${encodeURIComponent(cmdName)}/history?limit=15`).catch(() => null),
        ]);

        const ctr = contractRes?.contract || null;
        setContract(ctr);
        if (ctr?.tabs?.length) {
          setActiveContractTab((curr) =>
            ctr.tabs.some((t) => t.id === curr)
              ? curr
              : ctr.tabs.find((t) => t.id === "operation")?.id || ctr.tabs[0].id
          );
        }

        const eff = cfgRes?.effective || {};
        setEffectiveValues(eff);
        setProvenance(cfgRes?.provenance || {});
        setRevisions(cfgRes?.revisions || { global: 0 });

        const savedLayerValues =
          layersRes?.[targetScope]?.commands?.[cmdName]?.values || {};
        const activeDraft = draftRes?.draft || null;
        setDraftInfo(activeDraft);

        const initialPatch = activeDraft?.patch
          ? { ...savedLayerValues, ...activeDraft.patch }
          : { ...savedLayerValues };

        setLayerPatch(initialPatch);
        setJsonText(JSON.stringify(initialPatch, null, 2));
        setHistoryEntries(Array.isArray(histRes?.entries) ? histRes.entries : []);
        setPreviewResult(null);
      } catch (err) {
        notify(err.message || `Không thể tải cấu hình lệnh ${cmdName}`, "error");
      }
    },
    [notify]
  );

  useEffect(() => {
    if (mainTab === "studio" && selectedCmdName) {
      loadCommandDetail(selectedCmdName, scope, activeBot?.id || "admin", groupThreadId);
    }
  }, [mainTab, selectedCmdName, scope, activeBot?.id, groupThreadId, loadCommandDetail]);

  // Load 24h SendTask Schedule
  const loadSendTask24h = useCallback(async () => {
    const targetBot = sendtaskScope === "bot" ? activeBot?.id || "admin" : undefined;
    const qs = targetBot ? `?botId=${encodeURIComponent(targetBot)}` : "";
    try {
      const cfg = await v4Fetch(`/api/command-studio/commands/sendtask/config${qs}`);
      const rev = cfg?.revisions?.[sendtaskScope] ?? cfg?.revisions?.global ?? 0;
      setSendtaskRevision(Number(rev));
      const eff = cfg?.effective || {};
      setSendtaskEnabled(eff["schedules.enabled"] !== false);
      const rawItems = Array.isArray(eff["schedules.items"])
        ? eff["schedules.items"]
        : buildFallback24Schedules();
      setScheduleSlots(rawItems.map((it, idx) => ({ ...it, _hour: parseHourFromSlot(it, idx) })));
    } catch {
      setScheduleSlots(
        buildFallback24Schedules().map((it, idx) => ({ ...it, _hour: parseHourFromSlot(it, idx) }))
      );
    }
  }, [sendtaskScope, activeBot?.id]);

  // Load VIP Feature Flags
  const loadVipFlagsAndCatalog = useCallback(async () => {
    const [flagRes, catRes] = await Promise.all([
      v4Fetch("/api/vip/feature-flags").catch(() => null),
      v4Fetch("/api/vip/catalog").catch(() => null),
    ]);
    if (flagRes) {
      setVipFlags(flagRes.flags || flagRes || {});
    }
    if (catRes) {
      setVipCatalog(Array.isArray(catRes.commands) ? catRes.commands : []);
    }
  }, []);

  useEffect(() => {
    if (mainTab === "sendtask") loadSendTask24h();
    if (mainTab === "vip_flags") loadVipFlagsAndCatalog();
  }, [mainTab, loadSendTask24h, loadVipFlagsAndCatalog]);

  // Categories list derived from commands metadata + phases
  const categories = useMemo(() => {
    const set = new Set();
    for (const c of catalog) {
      const meta = cmdMetaMap[c.commandName.toLowerCase()];
      const cat = meta?.category || (c.phase ? `Phase ${c.phase}` : "Core");
      set.add(cat);
    }
    return Array.from(set).sort();
  }, [catalog, cmdMetaMap]);

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalog.filter((c) => {
      const cov = coverageMap[c.commandName] || "FULL";
      const meta = cmdMetaMap[c.commandName.toLowerCase()];
      const cat = meta?.category || (c.phase ? `Phase ${c.phase}` : "Core");
      if (categoryFilter !== "ALL" && cat !== categoryFilter) return false;
      if (coverageFilter !== "ALL" && cov !== coverageFilter) return false;
      if (permissionFilter !== "ALL" && c.permission !== permissionFilter) return false;
      if (!q) return true;
      return (
        c.commandName.toLowerCase().includes(q) ||
        (c.aliases || []).some((a) => String(a).toLowerCase().includes(q)) ||
        String(meta?.description || "").toLowerCase().includes(q)
      );
    });
  }, [catalog, coverageMap, cmdMetaMap, searchQuery, categoryFilter, coverageFilter, permissionFilter]);

  // Helper to get displayed value for a field
  const getDisplayedFieldValue = (field) => {
    if (Object.prototype.hasOwnProperty.call(layerPatch, field.key)) {
      return layerPatch[field.key];
    }
    if (Object.prototype.hasOwnProperty.call(effectiveValues, field.key)) {
      return effectiveValues[field.key];
    }
    return field.default ?? "";
  };

  const updateFieldInPatch = (field, nextVal) => {
    setLayerPatch((prev) => {
      const updated = { ...prev, [field.key]: nextVal };
      setJsonText(JSON.stringify(updated, null, 2));
      return updated;
    });
  };

  const resetSingleField = (fieldKey) => {
    setLayerPatch((prev) => {
      const updated = { ...prev };
      delete updated[fieldKey];
      setJsonText(JSON.stringify(updated, null, 2));
      return updated;
    });
  };

  // Resolve clean editable payload for current scope
  const resolveCleanPatchPayload = () => {
    let rawPatch = layerPatch;
    if (editorMode === "json") {
      rawPatch = JSON.parse(jsonText || "{}");
    }
    if (!contract?.tabs) return rawPatch;
    const allowedMap = new Map();
    for (const t of contract.tabs) {
      for (const f of t.fields || []) {
        if (!f.readOnly && (f.allowedScopes || ["global"]).includes(scope)) {
          allowedMap.set(f.key, f);
        }
      }
    }
    const cleaned = {};
    for (const [k, v] of Object.entries(rawPatch || {})) {
      if (allowedMap.has(k)) cleaned[k] = v;
    }
    return cleaned;
  };

  const currentExpectedRevision = revisions?.[scope] ?? 0;

  // Dry-Run Preview
  const handleDryRunPreview = async () => {
    let values;
    try {
      values = resolveCleanPatchPayload();
    } catch {
      notify("JSON không hợp lệ — hãy kiểm tra cú pháp trước khi xem trước.", "error");
      return;
    }
    setBusyStudio(true);
    try {
      const res = await v4Fetch(
        `/api/command-studio/commands/${encodeURIComponent(selectedCmdName)}/preview`,
        {
          method: "POST",
          body: {
            scope,
            botId: scope !== "global" ? activeBot?.id || "admin" : undefined,
            threadId: scope === "group" ? groupThreadId : undefined,
            values,
          },
        }
      );
      setPreviewResult(res);
      notify("Đã tạo bản Xem trước (Dry-Run) thành công!", "info");
    } catch (err) {
      notify(err.message || "Xem trước Dry-Run thất bại", "error");
    } finally {
      setBusyStudio(false);
    }
  };

  // Save Draft
  const handleSaveDraft = async () => {
    let patch;
    try {
      patch = resolveCleanPatchPayload();
    } catch {
      notify("JSON không hợp lệ.", "error");
      return;
    }
    setBusyStudio(true);
    try {
      const res = await v4Fetch(
        `/api/command-studio/commands/${encodeURIComponent(selectedCmdName)}/draft`,
        {
          method: "PUT",
          body: {
            scope,
            botId: scope !== "global" ? activeBot?.id || "admin" : undefined,
            threadId: scope === "group" ? groupThreadId : undefined,
            patch,
            expectedRevision: currentExpectedRevision,
          },
        }
      );
      setDraftInfo(res?.draft || null);
      notify(`Đã lưu bản nháp cho lệnh "${selectedCmdName}" (${scope})!`, "success");
    } catch (err) {
      notify(err.message || "Lưu bản nháp thất bại", "error");
    } finally {
      setBusyStudio(false);
    }
  };

  // Apply & Hot-Reload + Poll Reload State ACK
  const handleApplyAndHotReload = async () => {
    let values;
    try {
      values = resolveCleanPatchPayload();
    } catch {
      notify("JSON không hợp lệ, không thể áp dụng.", "error");
      return;
    }
    const targetBot = activeBot?.id || "admin";
    setBusyStudio(true);
    setReloadAck({ status: "reloading", message: "Đang gửi tín hiệu Hot-Reload tới Bot..." });

    try {
      const applyRes = await v4Fetch(
        `/api/command-studio/commands/${encodeURIComponent(selectedCmdName)}/apply`,
        {
          method: "POST",
          body: {
            scope,
            botId: scope !== "global" ? targetBot : undefined,
            threadId: scope === "group" ? groupThreadId : undefined,
            values,
            expectedRevision: currentExpectedRevision,
          },
        }
      );

      // Discard draft if one existed
      if (draftInfo) {
        await v4Fetch(
          `/api/command-studio/commands/${encodeURIComponent(selectedCmdName)}/draft?scope=${encodeURIComponent(scope)}`,
          { method: "DELETE" }
        ).catch(() => {});
      }

      // Trigger Hot-Reload
      await v4Fetch("/api/system/command-config/reload", {
        method: "POST",
        body: {
          botId: targetBot,
          commandName: selectedCmdName,
          revision: applyRes?.revision,
          scope,
        },
      }).catch(() => {});

      notify(
        `Đã áp dụng cấu hình "${selectedCmdName}" (rev #${applyRes?.revision}) & phát lệnh Hot-Reload!`,
        "success"
      );

      await loadCommandDetail(selectedCmdName, scope, targetBot, groupThreadId);

      // Poll reload-state up to 5 times
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((r) => setTimeout(r, 900));
        const st = await v4Fetch(
          `/api/system/command-config/reload-state?botId=${encodeURIComponent(targetBot)}`
        ).catch(() => null);
        if (st && (st.status === "ready" || st.status === "applied" || st.ack === true)) {
          setReloadAck({
            status: "ready",
            revision: st.revision ?? applyRes?.revision,
            botId: targetBot,
          });
          return;
        }
      }
      setReloadAck({
        status: "ready",
        revision: applyRes?.revision,
        botId: targetBot,
        note: "Đã ghi nhận cấu hình mới",
      });
    } catch (err) {
      setReloadAck({ status: "failed", message: err.message });
      notify(err.message || "Áp dụng cấu hình thất bại", "error");
      if (err.code === "REVISION_CONFLICT") {
        await loadCommandDetail(selectedCmdName, scope, targetBot, groupThreadId);
      }
    } finally {
      setBusyStudio(false);
    }
  };

  // Rollback & Reset Layer Override
  const handleRollback = async () => {
    const targetBot = activeBot?.id || "admin";
    setBusyStudio(true);
    try {
      const res = await v4Fetch(
        `/api/command-studio/commands/${encodeURIComponent(selectedCmdName)}/rollback`,
        {
          method: "POST",
          body: {
            scope,
            botId: scope !== "global" ? targetBot : undefined,
            threadId: scope === "group" ? groupThreadId : undefined,
          },
        }
      );
      notify(`Đã khôi phục (Rollback) về bản rev #${res?.rolledBackTo ?? res?.revision}!`, "success");
      await loadCommandDetail(selectedCmdName, scope, targetBot, groupThreadId);
    } catch (err) {
      notify(err.message || "Không tìm thấy lịch sử để Rollback", "error");
    } finally {
      setBusyStudio(false);
    }
  };

  const handleResetLayerOverride = async () => {
    const targetBot = activeBot?.id || "admin";
    setBusyStudio(true);
    try {
      await v4Fetch(
        `/api/command-studio/commands/${encodeURIComponent(selectedCmdName)}/reset-override`,
        {
          method: "POST",
          body: {
            scope,
            botId: scope !== "global" ? targetBot : undefined,
            threadId: scope === "group" ? groupThreadId : undefined,
          },
        }
      );
      notify(`Đã xóa toàn bộ override ở tầng "${scope}" cho lệnh ${selectedCmdName}.`, "info");
      await loadCommandDetail(selectedCmdName, scope, targetBot, groupThreadId);
    } catch (err) {
      notify(err.message || "Xóa override thất bại", "error");
    } finally {
      setBusyStudio(false);
    }
  };

  // =========================================================================
  // SUB-TAB 2 HANDLERS: SAVE 24H SCHEDULE & TEST-FIRE SLOT
  // =========================================================================
  const updateScheduleSlot = (slotId, patch) => {
    setScheduleSlots((prev) =>
      prev.map((s) => (s.id === slotId ? { ...s, ...patch } : s))
    );
  };

  const handleSaveSendTask24h = async () => {
    setSavingSendtask(true);
    try {
      const cleanItems = scheduleSlots.map(({ _hour, ...rest }) => rest);
      const res = await v4Fetch("/api/commands/sendtask/config", {
        method: "PUT",
        body: {
          scope: sendtaskScope,
          botId: sendtaskScope === "bot" ? activeBot?.id || "admin" : undefined,
          expectedRevision: sendtaskRevision,
          values: {
            "schedules.enabled": Boolean(sendtaskEnabled),
            "schedules.items": cleanItems,
          },
        },
      });
      if (res?.revision !== undefined) setSendtaskRevision(Number(res.revision));
      notify("Đã lưu & cập nhật bộ lập lịch SendTask 24 giờ thành công!", "success");
      await loadSendTask24h();
    } catch (err) {
      notify(err.message || "Lưu lịch 24 giờ thất bại", "error");
      await loadSendTask24h();
    } finally {
      setSavingSendtask(false);
    }
  };

  const handleTestFireSlot = async (slot) => {
    const targetBot = activeBot?.id || "admin";
    setTestingSlotId(slot.id);
    try {
      const res = await callV5(v5Fetch, "/studio/sendtask-test", {
        method: "POST",
        body: {
          botId: targetBot,
          threadId: testTargetGroupId || undefined,
          slotId: slot.id,
          slot,
        },
      });
      notify(
        res?.message || `Đã bắn thử khung giờ ${formatSlotClock(slot, slot._hour)} thành công!`,
        "success"
      );
    } catch (err) {
      notify(err.message || "Bắn thử khung giờ thất bại", "error");
    } finally {
      setTestingSlotId("");
    }
  };

  // =========================================================================
  // SUB-TAB 3 HANDLER: COMMAND SIMULATOR SANDBOX
  // =========================================================================
  const handleRunSimulation = async (e) => {
    e.preventDefault();
    if (!simCommand.trim()) {
      notify("Vui lòng chọn lệnh cần giả lập.", "error");
      return;
    }
    setRunningSim(true);
    try {
      const res = await callV5(v5Fetch, "/studio/simulate", {
        method: "POST",
        body: {
          botId: simBotId || activeBot?.id || "admin",
          threadId: simThreadId || "group_demo_001",
          senderRole: simRole,
          role: simRole,
          senderUid: simSenderUid.trim() || "1000888999",
          senderName: simSenderName.trim() || "Người dùng thử",
          commandName: simCommand.trim().toLowerCase(),
          args: simArgs.trim(),
        },
      });
      setSimResult(res);
      notify("Đã hoàn tất giả lập kiểm tra Gate & Phản hồi!", "info");
    } catch (err) {
      notify(err.message || "Giả lập lệnh thất bại", "error");
    } finally {
      setRunningSim(false);
    }
  };

  // =========================================================================
  // SUB-TAB 4 HANDLERS: VIP FEATURE FLAGS
  // =========================================================================
  const handlePreviewVipMigration = async (nextFlags) => {
    try {
      const preview = await v4Fetch("/api/vip/migration-preview", {
        method: "POST",
        body: { flags: nextFlags },
      });
      setVipMigrationPreview(preview);
    } catch {
      setVipMigrationPreview(null);
    }
  };

  const toggleVipFlag = (flagKey) => {
    const next = { ...vipFlags, [flagKey]: !vipFlags[flagKey] };
    setVipFlags(next);
    handlePreviewVipMigration(next);
  };

  const handleSaveVipFlags = async () => {
    setSavingVip(true);
    try {
      const updated = await v4Fetch("/api/vip/feature-flags", {
        method: "PUT",
        body: vipFlags,
      });
      setVipFlags(updated?.flags || updated || vipFlags);
      setVipMigrationPreview(null);
      notify("Đã áp dụng Cờ Tính Năng VIP & sao lưu an toàn!", "success");
      await loadVipFlagsAndCatalog();
    } catch (err) {
      notify(err.message || "Cập nhật cờ VIP thất bại", "error");
    } finally {
      setSavingVip(false);
    }
  };

  // Render individual Schema Field in Visual Mode
  const renderSchemaField = (field) => {
    const prov = provenance[field.key] || { source: "default", overridden: false };
    const badgeMeta = PROVENANCE_BADGE[prov.source] || PROVENANCE_BADGE.default;
    const allowedInScope = (field.allowedScopes || ["global"]).includes(scope);
    const disabled = Boolean(field.readOnly || !allowedInScope);
    const val = getDisplayedFieldValue(field);
    const hasLocalEdit = Object.prototype.hasOwnProperty.call(layerPatch, field.key);

    return (
      <div
        key={field.key}
        className="v4-card"
        style={{
          padding: 12,
          background: "var(--bg-input)",
          opacity: disabled ? 0.75 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>{field.label}</strong>
            <span className={`v4-badge ${badgeMeta.cls}`} style={{ fontSize: 10 }}>
              Nguồn: {badgeMeta.label}
            </span>
            {field.readOnly && (
              <span className="v4-badge neutral" style={{ fontSize: 10 }}>
                Read-only
              </span>
            )}
            {!field.readOnly && !allowedInScope && (
              <span className="v4-badge warning" style={{ fontSize: 10 }}>
                Chỉ chỉnh ở: {(field.allowedScopes || []).join("/")}
              </span>
            )}
          </div>

          {!disabled && (hasLocalEdit || prov.source === scope) && (
            <button
              type="button"
              className="v4-btn sm"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={() => resetSingleField(field.key)}
            >
              ↺ Đặt lại
            </button>
          )}
        </div>

        {/* Control by Type */}
        {field.type === "boolean" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              disabled={disabled}
              className={`v4-switch ${val ? "on" : ""}`}
              onClick={() => !disabled && updateFieldInPatch(field, !val)}
            >
              <span className="v4-switch-knob" />
            </button>
            <span className="v4-muted">{val ? "Đang Bật (true)" : "Đang Tắt (false)"}</span>
          </div>
        ) : field.type === "select" ? (
          <select
            className="v4-select"
            disabled={disabled}
            value={val ?? ""}
            onChange={(e) =>
              updateFieldInPatch(
                field,
                e.target.value === "" && field.nullable ? null : e.target.value
              )
            }
          >
            {field.nullable && <option value="">(Mặc định theo hệ thống)</option>}
            {(field.options || []).map((opt) => (
              <option key={opt} value={opt}>
                {opt || "(Trống)"}
              </option>
            ))}
          </select>
        ) : field.type === "number" ? (
          <input
            type="number"
            className="v4-input v4-mono"
            disabled={disabled}
            min={field.min}
            max={field.max}
            placeholder={field.nullable ? "(Trống = mặc định)" : ""}
            value={val ?? ""}
            onChange={(e) =>
              updateFieldInPatch(
                field,
                e.target.value === "" ? (field.nullable ? null : 0) : Number(e.target.value)
              )
            }
          />
        ) : field.type === "template" ? (
          <div>
            {!disabled && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                {TEMPLATE_VAR_CHIPS.map((vChip) => (
                  <button
                    key={vChip}
                    type="button"
                    className="v4-chip"
                    style={{ padding: "2px 7px", fontSize: 11 }}
                    onClick={() => updateFieldInPatch(field, `${val || ""}${vChip}`)}
                  >
                    {vChip}
                  </button>
                ))}
              </div>
            )}
            <textarea
              className="v4-textarea"
              rows={2}
              disabled={disabled}
              value={val ?? ""}
              placeholder="Để trống nếu dùng thông điệp mặc định của lệnh..."
              onChange={(e) => updateFieldInPatch(field, e.target.value)}
            />
          </div>
        ) : field.type === "table" ? (
          <div>
            {Array.isArray(val) && val.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {val.slice(0, 24).map((row, rIdx) => {
                  const firstCol = field.columns?.[0]?.key || "id";
                  const label = typeof row === "object" ? row[firstCol] || JSON.stringify(row) : String(row);
                  return (
                    <span key={rIdx} className="v4-admin-chip v4-mono">
                      {label}
                      {!disabled && (
                        <button
                          type="button"
                          className="v4-btn-icon"
                          onClick={() =>
                            updateFieldInPatch(
                              field,
                              val.filter((_, i) => i !== rIdx)
                            )
                          }
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="v4-muted" style={{ marginBottom: 6 }}>
                Danh sách đang trống.
              </div>
            )}
            {!disabled && field.columns?.length === 1 && (
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="v4-input v4-mono"
                  placeholder={`Nhập ${field.columns[0].label} rồi nhấn Enter...`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const txt = e.currentTarget.value.trim();
                      if (!txt) return;
                      const colKey = field.columns[0].key;
                      updateFieldInPatch(field, [...(Array.isArray(val) ? val : []), { [colKey]: txt }]);
                      e.currentTarget.value = "";
                    }
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <input
            type={field.sensitive ? "password" : "text"}
            className={`v4-input ${field.readOnly ? "v4-mono" : ""}`}
            disabled={disabled}
            value={val ?? ""}
            placeholder={field.sensitive ? "•••••••• (Để trống = giữ nguyên env)" : ""}
            onChange={(e) => updateFieldInPatch(field, e.target.value)}
          />
        )}

        {field.description && (
          <div className="v4-muted" style={{ fontSize: 11, marginTop: 4 }}>
            {field.description}
          </div>
        )}
      </div>
    );
  };

  const currentTabObj = useMemo(
    () => contract?.tabs?.find((t) => t.id === activeContractTab) || contract?.tabs?.[0] || null,
    [contract, activeContractTab]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header & 4 Powerhouse Sub-Tabs */}
      <div className="v4-card">
        <div className="v4-card-header" style={{ marginBottom: 12 }}>
          <div>
            <h2>⚙️ Command Studio V2.5 — Quản Trị 218 Lệnh, Lịch 24h & Hộp Cát Giả Lập</h2>
            <div className="v4-muted">
              Cấu hình phân tầng 3 lớp (Global → Bot → Group) kèm Provenance từng trường, Hot-Reload trực tiếp không cần khởi động lại Bot.
            </div>
          </div>

          {reloadAck && (
            <span
              className={`v4-badge ${
                reloadAck.status === "ready"
                  ? "success"
                  : reloadAck.status === "failed"
                    ? "danger"
                    : "warning"
              }`}
              style={{ padding: "5px 12px", fontSize: 12 }}
            >
              {reloadAck.status === "ready"
                ? `✓ Hot-Reload ACK sẵn sàng (${reloadAck.botId} • rev #${reloadAck.revision ?? 1})`
                : reloadAck.status === "failed"
                  ? `✕ Lỗi Reload: ${reloadAck.message}`
                  : reloadAck.message}
            </span>
          )}
        </div>

        <div className="v4-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`v4-tab ${mainTab === "studio" ? "active" : ""}`}
            onClick={() => setMainTab("studio")}
          >
            🎛️ Studio {catalog.length || 218} Lệnh Schema-Driven
          </button>
          <button
            type="button"
            className={`v4-tab ${mainTab === "sendtask" ? "active" : ""}`}
            onClick={() => setMainTab("sendtask")}
          >
            ⏰ Lịch Trình 24 Giờ Trực Quan (Visual SendTask)
          </button>
          <button
            type="button"
            className={`v4-tab ${mainTab === "simulator" ? "active" : ""}`}
            onClick={() => setMainTab("simulator")}
          >
            🧪 Hộp Cát Giả Lập Lệnh (Command Simulator)
          </button>
          <button
            type="button"
            className={`v4-tab ${mainTab === "vip_flags" ? "active" : ""}`}
            onClick={() => setMainTab("vip_flags")}
          >
            🚩 Cờ Tính Năng VIP & Lệnh Nhạy Cảm
          </button>
        </div>
      </div>

      {/* =====================================================================
          SUB-TAB 1: 218-COMMAND SCHEMA-DRIVEN STUDIO
         ===================================================================== */}
      {mainTab === "studio" && (
        <div className="v4-card">
          <div className="v4-grid-2" style={{ gridTemplateColumns: "310px minmax(0, 1fr)" }}>
            {/* Left Sidebar: 218 Commands Filterable List */}
            <div style={{ borderRight: "1px solid var(--border)", paddingRight: 14 }}>
              <input
                className="v4-input"
                style={{ marginBottom: 8 }}
                placeholder="Tìm tên lệnh, alias, mô tả..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              <div className="v4-grid-2" style={{ gap: 6, marginBottom: 8 }}>
                <select
                  className="v4-select"
                  style={{ padding: "6px 8px", fontSize: 12 }}
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="ALL">Mọi danh mục</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <select
                  className="v4-select"
                  style={{ padding: "6px 8px", fontSize: 12 }}
                  value={permissionFilter}
                  onChange={(e) => setPermissionFilter(e.target.value)}
                >
                  <option value="ALL">Mọi quyền hạn</option>
                  <option value="all">Thành viên (all)</option>
                  <option value="adminBox">QTV Nhóm (adminBox)</option>
                  <option value="adminBot">Admin Bot (adminBot)</option>
                  <option value="adminLevelHigh">Super Admin</option>
                </select>
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {["ALL", "FULL", "PARTIAL"].map((cov) => (
                  <button
                    key={cov}
                    type="button"
                    className={`v4-chip ${coverageFilter === cov ? "active" : ""}`}
                    style={{ fontSize: 11, padding: "3px 9px" }}
                    onClick={() => setCoverageFilter(cov)}
                  >
                    {cov === "ALL" ? `Tất cả (${filteredCatalog.length})` : cov}
                  </button>
                ))}
              </div>

              <div style={{ maxHeight: 620, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {filteredCatalog.map((cmd) => {
                  const active = cmd.commandName === selectedCmdName;
                  const cov = coverageMap[cmd.commandName] || "FULL";
                  return (
                    <button
                      key={cmd.commandName}
                      type="button"
                      className={`v4-nav-btn ${active ? "active" : ""}`}
                      style={{ padding: "8px 10px" }}
                      onClick={() => setSelectedCmdName(cmd.commandName)}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div className="v4-mono" style={{ fontWeight: 700 }}>
                          !{cmd.commandName}
                        </div>
                        <div className="v4-muted" style={{ fontSize: 11 }}>
                          {cmd.permission} • {cmd.scope}
                        </div>
                      </div>
                      <span className={`v4-badge ${cov === "FULL" ? "success" : "warning"}`} style={{ fontSize: 9.5 }}>
                        {cov}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Panel: 3-Tier Scope Bar + Dynamic Schema Form / JSON */}
            <div>
              {/* Top Action & Scope Bar */}
              <div
                className="v4-card"
                style={{
                  padding: 12,
                  marginBottom: 14,
                  background: "var(--bg-elevated)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <select
                    className="v4-select"
                    style={{ width: 215 }}
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <option value="global">🌐 Toàn hệ thống (global)</option>
                    <option value="bot">🤖 Theo Bot riêng (bot)</option>
                    <option value="group">💬 Theo Nhóm cụ thể (group)</option>
                  </select>

                  {scope !== "global" && (
                    <select
                      className="v4-select"
                      style={{ width: 190 }}
                      value={activeBot?.id || ""}
                      onChange={(e) => setSelectedBotId(e.target.value)}
                    >
                      {botList.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.displayName} ({b.id})
                        </option>
                      ))}
                    </select>
                  )}

                  {scope === "group" && (
                    <select
                      className="v4-select"
                      style={{ width: 210 }}
                      value={groupThreadId}
                      onChange={(e) => setGroupThreadId(e.target.value)}
                    >
                      <option value="">-- Chọn Nhóm --</option>
                      {botGroups.map((g) => {
                        const gid = String(g.threadId || g.id);
                        return (
                          <option key={gid} value={gid}>
                            {g.name || `Nhóm ${gid}`}
                          </option>
                        );
                      })}
                    </select>
                  )}

                  <span className="v4-badge neutral v4-mono">rev #{currentExpectedRevision}</span>
                  {draftInfo && <span className="v4-badge warning">Có bản nháp chưa áp dụng</span>}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="v4-btn sm"
                    onClick={() => setEditorMode((m) => (m === "visual" ? "json" : "visual"))}
                  >
                    {editorMode === "visual" ? "📝 JSON Nâng Cao & Diff" : "🧩 Biểu Mẫu Trực Quan"}
                  </button>
                  <button
                    type="button"
                    className="v4-btn sm"
                    disabled={busyStudio}
                    onClick={handleDryRunPreview}
                  >
                    🔍 Xem Trước (Dry-Run)
                  </button>
                  <button
                    type="button"
                    className="v4-btn sm"
                    disabled={busyStudio}
                    onClick={handleSaveDraft}
                  >
                    📝 Lưu Nháp
                  </button>
                  <button
                    type="button"
                    className="v4-btn sm success"
                    disabled={busyStudio}
                    onClick={handleApplyAndHotReload}
                  >
                    {busyStudio ? "Đang áp dụng..." : "⚡ Áp Dụng & Hot-Reload"}
                  </button>
                </div>
              </div>

              {/* Preview Dry-Run Box */}
              {previewResult && (
                <div className="v4-card highlight-admin" style={{ padding: 12, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <strong>
                      🔍 Kết quả Dry-Run Preview ({previewResult.changedPaths?.length || 0} trường thay đổi)
                    </strong>
                    <button type="button" className="v4-btn sm" onClick={() => setPreviewResult(null)}>
                      Đóng
                    </button>
                  </div>
                  <pre className="v4-mono" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>
                    {JSON.stringify(previewResult, null, 2)}
                  </pre>
                </div>
              )}

              {/* Command Header Metadata */}
              {contract && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <span className="v4-mono" style={{ fontSize: 18, fontWeight: 800 }}>
                      !{contract.commandName}
                    </span>
                    {contract.aliases?.length > 0 && (
                      <span className="v4-muted v4-mono" style={{ marginLeft: 10 }}>
                        Aliases: {contract.aliases.join(", ")}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" className="v4-btn sm" onClick={handleRollback} disabled={busyStudio}>
                      ⏪ Rollback bản trước
                    </button>
                    <button type="button" className="v4-btn sm danger" onClick={handleResetLayerOverride} disabled={busyStudio}>
                      ↺ Xóa Override ({scope})
                    </button>
                  </div>
                </div>
              )}

              {editorMode === "json" ? (
                <div className="v4-field">
                  <label>
                    JSON Sparse Override cho tầng <strong>{scope}</strong> (chỉ ghi các khóa muốn ghi đè)
                  </label>
                  <textarea
                    className="v4-textarea mono"
                    rows={16}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                  />
                </div>
              ) : contract ? (
                <>
                  {/* Contract Sub-Tabs */}
                  <div className="v4-tabs">
                    {contract.tabs.map((ct) => (
                      <button
                        key={ct.id}
                        type="button"
                        className={`v4-tab ${activeContractTab === ct.id ? "active" : ""}`}
                        onClick={() => setActiveContractTab(ct.id)}
                      >
                        {ct.title}
                      </button>
                    ))}
                  </div>

                  {currentTabObj?.id === "history" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {historyEntries.length === 0 ? (
                        <div className="v4-muted" style={{ padding: 18 }}>
                          Chưa có lịch sử chỉnh sửa nào cho lệnh <strong>{selectedCmdName}</strong>.
                        </div>
                      ) : (
                        historyEntries.map((h, idx) => (
                          <div key={idx} className="v4-card" style={{ padding: 12, background: "var(--bg-input)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <div>
                                <span className="v4-badge info">{h.action}</span>{" "}
                                <strong className="v4-mono">rev #{h.revision}</strong> • Phạm vi:{" "}
                                <strong>{h.scope || "global"}</strong>
                              </div>
                              <span className="v4-muted v4-mono">{formatDateVi(h.timestamp || h.createdAt)}</span>
                            </div>
                            {h.changedPaths?.length > 0 && (
                              <div className="v4-muted v4-mono" style={{ marginTop: 4, fontSize: 11.5 }}>
                                Trường thay đổi: {h.changedPaths.join(", ")}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="v4-grid-2">
                      {(currentTabObj?.fields || []).map((field) => renderSchemaField(field))}
                    </div>
                  )}
                </>
              ) : (
                <div className="v4-muted" style={{ padding: 24 }}>Đang tải Schema của lệnh...</div>
              )}

              {/* Rollback History Pills */}
              {historyEntries.length > 0 && (
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <div className="v4-muted" style={{ marginBottom: 6, fontWeight: 600 }}>
                    Lịch sử phiên bản gần đây (Nhấp để Rollback nhanh):
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {historyEntries.slice(0, 6).map((h, i) => (
                      <button
                        key={i}
                        type="button"
                        className="v4-chip"
                        onClick={handleRollback}
                        title={`Khôi phục phiên bản trước rev #${h.revision}`}
                      >
                        ↺ Trước rev #{h.revision} ({h.scope || "global"})
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 2: VISUAL 24-HOUR SENDTASK SCHEDULER
         ===================================================================== */}
      {mainTab === "sendtask" && (
        <div className="v4-card">
          <div className="v4-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                className={`v4-switch ${sendtaskEnabled ? "on" : ""}`}
                onClick={() => setSendtaskEnabled((v) => !v)}
              >
                <span className="v4-switch-knob" />
              </button>
              <div>
                <h3 style={{ margin: 0 }}>
                  {sendtaskEnabled
                    ? "Đang BẬT Lịch Trình Gửi Tin Tự Động 24 Giờ (SendTask)"
                    : "Đang TẮT Lịch Trình SendTask"}
                </h3>
                <div className="v4-muted">
                  Múi giờ chuẩn <code>Asia/Ho_Chi_Minh</code> • Diff & Reschedule từng khung giờ thông minh (rev #{sendtaskRevision})
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                className="v4-select"
                style={{ width: 170 }}
                value={sendtaskScope}
                onChange={(e) => setSendtaskScope(e.target.value)}
              >
                <option value="global">Phạm vi: Global</option>
                <option value="bot">Riêng Bot: {activeBot?.displayName}</option>
              </select>

              <select
                className="v4-select"
                style={{ width: 210 }}
                value={testTargetGroupId}
                onChange={(e) => setTestTargetGroupId(e.target.value)}
                title="Nhóm nhận khi bấm Bắn Thử"
              >
                <option value="">-- Nhóm nhận bắn thử --</option>
                {botGroups.map((g) => {
                  const gid = String(g.threadId || g.id);
                  return (
                    <option key={gid} value={gid}>
                      🎯 {g.name || `Nhóm ${gid}`}
                    </option>
                  );
                })}
              </select>

              <button
                type="button"
                className="v4-btn sm"
                onClick={() => setScheduleSlots((prev) => prev.map((s) => ({ ...s, enabled: true })))}
              >
                Bật cả 24h
              </button>
              <button
                type="button"
                className="v4-btn sm"
                onClick={() => setScheduleSlots((prev) => prev.map((s) => ({ ...s, enabled: false })))}
              >
                Tắt hết
              </button>
              <button
                type="button"
                className="v4-btn success"
                disabled={savingSendtask}
                onClick={handleSaveSendTask24h}
              >
                {savingSendtask ? "Đang lưu..." : "💾 Lưu Lịch 24 Giờ"}
              </button>
            </div>
          </div>

          {TIME_GROUPS.map((group) => {
            const groupItems = group.hours
              .map((h) => scheduleSlots.find((s) => s._hour === h))
              .filter(Boolean);

            return (
              <div key={group.id} style={{ marginBottom: 20 }}>
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 15,
                    marginBottom: 10,
                    paddingBottom: 6,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {group.title}
                </div>

                <div className="v4-grid-2">
                  {groupItems.map((slot) => (
                    <div
                      key={slot.id}
                      className="v4-card"
                      style={{
                        padding: 12,
                        background: slot.enabled ? "var(--bg-elevated)" : "var(--bg-input)",
                        opacity: slot.enabled ? 1 : 0.72,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span className="v4-badge info v4-mono" style={{ fontSize: 13 }}>
                            🕒 {formatSlotClock(slot, slot._hour)}
                          </span>

                          <select
                            className="v4-select"
                            style={{ width: 150, padding: "4px 8px" }}
                            value={slot.kind || "girl-video"}
                            onChange={(e) => updateScheduleSlot(slot.id, { kind: e.target.value })}
                          >
                            <option value="girl-video">🎬 Girl Video Pool</option>
                            <option value="tiktok-search">📱 TikTok Search</option>
                            <option value="zing-chart">🎵 Nhạc ZingChart</option>
                          </select>

                          {slot.kind === "girl-video" && (
                            <select
                              className="v4-select"
                              style={{ width: 115, padding: "4px 8px" }}
                              value={slot.category || "default"}
                              onChange={(e) => updateScheduleSlot(slot.id, { category: e.target.value })}
                            >
                              <option value="default">Default</option>
                              <option value="sexy">Sexy</option>
                              <option value="cosplay">Cosplay</option>
                              <option value="anime">Anime</option>
                            </select>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button
                            type="button"
                            className="v4-btn sm primary"
                            disabled={testingSlotId === slot.id}
                            onClick={() => handleTestFireSlot(slot)}
                          >
                            {testingSlotId === slot.id ? "Đang bắn..." : "🚀 Bắn Thử Khung Giờ Này"}
                          </button>

                          <button
                            type="button"
                            className={`v4-switch ${slot.enabled ? "on" : ""}`}
                            onClick={() => updateScheduleSlot(slot.id, { enabled: !slot.enabled })}
                          >
                            <span className="v4-switch-knob" />
                          </button>
                        </div>
                      </div>

                      {slot.kind === "tiktok-search" && (
                        <input
                          className="v4-input v4-mono"
                          style={{ marginBottom: 6, fontSize: 12 }}
                          placeholder="Từ khóa tìm kiếm TikTok (VD: nhạc chill {{timestamp}})"
                          value={slot.queryTemplate || ""}
                          onChange={(e) => updateScheduleSlot(slot.id, { queryTemplate: e.target.value })}
                        />
                      )}

                      <textarea
                        className="v4-textarea"
                        rows={2}
                        style={{ minHeight: 54 }}
                        value={slot.caption || ""}
                        onChange={(e) => updateScheduleSlot(slot.id, { caption: e.target.value })}
                        placeholder="Nhập lời chúc / caption cho khung giờ này..."
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 3: COMMAND SIMULATOR SANDBOX
         ===================================================================== */}
      {mainTab === "simulator" && (
        <div className="v4-grid-2">
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>🧪 Hộp Cát Giả Lập Lệnh (Policy & Gate Simulator)</h3>
                <div className="v4-muted">
                  Kiểm tra thử xem một thành viên cụ thể gõ lệnh trong nhóm có vượt qua KillSwitch, Quyền hạn, Whitelist và Cooldown hay không mà không ảnh hưởng nhóm thật.
                </div>
              </div>
            </div>

            <form onSubmit={handleRunSimulation}>
              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Chọn Bot kiểm thử</label>
                  <select
                    className="v4-select"
                    value={simBotId}
                    onChange={(e) => {
                      setSimBotId(e.target.value);
                      loadGroupsForBot(e.target.value);
                    }}
                  >
                    {botList.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.displayName} ({b.id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="v4-field">
                  <label>Nhóm giả lập (Thread ID)</label>
                  <input
                    className="v4-input v4-mono"
                    list="v5-sim-groups-list"
                    value={simThreadId}
                    onChange={(e) => setSimThreadId(e.target.value)}
                    placeholder="Nhập hoặc chọn Thread ID..."
                  />
                  <datalist id="v5-sim-groups-list">
                    {botGroups.map((g) => {
                      const gid = String(g.threadId || g.id);
                      return (
                        <option key={gid} value={gid}>
                          {g.name}
                        </option>
                      );
                    })}
                  </datalist>
                </div>
              </div>

              <div className="v4-grid-3">
                <div className="v4-field">
                  <label>Vai trò người gửi (Sender Role)</label>
                  <select
                    className="v4-select"
                    value={simRole}
                    onChange={(e) => setSimRole(e.target.value)}
                  >
                    <option value="member">👤 Thành viên thường (member)</option>
                    <option value="adminBox">🛡️ Quản trị viên Nhóm (adminBox)</option>
                    <option value="adminBot">🤖 Admin điều khiển Bot (adminBot)</option>
                    <option value="adminLevelHigh">👑 Chủ hệ thống (adminLevelHigh)</option>
                  </select>
                </div>

                <div className="v4-field">
                  <label>Zalo UID người gửi</label>
                  <input
                    className="v4-input v4-mono"
                    value={simSenderUid}
                    onChange={(e) => setSimSenderUid(e.target.value)}
                  />
                </div>

                <div className="v4-field">
                  <label>Tên hiển thị người gửi</label>
                  <input
                    className="v4-input"
                    value={simSenderName}
                    onChange={(e) => setSimSenderName(e.target.value)}
                  />
                </div>
              </div>

              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Tên lệnh cần giả lập</label>
                  <input
                    className="v4-input v4-mono"
                    list="v5-sim-cmd-datalist"
                    value={simCommand}
                    onChange={(e) => setSimCommand(e.target.value)}
                  />
                  <datalist id="v5-sim-cmd-datalist">
                    {catalog.map((c) => (
                      <option key={c.commandName} value={c.commandName}>
                        {c.permission}
                      </option>
                    ))}
                  </datalist>
                </div>

                <div className="v4-field">
                  <label>Tham số đi kèm (Args)</label>
                  <input
                    className="v4-input v4-mono"
                    placeholder="VD: Hà Nội, on, @user..."
                    value={simArgs}
                    onChange={(e) => setSimArgs(e.target.value)}
                  />
                </div>
              </div>

              <button type="submit" className="v4-btn primary" style={{ width: "100%" }} disabled={runningSim}>
                {runningSim ? "Đang phân tích luồng Gate..." : "🧪 Chạy Giả Lập Lệnh"}
              </button>
            </form>
          </div>

          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>📋 Kết Quả Phán Quyết Của Gate & Xem Trước Phản Hồi</h3>
                <div className="v4-muted">Chi tiết cấu hình hợp nhất (Effective Config) và câu trả lời dự kiến</div>
              </div>
            </div>

            {!simResult ? (
              <div className="v4-muted" style={{ padding: 36, textAlign: "center" }}>
                Điền thông tin ngữ cảnh bên trái và bấm <strong>“Chạy Giả Lập Lệnh”</strong> để kiểm tra.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div
                  className={`v4-card ${
                    simResult.allowed !== false && simResult.verdict !== "BLOCK"
                      ? "highlight-admin"
                      : "highlight-danger"
                  }`}
                  style={{ padding: 14 }}
                >
                  <div style={{ fontSize: 16, fontWeight: 800 }}>
                    {simResult.allowed !== false && simResult.verdict !== "BLOCK"
                      ? "✅ CHO PHÉP THỰC THI (GATE PASS)"
                      : "⛔ BỊ CHẶN BỞI BEHAVIOR GATE (BLOCKED)"}
                  </div>
                  <div className="v4-muted" style={{ marginTop: 4 }}>
                    Lý do / Bước kiểm tra:{" "}
                    <strong>{simResult.reason || simResult.gateStage || "Đủ điều kiện thực thi bình thường"}</strong>
                  </div>
                </div>

                <div className="v4-card" style={{ padding: 12, background: "var(--bg-input)" }}>
                  <div className="v4-muted" style={{ marginBottom: 4 }}>
                    💬 Tin nhắn phản hồi dự kiến (Rendered Reply Preview):
                  </div>
                  <div style={{ fontWeight: 600, whiteSpace: "pre-wrap" }}>
                    {simResult.renderedReply ||
                      simResult.replyPreview ||
                      simResult.previewText ||
                      `(Lệnh !${simCommand} sẽ thực thi handler mặc định và gửi kết quả vào nhóm ${simThreadId})`}
                  </div>
                </div>

                <div>
                  <div className="v4-muted" style={{ marginBottom: 6, fontWeight: 600 }}>
                    Cấu hình hợp nhất áp dụng tại thời điểm chạy (Effective Config):
                  </div>
                  <pre className="v4-log-box" style={{ height: 220, margin: 0 }}>
                    {JSON.stringify(simResult.effectiveConfig || simResult.effective || simResult, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 4: VIP FEATURE FLAGS & HIGH-RISK COMMAND GROUPS
         ===================================================================== */}
      {mainTab === "vip_flags" && (
        <div className="v4-card">
          <div className="v4-card-header">
            <div>
              <h3>🚩 Cờ Tính Năng VIP & Kiểm Soát Nhóm Lệnh Nhạy Cảm</h3>
              <div className="v4-muted">
                Bật/tắt toàn cục các nhóm lệnh AI, Tiện ích hoặc Nhạy cảm (High-Risk) kèm kiểm tra sức khỏe khóa Provider.
              </div>
            </div>
            <button
              type="button"
              className="v4-btn success"
              disabled={savingVip}
              onClick={handleSaveVipFlags}
            >
              {savingVip ? "Đang lưu..." : "💾 Áp Dụng Cờ Tính Năng VIP"}
            </button>
          </div>

          <div className="v4-grid-3" style={{ marginBottom: 18 }}>
            {Object.entries(vipFlags).map(([flagKey, enabled]) => {
              const meta = VIP_FLAG_META[flagKey] || {
                title: `🚩 Cờ nhóm lệnh: ${flagKey}`,
                desc: "Điều khiển trạng thái kích hoạt nhóm lệnh tương ứng trên toàn hệ thống",
              };
              return (
                <div key={flagKey} className="v4-switch-card" style={{ alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14.5 }}>{meta.title}</div>
                    <div className="v4-mono v4-muted" style={{ fontSize: 11, margin: "2px 0 4px" }}>
                      {flagKey}
                    </div>
                    <div className="v4-muted" style={{ fontSize: 12 }}>{meta.desc}</div>
                  </div>
                  <button
                    type="button"
                    className={`v4-switch ${enabled ? "on" : ""}`}
                    onClick={() => toggleVipFlag(flagKey)}
                  >
                    <span className="v4-switch-knob" />
                  </button>
                </div>
              );
            })}
          </div>

          {vipMigrationPreview?.preview?.length > 0 && (
            <div className="v4-card highlight-admin" style={{ marginBottom: 16, padding: 12 }}>
              <strong>🔍 Xem trước thay đổi trước khi lưu:</strong>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                {vipMigrationPreview.preview.map((chg) => (
                  <span key={chg.key} className="v4-badge warning v4-mono">
                    {chg.key}: {String(chg.from)} → {String(chg.to)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="v4-table-wrap">
            <table className="v4-table">
              <thead>
                <tr>
                  <th>Lệnh</th>
                  <th>Mức rủi ro</th>
                  <th>Quyền hạn</th>
                  <th>Provider phụ thuộc</th>
                  <th>Sức khỏe khóa API</th>
                  <th>Trạng thái hiệu lực</th>
                </tr>
              </thead>
              <tbody>
                {vipCatalog.slice(0, 60).map((item) => (
                  <tr key={item.name}>
                    <td className="v4-mono" style={{ fontWeight: 700 }}>!{item.name}</td>
                    <td>
                      <span
                        className={`v4-badge ${
                          item.risk === "high" || item.risk === "critical" ? "danger" : "neutral"
                        }`}
                      >
                        {item.risk || "normal"}
                      </span>
                    </td>
                    <td className="v4-mono">{item.permission}</td>
                    <td className="v4-mono">{item.providerDependency || "—"}</td>
                    <td>
                      <span className={`v4-badge ${item.health === "healthy" ? "success" : "warning"}`}>
                        {item.health === "healthy" ? "Đủ khóa API" : "Thiếu khóa API"}
                      </span>
                    </td>
                    <td>
                      <span className={`v4-badge ${item.enabled ? "success" : "danger"}`}>
                        {item.enabled ? "Đang Mở" : "Đang Khóa"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
