# MyBot Dashboard - AGENTS.md

## Agent Rules

- Always query the codebase-memory MCP server FIRST before running system-wide Grep or Glob.
- Do NOT scan the entire repository with repeated Grep or Glob unless explicitly requested.
- Do NOT read the exact same file multiple times in a single turn.
- If a specific file is tagged or mentioned in the user prompt, navigate directly to that file.

## Dashboard Overview

Dashboard quản lý bot MYBOT-V3MYBOTQRLOGIN chạy như một tiến trình riêng, kết nối đến bot qua `socket.io-client` thay vì khởi động chung với bot.

## Ports & Architecture

- **Dashboard port:** `4173` (override qua `DASHBOARD_PORT`)
- **Upstream bot web-server:** đọc từ registry (`mybot/role-registry.json`, trường `webPort` của bot) hoặc env `DASHBOARD_UPSTREAM_URL` / `BOT_WEB_URL`; mặc định `http://127.0.0.1:2000` nếu không cấu hình (`src/dashboard/dashboard-gateway.js`).
- **Dashboard** đọc/ghi trực tiếp các file JSON trong `assets/` và đồng thời giữ socket relay + HTTP proxy (`gateway.middleware`) tới upstream để lấy dữ liệu real-time.
- Browser kết nối đến dashboard (port 4173) qua socket.io client.

## Directory Structure

```text
TH_MYBOT-V3MYBOTQRLOGIN-main/
├── dashboard/
│   ├── package.json        # Dependencies: express, socket.io-client, chalk, fs
│   ├── server.js           # Dashboard server (Express + Socket.IO server + bot client)
│   └── public/
│       ├── index.html
│       ├── css/style.css
│       ├── js/socket-client.js   # Client-side socket.io init
│       └── js/app.js             # Dashboard UI logic
├── src/
│   └── web-service/
│       └── web-server.js    # Bot web-server (CORS enabled, supports updateCommand)
├── assets/
│   ├── config.json
│   ├── json-data/command.json
│   └── data/group_settings.json
└── AGENTS.md
```

## Commands

```bash
# Install dashboard dependencies
cd dashboard && npm install

# Start dashboard only
cd dashboard && node server.js

# Start bot with web-server (upstream, mặc định port 2000)
npm start

# Dashboard URL (yêu cầu DASHBOARD_ADMIN_USERNAME + DASHBOARD_ADMIN_PASSWORD từ env)
http://localhost:4173
```

## CORS & Socket.IO Configuration

- `dashboard/server.js` tạo HTTP server trên port 4173 và serve static files + Socket.IO server.
- `dashboard/server.js` tạo `socket.io-client` kết nối đến upstream bot (URL resolve từ registry/env, mặc định `http://127.0.0.1:2000`).
- `src/web-service/web-server.js` đã bật CORS cho cả Express (`Access-Control-Allow-Origin: *`) và Socket.IO Server (`cors: { origin: "*", methods: ["GET", "POST"] }`).
- Dashboard chịu trách nhiệm đọc/ghi trực tiếp `command.json`, `group_settings.json`, `config.json`.
- Bot web-server cung cấp event `getCommands` và `updateCommand` để đồng bộ lệnh, đồng thời cung cấp `getAllGroups`, `getAllFriends`, `sendMessageAll`, `sendMessageForSelected`, `getInitialData`, `updateSelected`, `updateActiveBotStatus`, `updateFutureStatus`, `startBulkMessage`, `stopBulkMessage`.

## Pages

1. **Dashboard** - Overview stats (bot status, commands count, groups count, uptime, memory, prefix).
2. **Thông số Bot** - Bot config (prefix, web port, cookie, IMEI, User Agent).
3. **Quản lý Lệnh** - Toggle active, change permission, edit countdown, save all.
4. **Cài đặt Nhóm** - Select group and toggle group settings.
5. **Gửi Tin Nhắn** - Send to all/friends/groups/selected, bulk send.
6. **Logs** - Real-time event logs.

