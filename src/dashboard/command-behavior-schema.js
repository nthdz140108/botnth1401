export const BEHAVIOR_VERSION = 1;

export const RESPONSE_TEMPLATE_VARIABLES = Object.freeze([
  "{prefix}", "{command}", "{user}", "{userId}", "{thread}", "{remaining}", "{reason}",
]);

const TABLE_PARAM_COLUMNS = [
  { key: "key", label: "Tên tham số", type: "text" },
  { key: "type", label: "Kiểu", type: "select", control: "select", options: ["number", "string", "boolean", "select"] },
  { key: "value", label: "Giá trị", type: "text" },
  { key: "defaultValue", label: "Mặc định", type: "text" },
  { key: "min", label: "Min", type: "number" },
  { key: "max", label: "Max", type: "number" },
  { key: "options", label: "Lựa chọn (phân cách bởi dấu phẩy)", type: "text" },
  { key: "description", label: "Mô tả", type: "text" },
];

export const COMMAND_BEHAVIOR_SCHEMA = Object.freeze({
  version: BEHAVIOR_VERSION,
  groups: [
    {
      id: "operation",
      label: "Vận hành",
      fields: [
        { key: "operation.cooldownMode", type: "select", label: "Chế độ cooldown", options: ["perUser", "perThread", "global"], default: "perUser", help: "perUser: đếm riêng từng người · perThread: theo nhóm/hội thoại · global: chung toàn bot" },
        { key: "operation.cooldownOverride", type: "number", label: "Cooldown override (giây)", min: 0, nullable: true, default: null, help: "Để trống để dùng countdown gốc của lệnh" },
        { key: "operation.maxUsesPerHour", type: "number", label: "Giới hạn lượt/giờ", min: 0, max: 10000, default: 0, help: "0 = không giới hạn" },
        { key: "operation.timeoutMs", type: "number", label: "Timeout xử lý (ms)", min: 1000, max: 600000, default: 30000 },
        { key: "operation.killSwitch", type: "boolean", label: "Kill switch (vô hiệu hoá khẩn)", default: false },
        { key: "operation.dryRunRequired", type: "boolean", label: "Bắt buộc dry-run trước", default: false },
        { key: "operation.logLevel", type: "select", label: "Mức log runtime", options: ["debug", "info", "warn", "error", "silent"], default: "info" },
        { key: "operation.scheduleWindows", type: "table", label: "Khung giờ hoạt động", default: [], columns: [
          { key: "days", label: "Thứ (vd: 1-5 hoặc 0,6)", type: "text" },
          { key: "from", label: "Từ (HH:mm)", type: "text" },
          { key: "to", label: "Đến (HH:mm)", type: "text" },
        ], help: "Trống = luôn hoạt động" },
      ],
    },
    {
      id: "responses",
      label: "Phản hồi",
      fields: [
        { key: "responses.useCustomTemplates", type: "boolean", label: "Dùng template tuỳ chỉnh", default: false },
        { key: "responses.templates.onSuccess", type: "template", label: "Khi thành công", default: "" },
        { key: "responses.templates.onCooldown", type: "template", label: "Khi dính cooldown", default: "" },
        { key: "responses.templates.onPermissionDenied", type: "template", label: "Khi thiếu quyền", default: "" },
        { key: "responses.templates.onScopeDenied", type: "template", label: "Khi sai phạm vi chat", default: "" },
        { key: "responses.templates.onError", type: "template", label: "Khi lỗi", default: "" },
        { key: "responses.reactionOnReceive", type: "emoji", label: "Reaction khi nhận lệnh", default: "" },
        { key: "responses.reactionOnSuccess", type: "emoji", label: "Reaction khi hoàn tất", default: "" },
      ],
    },
    {
      id: "params",
      label: "Thông số lệnh",
      fields: [
        { key: "params.items", type: "table", label: "Bảng tham số", default: [], columns: TABLE_PARAM_COLUMNS,
          help: "Runtime đọc qua {param:<key>} trong template và context.params trong handler" },
      ],
    },
    {
      id: "restrictions",
      label: "Giới hạn",
      fields: [
        { key: "restrictions.mode", type: "select", label: "Chế độ giới hạn thread", options: ["all", "whitelist", "blacklist"], default: "all" },
        { key: "restrictions.allowedThreads", type: "table", label: "Whitelist thread", default: [], columns: [{ key: "threadId", label: "Thread ID", type: "text" }] },
        { key: "restrictions.blockedThreads", type: "table", label: "Blacklist thread", default: [], columns: [{ key: "threadId", label: "Thread ID", type: "text" }] },
        { key: "restrictions.allowedUsers", type: "table", label: "Cho phép user", default: [], columns: [{ key: "userId", label: "User ID", type: "text" }] },
      ],
    },
  ],
});

export function findSchemaField(path) {
  for (const group of COMMAND_BEHAVIOR_SCHEMA.groups) {
    const field = group.fields.find((item) => item.key === path);
    if (field) return field;
  }
  return null;
}

function buildDefaults() {
  const profile = { version: BEHAVIOR_VERSION };
  for (const group of COMMAND_BEHAVIOR_SCHEMA.groups) {
    for (const field of group.fields) {
      const [section, rest] = splitKey(field.key);
      profile[section] = profile[section] || {};
      applyField(profile[section], section === "params" || section === "restrictions" ? rest : rest, field);
    }
  }
  return profile;
}

function splitKey(key) {
  const parts = String(key).split(".");
  return [parts[0], parts.slice(1)];
}

function applyField(section, pathParts, field) {
  if (pathParts.length === 1) {
    section[pathParts[0]] = deepCloneDefault(field.default);
    return;
  }
  section[pathParts[0]] = section[pathParts[0]] || {};
  applyField(section[pathParts[0]], pathParts.slice(1), field);
}

function deepCloneDefault(value) {
  if (Array.isArray(value)) return value.map((item) => ({ ...item }));
  return value;
}

export function defaultBehaviorProfile() {
  return buildDefaults();
}
