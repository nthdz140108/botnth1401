# Command Studio Max — Nâng cấp toàn diện tab Command + Tối ưu FE/BE

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây "Command Studio" mức tối đa cho tab Command của dashboard: tùy chỉnh sâu mọi lệnh hiện có (cách vận hành, phản hồi, thông số) bằng form sinh tự động từ schema — enum dùng select, danh sách/thông số dùng bảng — kèm hot-reload vào bot mà không cần restart.

**Architecture:** Thêm lớp "Behavior Profile" (schema-driven) nằm trong `assets/json-data/command.json` (global) và `mybot/command-overrides/<botId>.json` (override theo bot). Backend: 3 module mới (schema, template-renderer, store) + endpoint mới trong `api-routes.js`. Runtime bot đọc profile qua `command-policy-loader.js`, thi hành qua module thuần `command-behavior-runtime.js` được wire vào `command.js` tại đúng 3 điểm (cooldown, gate trước dispatch, message kết quả). Frontend: thay thế `command-workspace.jsx` bằng Command Studio gồm FieldRenderer sinh từ schema + tabs (Tổng quan / Vận hành / Phản hồi / Tham số / Giới hạn) + preview trực tiếp.

**Tech Stack:** Node.js ESM, Express, node:test (repo chạy `node --test --test-force-exit --test-concurrency=1 tests`), React 19 + Vite (dashboard/), Socket.IO. Không thêm dependency mới.

**Spec:** Không có spec riêng — plan này tự chứa thiết kế. Bối cảnh kiến trúc: `AGENTS.md`, review ngày 2026-08-23 (đã xác định: server.js wiring trùng lặp, credential hardcode, main.jsx god-component).

## Global Constraints

- Node ESM (`"type": "module"` ở root và `dashboard/`). Test backend viết ESM `.js`; test UI làm smoke-test đọc source bằng `.cjs` (theo mẫu `tests/dashboard-command-scope-ui.test.cjs`).
- KHÔNG thêm npm dependency mới.
- Mọi ghi file JSON phải đi qua `ConfigStore.writeJson` (tự backup vào `logs/dashboard-backups`) và append audit log.
- Giữ nguyên 100% hành vi hiện có khi behavior profile KHÔNG tồn tại (backward compatible tuyệt đối).
- Template variable chuẩn: `{prefix}`, `{command}`, `{user}`, `{userId}`, `{thread}`, `{remaining}`, `{reason}` — biến lạ giữ nguyên văn.
- Route mới đăng ký TRƯỚC route generic `PUT /api/commands/:commandName` không bắt buộc (path shape khác nhau), nhưng phải nằm sau middleware auth+CSRF hiện có.
- Commit sau mỗi task, message dạng `feat(command): ...` / `refactor(server): ...`.
- Chạy test từng task: `node --test tests/<file>.test.js`. Toàn bộ: `npm test`.

## File Structure

```text
src/dashboard/
├── command-behavior-schema.js      # [MỚI] Schema metadata + defaultBehaviorProfile()
├── command-response-template.js    # [MỚI] renderTemplate() thuần
├── command-behavior-store.js       # [MỚI] BehaviorStore: validate/read/write/reset/effective
├── api-routes.js                   # [SỬA] +7 endpoint
src/commands/
├── command-behavior-runtime.js     # [MỚI] isWithinSchedule, evaluateRestrictions,
│                                   #        resolveCooldownSeconds, checkHourlyLimit
├── command-policy-loader.js        # [SỬA] resolveRuntimeCommandPolicy trả kèm behavior merged
├── command.js                      # [SỬA] wire 3 điểm (countdown/gate/sendPhase1Result)
dashboard/src/
├── app/command-schema.js           # [MỚI] fetch + cache behavior schema
├── components/fields.jsx           # [MỚI] SelectField, NumberField, ToggleField, TextField,
│                                   #        TemplateField, TableField, EmojiField
├── components/command-workspace.jsx# [MỚI lại] CommandStudio 5 tabs
tests/
├── command-behavior-schema.test.js         # [MỚI]
├── command-response-template.test.js       # [MỚI]
├── command-behavior-store.test.js          # [MỚI]
├── dashboard-behavior-api.test.js          # [MỚI]
├── command-behavior-runtime.test.js        # [MỚI]
├── command-policy-loader-behavior.test.js  # [MỚI]
├── command-runtime-wiring.test.js          # [MỚI] (smoke: command.js dùng các hàm mới)
├── command-studio-ui.test.cjs              # [MỚI] (smoke regex như test UI cũ)
```

---

### Task 1: Schema metadata cho Behavior Profile

**Files:**
- Create: `src/dashboard/command-behavior-schema.js`
- Test: `tests/command-behavior-schema.test.js`

**Interfaces:**
- Produces: `BEHAVIOR_VERSION = 1`; `COMMAND_BEHAVOR_SCHEMA` (đổi tên nếu muốn nhất quán — dùng `COMMAND_BEHAVIOR_SCHEMA`); `defaultBehaviorProfile()` trả object mới mỗi lần gọi; `RESPONSE_TEMPLATE_VARIABLES` (mảng string); field type hợp lệ: `"select" | "number" | "boolean" | "text" | "template" | "emoji" | "table"`; table field có `columns: [{ key, label, type }]`.

- [ ] **Step 1: Viết test thất bại**

```js
// tests/command-behavior-schema.test.js
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_BEHAVIOR_SCHEMA,
  defaultBehaviorProfile,
  RESPONSE_TEMPLATE_VARIABLES,
} from "../src/dashboard/command-behavior-schema.js";

const FIELD_TYPES = new Set(["select", "number", "boolean", "text", "template", "emoji", "table"]);

function collectFields(schema) {
  return schema.groups.flatMap((group) => group.fields);
}

test("schema exposes groups operation/responses/params/restrictions", () => {
  const ids = COMMAND_BEHAVIOR_SCHEMA.groups.map((g) => g.id);
  assert.deepEqual(ids, ["operation", "responses", "params", "restrictions"]);
});

test("every field has valid type, key, label, default-compatible shape", () => {
  for (const field of collectFields(COMMAND_BEHAVIOR_SCHEMA)) {
    assert.ok(field.key, "field.key required");
    assert.ok(field.label, "field.label required");
    assert.ok(FIELD_TYPES.has(field.type), `invalid type ${field.type} for ${field.key}`);
    if (field.type === "select") assert.ok(Array.isArray(field.options) && field.options.length > 0);
    if (field.type === "table") {
      assert.ok(Array.isArray(field.columns) && field.columns.every((c) => c.key && c.label));
    }
  }
});

test("enum fields use select type (cooldownMode, logLevel, restriction mode)", () => {
  const fields = Object.fromEntries(collectFields(COMMAND_BEHAVIOR_SCHEMA).map((f) => [f.key, f]));
  assert.equal(fields["operation.cooldownMode"].type, "select");
  assert.deepEqual(fields["operation.cooldownMode"].options, ["perUser", "perThread", "global"]);
  assert.equal(fields["operation.logLevel"].options.includes("info"), true);
  assert.equal(fields["restrictions.mode"].options, undefined === null ? null : fields["restrictions.mode"].options);
  assert.deepEqual(fields["restrictions.mode"].options, ["all", "whitelist", "blacklist"]);
});

test("params group declares a dynamic table field with typed columns", () => {
  const paramsField = collectFields(COMMAND_BEHAVIOR_SCHEMA).find((f) => f.key === "params.items");
  assert.equal(paramsField.type, "table");
  const colKeys = paramsField.columns.map((c) => c.key);
  for (const expected of ["key", "type", "value", "defaultValue", "min", "max", "options", "description"]) {
    assert.ok(colKeys.includes(expected), `missing column ${expected}`);
  }
  assert.equal(paramsField.columns.find((c) => c.key === "type").control, "select");
});

test("defaultBehaviorProfile returns fresh deep defaults matching schema", () => {
  const a = defaultBehaviorProfile();
  const b = defaultBehaviorProfile();
  assert.notEqual(a, b);
  assert.notEqual(a.operation, b.operation);
  assert.equal(a.version, 1);
  assert.equal(a.operation.cooldownMode, "perUser");
  assert.equal(a.operation.killSwitch, false);
  assert.equal(a.responses.useCustomTemplates, false);
  assert.deepEqual(a.params.items, []);
  assert.equal(a.restrictions.mode, "all");
  for (const v of RESPONSE_TEMPLATE_VARIABLES) {
    assert.match(v, /^\{[a-zA-Z]+\}$/);
  }
});
```

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/command-behavior-schema.test.js`
Expected: FAIL — Cannot find module `../src/dashboard/command-behavior-schema.js`

- [ ] **Step 3: Cài đặt module**

```js
// src/dashboard/command-behavior-schema.js
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
```

- [ ] **Step 4: Chạy test xác nhận pass**

Run: `node --test tests/command-behavior-schema.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/command-behavior-schema.js tests/command-behavior-schema.test.js
git commit -m "feat(command): add behavior profile schema metadata"
```

---

### Task 2: Template renderer (thuần, dùng chung runtime + preview API)

**Files:**
- Create: `src/dashboard/command-response-template.js`
- Test: `tests/command-response-template.test.js`

**Interfaces:**
- Consumes: nothing (thuần).
- Produces: `renderTemplate(template, vars)` → string; biến hỗ trợ `{prefix},{command},{user},{userId},{thread},{remaining},{reason}` và `{param:key}`; biến không có giá trị → chuỗi rỗng; biến lạ → giữ nguyên; template rỗng/không phải string → trả `null` để caller biết fallback về message mặc định.

- [ ] **Step 1: Viết test thất bại**

```js
// tests/command-response-template.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate } from "../src/dashboard/command-response-template.js";

test("replaces known variables", () => {
  const out = renderTemplate("Hey {user}, lệnh {prefix}{command} còn {remaining}s!", {
    prefix: "!", command: "help", user: "Nam", remaining: 42,
  });
  assert.equal(out, "Hey Nam, lệnh !help còn 42s!");
});

test("renders param values via {param:key}", () => {
  const out = renderTemplate("Giới hạn hiện tại: {param:limit}", {
    params: { limit: 10 },
  });
  assert.equal(out, "Giới hạn hiện tại: 10");
});

test("unknown variables are preserved verbatim", () => {
  assert.equal(renderTemplate("{khongton tai} {reason}", { reason: "x" }), "{khongton tai} x");
});

test("missing known variables become empty string", () => {
  assert.equal(renderTemplate("a{user}b", {}), "ab");
});

test("empty or non-string template yields null so caller falls back", () => {
  assert.equal(renderTemplate("", {}), null);
  assert.equal(renderTemplate(null, {}), null);
  assert.equal(renderTemplate(123, {}), null);
});

