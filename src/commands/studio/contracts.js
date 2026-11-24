import { commandRegistry, PHASE_1_COMMANDS, PHASE_2_COMMANDS, PHASE_3_COMMANDS, PHASE_4_COMMANDS, PHASE_5_COMMANDS, PHASE_6_COMMANDS, PHASE_7_COMMANDS, PHASE_8_COMMANDS, PHASE_9_COMMANDS, PHASE_10_COMMANDS, PHASE_11_COMMANDS } from "../command-registry.js";
import {
  STUDIO_CONTRACT_VERSION,
  validateStudioContract,
  commonTab,
} from "./contract-v2.js";
import {
  buildDefaultSendtaskSchedules,
  SENDTASK_RESPONSE_TEMPLATES,
  SENDTASK_RETRY,
  SENDTASK_TIMEZONE,
  SENDTASK_GIRL_CATEGORIES,
  SENDTASK_FALLBACK_KINDS,
} from "./sendtask-defaults.js";

const PHASE_BY_COMMAND = buildPhaseIndex();

function buildPhaseIndex() {
  const index = new Map();
  const phases = [
    [1, PHASE_1_COMMANDS], [2, PHASE_2_COMMANDS], [3, PHASE_3_COMMANDS],
    [4, PHASE_4_COMMANDS], [5, PHASE_5_COMMANDS], [6, PHASE_6_COMMANDS],
    [7, PHASE_7_COMMANDS], [8, PHASE_8_COMMANDS], [9, PHASE_9_COMMANDS],
    [10, PHASE_10_COMMANDS], [11, PHASE_11_COMMANDS],
  ];
  for (const [phase, names] of phases) {
    for (const name of names) if (!index.has(name)) index.set(name, phase);
  }
  return index;
}

const RESPONSE_TEMPLATES = [
  { key: "responses.templates.onSuccess", label: "Template thành công", type: "template", default: "", allowedScopes: ["global", "bot", "group"] },
  { key: "responses.templates.onCooldown", label: "Template cooldown", type: "template", default: "", allowedScopes: ["global", "bot", "group"] },
  { key: "responses.templates.onPermissionDenied", label: "Template thiếu quyền", type: "template", default: "", allowedScopes: ["global", "bot", "group"] },
  { key: "responses.templates.onScopeDenied", label: "Template sai phạm vi", type: "template", default: "", allowedScopes: ["global", "bot", "group"] },
  { key: "responses.templates.onError", label: "Template lỗi", type: "template", default: "", allowedScopes: ["global", "bot", "group"] },
  { key: "responses.templates.onKillSwitch", label: "Template kill switch", type: "template", default: "", allowedScopes: ["global", "bot", "group"] },
];

function readOnlyField(key, label, value, description = "") {
  return { key, label, type: "string", default: String(value ?? ""), allowedScopes: ["global"], readOnly: true, sensitive: false, apply: "config", description };
}

function secretFields(definition) {
  const fields = [];
  for (const entry of definition.requiredConfig || []) {
    const names = Array.isArray(entry) ? entry : [entry];
    names.forEach((envName, idx) => {
      fields.push({
        key: `secrets.${envName}`,
        label: `${envName}${names.length > 1 ? ` (phương án ${idx + 1})` : ""}`,
        type: "string",
        default: "",
        allowedScopes: ["global"],
        sensitive: true,
        apply: "config",
        description: `Biến môi trường ${envName} dùng bởi handler. Giá trị trống = dùng env hiện tại.`,
      });
    });
  }
  return fields;
}