## Important Notes

- Dashboard **KHÔNG** khởi động chung với bot. Chạy bot trước (upstream, mặc định port 2000), rồi chạy dashboard (port 4173) trong terminal khác.
- Nếu bot chưa chạy, dashboard sẽ hiển thị "Chưa kết nối" và tự kết nối lại khi bot khởi động.
- Mọi thay đổi từ dashboard sẽ ghi trực tiếp vào file JSON. Bot cần khởi động lại hoặc dùng `/setcmd` nếu cần reload real-time.

## Command Studio

Tab **Command** của dashboard là studio schema-driven để tuỳ biến Behavior Profile cho từng lệnh (5 tabs: Tổng quan / Vận hành / Phản hồi / Tham số / Giới hạn), kèm hot-reload qua `POST /api/system/command-config/reload` (không cần restart bot).

- Thiết kế chi tiết (model, template variables, endpoints, luồng runtime, vị trí lưu trữ): `docs/superpowers/specs/2026-08-23-command-studio-design.md`.
- Lưu trữ: global trong key `behavior` của `assets/json-data/command.json`; override theo bot trong `mybot/command-overrides/<botId>.json`; backup tự động vào `logs/dashboard-backups`.
- Runtime: `src/commands/command-policy-loader.js` merge profile → gate (`killSwitch`/schedule/restrictions) trước dispatch → cooldown ledger → template phản hồi; không có profile thì hành vi giữ nguyên 100%.

## Command Studio V2

- Mỗi command trong registry (218/218) có `CommandStudioContractV2` sinh từ `src/commands/studio/contracts.js`: metadata, alias, `handlerRef` (module/export/dependency/provider — gắn tại lazy loader qua `__handlerRef`, không import handler), các tab field (kiểu dữ liệu, mặc định, `allowedScopes`, sensitive, apply mode) và coverage `FULL`.
- Lưu trữ sparse override: global `assets/json-data/command-studio/global.json`; bot `mybot/instances/<botId>/data/command-studio.json`; group `mybot/instances/<botId>/data/command-group-overrides/<threadId>.json`; draft chung trong `command-studio/drafts.json`; lịch sử `history.json`; revision tăng mỗi lần apply (`_meta.revision`) + backup vào `logs/dashboard-backups`.
- Resolver: `resolveCommandConfig({root, commandName, contract, botId, threadId})` hợp nhất default → global → bot → group, trả effective + provenance từng field; field ngoài `allowedScopes` bị bỏ qua ở tầng thấp hơn. Handler nhận `context.commandConfig` qua dispatcher.
- Apply chain API (`/api/command-studio/*`): lưu nháp → schema validate → cross-field validate → preview/dry-run → backup → runtime adapter apply → audit/history. Rollback phục hồi snapshot từ history. Revision cũ khi apply → 409 `REVISION_CONFLICT`.
- Adapter: `default-config` cho mọi command; `sendtask-scheduler` dùng `SendTaskSchedulerManager` (`src/service-debug/scheduler/sendtask-scheduler-manager.js`) giữ job handles, diff/cancel/reschedule đúng job, rollback snapshot. 24 lịch giờ migrate 1:1 từ mảng cron hard-code trong `scheduler.js` sang `sendtask-defaults.js` (timezone `Asia/Ho_Chi_Minh`).
- Hot-reload: `POST /api/system/command-config/reload` với `commandName` sẽ gửi `reloadType:"command-studio"`; bot áp dụng qua `performRuntimeReload` → ACK trạng thái ready/failed kèm commandName+revision vào state file (đọc bằng `GET /api/system/command-config/reload-state`).
- Migration V1→V2: `migrateBehaviorProfileToV2()` map behavior profile sang field V2; bridge ngược `toBehaviorProfile()` nối cấu hình V2 vào behavior gate sẵn có.