test("non-string values are coerced to string", () => {
  assert.equal(renderTemplate("{remaining}s", { remaining: 5 }), "5s");
  assert.equal(renderTemplate("{param:flag}", { params: { flag: true } }), "true");
});
```

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/command-response-template.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Cài đặt**

```js
// src/dashboard/command-response-template.js
const KNOWN_VARS = new Set(["prefix", "command", "user", "userId", "thread", "remaining", "reason"]);

export function renderTemplate(template, vars = {}) {
  if (typeof template !== "string" || template.trim() === "") return null;
  return template.replace(/\{([a-zA-Z]+)(?::([a-zA-Z0-9_-]+))?\}/g, (match, name, paramKey) => {
    if (name === "param") {
      if (!paramKey) return "";
      const value = vars.params?.[paramKey];
      return value === undefined || value === null ? "" : String(value);
    }
    if (!KNOWN_VARS.has(name)) return match;
    const value = vars[name];
    return value === undefined || value === null ? "" : String(value);
  });
}
```

- [ ] **Step 4: Chạy test xác nhận pass**

Run: `node --test tests/command-response-template.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/command-response-template.js tests/command-response-template.test.js
git commit -m "feat(command): add response template renderer"
```

---

### Task 3: BehaviorStore — validate, merge, read/write có backup + audit-ready

**Files:**
- Create: `src/dashboard/command-behavior-store.js`
- Test: `tests/command-behavior-store.test.js`

**Interfaces:**
- Consumes: `defaultBehaviorProfile`, `findSchemaField` (Task 1); `ConfigStore` (`writeJson(file, value)` → `{ backup }`, đã có backup/atomic).
- Produces: `validateBehaviorProfile(profile)` → `{ ok, errors: [{path, message}], normalized }`; `class BehaviorStore` với methods:
  - `async getGlobal(commandName)` → profile|null (đọc `assets/json-data/command.json`)
  - `async setGlobal(commandName, profile)` → `{ value, backup }`
  - `async resetGlobal(commandName)` → `{ value }` (xoá key behavior)
  - `async getForBot(botId, commandName)` → `{ override: profile|null }` (từ `mybot/command-overrides/<botId>.json`)
  - `async setForBot(botId, commandName, profile)` → `{ value, backup }`
  - `async resetForBot(botId, commandName)` → `{ value }`
  - `effective(globalProfile, overrideProfile)` (static) → deep merge, override thắng từng lá.

Validation rules theo field type: `select` ∈ options; `number` nguyên trong [min,max], `nullable:true` cho phép null; `boolean` boolean; `text/template/emoji` string; `table` mảng object đủ column key (column number phải là số nếu có); `params.items[].key` non-empty unique; `params.items[].type` ∈ 4 giá trị; nếu `type=select` thì `options` non-empty. Key lạ → lỗi `UNKNOWN_FIELD`. `version` phải === 1.

- [ ] **Step 1: Viết test thất bại**

```js
// tests/command-behavior-store.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BehaviorStore, validateBehaviorProfile } from "../src/dashboard/command-behavior-store.js";
import { defaultBehaviorProfile } from "../src/dashboard/command-behavior-schema.js";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-store-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot", "command-overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    prefix: "!",
    commands: [{ name: "help", permission: "all", active: true }, { name: "kick", permission: "adminBox", active: true }],
  }));
  return root;
}

test("valid profile passes and unknown field rejected", () => {
  const profile = defaultBehaviorProfile();
  profile.operation.cooldownMode = "perThread";
  const result = validateBehaviorProfile(profile);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.operation.cooldownMode, "perThread");

  const bad = validateBehaviorProfile({ ...profile, whatIsThis: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path === "whatIsThis"));
});

test("select/number/boolean rules enforced", () => {
  const p1 = defaultBehaviorProfile();
  p1.operation.cooldownMode = "nonsense";
  assert.equal(validateBehaviorProfile(p1).ok, false);

  const p2 = defaultBehaviorProfile();
  p2.operation.timeoutMs = 10; // dưới min 1000
  assert.equal(validateBehaviorProfile(p2).ok, false);

  const p3 = defaultBehaviorProfile();
  p3.operation.cooldownOverride = null; // nullable OK
  assert.equal(validateBehaviorProfile(p3).ok, true);

  const p4 = defaultBehaviorProfile();
  p4.operation.killSwitch = "yes";
  assert.equal(validateBehaviorProfile(p4).ok, false);
});

test("params items require unique non-empty keys and typed rows", () => {
  const ok = defaultBehaviorProfile();
  ok.params.items = [{ key: "limit", type: "number", value: 10, defaultValue: 5 }];
  assert.equal(validateBehaviorProfile(ok).ok, true);

  const dup = defaultBehaviorProfile();
  dup.params.items = [{ key: "a", type: "number" }, { key: "a", type: "string" }];
  assert.equal(validateBehaviorProfile(dup).ok, false);

  const empty = defaultBehaviorProfile();
  empty.params.items = [{ key: "", type: "number" }];
  assert.equal(validateBehaviorProfile(empty).ok, false);
});

test("effective() merges override over global leaf-wise", () => {
  const globalP = defaultBehaviorProfile();
  globalP.operation.cooldownMode = "perUser";
  globalP.operation.maxUsesPerHour = 5;
  const overrideP = { operation: { maxUsesPerHour: 20 } };
  const merged = BehaviorStore.effective(globalP, overrideP);
  assert.equal(merged.operation.cooldownMode, "perUser");
  assert.equal(merged.operation.maxUsesPerHour, 20);
});

test("setGlobal writes behavior into command entry with backup; reset removes it", async () => {
  const root = tmpRoot();
  const store = new BehaviorStore({ root });
  const profile = defaultBehaviorProfile();
  profile.responses.reactionOnReceive = "👀";
  const result = await store.setGlobal("help", profile);
  assert.ok(result.backup);
  const raw = JSON.parse(fs.readFileSync(path.join(root, "assets/json-data/command.json"), "utf8"));
  assert.equal(raw.commands.find((c) => c.name === "help").behavior.responses.reactionOnReceive, "👀");

  await store.resetGlobal("help");
  const after = JSON.parse(fs.readFileSync(path.join(root, "assets/json-data/command.json"), "utf8"));
  assert.equal(after.commands.find((c) => c.name === "help").behavior, undefined);
});

test("setForBot writes override file; unknown command rejected with 404-style error", async () => {
  const root = tmpRoot();
  const store = new BehaviorStore({ root });
  await assert.rejects(() => store.setGlobal("ghost", defaultBehaviorProfile()), /COMMAND_NOT_FOUND/);

  const profile = defaultBehaviorProfile();
  profile.operation.killSwitch = true;
  await store.setForBot("bot01", "kick", profile);
  const overrides = JSON.parse(fs.readFileSync(path.join(root, "mybot/command-overrides/bot01.json"), "utf8"));
  assert.equal(overrides.kick.behavior.operation.killSwitch, true);
  assert.deepEqual(await store.getForBot("bot01", "kick"), { override: profile });
  assert.deepEqual(await store.getForBot("bot404", "kick"), { override: null });
});
```

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/command-behavior-store.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Cài đặt**

```js
// src/dashboard/command-behavior-store.js
import fs from "node:fs/promises";
import path from "node:path";
import { COMMAND_BEHAVIOR_SCHEMA, defaultBehaviorProfile, findSchemaField } from "./command-behavior-schema.js";
import { ConfigStore } from "./config-store.js";

const SELECT_TYPES_FOR_PARAMS = new Set(["number", "string", "boolean", "select"]);

export function validateBehaviorProfile(input) {
  const errors = [];
  const normalized = defaultBehaviorProfile();

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", message: "Behavior profile must be an object" }], normalized: null };
  }
  if (input.version !== undefined && input.version !== 1) {
    errors.push({ path: "version", message: "Unsupported behavior version" });
  }

  for (const group of COMMAND_BEHAVIOR_SCHEMA.groups) {
    for (const field of group.fields) {
      const provided = getPathValue(input, field.key);
      if (provided === undefined) continue;
      const error = validateFieldValue(field, provided);
      if (error) errors.push({ path: field.key, message: error });
      else setPathValue(normalized, field.key, clone(provided));
    }
  }
  for (const key of Object.keys(input)) {
    if (key !== "version" && !COMMAND_BEHAVIOR_SCHEMA.groups.some((group) => group.fields.some((field) => field.key.startsWith(`${key}.`)))) {
      errors.push({ path: key, message: "Unknown field" });
    }
  }

  const paramKeys = new Set((normalized.params?.items || []).map((item) => String(item.key || "").trim().toLowerCase()));
  if ((normalized.params?.items || []).length !== paramKeys.size) {
    errors.push({ path: "params.items", message: "Parameter keys must be unique" });
  }
  return errors.length ? { ok: false, errors, normalized: null } : { ok: true, errors: [], normalized };
}

function getPathValue(source, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), source);
}

function setPathValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let cursor = target;
  while (parts.length > 1) {
    cursor = cursor[parts.shift()] ||= {};
  }
  cursor[parts[0]] = value;
}