export function buildGenericContract(definition, { phase } = {}) {
  const ref = definition.handler?.__handlerRef || { module: "unknown", export: null, dependencies: [], providers: [], flow: "" };
  return {
    version: STUDIO_CONTRACT_VERSION,
    commandName: definition.name,
    aliases: [...(definition.aliases || [])],
    permission: definition.permission,
    scope: definition.scope,
    countdown: definition.countdown,
    status: definition.active ? "active" : "inactive",
    phase: phase ?? PHASE_BY_COMMAND.get(definition.name) ?? null,
    risk: definition.risk,
    requiresDb: definition.requiresDb === true,
    adapter: "default-config",
    handlerRef: {
      module: ref.module,
      export: ref.export,
      source: ref.source || ref.module,
      dependencies: [...(ref.dependencies || []), ...(definition.requiredDependencies || [])],
      providers: [...(ref.providers || [])],
      flow: ref.flow || `Dispatch → lazy import ${ref.module}#${ref.export ?? "inline"} → api.sendMessage phản hồi vào thread.`,
    },
    tabs: [
      commonTab("overview", {
        title: "Tổng quan",
        fields: [
          readOnlyField("meta.description", "Mô tả", definition.description),
          readOnlyField("meta.type", "Kiểu lệnh (type)", definition.type),
          readOnlyField("meta.scope", "Phạm vi chat", definition.scope),
          readOnlyField("meta.active", "Đang bật trong registry", definition.active),
          readOnlyField("meta.phase", "Phase migrate", phase ?? PHASE_BY_COMMAND.get(definition.name) ?? null),
          readOnlyField("meta.risk", "Mức rủi ro", definition.risk),
          readOnlyField("meta.minArgs", "Số đối số tối thiểu", definition.minArgs),
          readOnlyField("meta.requiresDb", "Cần database", definition.requiresDb),
        ],
      }),
      commonTab("handler", {
        title: "Handler & luồng",
        fields: [
          readOnlyField("handler.module", "Module handler", ref.module),
          readOnlyField("handler.export", "Export handler", ref.export ?? "(inline)"),
          readOnlyField("handler.dependencies", "Dependency bắt buộc", (definition.requiredDependencies || []).join(", ") || "(không có ngoài zaloSession)"),
          readOnlyField("handler.providers", "Provider/API ngoài", (definition.requiredConfig || []).flat().join(", ") || "(không gọi provider cấu hình)"),
          readOnlyField("handler.flow", "Luồng xử lý", ref.flow || `Dispatch → lazy import ${ref.module}#${ref.export ?? "inline"} → api.sendMessage phản hồi vào thread.`),
        ],
      }),
      commonTab("operation", {
        title: "Vận hành",
        fields: [
          { key: "operation.enabled", label: "Bật lệnh", type: "boolean", default: true, allowedScopes: ["global", "bot", "group"], apply: "config", description: "Tắt sẽ chặn dispatch qua behavior gate (kill switch)." },
          { key: "operation.cooldownMode", label: "Chế độ cooldown", type: "select", options: ["perUser", "perThread", "global"], default: null, nullable: true, allowedScopes: ["global", "bot"], apply: "config", description: "null = giữ cooldown mặc định theo countdown của lệnh." },
          { key: "operation.cooldownSeconds", label: "Cooldown (giây)", type: "number", min: 0, max: 86400, default: null, nullable: true, allowedScopes: ["global", "bot"], apply: "config", description: "null = giữ countdown mặc định." },
          { key: "operation.maxUsesPerHour", label: "Giới hạn lượt/giờ", type: "number", min: 0, max: 100000, default: null, nullable: true, allowedScopes: ["global", "bot"], apply: "config" },
          ...(definition.requiredDependencies.includes("ffmpeg") ? [{ key: "operation.requireFfmpeg", label: "Yêu cầu ffmpeg", type: "boolean", default: true, allowedScopes: ["global"], apply: "config", description: "Ngoại lệ read-only: ffmpeg bắt buộc từ registry, không thể tắt khi chạy.", readOnly: true }] : []),
        ],
      }),
      commonTab("responses", {
        title: "Phản hồi",
        fields: [
          { key: "responses.useCustomTemplates", label: "Dùng template riêng", type: "boolean", default: false, allowedScopes: ["global", "bot", "group"], apply: "config" },
          ...RESPONSE_TEMPLATES.map((field) => ({ ...field })),
        ],
      }),
      commonTab("permissions", {
        title: "Quyền & giới hạn",
        fields: [
          { key: "restrictions.mode", label: "Chế độ giới hạn", type: "select", options: ["all", "whitelist", "blacklist"], default: "all", allowedScopes: ["global", "bot", "group"], apply: "config" },
          { key: "restrictions.allowedThreads", label: "Thread trong whitelist", type: "table", default: [], allowedScopes: ["global", "bot", "group"], apply: "config", columns: [{ key: "threadId", label: "ThreadId", type: "string" }] },
          { key: "restrictions.blockedThreads", label: "Thread bị chặn", type: "table", default: [], allowedScopes: ["global", "bot", "group"], apply: "config", columns: [{ key: "threadId", label: "ThreadId", type: "string" }] },
          { key: "restrictions.allowedUsers", label: "User trong whitelist", type: "table", default: [], allowedScopes: ["global", "bot", "group"], apply: "config", columns: [{ key: "userId", label: "UserId", type: "string" }] },
          readOnlyField("permissions.registryPermission", "Quyền mặc định registry", definition.permission, "Ngoại lệ read-only: quyền gốc khai báo trong registry, đổi tại source code."),
          readOnlyField("permissions.countdown", "Countdown mặc định", definition.countdown),
        ],
      }),
      commonTab("secrets", { title: "Secrets", fields: secretFields(definition) }),
      commonTab("history", { title: "Lịch sử", fields: [] }),
    ],
  };
}

