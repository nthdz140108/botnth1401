import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../app/api.js";
import { fetchBehaviorSchema } from "../app/command-schema.js";
import { SchemaGroup } from "./fields.jsx";

const emptyCommand = { name: "", alias: [], description: "", syntax: "", permission: "all", scope: "both", countdown: 0, active: true, icon: "", type: 0 };
const permissions = ["all", "adminBot", "adminBox", "adminBotOrGroup", "adminLevelHigh"];
const scopeOptions = [["group", "Group"], ["private", "Private"], ["both", "Both"]];
const SCHEMA_GROUP_BY_TAB = { operation: "operation", responses: "responses", params: "params", restrictions: "restrictions" };
const COMMON_TAB_TITLES = [
  ["overview", "Tổng quan"],
  ["handler", "Handler & luồng"],
  ["operation", "Vận hành"],
  ["responses", "Phản hồi"],
  ["permissions", "Quyền & giới hạn"],
  ["secrets", "Secrets"],
  ["history", "Lịch sử"],
];
const LEGACY_TABS = [
  ["params", "Tham số"],
  ["restrictions", "Giới hạn"],
];
const STATUS_FILTERS = [
  ["all", "Tất cả trạng thái"],
  ["enabled", "Enabled"],
  ["disabled", "Disabled"],
  ["override", "Có override"],
  ["missing-handler", "Thiếu handler"],
];
const COVERAGE_FILTERS = [
  ["all", "Mọi coverage"],
  ["FULL", "FULL"],
  ["PARTIAL", "PARTIAL"],
  ["MISSING", "MISSING"],
];
const TYPE_FILTERS = [["all", "Tất cả loại"], ["1", "Loại 1"], ["2", "Loại 2"], ["3", "Loại 3"], ["5", "Loại 5"], ["99", "Loại 99"]];
const SCOPE_LAYER_BY_MODE = { global: "global", bot: "bot", group: "group" };

function stripVolatile(value) {
  const { enabled, handlerAvailable, missingConfig, missingDependencies, registryActive, effectiveScope, override, requiredConfig, requiredDependencies, ...rest } = value || {};
  void enabled;
  void handlerAvailable;
  void missingConfig;
  void missingDependencies;
  void registryActive;
  void effectiveScope;
  void override;
  void requiredConfig;
  void requiredDependencies;
  return rest;
}

function filterCommands(list, needle, status, type, coverageFilter, catalogByCommand) {
  const q = needle.trim().toLowerCase();
  return list.filter((command) => {
    const entry = catalogByCommand.get(command.name);
    const haystack = [
      command.name,
      ...(command.alias || []),
      command.type,
      command.permission,
      command.scope,
      command.effectiveScope,
      command.enabled ? "enabled" : "disabled",
      command.handlerAvailable === false ? "missing-handler" : "handler",
      ...(command.requiredConfig || []),
      ...(command.requiredDependencies || []),
      entry?.handlerRef?.module || "",
      ...(entry?.handlerRef?.dependencies || []),
      ...(entry?.handlerRef?.providers || []),
    ].join(" ").toLowerCase();
    const matchesQuery = !q || haystack.includes(q);
    const matchesStatus = status === "all"
      || (status === "enabled" && Boolean(command.enabled))
      || (status === "disabled" && !command.enabled)
      || (status === "override" && Boolean(command.override))
      || (status === "missing-handler" && command.handlerAvailable === false);
    const matchesType = type === "all" || String(command.type) === type;
    const coverage = entry?.coverage || "MISSING";
    const matchesCoverage = coverageFilter === "all" || coverage === coverageFilter;
    return matchesQuery && matchesStatus && matchesType && matchesCoverage;
  });
}

function leafMatches(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function diffBehaviorLeaves(next, base) {
  if (next === null || typeof next !== "object" || Array.isArray(next)) {
    return leafMatches(next, base) ? undefined : next;
  }
  const baseObject = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  let changed = false;
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    const diff = diffBehaviorLeaves(value, baseObject[key]);
    if (diff !== undefined) {
      out[key] = diff;
      changed = true;
    }
  }
  return changed ? out : undefined;
}

function sourceBadge(source) {
  if (!source || source === "default") return { label: "mặc định", className: "provenance-badge default" };
  if (source === "draft") return { label: "nháp chưa áp dụng", className: "provenance-badge draft" };
  return { label: `kế thừa từ ${source}`, className: `provenance-badge ${source}` };
}