function validateFieldValue(field, value) {
  switch (field.type) {
    case "select":
      if (!field.options.includes(value)) return `Must be one of: ${field.options.join(", ")}`;
      return null;
    case "number": {
      if (value === null) return field.nullable ? null : "Must be a number";
      if (!Number.isInteger(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        return `Must be an integer${field.min !== undefined ? ` ≥ ${field.min}` : ""}${field.max !== undefined ? ` ≤ ${field.max}` : ""}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "Must be a boolean";
    case "text":
    case "template":
    case "emoji":
      return typeof value === "string" ? null : "Must be a string";
    case "table": {
      if (!Array.isArray(value)) return "Must be an array";
      for (const row of value) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return "Table rows must be objects";
        for (const column of field.columns) {
          const cell = row[column.key];
          if (cell === undefined || cell === "") continue;
          if (column.type === "number" && !Number.isFinite(Number(cell))) return `Column ${column.key} must be numeric`;
          if (column.control === "select" && !column.options.includes(cell)) return `Column ${column.key} must be one of: ${column.options.join(", ")}`;
        }
      }
      return null;
    }
    default:
      return `Unsupported field type: ${field.type}`;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class BehaviorStore {
  constructor({ root = process.cwd(), configStore } = {}) {
    this.root = path.resolve(root);
    this.globalPath = path.join(this.root, "assets", "json-data", "command.json");
    this.overrideDir = path.join(this.root, "mybot", "command-overrides");
    this.configStore = configStore || new ConfigStore({ backupDir: path.join(this.root, "logs", "dashboard-backups") });
  }

  static effective(globalProfile, overrideProfile) {
    return deepMerge(defaultBehaviorProfile(), globalProfile, overrideProfile);
  }

  #assertCommandExists(globalDoc, commandName) {
    const found = (Array.isArray(globalDoc.commands) ? globalDoc.commands : [])
      .find((command) => command.name === commandName);
    if (!found) {
      const error = new Error(`Command not found: ${commandName}`);
      error.status = 404;
      error.code = "COMMAND_NOT_FOUND";
      throw error;
    }
    return found;
  }

  async getGlobal(commandName) {
    const doc = await this.#readGlobal();
    const command = (doc.commands || []).find((entry) => entry.name === commandName);
    return command?.behavior ? clone(command.behavior) : null;
  }

  async setGlobal(commandName, profile) {
    const doc = await this.#readGlobal();
    const command = this.#assertCommandExists(doc, commandName);
    command.behavior = clone(profile);
    const result = await this.configStore.writeJson(this.globalPath, doc);
    return { ...result, value: doc };
  }

  async resetGlobal(commandName) {
    const doc = await this.#readGlobal();
    const command = this.#assertCommandExists(doc, commandName);
    delete command.behavior;
    const result = await this.configStore.writeJson(this.globalPath, doc);
    return { ...result, value: doc };
  }

  async getForBot(botId, commandName) {
    const override = await this.#readOverride(botId);
    const entry = override[commandName];
    return { override: entry?.behavior ? clone(entry.behavior) : null };
  }

  async setForBot(botId, commandName, profile) {
    const doc = await this.#readGlobal();
    this.#assertCommandExists(doc, commandName);
    const override = await this.#readOverride(botId);
    override[commandName] = { ...(override[commandName] || {}), behavior: clone(profile) };
    const result = await this.configStore.writeJson(this.#overridePath(botId), override);
    return { ...result, value: override };
  }

  async resetForBot(botId, commandName) {
    const override = await this.#readOverride(botId);
    if (override[commandName]) {
      delete override[commandName].behavior;
      if (Object.keys(override[commandName]).length === 0) delete override[commandName];
      const result = await this.configStore.writeJson(this.#overridePath(botId), override);
      return { ...result, value: override };
    }
    return { backup: null, changedPaths: [], value: override };
  }

  async #readGlobal() {
    try {
      return JSON.parse(await fs.readFile(this.globalPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { prefix: "!", commands: [] };
      throw error;
    }
  }

  async #readOverride(botId) {
    try {
      return JSON.parse(await fs.readFile(this.#overridePath(botId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  #overridePath(botId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(botId))) throw new Error("Invalid bot id");
    return path.join(this.overrideDir, `${botId}.json`);
  }
}

function deepMerge(...layers) {
  const output = {};
  for (const layer of layers.filter(Boolean)) {
    for (const [key, value] of Object.entries(layer)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        output[key] = deepMerge(output[key], value);
      } else if (value !== undefined) {
        output[key] = clone(value);
      }
    }
  }
  return output;
}
```

> Lưu ý: `findSchemaField` được import nhưng chỉ dùng cho tiện ích tương lai — xoá import nếu lint báo unused.

- [ ] **Step 4: Chạy test xác nhận pass**

Run: `node --test tests/command-behavior-store.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/command-behavior-store.js tests/command-behavior-store.test.js
git commit -m "feat(command): add behavior store with validation, backup and merge"
```

---

### Task 4: REST API cho behavior + preview + hot-reload

**Files:**
- Modify: `src/dashboard/api-routes.js` (thêm routes trong `registerDashboardApi`, sau block qr-session, TRƯỚC `/api/bots` list)
- Test: `tests/dashboard-behavior-api.test.js`

**Interfaces:**
- Consumes: Task 1–3 (`COMMAND_BEHAVIOR_SCHEMA`, `defaultBehaviorProfile`, `validateBehaviorProfile`, `BehaviorStore`, `renderTemplate`); helpers sẵn có `sendSuccess/sendError/wrap`.
- Produces endpoints:
  - `GET /api/commands/behavior-schema` → `{ schema, variables }`
  - `GET /api/commands/:commandName/behavior` → `{ global, defaults }`
  - `PUT /api/commands/:commandName/behavior` → validate + save + audit
  - `DELETE /api/commands/:commandName/behavior` → reset + audit
  - `GET /api/bots/:id/commands/:commandName/behavior` → `{ global, override, effective, hasOverride }`
  - `PUT /api/bots/:id/commands/:commandName/behavior`, `DELETE` tương tự
  - `POST /api/commands/render-preview` body `{ template, vars? }` → `{ rendered }`
  - `POST /api/system/command-config/reload` body `{ botId }` → ghi request reload (Task 6 sẽ dùng cơ chế này)

Route registration: tạo instance `const behaviorStore = options.behaviorStore || new BehaviorStore({ root, configStore });` cạnh các service khác ở đầu hàm.

- [ ] **Step 1: Viết test thất bại** (dùng express app thật, mount registerDashboardApi với root tmp)

```js
// tests/dashboard-behavior-api.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { requestIdMiddleware } from "../src/dashboard/api-response.js";

function buildApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-api-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot", "bots"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot", "command-overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "json-data", "command.json"),
    JSON.stringify({ prefix: "!", commands: [{ name: "help", permission: "all", active: true }] }));
  fs.writeFileSync(path.join(root, "mybot", "mybots.json"), JSON.stringify({}));
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  registerDashboardApi(app, { root });
  return { app, root };
}

function put(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${url}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => {
        resolve({ status: res.status, body: await res.json() });
        server.close();
      }).catch(reject);
    });
  });
}

function get(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${url}`).then(async (res) => {
        resolve({ status: res.status, body: await res.json() });
        server.close();
      }).catch(reject);
    });
  });
}

test("serves behavior schema with variables", async () => {
  const { app } = buildApp();
  const res = await get(app, "/api/commands/behavior-schema");
  assert.equal(res.status, 200);
  assert.ok(res.body.data.schema.groups.length >= 4);
  assert.ok(res.body.data.variables.includes("{prefix}"));
});

test("put+get global behavior roundtrip and validation failure", async () => {
  const { app, root } = buildApp();
  const good = await put(app, "/api/commands/help/behavior", {
    responses: { useCustomTemplates: true, templates: { onCooldown: "{user} đợi {remaining}s" } },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.value.behavior.responses.useCustomTemplates, true);

  const fetched = await get(app, "/api/commands/help/behavior");
  assert.equal(fetched.body.data.global.responses.templates.onCooldown, "{user} đợi {remaining}s");

  const bad = await put(app, "/api/commands/help/behavior", { operation: { cooldownMode: "sai" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "COMMAND_VALIDATION_FAILED");

  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "assets/json-data/command.json"), "utf8"))
    .commands[0].behavior);
});

test("bot override roundtrip returns effective merged profile", async () => {
  const { app } = buildApp();
  await put(app, "/api/commands/help/behavior", { operation: { maxUsesPerHour: 5 } });
  const saved = await put(app, "/api/bots/bot01/commands/help/behavior", { operation: { killSwitch: true } });
  assert.equal(saved.status, 200);

  const view = await get(app, "/api/bots/bot01/commands/help/behavior");
  assert.equal(view.body.data.effective.operation.killSwitch, true);
  assert.equal(view.body.data.effective.operation.maxUsesPerHour, 5);
  assert.equal(view.body.data.hasOverride, true);
});