export function buildSendtaskContract(definition, options = {}) {
  const base = buildGenericContract(definition, options);
  const scheduleColumns = [
    { key: "id", label: "Mã lịch", type: "string" },
    { key: "enabled", label: "Bật", type: "boolean", control: "checkbox" },
    { key: "cron", label: "Cron", type: "string" },
    { key: "timezone", label: "Múi giờ", type: "string" },
    { key: "kind", label: "Nguồn", type: "select", control: "select", options: ["girl-video", "tiktok-search", "zing-chart"] },
    { key: "category", label: "Danh mục girl", type: "select", control: "select", options: ["", ...SENDTASK_GIRL_CATEGORIES] },
    { key: "queryTemplate", label: "Query TikTok", type: "string" },
    { key: "fallbackKind", label: "Nguồn dự phòng", type: "select", control: "select", options: ["", ...SENDTASK_FALLBACK_KINDS], description: "Dùng khi nguồn chính lỗi hoặc rỗng trước khi gửi. Để trống = không fallback." },
    { key: "fallbackCategory", label: "Danh mục dự phòng", type: "select", control: "select", options: ["", ...SENDTASK_GIRL_CATEGORIES] },
    { key: "caption", label: "Caption", type: "text" },
    { key: "ttlMinutes", label: "TTL (phút)", type: "number" },
  ];
  base.adapter = "sendtask-scheduler";
  base.tabs.splice(
    2,
    0,
    {
      id: "schedules",
      title: "Lịch gửi",
      fields: [
        { key: "schedules.enabled", label: "Bật scheduler", type: "boolean", default: true, allowedScopes: ["global", "bot"], apply: "scheduler" },
        { key: "schedules.timezone", label: "Múi giờ mặc định", type: "string", default: SENDTASK_TIMEZONE, allowedScopes: ["global", "bot"], apply: "scheduler" },
        { key: "schedules.items", label: "24 lịch gửi theo giờ", type: "table", default: buildDefaultSendtaskSchedules(), allowedScopes: ["global", "bot"], apply: "scheduler", columns: scheduleColumns, itemPanel: true, description: "Mỗi bản ghi một lịch giờ. Apply sẽ diff và chỉ reschedule job thay đổi." },
      ],
    },
    {
      id: "sources",
      title: "Nguồn",
      fields: [
        readOnlyField("sources.girlVideo", "Flow 1: Girl video", `Category: ${SENDTASK_GIRL_CATEGORIES.join(" / ")}`, "sendRandomGirlVideo(api, message, caption, category, ttl)."),
        readOnlyField("sources.tiktokSearch", "Flow 2: TikTok search", "Query template, {{timestamp}} để chống cache", "searchVideoTiktok(query) → sendTikTokMedia."),
        readOnlyField("sources.zingChart", "Flow 3: Zing chart music", "Bài hát ngẫu nhiên từ bảng xếp hạng Zing", "handleRandomChartZingMp3(api, message, caption, ttl)."),
        { key: "sources.tiktokQueryFallback", label: "Query TikTok dự phòng", type: "template", default: "nhạc chill cảnh đẹp {{timestamp}}", allowedScopes: ["global", "bot"], apply: "scheduler", description: "Dùng khi queryTemplate của bản ghi trống." },
      ],
    },
  );
  const operationTab = base.tabs.find((tab) => tab.id === "operation");
  operationTab.fields.push(
    { key: "operation.retry.maxRetries", label: "Số lần retry", type: "number", min: 0, max: 5, default: SENDTASK_RETRY.maxRetries, allowedScopes: ["global", "bot"], apply: "scheduler" },
    { key: "operation.retry.backoffMs", label: "Backoff giữa retry (ms)", type: "number", min: 0, max: 30000, default: SENDTASK_RETRY.backoffMs, allowedScopes: ["global", "bot"], apply: "scheduler" },
    { key: "operation.retry.disableOnMissingGroup", label: "Tắt nhóm khi không tồn tại", type: "boolean", default: SENDTASK_RETRY.disableOnMissingGroup, allowedScopes: ["global", "bot", "group"], apply: "scheduler", description: "Khi gửi lỗi 'Không tồn tại', tự tắt sendTask cho nhóm đó." },
  );
  const responsesTab = base.tabs.find((tab) => tab.id === "responses");
  responsesTab.fields.push(
    { key: "responses.messages.on", label: "Phản hồi khi bật", type: "template", default: SENDTASK_RESPONSE_TEMPLATES.on, allowedScopes: ["global", "bot", "group"], apply: "config" },
    { key: "responses.messages.off", label: "Phản hồi khi tắt", type: "template", default: SENDTASK_RESPONSE_TEMPLATES.off, allowedScopes: ["global", "bot", "group"], apply: "config" },
    { key: "responses.messages.toggle", label: "Phản hồi khi toggle ({state})", type: "template", default: SENDTASK_RESPONSE_TEMPLATES.toggle, allowedScopes: ["global", "bot", "group"], apply: "config" },
  );
  return base;
}