export function CommandWorkspace({ bots }) {
  const [selectedBot, setSelectedBot] = useState("");
  const [threadIdInput, setThreadIdInput] = useState("");
  const [commands, setCommands] = useState([]);
  const [diagnostics, setDiagnostics] = useState([]);
  const [selectedName, setSelectedName] = useState("");
  const [draft, setDraft] = useState(emptyCommand);
  const [baseline, setBaseline] = useState(JSON.stringify(stripVolatile(emptyCommand)));
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [coverageFilter, setCoverageFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [detailTab, setDetailTab] = useState("overview");
  const [schema, setSchema] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const globalBehaviorRef = useRef(null);

  const [catalogByCommand, setCatalogByCommand] = useState(new Map());
  const [contract, setContract] = useState(null);
  const [studioEffective, setStudioEffective] = useState(null);
  const [studioProvenance, setStudioProvenance] = useState({});
  const [studioRevisions, setStudioRevisions] = useState({});
  const [studioPatch, setStudioPatch] = useState({});
  const [studioResetKeys, setStudioResetKeys] = useState([]);
  const [validationResult, setValidationResult] = useState(null);
  const [ackState, setAckState] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [tablePanelRow, setTablePanelRow] = useState(null);
  const [busy, setBusy] = useState(false);

  const selected = commands.find((command) => command.name === selectedName) || null;
  const scopeMode = !selectedBot ? "global" : (threadIdInput.trim() ? "group" : "bot");

  const dirty = useMemo(() => JSON.stringify(stripVolatile(draft)) !== baseline
    || Object.keys(studioPatch).length > 0
    || studioResetKeys.length > 0, [draft, baseline, studioPatch, studioResetKeys]);
  const visible = useMemo(
    () => filterCommands(commands, query, statusFilter, typeFilter, coverageFilter, catalogByCommand),
    [commands, query, statusFilter, typeFilter, coverageFilter, catalogByCommand],
  );
  const schemaGroup = schema?.schema?.groups?.find((group) => group.id === SCHEMA_GROUP_BY_TAB[detailTab]) || null;

  const workspaceTabs = useMemo(() => {
    const contractTabs = (contract?.contract?.tabs || []).map((tab) => ({ id: tab.id, title: tab.title }));
    const tabs = contractTabs.length ? contractTabs : COMMON_TAB_TITLES.map(([id, title]) => ({ id, title }));
    return [...tabs, ...LEGACY_TABS.map(([id, title]) => ({ id, title }))];
  }, [contract]);

  useEffect(() => {
    fetchBehaviorSchema().then(setSchema).catch((e) => setError(e.message));
    loadCatalog();
  }, []);

  useEffect(() => {
    load();
  }, [selectedBot]);

  useEffect(() => {
    if (!selected) return undefined;
    const effective = { ...selected, ...(selected.override || {}) };
    const base = { ...emptyCommand, ...effective, scope: effective.effectiveScope || effective.scope || "both", alias: effective.alias || [] };
    setDraft(base);
    setBaseline(JSON.stringify(stripVolatile(base)));
    globalBehaviorRef.current = null;
    let active = true;
    fetchBehaviorProfile(effective.name || selected.name)
      .then(({ profile, global }) => {
        if (!active) return;
        globalBehaviorRef.current = global;
        const merged = { ...base, behavior: profile };
        setDraft(merged);
        setBaseline(JSON.stringify(stripVolatile(merged)));
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [selectedName, commands]);

  useEffect(() => {
    if (!selectedName) return undefined;
    let active = true;
    setDetailTab("overview");
    setStudioPatch({});
    setStudioResetKeys([]);
    setValidationResult(null);
    setTablePanelRow(null);
    loadContractAndConfig(selectedName).catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [selectedName, selectedBot, threadIdInput]);

  async function loadCatalog() {
    try {
      const [catalogRes, coverageRes] = await Promise.all([
        apiRequest("/api/command-studio/catalog"),
        apiRequest("/api/command-studio/coverage"),
      ]);
      const catalog = catalogRes.data || {};
      const coverageRows = (coverageRes.data?.rows || []);
      const coverageByName = new Map(coverageRows.map((row) => [row.commandName, row.coverage]));
      const next = new Map();
      for (const entry of catalog.commands || []) {
        next.set(entry.commandName, { ...entry, coverage: coverageByName.get(entry.commandName) || "MISSING" });
      }
      setCatalogByCommand(next);
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadContractAndConfig(commandName) {
    const key = encodeURIComponent(commandName);
    const scopeQuery = buildScopeQuery();
    const [contractRes, configRes] = await Promise.all([
      apiRequest(`/api/command-studio/commands/${key}/contract`),
      apiRequest(`/api/command-studio/commands/${key}/config${scopeQuery}`),
    ]);
    setContract(contractRes.data || null);
    setStudioEffective(configRes.data?.effective || {});
    setStudioProvenance(configRes.data?.provenance || {});
    setStudioRevisions(configRes.data?.revisions || {});
    try {
      const draftRes = await apiRequest(`/api/command-studio/commands/${key}/draft${scopeQuery}`);
      if (draftRes.data?.draft?.patch) setStudioPatch({ ...draftRes.data.draft.patch });
      if (draftRes.data?.draft?.resetKeys) setStudioResetKeys([...draftRes.data.draft.resetKeys]);
    } catch {}
    if ((contractRes.data?.contract?.tabs || []).some((tab) => tab.id === detailTab) === false && !LEGACY_TABS.some(([id]) => id === detailTab)) {
      setDetailTab("overview");
    }
  }

  function buildScopeQuery() {
    const params = new URLSearchParams();
    if (selectedBot) params.set("botId", selectedBot);
    if (selectedBot && threadIdInput.trim()) params.set("threadId", threadIdInput.trim());
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  async function load() {
    try {
      const url = selectedBot ? `/api/bots/${encodeURIComponent(selectedBot)}/commands` : "/api/commands/scan";
      const result = await apiRequest(url);
      const data = result.data || result;
      setCommands(data.commands || []);
      setDiagnostics(data.diagnostics || []);
      setSelectedName((current) => current || data.commands?.[0]?.name || "");
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function fetchBehaviorProfile(commandName) {
    const key = encodeURIComponent(commandName);
    const url = selectedBot
      ? `/api/bots/${encodeURIComponent(selectedBot)}/commands/${key}/behavior`
      : `/api/commands/${key}/behavior`;
    const result = await apiRequest(url);
    const data = result.data || {};
    return {
      profile: selectedBot ? data.effective || data.defaults || {} : data.global || data.defaults || {},
      global: data.global || null,
    };
  }

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateBehavior(nextProfile) {
    setDraft((current) => ({ ...current, behavior: nextProfile }));
  }

  function studioValue(fieldKey) {
    if (Object.prototype.hasOwnProperty.call(studioPatch, fieldKey)) {
      return { value: studioPatch[fieldKey], source: "draft" };
    }
    return { value: studioEffective?.[fieldKey], source: studioProvenance[fieldKey]?.source || "default" };
  }

  function setStudioField(fieldKey, value) {
    setStudioPatch((current) => ({ ...current, [fieldKey]: value }));
    setValidationResult(null);
  }

  function resetStudioField(fieldKey) {
    setStudioPatch((current) => {
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
  }

  function confirmDiscard(message) {
    return !dirty || window.confirm(`${message} Có thay đổi chưa lưu sẽ mất. Tiếp tục?`);
  }

  function chooseCommand(name) {
    if (name === selectedName) return;
    if (!confirmDiscard("Đang chuyển sang lệnh khác.")) return;
    setSelectedName(name);
  }

  function chooseTab(tabId) {
    if (tabId === detailTab) return;
    if (!confirmDiscard("Đang chuyển tab chỉnh sửa.")) return;
    setTablePanelRow(null);
    setDetailTab(tabId);
  }

  function chooseBot(botId) {
    if (botId === selectedBot) return;
    if (!confirmDiscard("Đang đổi phạm vi bot.")) return;
    setSelectedName(selectedName);
    setSelectedBot(botId);
    setThreadIdInput("");
  }

  async function saveStudioDraft() {
    if (!selected || !contract) return null;
    const patch = {};
    for (const [key, value] of Object.entries(studioPatch)) {
      if (!studioResetKeys.includes(key)) patch[key] = value;
    }
    const result = await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/draft`, {
      method: "PUT",
      body: {
        scope: scopeMode,
        botId: selectedBot || undefined,
        threadId: scopeMode === "group" ? threadIdInput.trim() : undefined,
        patch,
        expectedRevision: studioRevisions[scopeMode],
      },
    });
    return result.data;
  }

  async function validateStudio() {
    if (!selected || !contract) return;
    setBusy(true);
    try {
      const values = mergeOverrideMap();
      await saveStudioDraft();
      const result = await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/validate`, {
        method: "POST",
        body: { scope: scopeMode, botId: selectedBot || undefined, threadId: scopeMode === "group" ? threadIdInput.trim() : undefined, values },
      });
      setValidationResult(result.data || { ok: true, errors: [] });
      setNotice(result.data?.ok ? "Validate OK. Có thể Apply." : "Validate có lỗi.");
      setError("");
    } catch (e) {
      setValidationResult({ ok: false, errors: [{ path: "", message: e.message }] });
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function mergeOverrideMap() {
    const effectiveBase = { ...(studioEffective || {}) };
    const values = {};
    const contractFields = new Map();
    for (const tab of contract?.contract?.tabs || []) {
      for (const field of tab.fields || []) contractFields.set(field.key, field);
    }
    for (const [key, field] of contractFields) {
      if (field.readOnly) continue;
      values[key] = studioEffective?.[key] ?? (field.default !== undefined ? field.default : null);
    }
    void effectiveBase;
    for (const [key, value] of Object.entries(studioPatch)) {
      if (studioResetKeys.includes(key) || contractFields.get(key)?.readOnly) continue;
      values[key] = value;
    }
    return values;
  }

  async function previewStudio() {
    if (!selected || !contract) return;
    setBusy(true);
    try {
      const values = mergeOverrideMap();
      await saveStudioDraft();
      const result = await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/preview`, {
        method: "POST",
        body: { scope: scopeMode, botId: selectedBot || undefined, threadId: scopeMode === "group" ? threadIdInput.trim() : undefined, values },
      });
      setNotice(`Dry-run OK. Thay đổi: ${(result.data?.changedPaths || []).join(", ") || "(không)"}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyStudio() {
    if (!selected || !contract || saving) return;
    setSaving(true);
    try {
      const values = mergeOverrideMap();
      await saveStudioDraft();
      await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/validate`, {
        method: "POST",
        body: { scope: scopeMode, botId: selectedBot || undefined, threadId: scopeMode === "group" ? threadIdInput.trim() : undefined, values },
      });
      const result = await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/apply`, {
        method: "POST",
        body: {
          scope: scopeMode,
          botId: selectedBot || undefined,
          threadId: scopeMode === "group" ? threadIdInput.trim() : undefined,
          expectedRevision: studioRevisions[scopeMode],
          fromDraft: true,
        },
      });
      setNotice(`Đã apply revision ${result.data?.revision}.`);
      setError("");
      setStudioPatch({});
      setStudioResetKeys([]);
      setValidationResult(null);
      await loadContractAndConfig(selected.name);
      await requestStudioReload(result.data?.revision);
    } catch (e) {
      setError(e.status === 409 ? "Revision conflict: ai đó đã đổi cấu hình trước bạn. Hãy tải lại." : e.message);
    } finally {
      setSaving(false);
    }
  }

  async function rollbackStudio() {
    if (!selected) return;
    if (!window.confirm("Rollback sẽ phục hồi snapshot cũ của lớp cấu hình này. Tiếp tục?")) return;
    setBusy(true);
    try {
      const result = await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/rollback`, {
        method: "POST",
        body: { scope: scopeMode, botId: selectedBot || undefined, threadId: scopeMode === "group" ? threadIdInput.trim() : undefined },
      });
      setNotice(`Đã rollback về revision ${result.data?.rolledBackTo}.`);
      setStudioPatch({});
      setStudioResetKeys([]);
      await loadContractAndConfig(selected.name);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetFieldToInherited(fieldKey) {
    setStudioResetKeys((current) => [...new Set([...current, fieldKey])]);
    setNotice(`"${fieldKey}" sẽ trả về kế thừa khi Apply.`);
  }

  async function requestStudioReload(revision) {
    try {
      await apiRequest("/api/system/command-config/reload", {
        method: "POST",
        body: {
          botId: selectedBot || "admin",
          commandName: selected?.name,
          revision: revision ?? null,
          scope: scopeMode,
        },
      });
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts += 1;
        try {
          const stateRes = await apiRequest(`/api/system/command-config/reload-state?botId=${encodeURIComponent(selectedBot || "admin")}`);
          const state = stateRes.data || {};
          setAckState(state);
          if (state.status === "ready" || state.status === "failed" || attempts > 10) clearInterval(timer);
        } catch {
          clearInterval(timer);
        }
      }, 1000);
      setNotice((prev) => `${prev} Đã gửi yêu cầu reload runtime, chờ bot ACK…`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadHistory() {
    if (!selected) return;
    try {
      const result = await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/history?limit=50`);
      setHistoryEntries(result.data?.entries || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    if (detailTab === "history") loadHistory();
  }, [detailTab, selectedName]);

  async function save() {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const { behavior, ...basic } = draft;
      const basicPayload = stripVolatile(basic);
      if (selectedBot) {
        const { name, ...overridePatch } = basicPayload;
        void name;
        await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}`, { method: "PUT", body: overridePatch });
        if (behavior) {
          const behaviorPatch = diffBehaviorLeaves(behavior, globalBehaviorRef.current);
          if (behaviorPatch) {
            await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}/behavior`, { method: "PUT", body: behaviorPatch });
          }
        }
      } else {
        await apiRequest(`/api/commands/${encodeURIComponent(selected.name)}`, { method: "PUT", body: basicPayload });
        if (behavior) await apiRequest(`/api/commands/${encodeURIComponent(selected.name)}/behavior`, { method: "PUT", body: behavior });
      }
      setNotice("Đã lưu metadata/behavior. Cấu hình Studio dùng nút Apply riêng ở header.");
      setError("");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetOverride() {
    if (!selectedBot || !selected) return;
    try {
      await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}/override`, { method: "DELETE" });
      await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}/behavior`, { method: "DELETE" });
      await apiRequest(`/api/command-studio/commands/${encodeURIComponent(selected.name)}/reset-override`, {
        method: "POST",
        body: { scope: scopeMode, botId: selectedBot, threadId: scopeMode === "group" ? threadIdInput.trim() : undefined },
      });
      setNotice("Đã đặt lại override theo cấu hình global.");
      await Promise.all([load(), loadContractAndConfig(selected.name)]);
    } catch (e) {
      setError(e.message);
    }
  }

  async function copyFromAdmin() {
    if (!selectedBot) return;
    try {
      await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/copy-from-admin`, { method: "POST" });
      setNotice("Đã sao chép override từ admin.");
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function applyAll() {
    if (!selected) return;
    if (!confirmDiscard("Sẽ áp dụng bản đã lưu trên máy chủ cho toàn bộ bot.")) return;
    const { behavior, ...patch } = stripVolatile(draft);
    void behavior;
    try {
      await apiRequest("/api/commands/apply-all", { method: "POST", body: { commandName: selected.name, patch } });
      setNotice("Đã áp dụng command cho toàn bộ bot con.");
    } catch (e) {
      setError(e.message);
    }
  }

  async function reloadRuntime() {
    try {
      await apiRequest("/api/system/command-config/reload", { method: "POST", body: { botId: selectedBot || "admin" } });
      setNotice("Đã gửi yêu cầu reload cấu hình lệnh.");
    } catch (e) {
      setError(e.message);
    }
  }

  function renderStudioField(field) {
    const { value, source } = studioValue(field.key);
    const provenance = studioProvenance[field.key] || {};
    const badge = sourceBadge(source);
    const disabled = Boolean(field.readOnly);
    const inherited = !Object.prototype.hasOwnProperty.call(studioPatch, field.key);
    if (field.sensitive) {
      return (
        <div className={`field ${inherited ? "" : "field-overridden"}`} key={field.key}>
          <div className="field-head">
            <label>{field.label}</label>
            <span className={badge.className}>{badge.label}</span>
            {!inherited ? (
              <button type="button" className="link-button" onClick={() => resetStudioField(field.key)}>Trả về kế thừa</button>
            ) : provenance.overridden && field.allowedScopes.includes(scopeMode) ? (
              <button type="button" className="link-button" onClick={() => setStudioField(field.key, value)}>Tạo override</button>
            ) : null}
          </div>
          <input
            type="password"
            autoComplete="new-password"
            value={String(value ?? "")}
            placeholder={field.description || ""}
            disabled={disabled}
            onChange={(e) => setStudioField(field.key, e.target.value)}
          />
        </div>
      );
    }
    switch (field.type) {
      case "boolean":
        return (
          <div className={`field field-check ${inherited ? "" : "field-overridden"}`} key={field.key}>
            <div className="field-head">
              <label><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => setStudioField(field.key, e.target.checked)} /> {field.label}</label>
              <span className={badge.className}>{badge.label}</span>
              {!inherited ? <button type="button" className="link-button" onClick={() => resetStudioField(field.key)}>Trả về kế thừa</button> : null}
            </div>
            {field.description ? <small className="muted">{field.description}</small> : null}
          </div>
        );
      case "number":
        return (
          <div className={`field ${inherited ? "" : "field-overridden"}`} key={field.key}>
            <div className="field-head">
              <label>{field.label}{field.nullable ? " (trống = mặc định)" : ""}</label>
              <span className={badge.className}>{badge.label}</span>
              {!inherited ? <button type="button" className="link-button" onClick={() => resetStudioField(field.key)}>Trả về kế thừa</button> : null}
            </div>
            <input
              type="number"
              min={field.min}
              max={field.max}
              value={value === null || value === undefined ? "" : Number(value)}
              disabled={disabled}
              onChange={(e) => setStudioField(field.key, e.target.value === "" ? (field.nullable ? null : "") : Number(e.target.value))}
            />
          </div>
        );
      case "select":
        return (
          <div className={`field ${inherited ? "" : "field-overridden"}`} key={field.key}>
            <div className="field-head">
              <label>{field.label}</label>
              <span className={badge.className}>{badge.label}</span>
              {!inherited ? <button type="button" className="link-button" onClick={() => resetStudioField(field.key)}>Trả về kế thừa</button> : null}
            </div>
            <select value={String(value ?? "")} disabled={disabled} onChange={(e) => setStudioField(field.key, e.target.value)}>
              {(field.options || []).map((option) => <option key={String(option)} value={String(option)}>{option === null || option === "" ? "(mặc định)" : String(option)}</option>)}
            </select>
          </div>
        );
      case "table":
        return (
          <StudioTableField
            key={field.key}
            field={field}
            rows={Array.isArray(value) ? value : []}
            onChange={(rows) => setStudioField(field.key, rows)}
            panelRow={tablePanelRow}
            onPanelRow={setTablePanelRow}
          />
        );
      case "template":
      case "text":
        return (
          <div className={`field field-template ${inherited ? "" : "field-overridden"}`} key={field.key}>
            <div className="field-head">
              <label>{field.label}</label>
              <span className={badge.className}>{badge.label}</span>
              {!inherited ? <button type="button" className="link-button" onClick={() => resetStudioField(field.key)}>Trả về kế thừa</button> : null}
            </div>
            <textarea rows={field.type === "text" ? 3 : 2} value={String(value ?? "")} disabled={disabled} onChange={(e) => setStudioField(field.key, e.target.value)} />
            {field.description ? <small className="muted">{field.description}</small> : null}
          </div>
        );
      case "string":
      case "emoji":
      default:
        return (
          <div className={`field ${inherited ? "" : "field-overridden"}`} key={field.key}>
            <div className="field-head">
              <label>{field.label}</label>
              <span className={badge.className}>{badge.label}</span>
              {!inherited ? <button type="button" className="link-button" onClick={() => resetStudioField(field.key)}>Trả về kế thừa</button> : null}
            </div>
            <input value={String(value ?? "")} maxLength={field.type === "emoji" ? 8 : undefined} disabled={disabled} onChange={(e) => setStudioField(field.key, e.target.value)} />
          </div>
        );
    }
  }

  const activeContractTab = contract?.contract?.tabs?.find((tab) => tab.id === detailTab) || null;
  const layerRevisionValue = studioRevisions[scopeMode];

  return (
    <section className="panel workspace">
      <div className="section-heading">
        <div>
          <p className="kicker">COMMAND STUDIO V2</p>
          <h2>Quản lý command</h2>
          <p className="muted">Contract từng command · cấu hình Global → Bot → Group · nháp → validate → apply → rollback.</p>
        </div>
        <div className="toolbar">
          {dirty ? <span className="stale-state" role="status">● dirty</span> : <span className="chip">clean</span>}
          <button className="secondary" onClick={() => load()}>Quét lại</button>
        </div>
      </div>

      {error ? <div className="error" role="alert">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="studio-header">
        <div className="toolbar command-toolbar">
          <select value={selectedBot} onChange={(e) => chooseBot(e.target.value)}>
            <option value="">Global / Admin</option>
            {(bots || []).map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName || bot.id}</option>)}
          </select>
          <input
            value={threadIdInput}
            onChange={(e) => setThreadIdInput(e.target.value)}
            placeholder={selectedBot ? "ThreadId để override theo nhóm (tuỳ chọn)" : "Chọn bot để override"}
            disabled={!selectedBot}
          />
          <span className="chip">{scopeMode === "global" ? "Phạm vi: Global" : scopeMode === "bot" ? "Phạm vi: Bot" : "Phạm vi: Group"}</span>
          <span className="chip" title="Revision của lớp đang chọn">rev {layerRevisionValue ?? "?"}</span>
        </div>
        <div className="toolbar studio-actions">
          <button onClick={validateStudio} disabled={!selected || busy}>Validate</button>
          <button className="secondary" onClick={previewStudio} disabled={!selected || busy}>Preview</button>
          <button onClick={applyStudio} disabled={!selected || saving}>{saving ? "Đang apply…" : "Apply"}</button>
          <button className="secondary" onClick={rollbackStudio} disabled={!selected || busy}>Rollback</button>
          <button className="secondary" onClick={reloadRuntime}>Reload runtime ↻</button>
        </div>
        {validationResult ? (
          <div className={validationResult.ok ? "notice" : "error"}>
            {validationResult.ok ? "✓ Hợp lệ" : validationResult.errors.map((err, index) => <div key={index}>{err.path}: {err.message}</div>)}
          </div>
        ) : null}
        {ackState ? (
          <div className={ackState.status === "failed" ? "error" : "notice"}>
            Bot ACK: {ackState.status || "unknown"}{ackState.commandName ? ` · ${ackState.commandName}` : ""}{ackState.revision != null ? ` · rev ${ackState.revision}` : ""}{ackState.error ? ` · ${ackState.error}` : ""}
          </div>
        ) : null}
      </div>

      <div className="toolbar filter-chips">
        <span className="muted">Trạng thái:</span>
        {STATUS_FILTERS.map(([value, label]) => (
          <button key={value} type="button" className={statusFilter === value ? "chip active" : "chip"} onClick={() => setStatusFilter(value)}>{label}</button>
        ))}
        <span className="muted">Coverage:</span>
        {COVERAGE_FILTERS.map(([value, label]) => (
          <button key={value} type="button" className={coverageFilter === value ? "chip active" : "chip"} onClick={() => setCoverageFilter(value)}>{label}</button>
        ))}
        <span className="muted">Loại:</span>
        {TYPE_FILTERS.map(([value, label]) => (
          <button key={value} type="button" className={typeFilter === value ? "chip active" : "chip"} onClick={() => setTypeFilter(value)}>{label}</button>
        ))}
      </div>

      <div className="command-editor">
        <aside className="command-list">
          {visible.map((command) => {
            const entry = catalogByCommand.get(command.name);
            const coverage = entry?.coverage || "MISSING";
            return (
              <button
                key={command.name}
                type="button"
                className={command.name === selectedName ? "command-row active" : "command-row"}
                onClick={() => chooseCommand(command.name)}
              >
                <strong>{command.name}</strong>
                <small>{(command.alias || []).join(", ") || "Không alias"}</small>
                <span>
                  <span className={`coverage-dot ${coverage.toLowerCase()}`} /> {coverage} · {entry?.adapter || "no-adapter"} · {command.enabled ? "Enabled" : "Disabled"}
                  {command.override ? " · Override" : ""}
                </span>
              </button>
            );
          })}
          {!visible.length ? <p className="muted empty-state">Không có command phù hợp.</p> : null}
        </aside>

        <div className="workspace-card command-form">
          {selected ? (
            <>
              <div className="toolbar">
                <div>
                  <h3>{selected.name}</h3>
                  <p className="muted">
                    {catalogByCommand.get(selected.name)?.handlerRef?.module || "—"} · adapter {contract?.contract?.adapter || "…"}
                  </p>
                </div>
                <span className={selected.enabled ? "chip active" : "chip"}>{selected.enabled ? "Enabled" : "Disabled"}</span>
                <span className={selected.handlerAvailable === false ? "chip" : "chip active"}>
                  {selected.handlerAvailable === false ? "Handler missing" : "Handler ready"}
                </span>
                {selectedBot && selected.override ? <span className="chip">Override theo bot</span> : null}
              </div>

              <div className="detail-tabs" role="tablist">
                {workspaceTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={detailTab === tab.id}
                    className={detailTab === tab.id ? "detail-tab active" : "detail-tab"}
                    onClick={() => chooseTab(tab.id)}
                  >
                    {tab.title}
                  </button>
                ))}
              </div>

              <div className="tab-panel">
                {activeContractTab ? (
                  <div className={`schema-group schema-group-${activeContractTab.id}`}>
                    {activeContractTab.fields.length ? (
                      <div className="form-grid">
                        {activeContractTab.fields.map((field) => renderStudioField(field))}
                      </div>
                    ) : detailTab === "history" ? (
                      <div className="history-list">
                        {historyEntries.length === 0 ? <p className="muted">Chưa có lịch sử.</p> : historyEntries.map((entryItem, index) => (
                          <div className="history-row" key={index}>
                            <span>{new Date(entryItem.at).toLocaleString()}</span>
                            <span className="chip">{entryItem.action}</span>
                            <span>{entryItem.commandName || ""} {entryItem.revision ? `· rev ${entryItem.revision}` : ""} {entryItem.scope ? `· ${entryItem.scope}` : ""}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">Tab này không có trường cấu hình.</p>
                    )}
                    {schemaGroup && ["operation", "responses"].includes(detailTab) ? (
                      <SchemaGroup group={schemaGroup} values={draft.behavior || {}} onChange={updateBehavior} />
                    ) : null}
                  </div>
                ) : schemaGroup ? (
                  <>
                    {detailTab === "params" ? (
                      <p className="muted">Dùng {"{param:<key>}"} trong template phản hồi để đọc tham số đã cấu hình.</p>
                    ) : null}
                    <SchemaGroup group={schemaGroup} values={draft.behavior || {}} onChange={updateBehavior} />
                  </>
                ) : (
                  <p className="muted">Đang tải schema hành vi…</p>
                )}
              </div>

              <div className="toolbar editor-actions">
                <button onClick={save} disabled={!dirty || saving}>{saving ? "Đang lưu…" : "Lưu metadata & behavior"}</button>
                {selectedBot ? <button className="secondary" onClick={resetOverride}>Reset override</button> : null}
                {selectedBot ? <button className="secondary" onClick={copyFromAdmin}>Copy admin</button> : null}
                <button className="secondary" disabled={!selected} onClick={applyAll}>Áp dụng tất cả (apply-all)</button>
              </div>
            </>
          ) : (
            <p className="muted">Chưa có command phù hợp.</p>
          )}
        </div>
      </div>

      {diagnostics.length ? (
        <div className="diagnostics">
          {diagnostics.map((item, index) => <span key={`${item.type}-${index}`}>{item.type}: {item.value || item.command}</span>)}
        </div>
      ) : null}
    </section>
  );
}

function StudioTableField({ field, rows, onChange, panelRow, onPanelRow }) {
  const columns = field.columns || [];
  const editing = panelRow && panelRow.fieldKey === field.key ? panelRow.index : null;
  function updateRow(index, columnKey, cellValue) {
    const next = rows.map((row, i) => (i === index ? { ...row, [columnKey]: cellValue } : { ...row }));
    onChange(next);
  }
  function addRow() {
    const blank = {};
    for (const column of columns) blank[column.key] = column.type === "number" ? 60 : column.type === "boolean" ? true : "";
    onChange([...rows, blank]);
    onPanelRow({ fieldKey: field.key, index: rows.length });
  }
  function removeRow(index) {
    onChange(rows.filter((_, i) => i !== index));
    if (editing === index) onPanelRow(null);
  }
  return (
    <div className="field field-table wide" key={field.key}>
      <div className="field-head">
        <label>{field.label}</label>
        <button type="button" className="secondary" onClick={addRow}>+ Thêm dòng</button>
      </div>
      {field.description ? <small className="muted">{field.description}</small> : null}
      <div className="table-scroll">
        <table className="editable-table">
          <thead>
            <tr>
              {columns.map((column) => <th key={column.key}>{column.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className={editing === index ? "row-editing" : ""}>
                {columns.map((column) => (
                  <td key={column.key}>
                    {column.control === "select" ? (
                      <select value={String(row[column.key] ?? "")} onChange={(e) => updateRow(index, column.key, e.target.value)}>
                        {(column.options || []).map((option) => <option key={String(option)} value={String(option)}>{option === "" ? "(không)" : String(option)}</option>)}
                      </select>
                    ) : column.control === "checkbox" || column.type === "boolean" ? (
                      <input type="checkbox" checked={Boolean(row[column.key])} onChange={(e) => updateRow(index, column.key, e.target.checked)} />
                    ) : column.type === "number" ? (
                      <input type="number" value={Number(row[column.key] ?? 0)} onChange={(e) => updateRow(index, column.key, Number(e.target.value))} />
                    ) : column.key === "caption" || column.type === "text" ? (
                      <input value={String(row[column.key] ?? "")} onChange={(e) => updateRow(index, column.key, e.target.value)} />
                    ) : (
                      <input value={String(row[column.key] ?? "")} onChange={(e) => updateRow(index, column.key, e.target.value)} />
                    )}
                  </td>
                ))}
                <td>
                  <button type="button" className="link-button" onClick={() => onPanelRow(editing === index ? null : { fieldKey: field.key, index })}>Sửa</button>
                  <button type="button" className="link-button danger" onClick={() => removeRow(index)}>Xoá</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing !== null && rows[editing] ? (
        <div className="row-panel">
          <h5>Sửa bản ghi #{editing + 1}</h5>
          <div className="form-grid">
            {columns.filter((column) => column.type === "text" || column.key === "caption").map((column) => (
              <label key={column.key} className="wide">
                {column.label}
                <textarea rows={3} value={String(rows[editing][column.key] ?? "")} onChange={(e) => updateRow(editing, column.key, e.target.value)} />
              </label>
            ))}
          </div>
          <button type="button" className="secondary" onClick={() => onPanelRow(null)}>Đóng panel</button>
        </div>
      ) : null}
    </div>
  );
}