test("render-preview renders template or 400 on invalid input", async () => {
  const { app } = buildApp();
  const server = app.listen(0, "127.0.0.1");
  const port = server.address().port;
  const post = async (body) => await fetch(`http://127.0.0.1:${port}/api/commands/render-preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const okRes = await post({ template: "{prefix}{command} cho {user}", vars: { prefix: "!", command: "kick", user: "An" } });
  assert.equal(okRes.body.data.rendered, "!kick cho An");

  const fallback = await post({ template: "", vars: {} });
  assert.equal(fallback.body.data.rendered, null);

  const invalid = await post({ template: 42 });
  assert.equal(invalid.status, 400);
  server.close();
});
```

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/dashboard-behavior-api.test.js`
Expected: FAIL — 404 trên `/api/commands/behavior-schema`

- [ ] **Step 3: Thêm routes vào api-routes.js**

Imports bổ sung ở đầu file:

```js
import { COMMAND_BEHAVIOR_SCHEMA, RESPONSE_TEMPLATE_VARIABLES, defaultBehaviorProfile } from "./command-behavior-schema.js";
import { BehaviorStore, validateBehaviorProfile } from "./command-behavior-store.js";
import { renderTemplate } from "./command-response-template.js";
```

Bên trong `registerDashboardApi(...)`, sau dòng khai báo `qrSessionManager`:

```js
  const behaviorStore = options.behaviorStore || new BehaviorStore({ root, configStore });

  app.get("/api/commands/behavior-schema", wrap(async (req, res) => {
    return sendSuccess(res, req, { schema: COMMAND_BEHAVIOR_SCHEMA, variables: [...RESPONSE_TEMPLATE_VARIABLES, "{param:<key>}"] });
  }));

  app.get("/api/commands/:commandName/behavior", wrap(async (req, res) => {
    const global = await behaviorStore.getGlobal(req.params.commandName);
    return sendSuccess(res, req, { global, defaults: defaultBehaviorProfile() });
  }));

  const upsertGlobalBehavior = wrap(async (req, res, action) => {
    try {
      if (action === "reset") {
        const result = await behaviorStore.resetGlobal(req.params.commandName);
        await auditStore.append({ requestId: req.requestId, action: "command.behavior.reset", commandName: req.params.commandName, scope: "global" });
        return sendSuccess(res, req, { removed: true }, { backup: result.backup });
      }
      const validated = validateBehaviorProfile(req.body || {});
      if (!validated.ok) {
        return sendError(res, req, 400, "COMMAND_VALIDATION_FAILED", validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "), { data: validated.errors });
      }
      const result = await behaviorStore.setGlobal(req.params.commandName, validated.normalized);
      await auditStore.append({ requestId: req.requestId, action: "command.behavior.update", commandName: req.params.commandName, scope: "global" });
      return sendSuccess(res, req, result.value, { backup: result.backup });
    } catch (error) {
      if (error.code === "COMMAND_NOT_FOUND") return sendError(res, req, 404, error.code, error.message);
      throw error;
    }
  });

  app.put("/api/commands/:commandName/behavior", wrap(async (req, res) => upsertGlobalBehavior(req, res, "update")));
  app.delete("/api/commands/:commandName/behavior", wrap(async (req, res) => upsertGlobalBehavior(req, res, "reset")));

  app.get("/api/bots/:id/commands/:commandName/behavior", wrap(async (req, res) => {
    const global = await behaviorStore.getGlobal(req.params.commandName);
    const { override } = await behaviorStore.getForBot(req.params.id, req.params.commandName);
    return sendSuccess(res, req, {
      global,
      override,
      effective: BehaviorStore.effective(global, override),
      hasOverride: Boolean(override),
    });
  }));

  const upsertBotBehavior = wrap(async (req, res, action) => {
    try {
      if (action === "reset") {
        const result = await behaviorStore.resetForBot(req.params.id, req.params.commandName);
        await auditStore.append({ requestId: req.requestId, action: "command.behavior.reset", commandName: req.params.commandName, scope: "bot", botId: req.params.id });
        return sendSuccess(res, req, { removed: true }, { backup: result.backup });
      }
      const validated = validateBehaviorProfile(req.body || {});
      if (!validated.ok) {
        return sendError(res, req, 400, "COMMAND_VALIDATION_FAILED", validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "), { data: validated.errors });
      }
      const result = await behaviorStore.setForBot(req.params.id, req.params.commandName, validated.normalized);
      await auditStore.append({ requestId: req.requestId, action: "command.behavior.update", commandName: req.params.commandName, scope: "bot", botId: req.params.id });
      return sendSuccess(res, req, result.value, { backup: result.backup });
    } catch (error) {
      if (error.code === "COMMAND_NOT_FOUND") return sendError(res, req, 404, error.code, error.message);
      throw error;
    }
  });

  app.put("/api/bots/:id/commands/:commandName/behavior", wrap(async (req, res) => upsertBotBehavior(req, res, "update")));
  app.delete("/api/bots/:id/commands/:commandName/behavior", wrap(async (req, res) => upsertBotBehavior(req, res, "reset")));

  app.post("/api/commands/render-preview", wrap(async (req, res) => {
    const template = req.body?.template;
    if (typeof template !== "string") {
      return sendError(res, req, 400, "INVALID_TEMPLATE", "template must be a string");
    }
    return sendSuccess(res, req, { rendered: renderTemplate(template, req.body?.vars || {}) });
  }));
```

> Kiểm tra chữ ký `sendError(res, req, status, code, message, extra)` trong `src/dashboard/api-response.js` trước khi dùng tham số `extra` — điều chỉnh theo thực tế.

- [ ] **Step 4: Chạy test xác nhận pass + chạy trọn bộ dashboard liên quan**

Run: `node --test tests/dashboard-behavior-api.test.js && node --test tests/dashboard-router.test.cjs`
Expected: PASS cả hai (router test đảm bảo không phá route cũ)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/api-routes.js tests/dashboard-behavior-api.test.js
git commit -m "feat(command): add behavior CRUD, schema and preview endpoints"
```

---

### Task 5: Runtime enforcement thuần (schedule/restrictions/cooldown/hourly-limit)

**Files:**
- Create: `src/commands/command-behavior-runtime.js`
- Test: `tests/command-behavior-runtime.test.js`

**Interfaces:**
- Consumes: behavior profile shape từ Task 1.
- Produces (pure functions, không I/O):
  - `isWithinSchedule(nowDate, windows)` → boolean (windows rỗng → true; days: "1-5","0,6","*" ; from/to "HH:mm")
  - `evaluateRestrictions(behavior, { threadId, senderId })` → `{ allowed: boolean, reason: string }` (mode all/whitelist/blacklist; allowedUsers nếu non-empty thì senderId phải thuộc)
  - `resolveCooldownSeconds(behavior, fallbackSeconds)` → số giây (cooldownOverride ?? fallback)
  - `cooldownBucket(mode, { userId, threadId })` → string key ("u:<id>"|"t:<id>"|"*")
  - `checkHourlyLimit(historyTimestamps, maxUsesPerHour, nowMs)` → `{ allowed, oldestRemainingMs }`

- [ ] **Step 1: Viết test thất bại**

```js
// tests/command-behavior-runtime.test.js
import assert from "node:assert/strict";
import test from "node:test";
import {
  isWithinSchedule,
  evaluateRestrictions,
  resolveCooldownSeconds,
  cooldownBucket,
  checkHourlyLimit,
} from "../src/commands/command-behavior-runtime.js";

test("empty schedule always allows", () => {
  assert.equal(isWithinSchedule(new Date("2026-08-23T03:00:00"), []), true);
});

test("schedule window days range and time bounds", () => {
  const windows = [{ days: "1-5", from: "08:00", to: "22:00" }];
  assert.equal(isWithinSchedule(new Date("2026-08-19T10:00:00"), windows), true);  // Thứ 4
  assert.equal(isWithinSchedule(new Date("2026-08-23T10:00:00"), windows), false); // Chủ nhật
  assert.equal(isWithinSchedule(new Date("2026-08-19T07:59:00"), windows), false);
  assert.equal(isWithinSchedule(new Date("2026-08-19T22:00:00"), windows), true);  // biên inclusive
});

test("wildcard days and comma list", () => {
  const windows = [{ days: "*", from: "00:00", to: "23:59" }];
  assert.equal(isWithinSchedule(new Date("2026-08-23T12:00:00"), windows), true);
  const weekend = [{ days: "0,6", from: "09:00", to: "11:00" }];
  assert.equal(isWithinSchedule(new Date("2026-08-22T09:30:00"), weekend), true); // Thứ 7
});

test("restriction modes enforce whitelist/blacklist/user allowlist", () => {
  const base = { restrictions: { mode: "all", allowedThreads: [], blockedThreads: [], allowedUsers: [] } };
  assert.deepEqual(evaluateRestrictions(base, { threadId: "t1", senderId: "u1" }), { allowed: true, reason: "" });

  const wl = { restrictions: { mode: "whitelist", allowedThreads: [{ threadId: "ok" }], blockedThreads: [], allowedUsers: [] } };
  assert.equal(evaluateRestrictions(wl, { threadId: "nope", senderId: "u1" }).allowed, false);

  const bl = { restrictions: { mode: "blacklist", allowedThreads: [], blockedThreads: [{ threadId: "bad" }], allowedUsers: [] } };
  assert.equal(evaluateRestrictions(bl, { threadId: "bad", senderId: "u1" }).allowed, false);
  assert.equal(evaluateRestrictions(bl, { threadId: "good", senderId: "u1" }).allowed, true);

  const users = { restrictions: { mode: "all", allowedThreads: [], blockedThreads: [], allowedUsers: [{ userId: "vip" }] } };
  assert.equal(evaluateRestrictions(users, { threadId: "t", senderId: "vip" }).allowed, true);
  assert.equal(evaluateRestrictions(users, { threadId: "t", senderId: "other" }).allowed, false);
});

test("cooldown resolution falls back and buckets by mode", () => {
  assert.equal(resolveCooldownSeconds({}, 15), 15);
  assert.equal(resolveCooldownSeconds({ operation: { cooldownOverride: null } }, 15), 15);
  assert.equal(resolveCooldownSeconds({ operation: { cooldownOverride: 60 } }, 15), 60);
  assert.equal(cooldownBucket("perUser", { userId: "u1", threadId: "t1" }), "u:u1");
  assert.equal(cooldownBucket("perThread", { userId: "u1", threadId: "t1" }), "t:t1");
  assert.equal(cooldownBucket("global", { userId: "u1", threadId: "t1" }), "*");
});

test("hourly limit counts only within window", () => {
  const now = 1_800_000_000_000;
  const history = [now - 10 * 60_000, now - 70 * 60_000]; // 1 hit trong giờ, 1 ngoài
  const ok = checkHourlyLimit(history, 2, now);
  assert.equal(ok.allowed, true);
  const full = checkHourlyLimit([...history, now - 5 * 60_000], 2, now);
  assert.equal(full.allowed, false);
  assert.ok(full.oldestRemainingMs > 0);
  assert.equal(checkHourlyLimit([], 0, now).allowed, true); // 0 = unlimited
});
```

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/command-behavior-runtime.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Cài đặt**

```js
// src/commands/command-behavior-runtime.js
export function isWithinSchedule(now, windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (list.length === 0) return true;
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return list.some((window) => {
    if (!window || typeof window.from !== "string" || typeof window.to !== "string") return false;
    if (!matchesDays(window.days, day)) return false;
    const from = parseHHMM(window.from);
    const to = parseHHMM(window.to);
    if (from === null || to === null) return false;
    return minutes >= from && minutes <= to;
  });
}

function matchesDays(pattern, day) {
  const raw = String(pattern ?? "*").trim();
  if (raw === "*" || raw === "") return true;
  return raw.split(",").some((part) => {
    const trimmed = part.trim();
    const range = trimmed.split("-").map((value) => Number(value.trim()));
    if (range.length === 2 && range.every(Number.isInteger)) {
      return day >= Math.min(...range) && day <= Math.max(...range);
    }
    return Number(trimmed) === day;
  });
}

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function evaluateRestrictions(behavior, { threadId, senderId }) {
  const restrictions = behavior?.restrictions || {};
  const mode = restrictions.mode || "all";
  const allowedUsers = normalizeIds(restrictions.allowedUsers, "userId");
  if (allowedUsers.length > 0 && !allowedUsers.includes(String(senderId))) {
    return { allowed: false, reason: "USER_NOT_ALLOWED" };
  }
  if (mode === "whitelist") {
    const allowedThreads = normalizeIds(restrictions.allowedThreads, "threadId");
    if (!allowedThreads.includes(String(threadId))) return { allowed: false, reason: "THREAD_NOT_WHITELISTED" };
    return { allowed: true, reason: "" };
  }
  if (mode === "blacklist") {
    const blocked = normalizeIds(restrictions.blockedThreads, "threadId");
    if (blocked.includes(String(threadId))) return { allowed: false, reason: "THREAD_BLOCKED" };
  }
  return { allowed: true, reason: "" };
}

function normalizeIds(rows, columnKey) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row?.[columnKey]).filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map((value) => String(value).trim());
}

export function resolveCooldownSeconds(behavior, fallbackSeconds) {
  const override = behavior?.operation?.cooldownOverride;
  if (Number.isInteger(override) && override >= 0) return override;
  const fallback = Number(fallbackSeconds);
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
}

export function cooldownBucket(mode, { userId, threadId }) {
  if (mode === "perThread") return `t:${threadId}`;
  if (mode === "global") return "*";
  return `u:${userId}`;
}

export function checkHourlyLimit(historyTimestamps, maxUsesPerHour, nowMs) {
  const limit = Number(maxUsesPerHour);
  if (!Number.isInteger(limit) || limit <= 0) return { allowed: true, oldestRemainingMs: 0 };
  const windowStart = nowMs - 60 * 60 * 1000;
  const withinWindow = (Array.isArray(historyTimestamps) ? historyTimestamps : []).filter((ts) => ts > windowStart);
  if (withinWindow.length < limit) return { allowed: true, oldestRemainingMs: 0 };
  const oldest = Math.min(...withinWindow);
  return { allowed: false, oldestRemainingMs: Math.max(1, oldest + 60 * 60 * 1000 - nowMs) };
}
```

- [ ] **Step 4: Chạy test xác nhận pass**

Run: `node --test tests/command-behavior-runtime.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/commands/command-behavior-runtime.js tests/command-behavior-runtime.test.js
git commit -m "feat(command): add pure runtime behavior enforcement helpers"
```

---

### Task 6: Merge behavior vào runtime policy loader

**Files:**
- Modify: `src/commands/command-policy-loader.js`
- Test: `tests/command-policy-loader-behavior.test.js`

**Interfaces:**
- Produces: `resolveRuntimeCommandPolicy(command, policy)` giờ trả thêm `behavior` (merged global+override, thiếu → `null`); hàm mới `getCommandBehavior(policy, commandName)` → profile|null (dùng cho sendPhase1Result lookup).

- [ ] **Step 1: Viết test thất bại**

```js
// tests/command-policy-loader-behavior.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeCommandPolicy, getCommandBehavior } from "../src/commands/command-policy-loader.js";

const policy = {
  commands: [
    { name: "help", scope: "both", behavior: { operation: { cooldownMode: "global", maxUsesPerHour: 5 } } },
    { name: "plain", scope: "both" },
  ],
  overrides: {
    help: { scope: "private", behavior: { operation: { maxUsesPerHour: 20 } } },
  },
};

test("resolves merged behavior with override winning leaves", () => {
  const resolved = resolveRuntimeCommandPolicy({ name: "help" }, policy);
  assert.equal(resolved.effectiveScope, "private");
  assert.equal(resolved.behavior.operation.maxUsesPerHour, 20);
  assert.equal(resolved.behavior.operation.cooldownMode, "global");
});

test("commands without behavior yield null behavior (full backward compat)", () => {
  const resolved = resolveRuntimeCommandPolicy({ name: "plain" }, policy);
  assert.equal(resolved.behavior, null);
  assert.equal(getCommandBehavior(policy, "unknown-cmd"), null);
});

test("getCommandBehavior resolves by alias too", () => {
  const policyWithAlias = {
    commands: [{ name: "kick", alias: ["duoi"], behavior: { operation: { killSwitch: true } } }],
    overrides: {},
  };
  const behavior = getCommandBehavior(policyWithAlias, "duoi");
  assert.equal(behavior?.operation.killSwitch, true);
});
```

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/command-policy-loader-behavior.test.js`
Expected: FAIL — resolved.behavior undefined

- [ ] **Step 3: Sửa `command-policy-loader.js`**

Trong `resolveRuntimeCommandPolicy`, sau khi có `resolved`, thêm:

```js
  const behaviorSource = overrideEntry?.behavior || globalCommand?.behavior || null;
  return {
    ...resolved,
    behavior: behaviorSource ? structuredCloneSafe(behaviorSource) : null,
  };
```

Sửa `findOverride` hiện tại để trả cả entry: đổi thành `return entry && typeof entry[1] === "object" ? entry[1] : null;` giữ nguyên, nhưng cần entry ra ngoài — refactor nhỏ:

```js
function findOverride(overrides, canonicalName, command) {
  const targetKeys = [canonicalName, command?.name, ...(Array.isArray(command?.aliases) ? command.aliases : []), ...(Array.isArray(command?.alias) ? command.alias : [])]
    .map(normalizeKey)
    .filter(Boolean);
  const entry = Object.entries(overrides || {}).find(([key]) => targetKeys.includes(normalizeKey(key)));
  return entry?.[1] && typeof entry[1] === "object" ? entry[1] : null;
}
```
(hàm này đã trả entry rồi — chỉ cần gán `const overrideEntry = findOverride(...)` trước khi truyền vào `resolveCommandPolicy`.)

Thêm export:

```js
export function getCommandBehavior(policy, commandName) {
  const globalCommand = findCommand(policy?.commands, { name: commandName });
  const overrideEntry = findOverride(policy?.overrides, globalCommand?.name || commandName, { name: commandName });
  return overrideEntry?.behavior || globalCommand?.behavior || null;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
```

- [ ] **Step 4: Chạy test pass + regression policy cũ**

Run: `node --test tests/command-policy-loader-behavior.test.js && npm test -- tests/dashboard-command-scope-ui.test.cjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/command-policy-loader.js tests/command-policy-loader-behavior.test.js
git commit -m "feat(command): surface merged behavior profile in runtime policy"
```

---

### Task 7: Wire behavior vào `command.js` (3 điểm duy nhất)

**Files:**
- Create: `src/commands/command-behavior-context.js` (helper lấy profile + state usage)
- Modify: `src/commands/command.js`
- Test: `tests/command-runtime-wiring.test.js` (smoke: assert command.js import & gọi các hàm mới — pattern regex giống test UI vì command.js quá lớn để unit-test trực tiếp)

**Interfaces:**
- Consumes: Task 5 helpers; `getRuntimeCommandPolicy` đã có trong command.js (trả `.behavior` sau Task 6); `renderTemplate` (re-export từ `../dashboard/command-response-template.js`).
- Produces: 
  - `getBehaviorForCommand(commandInfo)` → profile|null
  - `checkCommandCountdown` mở rộng: bucket theo mode + hourly limit; khi chặn → gửi template `onCooldown`/`onMaxUses` nếu có, ngược lại giữ reaction cũ.
  - Gate mới `enforceBehaviorGate(context)` chạy TRƯỚC dispatch trong `handleCommandPrivate` và `handleCommand`: kiểm tra killSwitch/dry-run/schedule/restrictions, trả result code tái sử dụng `sendPhase1Result`.
  - `sendPhase1Result`: khi có profile → thử template `templates[code]` trước khi fallback messages mặc định.

- [ ] **Step 1: Viết helper context + test**

```js
// src/commands/command-behavior-context.js
import { renderTemplate } from "../dashboard/command-response-template.js";
import {
  isWithinSchedule,
  evaluateRestrictions,
  resolveCooldownSeconds,
  cooldownBucket,
  checkHourlyLimit,
} from "./command-behavior-runtime.js";

const RESULT_TO_TEMPLATE = {
  KILL_SWITCH_ACTIVE: "onKillSwitch",
  SCOPE_DENIED: "onScopeDenied",
  PERMISSION_DENIED: "onPermissionDenied",
};

export function getBehaviorForCommand(commandPolicy) {
  const behavior = commandPolicy?.behavior;
  return behavior && typeof behavior === "object" ? behavior : null;
}

export function evaluateBehaviorGate({ behavior, threadId, senderId, now = new Date() }) {
  if (!behavior) return { code: "OK" };
  if (behavior.operation?.killSwitch === true) return { code: "KILL_SWITCH_ACTIVE" };
  if (!isWithinSchedule(now, behavior.operation?.scheduleWindows)) return { code: "OUT_OF_SCHEDULE" };
  const verdict = evaluateRestrictions(behavior, { threadId, senderId });
  if (!verdict.allowed) return { code: verdict.reason };
  return { code: "OK" };
}

export class CooldownLedger {
  constructor() { this.usage = new Map(); }

  consume({ behavior, fallbackCountdownSeconds, userId, threadId, now = Date.now() }) {
    const mode = behavior?.operation?.cooldownMode || "perUser";
    const bucket = cooldownBucket(mode, { userId, threadId });
    const seconds = resolveCooldownSeconds(behavior, fallbackCountdownSeconds);
    const history = this.usage.get(bucket) || [];
    if (seconds > 0) {
      const lastAt = history.length ? Math.max(...history) : 0;
      const remainingMs = lastAt + seconds * 1000 - now;
      if (remainingMs > 0) {
        return { allowed: false, remainingSeconds: Math.ceil(remainingMs / 1000) };
      }
    }
    const limit = Number(behavior?.operation?.maxUsesPerHour || 0);
    const hourly = checkHourlyLimit(history, limit, now);
    if (!hourly.allowed) {
      return { allowed: false, remainingSeconds: Math.ceil(hourly.oldestRemainingMs / 1000), reasonCode: "MAX_USES_PER_HOUR" };
    }
    history.push(now);
    this.usage.set(bucket, history.filter((ts) => ts > now - 60 * 60 * 1000));
    return { allowed: true, remainingSeconds: 0 };
  }
}

export function renderBehaviorMessage(behavior, code, vars) {
  if (!behavior?.responses?.useCustomTemplates) return null;
  const key = RESULT_TO_TEMPLATE[code] || code;
  const template = behavior.responses.templates?.[uncapitalize(key)];
  return renderTemplate(template, vars);
}

function uncapitalize(value) {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}
```

```js
// tests/command-runtime-wiring.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CooldownLedger, evaluateBehaviorGate } from "../src/commands/command-behavior-context.js";

test("ledger blocks per-user but isolates users", () => {
  const ledger = new CooldownLedger();
  const first = ledger.consume({ behavior: null, fallbackCountdownSeconds: 60, userId: "u1", threadId: "t1", now: 1_000_000 });
  assert.equal(first.allowed, true);
  const blocked = ledger.consume({ behavior: null, fallbackCountdownSeconds: 60, userId: "u1", threadId: "t1", now: 1_030_000 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.remainingSeconds > 50);
  const other = ledger.consume({ behavior: null, fallbackCountdownSeconds: 60, userId: "u2", threadId: "t1", now: 1_030_000 });
  assert.equal(other.allowed, true);
});

test("gate honours kill switch and schedule", () => {
  assert.equal(evaluateBehaviorGate({ behavior: { operation: { killSwitch: true } }, threadId: "t", senderId: "u" }).code, "KILL_SWITCH_ACTIVE");
  const nightOwl = { operation: { scheduleWindows: [{ days: "*", from: "08:00", to: "22:00" }] } };
  assert.equal(evaluateBehaviorGate({ behavior: nightOwl, threadId: "t", senderId: "u", now: new Date("2026-08-23T23:00:00") }).code, "OUT_OF_SCHEDULE");
});

test("wiring present in command.js (cooldown ledger, gate, templates)", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/commands/command.js"), "utf8");
  assert.match(source, /command-behavior-context/);
  assert.match(source, /CooldownLedger|cooldownLedger/);
  assert.match(source, /evaluateBehaviorGate/);
  assert.match(source, /renderBehaviorMessage/);
});
```

> Lưu ý: test wiring dùng `__dirname` — trong ESM thay bằng:
> ```js
> const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
> ```
> hoặc đặt file này là `.cjs` và require source thuần. **Chọn phương án `.cjs`** cho đơn giản: đổi tên thành `tests/command-runtime-wiring.test.cjs`, bỏ import 2 hàm trên và test chúng trong một file `.js` riêng (`tests/command-behavior-context.test.js`).

- [ ] **Step 2: Chạy test xác nhận thất bại**

Run: `node --test tests/command-behavior-context.test.js tests/command-runtime-wiring.test.cjs`
Expected: context tests FAIL (module chưa có); wiring test FAIL (command.js chưa import)

- [ ] **Step 3: Wire vào command.js — đúng 3 chỗ**

3a. Imports (đầu file, sau các import hiện có):

```js
import { getBehaviorForCommand, evaluateBehaviorGate, CooldownLedger, renderBehaviorMessage } from "./command-behavior-context.js";
```

3b. Thay thế trạng thái cooldown: dòng `const lastCommandUsage = {};` →

```js
const cooldownLedger = new CooldownLedger();
```

3c. Trong `checkCommandCountdown(api, message, userId, commandName, commandUsage)` — giữ chữ ký cũ để không vỡ callers, nhưng thân hàm chuyển sang ledger:

```js
  const command = getCommand(commandName, commandConfig);
  if (!command) return true;
  const behavior = getBehaviorForCommand(getRuntimeCommandPolicy(command));
  const verdict = cooldownLedger.consume({
    behavior,
    fallbackCountdownSeconds: Number(command.countdown) || 0,
    userId,
    threadId: message.threadId,
  });
  if (!verdict.allowed) {
    const custom = renderBehaviorMessage(behavior, "onCooldown", {
      user: message?.data?.uidFrom, userId: message?.data?.uidFrom, thread: message.threadId,
      command: command.name, prefix: getGlobalPrefix(), remaining: verdict.remainingSeconds,
    });
    if (custom) {
      await api.sendMessage({ msg: custom }, message.threadId, message.type);
    } else {
      await sendReactionWaitingCountdown(api, message, verdict.remainingSeconds, commandName);
    }
    return false;
  }
  return true;
```

3d. Gate trước dispatch — trong CẢ `handleCommandPrivate` và `handleCommand`, ngay SAU tính `commandPolicy` và TRƯỚC dòng `dispatchCommand`:

```js
      const behaviorProfile = getBehaviorForCommand(commandPolicy);
      const gateVerdict = evaluateBehaviorGate({
        behavior: behaviorProfile,
        threadId,
        senderId,
      });
      if (gateVerdict.code !== "OK") {
        const customGate = renderBehaviorMessage(behaviorProfile, gateVerdict.code, {
          user: senderId, userId: senderId, thread: threadId, command, prefix,
        });
        if (customGate) await api.sendMessage({ msg: customGate }, threadId, message.type);
        else await sendPhase1Result(api, message, { code: gateVerdict.code, command });
        return numHandleCommand;
      }
```

3e. Template trong `sendPhase1Result` — trong map messages, trước khi dùng `messages[result.code]`:

```js
  const behavior = getBehaviorForCommand(getRuntimeCommandPolicy({ name: result.command }));
  const customText = renderBehaviorMessage(behavior, result.code, {
    user: message?.data?.uidFrom, userId: message?.data?.uidFrom, thread: message?.threadId,
    command: result.command, prefix: getGlobalPrefix(), reason: result.reason || "",
  });
  if (customText) {
    await api.sendMessage({ msg: customText }, message.threadId, message.type);
    return;
  }
```

> Nếu lint phàn nàn vòng import (`command-behavior-context` ← `command.js` ← index): `renderBehaviorMessage` nằm ở context module nên không có vòng; `getRuntimeCommandPolicy` đã cùng file.

- [ ] **Step 4: Chạy test pass + smoke toàn bộ suite command liên quan**

Run: `node --test tests/command-behavior-context.test.js tests/command-runtime-wiring.test.cjs && npm test`
Expected: PASS toàn bộ (npm test chạy full `tests/`)

- [ ] **Step 5: Commit**

```bash
git add src/commands/command-behavior-context.js src/commands/command.js tests/command-behavior-context.test.js tests/command-runtime-wiring.test.cjs
git commit -m "feat(command): enforce behavior profiles in runtime dispatch"
```

---

### Task 8: Hot-reload endpoint dùng reload-request sẵn có

**Files:**
- Modify: `src/dashboard/api-routes.js` (thêm 1 route)
- Test: thêm case vào `tests/dashboard-behavior-api.test.js`

**Interfaces:**
- Consumes: `writeReloadRequest(uid, request)` từ `../commands/mybot/System/reload-request.js`; `performRuntimeReload` phía bot đã hỗ trợ `reloadType: "command-config"` (qua `reload-request.js` + `runtime-reload.js` hiện hữu).
- Produces: `POST /api/system/command-config/reload` body `{ botId }` → 202 `{ requested: true, botId }`.

- [ ] **Step 1: Thêm test thất bại** (append vào `dashboard-behavior-api.test.js`)

```js
test("command-config reload writes request file", async () => {
  const { app, root } = buildApp();
  const server = app.listen(0, "127.0.0.1");
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/system/command-config/reload`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId: "bot01" }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal(res.status, 202);
  assert.equal(res.body.data.requested, true);
  const written = JSON.parse(fs.readFileSync(
    path.join(root, "mybot", "state", "reload", "bot01.json"), "utf8"));
  assert.equal(written.reloadType, "command-config");
  assert.equal(written.status, "requested");
  server.close();
});
```

- [ ] **Step 2: Chạy xác nhận FAIL** — `node --test tests/dashboard-behavior-api.test.js` (route 404)

- [ ] **Step 3: Implement** — import đầu file `api-routes.js`:

```js
import { writeReloadRequest } from "../commands/mybot/System/reload-request.js";
```

Thêm route (đặt cạnh nhóm `/api/system/*`):

```js
  app.post("/api/system/command-config/reload", wrap(async (req, res) => {
    const botId = String(req.body?.botId || "admin");
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) {
      return sendError(res, req, 400, "INVALID_BOT_ID", "botId must match [a-zA-Z0-9_-]");
    }
    const request = writeReloadRequest(botId, { reloadType: "command-config" });
    await auditStore.append({ requestId: req.requestId, action: "command-config.reload-request", botId });
    res.status(202);
    return sendSuccess(res, req, { requested: true, botId, requestedAt: request.requestedAt });
  }));
```

> Bot side đã có vòng đời đọc `mybot/state/reload/<uid>.json` → `performRuntimeReload({reloadType:"command-config"})` → `reloadCommandConfig()` — không cần sửa gì thêm. Nếu bot đang chạy chưa poll file này, ghi chú trong PR: restart bot 1 lần cuối để kích hoạt watcher.

- [ ] **Step 4: PASS** — `node --test tests/dashboard-behavior-api.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/api-routes.js tests/dashboard-behavior-api.test.js
git commit -m "feat(command): add command-config hot-reload trigger endpoint"
```

---

### Task 9: Frontend — schema client + FieldRenderer

**Files:**
- Create: `dashboard/src/app/command-schema.js`
- Create: `dashboard/src/components/fields.jsx`
- Test: `tests/command-studio-fields-ui.test.cjs` (regex smoke theo pattern repo)

**Interfaces:**
- Produces:
  - `fetchBehaviorSchema()` → `{ schema, variables }` (cache module-level, force flag)
  - `<SchemaFields schemaGroups values onChange />` render mọi group.field theo type:
    - `select` → `<select>`
    - `number` → `<input type="number">` (nullable: ô trống → null)
    - `boolean` → toggle checkbox styled
    - `text/emoji` → `<input>`
    - `template` → textarea + nút "Xem trước" gọi `/api/commands/render-preview` với sample vars
    - `table` → bảng editable: hàng + nút thêm/xoá, ô theo column type (select nếu `control==="select"`, number nếu `type==="number"`)
  - Path helpers: `getValueAtPath(values, "operation.cooldownMode")`, `setValueAtPath(values, path, v)` (immutable).

- [ ] **Step 1: Viết smoke test**

```js
// tests/command-studio-fields-ui.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fieldsFile = path.join(__dirname, "../dashboard/src/components/fields.jsx");
const schemaFile = path.join(__dirname, "../dashboard/src/app/command-schema.js");

test("fields component covers every schema control type", () => {
  const source = fs.readFileSync(fieldsFile, "utf8");
  for (const marker of ['"select"', '"number"', '"boolean"', '"text"', '"template"', '"emoji"', '"table"']) {
    assert.ok(source.includes(marker), `missing control ${marker}`);
  }
  assert.match(source, /render-preview/);
  assert.match(source, /setValueAtPath/);
});

test("schema client caches and can force refresh", () => {
  const source = fs.readFileSync(schemaFile, "utf8");
  assert.match(source, /behavior-schema/);
  assert.match(source, /force/);
});
```

- [ ] **Step 2: FAIL** — `node --test tests/command-studio-fields-ui.test.cjs`

- [ ] **Step 3: Implement**

```js
// dashboard/src/app/command-schema.js
import { apiRequest } from "./api.js";

let cache = null;

export async function fetchBehaviorSchema({ force = false } = {}) {
  if (cache && !force) return cache;
  const result = await apiRequest("/api/commands/behavior-schema");
  cache = result.data || result;
  return cache;
}
```

```jsx
// dashboard/src/components/fields.jsx
import React, { useState } from "react";
import { apiRequest } from "../app/api.js";

export function getValueAtPath(values, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), values);
}

export function setValueAtPath(values, dottedPath, next) {
  const parts = String(dottedPath).split(".");
  const clone = structuredClone(values || {});
  let cursor = clone;
  while (parts.length > 1) cursor = cursor[parts.shift()] ||= {};
  cursor[parts[0]] = next;
  return clone;
}

function TemplateField({ field, value, onChange }) {
  const [preview, setPreview] = useState("");
  const runPreview = async () => {
    try {
      const result = await apiRequest("/api/commands/render-preview", {
        method: "POST",
        body: { template: value || "", vars: { prefix: "!", command: "tenlenh", user: "NgườiDùng", userId: "000000", thread: "NhómMẫu", remaining: "30", reason: "ví dụ", params: { example: 1 } } },
      });
      setPreview(result.data?.rendered ?? "(trống — sẽ dùng message mặc định)");
    } catch (error) {
      setPreview(`Lỗi preview: ${error.message}`);
    }
  };
  return (
    <label className="field field-template">
      <span>{field.label}</span>
      <textarea rows="2" value={value || ""} placeholder={field.help || ""} onChange={(e) => onChange(e.target.value)} />
      <small className="muted">{field.help}</small>
      <div className="toolbar">
        <button className="secondary" type="button" onClick={runPreview}>Xem trước</button>
        {preview ? <code className="preview-box">{preview}</code> : null}
      </div>
    </label>
  );
}

function TableField({ field, rows, onChange }) {
  const updateRow = (index, columnKey, cellValue) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [columnKey]: cellValue } : row));
    onChange(next);
  };
  return (
    <div className="field field-table">
      <div className="field-head">
        <span>{field.label}</span>
        <button className="secondary" type="button" onClick={() => onChange([...rows, Object.fromEntries(field.columns.map((c) => [c.key, ""]))])}>+ Thêm dòng</button>
      </div>
      {rows.length ? (
        <table className="editable-table">
          <thead><tr>{field.columns.map((col) => <th key={col.key}>{col.label}</th>)}<th /></tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {field.columns.map((col) => (
                  <td key={col.key}>
                    {col.control === "select" ? (
                      <select value={row[col.key] ?? ""} onChange={(e) => updateRow(index, col.key, e.target.value)}>
                        <option value="">—</option>
                        {(col.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input type={col.type === "number" ? "number" : "text"} value={row[col.key] ?? ""} onChange={(e) => updateRow(index, col.key, col.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />
                    )}
                  </td>
                ))}
                <td><button className="secondary danger" type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Xoá</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">{field.help || "Chưa có dòng nào."}</p>}
    </div>
  );
}

export function SchemaField({ field, values, onChange }) {
  const value = getValueAtPath(values, field.key);
  const update = (next) => onChange(setValueAtPath(values, field.key, next));

  if (field.type === "table") return <TableField field={field} rows={Array.isArray(value) ? value : []} onChange={update} />;
  if (field.type === "template") return <TemplateField field={field} value={value} onChange={update} />;
  if (field.type === "select") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select value={value ?? ""} onChange={(e) => update(e.target.value)}>
          {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
        <small className="muted">{field.help}</small>
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <input type="number" min={field.min} max={field.max} value={value ?? ""} placeholder={field.nullable ? "(trống = dùng mặc định)" : ""} onChange={(e) => update(e.target.value === "" ? (field.nullable ? null : 0) : Number(e.target.value))} />
        <small className="muted">{field.help}</small>
      </label>
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="field field-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => update(e.target.checked)} />
        <span>{field.label}</span>
        {field.help ? <small className="muted">{field.help}</small> : null}
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}</span>
      <input type="text" value={value ?? ""} maxLength={field.type === "emoji" ? 8 : undefined} onChange={(e) => update(e.target.value)} />
      {field.help ? <small className="muted">{field.help}</small> : null}
    </label>
  );
}

export function SchemaGroup({ group, values, onChange }) {
  return (
    <div className={`schema-group schema-group-${group.id}`}>
      <h4>{group.label}</h4>
      <div className="form-grid">
        {group.fields.map((field) => <SchemaField key={field.key} field={field} values={values} onChange={onChange} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: PASS** — `node --test tests/command-studio-fields-ui.test.cjs`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/command-schema.js dashboard/src/components/fields.jsx tests/command-studio-fields-ui.test.cjs
git commit -m "feat(dashboard): schema-driven field renderers for command studio"
```

---

### Task 10: Frontend — Command Studio thay thế command-workspace

**Files:**
- Rewrite: `dashboard/src/components/command-workspace.jsx`
- Test: `tests/command-studio-ui.test.cjs`

**Thiết kế UI (5 tabs trong editor phải, danh sách trái giữ nguyên concept cũ):**

```
┌───────────────┬────────────────────────────────────────────────┐
│ [Bot selector]│  <tên lệnh>  [chip enabled/handler/scope]      │
│ [Search box  ]│  Tabs: Tổng quan | Vận hành | Phản hồi |       │
│ ┌───────────┐ │        Tham số | Giới hạn                      │
│ │ filter    │ │  ┌──────────────────────────────────────────┐  │
│ │ chips:    │ │  │ (SchemaGroup render theo tab hiện hành)  │  │
│ │ Loại/Trạng│ │  │                                          │  │
│ │ thái      │ │  └──────────────────────────────────────────┘  │
│ │ danh sách │ │  [Lưu] [Reset override] [Copy admin]           │
│ │ 240 lệnh  │ │  [Áp dụng tất cả] [Reload runtime ↻]           │
│ └───────────┘ │  Dirty indicator: "● Có thay đổi chưa lưu"     │
└───────────────┴────────────────────────────────────────────────┘
```

- Tab "Tổng quan": form cũ (tên/alias/quyền/scope/countdown/type/icon/mô tả/cú pháp) — giữ PUT endpoint cũ (`/api/commands/:name` hoặc override).
- Tab Vận hành/Phản hồi/Giới hạn: `SchemaGroup` tương ứng group id, lưu qua endpoint behavior mới (global hoặc theo bot tuỳ selector).
- Tab "Tham số": `SchemaGroup` group `params` + hint `{param:<key>}`.
- Dirty tracking: so sánh JSON draft ban đầu vs hiện tại; cảnh báo khi rời tab/chuyển lệnh (`window.confirm`).
- Nút "Reload runtime": `POST /api/system/command-config/reload` với botId đang chọn (hoặc "admin").
- Filter chips: loại (1/2/3/5/99), trạng thái (enabled/disabled/missing-handler), có override.

**Interfaces:**
- Consumes: Task 4 endpoints; Task 9 components; props cũ `{ bots }`.
- Produces: giữ export tên `CommandWorkspace` để `main.jsx` không phải đổi import.

- [ ] **Step 1: Smoke test**

```js
// tests/command-studio-ui.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const file = path.join(__dirname, "../dashboard/src/components/command-workspace.jsx");
const source = () => fs.readFileSync(file, "utf8");

test("studio keeps legacy actions and adds behavior endpoints", () => {
  const s = source();
  assert.match(s, /apply-all/);
  assert.match(s, /copy-from-admin/);
  assert.match(s, /Reset override/);
  assert.match(s, /behavior/);
  assert.match(s, /command-config\/reload/);
});

test("studio renders five detail tabs from schema groups", () => {
  const s = source();
  for (const tab of ["Tổng quan", "Vận hành", "Phản hồi", "Tham số", "Giới hạn"]) {
    assert.ok(s.includes(tab), `missing tab ${tab}`);
  }
  assert.match(s, /SchemaGroup/);
});

test("studio tracks dirty state before saving", () => {
  assert.match(source(), /dirty/i);
});
```

- [ ] **Step 2: FAIL** — `node --test tests/command-studio-ui.test.cjs`

- [ ] **Step 3: Implement** — cấu trúc component (code đầy đủ):

```jsx
// dashboard/src/components/command-workspace.jsx
import React, { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../app/api.js";
import { fetchBehaviorSchema } from "../app/command-schema.js";
import { SchemaGroup } from "./fields.jsx";

const emptyCommand = { name: "", alias: [], description: "", syntax: "", permission: "all", scope: "both", countdown: 0, active: true, icon: "", type: 0 };
const permissions = ["all", "adminBot", "adminBox", "adminBotOrGroup", "adminLevelHigh"];
const scopeOptions = [["group", "Group"], ["private", "Private"], ["both", "Both"]];
const DETAIL_TABS = [
  ["overview", "Tổng quan"],
  ["operation", "Vận hành"],
  ["responses", "Phản hồi"],
  ["params", "Tham số"],
  ["restrictions", "Giới hạn"],
];
const SCHEMA_GROUP_BY_TAB = { operation: "operation", responses: "responses", params: "params", restrictions: "restrictions" };

export function CommandWorkspace({ bots }) {
  const [selectedBot, setSelectedBot] = useState("");
  const [commands, setCommands] = useState([]);
  const [diagnostics, setDiagnostics] = useState([]);
  const [selectedName, setSelectedName] = useState("");
  const [draft, setDraft] = useState(emptyCommand);
  const [baseline, setBaseline] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [detailTab, setDetailTab] = useState("overview");
  const [schema, setSchema] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const selected = commands.find((c) => c.name === selectedName) || null;

  useEffect(() => { fetchBehaviorSchema().then(setSchema).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); }, [selectedBot]);
  useEffect(() => {
    if (!selected) return;
    const effective = { ...selected, ...(selected.override || {}) };
    setDraft({ ...emptyCommand, ...effective, scope: effective.effectiveScope || effective.scope || "both", alias: effective.alias || [] });
    loadBehavior(effective);
  }, [selectedName, commands]);

  const dirty = useMemo(() => JSON.stringify(stripVolatile(draft)) !== baseline, [draft, baseline]);
  const visible = useMemo(() => filterCommands(commands, query, statusFilter, typeFilter), [commands, query, statusFilter, typeFilter]);

  function stripVolatile(v) { const { enabled, handlerAvailable, missingConfig, missingDependencies, registryActive, effectiveScope, override, diagnostics, ...rest } = v; void enabled; void handlerAvailable; void missingConfig; void missingDependencies; void registryActive; void effectiveScope; void override; void diagnostics; return rest; }

  function filterCommands(list, needle, status, type) {
    const q = needle.trim().toLowerCase();
    return list.filter((c) => {
      const haystack = [c.name, ...(c.alias || []), c.permission, c.scope, c.effectiveScope].join(" ").toLowerCase();
      const matchesQuery = !q || haystack.includes(q);
      const matchesStatus = status === "all"
        || (status === "enabled" && c.enabled) || (status === "disabled" && !c.enabled)
        || (status === "override" && Boolean(c.override)) || (status === "missing-handler" && c.handlerAvailable === false);
      const matchesType = type === "all" || String(c.type) === type;
      return matchesQuery && matchesStatus && matchesType;
    });
  }

  async function load() {
    try {
      const url = selectedBot ? `/api/bots/${encodeURIComponent(selectedBot)}/commands` : "/api/commands/scan";
      const data = (await apiRequest(url)).data || {};
      setCommands(data.commands || []);
      setDiagnostics(data.diagnostics || []);
      setSelectedName((cur) => cur || data.commands?.[0]?.name || "");
      setError("");
    } catch (e) { setError(e.message); }
  }

  async function loadBehavior(effective) {
    try {
      const url = selectedBot
        ? `/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}/behavior`
        : `/api/commands/${encodeURIComponent(selected.name)}/behavior`;
      const data = (await apiRequest(url)).data || {};
      const profile = selectedBot ? (data.effective || data.defaults) : (data.global || data.defaults);
      setDraft((cur) => ({ ...cur, behavior: profile }));
      setBaseline(JSON.stringify(stripVolatile({ ...effective, behavior: profile })));
    } catch (e) { setError(e.message); }
  }

  function updateBehavior(nextProfile) { setDraft((cur) => ({ ...cur, behavior: nextProfile })); }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const { behavior, ...basic } = draft;
      const basicPayload = { ...basic };
      delete basicPayload.enabled; delete basicPayload.handlerAvailable; delete basicPayload.missingConfig; delete basicPayload.missingDependencies; delete basicPayload.registryActive; delete basicPayload.effectiveScope; delete basicPayload.override;
      if (selectedBot) {
        const { name, ...overridePatch } = basicPayload;
        void name;
        await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}`, { method: "PUT", body: { ...overridePatch, ...(behavior ? { behavior } : {}) } });
        if (behavior) await apiRequest(`/api/bots/${encodeURIComponent(selectedBot)}/commands/${encodeURIComponent(selected.name)}/behavior`, { method: "PUT", body: behavior });
      } else {
        await apiRequest(`/api/commands/${encodeURIComponent(selected.name)}`, { method: "PUT", body: basicPayload });
        if (behavior) await apiRequest(`/api/commands/${encodeURIComponent(selected.name)}/behavior`, { method: "PUT", body: behavior });
      }
      setNotice("Đã lưu. Dùng 'Reload runtime' để bot nhận ngay.");
      setError("");
      setBaseline(JSON.stringify(stripVolatile(draft)));
      selectedBot ? await load() : await load();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  async function resetOverride() { /* giữ logic cũ: DELETE override + behavior reset */ }
  async function copyFromAdmin() { /* giữ logic cũ */ }
  async function applyAll() {
    if (!selected || dirty) { if (dirty && !window.confirm("Có thay đổi chưa lưu. Áp dụng bản đã lưu?")) return; }
    const { behavior, ...patch } = draft;
    void behavior;
    try {
      await apiRequest("/api/commands/apply-all", { method: "POST", body: { commandName: selected.name, patch } });
      setNotice("Đã áp dụng cho toàn bộ bot con.");
    } catch (e) { setError(e.message); }
  }
  async function reloadRuntime() {
    try {
      await apiRequest("/api/system/command-config/reload", { method: "POST", body: { botId: selectedBot || "admin" } });
      setNotice("Đã gửi yêu cầu reload cấu hình lệnh.");
    } catch (e) { setError(e.message); }
  }

  /* render: sidebar giữ pattern cũ + filter chips; editor phải gồm:
     - tab bar DETAIL_TABS
     - tab overview → form-grid cũ (tên/alias/permission/scope/countdown/type/icon/description/syntax)
     - tab khác → schema && <SchemaGroup group={schema.schema.groups.find(g => g.id === SCHEMA_GROUP_BY_TAB[detailTab])} values={draft.behavior || {}} onChange={updateBehavior} />
     - toolbar: Lưu(disabled={!dirty||saving}) Reset/Copy/ApplyAll/Reload + dirty badge */
  return (
    <section className="panel workspace">
      {/* ... giữ heading/toolbar cũ, thêm: */}
      {/* {dirty ? <div className="stale-state" role="status">● Có thay đổi chưa lưu</div> : null} */}
      {/* chi tiết render theo mô tả trên */}
    </section>
  );
}
```

> Ghi chú executor: phần comment render phải được viết THẬT (không để comment). Giữ nguyên class names cũ (`command-list`, `command-form`, `command-editor`, `command-row`...) để tái sử dụng CSS hiện có; thêm class mới `detail-tabs`, `editable-table`, `schema-group`, `field-*` và bổ sung CSS vào `dashboard/src/styles.css` (task này gồm ~80 dòng CSS: tab bar, bảng, toggle, preview-box).

- [ ] **Step 4: PASS + build**

Run: `node --test tests/command-studio-ui.test.cjs tests/dashboard-command-scope-ui.test.cjs && npm run dashboard:build`
Expected: tests PASS, vite build SUCCESS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/command-workspace.jsx dashboard/src/styles.css tests/command-studio-ui.test.cjs
git commit -m "feat(dashboard): rebuild command workspace as schema-driven studio"
```

---

### Task 11: Tối ưu server.js — khử trùng lặp wiring + headers đúng thứ tự

**Files:**
- Modify: `dashboard/server.js`
- Test: `tests/server-wiring.test.js`

**Các thay đổi chính:**
1. Trích `configureDashboardApp(app, deps)` dùng chung cho app thật + testApp: thứ tự đúng = `express.json()` (1 lần) → security headers → auth routes → auth middleware → CSRF → gateway proxy middleware → overview/API/static/fallback. Hiện bản thật đặt headers SAU auth (dòng 371) — sửa để headers áp dụng cho mọi response kể cả 401.
2. Bỏ `app.use(express.json())` trùng (dòng 358).
3. Gateway middleware hiện được tạo nhưng **chưa bao giờ `app.use`** (`gateway.middleware` bỏ quên!) — wire vào: `app.use(gateway.middleware)`. Đây là bug thật: proxy HTTP tới upstream đang không hoạt động, chỉ socket relay chạy.

- [ ] **Step 1: Test thất bại**

```js
// tests/server-wiring.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const file = path.join(__dirname, "../dashboard/server.js").replace("\\tests\\..", "");
const source = fs.readFileSync(path.normalize(path.join(process.cwd(), "dashboard", "server.js")), "utf8");

test("security headers registered once and before api routes", () => {
  const headerPos = source.indexOf('res.setHeader("X-Frame-Options"');
  const jsonUses = source.match(/express\.json\(\)/g) || [];
  assert.equal(jsonUses.length, 2); // 1 configure + 1 createServer factory nội bộ? → sau refactor: 2 app khác nhau, mỗi app 1 lần
  const authUse = source.indexOf('requireDashboardAuth)');
  assert.ok(headerPos >= 0);
  assert.ok(headerPos < authUse, "headers must precede auth middleware");
});

test("gateway http proxy middleware is mounted", () => {
  assert.match(source, /app\.use\(gateway\.middleware\)/);
});
```

- [ ] **Step 2: FAIL** — `node --test tests/server-wiring.test.js` (middleware chưa mount)

- [ ] **Step 3: Refactor** — tạo hàm:

```js
function configureDashboardApp(serverApp, { observabilityService, ioServer, gateway: gw } = {}) {
  serverApp.disable("x-powered-by");
  serverApp.use(express.json());
  serverApp.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  registerAuthRoutes(serverApp);
  serverApp.use("/api", requireDashboardAuth);
  serverApp.use("/api", requireCsrf);
  registerOverviewRoute(serverApp, observabilityService);
  registerDashboardApi(serverApp, { root: process.cwd(), qrSessionManager });
  serverApp.use(gw.middleware);
  serverApp.use(express.static(assetRoot));
  serverApp.get("*", (req, res) => {
    if (!req.headers.accept?.includes("text/html")) return res.status(404).json({ success: false, error: "Not found" });
    return res.sendFile(path.join(assetRoot, "index.html"));
  });
  return serverApp;
}
```

`createDashboardServer` và phần module-level cùng gọi `configureDashboardApp`. Xoá toàn bộ wiring trùng.

- [ ] **Step 4: PASS + full suite** — `node --test tests/server-wiring.test.js && npm test && npm run dashboard:build`

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.js tests/server-wiring.test.js
git commit -m "refactor(server): unify app wiring, mount gateway proxy, fix header order"
```

---

### Task 12: Bảo mật — credential bắt buộc từ env

**Files:**
- Modify: `dashboard/server.js:28-29`
- Test: thêm vào `tests/server-wiring.test.js`

- [ ] **Step 1: Test**

```js
test("no hardcoded default credentials", () => {
  assert.doesNotMatch(source, /"nthdz"/);
  assert.doesNotMatch(source, /"140108"/);
  assert.match(source, /throw new Error\("DASHBOARD_ADMIN_USERNAME/);
});
```

- [ ] **Step 2: FAIL** — vẫn match "nthdz"

- [ ] **Step 3: Implement**

```js
if (process.env.DASHBOARD_TEST_MODE !== "1") {
  if (!process.env.DASHBOARD_ADMIN_USERNAME || !process.env.DASHBOARD_ADMIN_PASSWORD) {
    throw new Error("DASHBOARD_ADMIN_USERNAME và DASHBOARD_ADMIN_PASSWORD là bắt buộc (không còn giá trị mặc định)");
  }
}
const authUsername = String(process.env.DASHBOARD_ADMIN_USERNAME || "test-admin").trim() || "test-admin";
const authSecret = String(process.env.DASHBOARD_ADMIN_PASSWORD || process.env.DASHBOARD_AUTH_SECRET || "test-secret").trim() || "test-secret";
```
(placeholder `test-*` chỉ phục vụ test-mode; production throw.)

- [ ] **Step 4: PASS** — full suite

- [ ] **Step 5: Commit**

```bash
git add dashboard/server.js tests/server-wiring.test.js
git commit -m "fix(security): require admin credentials from environment"
```

---

### Task 13: Kiểm thử tổng + tài liệu

**Files:**
- Modify: `AGENTS.md` (cập nhật ports thực tế :4173, upstream :2000, mục Command Studio mới)
- Create: `docs/superpowers/specs/2026-08-23-command-studio-design.md` (1 trang tóm tắt model behavior + template vars + endpoints — trích từ plan này)

- [ ] **Step 1:** `npm test` toàn bộ — Expected: PASS 100%
- [ ] **Step 2:** `npm run lint` — Expected: 0 warnings
- [ ] **Step 3:** `npm run dashboard:build` — Expected: SUCCESS
- [ ] **Step 4:** Manual smoke (chạy `npm run dashboard:start`, login):
  1. Tab Command → chọn lệnh `help` → tab Vận hành → đổi cooldownMode = `global`, maxUsesPerHour = 3 → Lưu → Reload runtime
  2. Tab Phản hồi → bật template tuỳ chỉnh → `onCooldown` = `{user} ơi, chờ {remaining}s` → Xem trước hiển thị đúng
  3. Tab Tham số → thêm row `limit`/`number`/value 10 → Lưu
  4. Tab Giới hạn → blacklist 1 thread ID → test từ Zalo: lệnh bị chặn đúng
  5. Kill switch ON → lệnh trả KILL_SWITCH_ACTIVE
- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-23-command-studio-design.md
git commit -m "docs: document command studio architecture and refresh agents guide"
```

---

## Phụ thuộc giữa các task

```text
Task 1 ─► Task 2 ─► Task 3 ─► Task 4 ─┐
Task 5 ──────────────────► Task 6 ─► Task 7 (cần 4+6)
                              Task 8 (cần 4)
Task 9 ─► Task 10 (cần 4+8+9)
Task 11, 12 độc lập — làm bất kỳ lúc nào
Task 13 cuối cùng
```

## Rủi ro & lưu ý

- `command.json` có **240 lệnh** — BehaviorStore ghi lại toàn file qua ConfigStore (có backup tự động); tránh 2 request PUT song song cùng lúc (Express single-thread + await tuần tự là đủ ở quy mô này).
- File `command.json` hiện **lỗi encoding** (tiếng Việt mojibake trong description/icon). Plan này KHÔNG sửa dữ liệu — khuyến nghị làm task riêng convert UTF-8 sau khi Studio ổn định.
- `main.jsx` god-component và session in-memory nằm ngoài phạm vi plan này (ghi nhận ở review 2026-08-23, làm đợt sau).