const SPECIAL_CONTRACT_BUILDERS = new Map([
  ["sendtask", buildSendtaskContract],
]);

let catalogCache = null;

export function getStudioContractCatalog({ registry = commandRegistry } = {}) {
  if (catalogCache && catalogCache.registry === registry) return catalogCache;
  const contracts = [];
  const errors = [];
  for (const definition of registry.definitions) {
    const builder = SPECIAL_CONTRACT_BUILDERS.get(definition.name) || buildGenericContract;
    let contract;
    try {
      contract = builder(definition);
    } catch (error) {
      errors.push({ commandName: definition.name, message: error.message });
      continue;
    }
    contracts.push(contract);
  }
  catalogCache = Object.freeze({
    registry,
    contracts: Object.freeze(contracts),
    errors: Object.freeze(errors),
    byName: new Map(contracts.map((contract) => [contract.commandName, contract])),
    builtAt: new Date().toISOString(),
  });
  return catalogCache;
}

export function getCommandStudioContract(commandName, { registry = commandRegistry } = {}) {
  return getStudioContractCatalog({ registry }).byName.get(String(commandName || "").toLowerCase()) || null;
}

export function invalidateContractCatalog() {
  catalogCache = null;
}

export function buildCoverageMatrix({ registry = commandRegistry, catalog = getStudioContractCatalog({ registry }) } = {}) {
  const rows = [];
  const registryNames = new Set(registry.definitions.map((d) => d.name));
  for (const definition of registry.definitions) {
    const contract = catalog.byName.get(definition.name);
    let coverage = "MISSING";
    const reasons = [];
    if (!contract) {
      reasons.push("No studio contract");
    } else {
      const validation = validateStudioContract(contract);
      if (!validation.ok) {
        coverage = "PARTIAL";
        reasons.push(...validation.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`));
      } else if (!contract.handlerRef || !contract.handlerRef.module || contract.handlerRef.module === "unknown") {
        coverage = "PARTIAL";
        reasons.push("handlerRef missing");
      } else {
        coverage = "FULL";
      }
    }
    rows.push({
      commandName: definition.name,
      phase: contract?.phase ?? PHASE_BY_COMMAND.get(definition.name) ?? null,
      aliases: [...(definition.aliases || [])],
      adapter: contract?.adapter || null,
      coverage,
      reasons,
      active: definition.active,
      hasDefaults: Boolean(contract),
    });
  }
  for (const contract of catalog.contracts) {
    if (!registryNames.has(contract.commandName)) {
      rows.push({ commandName: contract.commandName, phase: contract.phase, aliases: contract.aliases, adapter: contract.adapter, coverage: "PARTIAL", reasons: ["Contract without registry definition"], active: false, hasDefaults: true });
    }
  }
  const summary = {
    totalRegistry: registry.definitions.length,
    totalContracts: catalog.contracts.length,
    full: rows.filter((r) => r.coverage === "FULL").length,
    partial: rows.filter((r) => r.coverage === "PARTIAL").length,
    missing: rows.filter((r) => r.coverage === "MISSING").length,
  };
  summary.complete = summary.full === summary.totalRegistry && summary.totalRegistry === summary.totalContracts;
  return { summary, rows };
}
