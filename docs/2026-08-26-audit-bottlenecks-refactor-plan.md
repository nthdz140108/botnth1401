# AUDIT HIỆU NĂNG & KẾ HOẠCH REFACTOR — BOT ZALO MYBOT-V3

> Ngày: 2026-08-26
> Phạm vi: Toàn bộ source bot Zalo (Node.js ESM, zca-js 2.1.2) tại thư mục gốc dự án.
> Phương pháp: Audit tĩnh 3 tầng (pipeline nhận/dispatch tin nhắn, logging + persistence JSON, media/services/multi-bot), mọi phát hiện đều có tham chiếu `file:line` đã xác thực trên mã nguồn hiện tại.
> Bối cảnh tải mục tiêu: hàng trăm nhóm chat hoạt động đồng thời.

---

# PHẦN 1 — AUDIT & BOTTLENECKS

## 1.1 Kiến trúc hiện tại (như đang chạy)

```
zca-js WebSocket (src/api-zalo/apis/listen.js)
  └─ ws.onmessage → JSON.parse → AES decrypt → emit("message") từng msg [KHÔNG await]
       └─ src/index.js:916 handler async → fire-and-forget promise chain
            └─ messagesUser (src/automations/event-send-msg.js:193-558): ~20 stage SERIAL
                auth snapshot → readWebConfig → groupInfo(10s TTL) → log file (sync)
                → updateUserRank (sync) → scold/prefix/mute/badword (serial)
                → handleCommand (241 commands, lazy registry)
                → 14 anti-rules (serial) → games → 11 reply-matchers (serial)
                → Gemini/auto-download/auto-join (Promise.all)
State: ~50+ file JSON, đọc/ghi sync rải khắp hot path.
Cùng process: Express web-server + Socket.IO + scheduler (~50 jobs node-schedule) + game timers.
```

Điểm mấu chốt về mô hình thực thi: `EventEmitter` gọi handler async **không await** ⇒ mỗi tin nhắn đến tạo ra một chuỗi promise độc lập, **đồng thời không giới hạn (unbounded concurrency)**. Không có bất kỳ cơ chế xếp hàng/throttle đầu vào nào.

## 1.2 Phát hiện nghiêm trọng (đã verify tại file:line)

### 🔴 Mức ĐỘ (sập/không chịu tải ở quy mô hàng trăm nhóm)

| # | Vị trí | Vấn đề |
|---|--------|--------|
| 1 | `src/service-debug/info-service/rank-chat.js:108-133` | **Mỗi tin nhắn nhóm**: đọc + parse TOÀN BỘ `rank-info.json` (tất cả nhóm × tất cả user), rồi ghi lại nguyên file **2 lần** (canonical + mirror legacy cho admin) bằng `writeFileSync` + `renameSync`. Chi phí tăng O(số nhóm × số thành viên)/message. Ở 300 nhóm × 50 user = hàng MB `JSON.stringify` + nhiều syscall block chặn event loop **trên mỗi dòng chat** |
| 2 | `src/api-zalo/apis/listen.js:175-190` + `src/index.js:916` | **Không có admission control**: mỗi message phát 1 promise chain ~20 stage không giới hạn. Storm 100 nhóm cùng nhắn = 100 pipeline đồng thời → RAM spike, event loop saturation, Zalo API 429. **`bottleneck` và `p-queue` đã cài trong package.json nhưng 0 nơi nào import trong `src/`** |
| 3 | `src/index.js:84-94` | **Một rejection lạc nào đó cũng giết cả bot** (`unhandledRejection` → `process.exit(1)` sau 1s). Với 241 command fire-and-forget làm side-effect nền (upload timeout, axios blip…), đây là bom hẹn giờ |
| 4 | `listen.js:73,123-126` + `index.js:976-984` | **1 frame WebSocket lỗi/garbage = exit(1)**. Tệ hơn: `getHeader()` nằm NGOÀI try (line 73) → ném thành `uncaughtException`. Ngược lại `emit("closed")` (line 65-68) **không ai đăng ký handler** → Zalo đóng socket sạch → process sống mà "điếc" vĩnh viễn (hiện tượng "bot tự dưng im mấy tiếng") |
| 5 | `src/service-debug/chat-bot/bot-learning/dqt-bot.js:144-158,264` | `findResponse` chạy cho **mọi tin nhắn thường** → re-read + parse toàn bộ `data-training.json` (file lớn dần vô hạn do bot tự học Q/A) mỗi message; match temp-response thì thêm 1 read + 1 write full-file |
| 6 | `src/utils/env.js:200-211` + `src/utils/group-settings-store.js:12` | `getBotInfoSync()` = `existsSync` + `readFileSync` + parse config bot chạy **mỗi lần truy cập settings** (≥2 lần/message); auth snapshot đọc 5–7 file JSON sync/lần gọi (`instance-authorization.js`, `command.js:1222`) |

### 🟠 Mức CAO

- **Memory leak / growth không chặn**:
  - `src/utils/message-cache.js:115` — giữ 24h toàn bộ traffic mọi nhóm trong RAM + **rewrite full `message.json` mỗi 5 giây** (`JSON.stringify(data,null,2)`).
  - `src/utils/link-platform-cache.js:9-18` — cache media-link KHÔNG TTL/eviction.
  - `src/commands/command-behavior-context.js:51` — `CooldownLedger.usage`: bucket key không bao giờ bị xóa (chỉ filter giá trị về `[]`).
  - `src/utils/image-buffer-cache.js` — Map Buffer ảnh không cap byte.
  - `src/service-debug/info-service/group-info-data.js:4` — cache groupInfo không evict entry (giữ member list đầy đủ per group).
- **CPU block main thread**:
  - nsfwjs `model.classify()` + `canvas.loadImage` chạy ngay trên V8 thread (`anti-nude.js:36,128-132`) — TF.js CPU kernel đóng băng loop trăm ms/lần; video check = 3 lần ffmpeg extract + classify tuần tự.
  - Welcome/kick/goodbye render node-canvas sync inline (`events-group.js:84,127,183,208,245,290`).
  - `/api/commands/scan` chạy `spawnSync("where"/"which")` × dependency của 241 command **trên main thread của bot** khi dashboard poll (`dashboard/command-scanner.js:116-119`).
- **Buffer cả file media vào heap**: `api-zalo/apis/uploadAttachment.js:126` `fs.promises.readFile` nguyên file video/audio rồi mới slice chunk 3MB; `utils.js:402-434` `getMd5LargeFileFromUrl` kéo cả file remote về arraybuffer chỉ để tính MD5. N send song song = N × filesize RAM.
- **Race condition đa writer**: Dashboard process ghi trực tiếp `command.json` / `group_settings.json` / `config.json` trong khi bot giữ cache Map và rewrite đè nguyên file. `proper-lockfile` đã cài, **0 import**. Bằng chứng thực địa: hàng chục rác `.tmp-*-<pid>-<ts>` trong `mybot/` — writer chết giữa rename; port allocation TOCTOU.
- **Logging sync, không rotate**: `appendFileSync` mỗi message (`io-json.js:207-213`); thậm chí `mkdirSync` recursive mỗi lần ghi log auth (`authorization-log.js:46`); `Intl.DateTimeFormat` tạo mới mỗi dòng (`terminal-log.js:52`). Không có bất kỳ rotation/truncation nào trong `src/`.

### 🟡 Mức TRUNG BÌNH

- Serial await chains làm phình latency floor: 14 anti-rules nối tiếp (`message-protection.js:17-38`), 11 reply-handlers nối tiếp (`service-debug/service.js:81-117`).
- Games: `setInterval` 1Hz **per nhóm đang chơi** (`tai-xiu.js:341`, `vietlott655.js:361`, Caro…) — O(nhóm) timers; fishing/caro vẫn `writeFileSync` sync per event (`fishing.js:27,39,109,116`, `carobot-score.js:25`) trong khi `game-manager.js` đã làm đúng dirty-flush 5s.
- MySQL pool mặc định (không `connectionLimit`, không timeout — limit 10), DB fail-open → payout lỗi lặng lẽ khi XAMPP tắt.
- Web-server trong bot process: `requireSocketAdmin` tin flag **client tự khai** `handshake.auth.isAdmin === true`; HTTP API không auth (shutdown chỉ check body `"SHUTDOWN"`); `sendMessageAll` loop tuần tự trên socket thread của bot.
- Mirror 3 bản groupSettings (`assets/data/group_settings.json` + root `groupSettings.json` + canonical) cùng bị nhiều process ghi không khóa; busy-wait `while (Date.now()-start < 10) {}` trong `group-settings-store.js:83` là dấu hiệu tranh chấp rename.
- Không reconnect khi WS đóng sạch (cmd 3000 "another connection").

### Con số tổng hợp

Một tin nhắn nhóm điển hình = **8–9 sync fs ops**; có training-hit ≈ 11; nhóm mới lần đầu ≈ 17 ops; cộng thêm 1 full-rewrite `message.json` toàn hệ thống mỗi 5 giây. Các file bị ghi lại nhiều nhất theo thứ tự:

1. `mybot/instances/<uid>/data/rank-info.json` — mỗi message nhóm
2. `assets/json-data/rank-info.json` (mirror legacy) — mỗi message nhóm
3. `logs/message.json` — full rewrite mỗi 5s (24h window toàn hệ thống)
4. `assets/data/group_settings.json` + root `groupSettings.json` — mỗi toggle/mute-expiry/rename
5. `cache-link.json` + anti-config — mỗi 5s khi dirty

---

# PHẦN 2 — ĐỀ XUẤT CÔNG NGHỆ & KIẾN TRÚC

## 2.1 Ràng buộc thực tế

Zalo user-bot (zca-js QR-login) = **1 WS session/tài khoản**, không scale ngang listener được. Vì vậy mục tiêu là: **1 process bot chịu được throughput cao + tách hết thứ nặng ra ngoài**, chứ không phải cluster bot. Lưu ý: Node `cluster` module **không phù hợp** (WS session duy nhất + state JSON chia sẻ).

## 2.2 Kiến trúc đích

```
┌─────────────────────── BOT PROCESS (chỉ I/O + routing) ───────────────────────┐
│ zca-js Listener                                                               │
│   └─ InboundGate: keyed-queue (shard theo threadId)                           │
│        • cùng nhóm = tuần tự (giữ thứ tự)                                     │
│        • khác nhóm = song song, tổng concurrency chặn (vd 16)                 │
│        • backlog vượt ngưỡng → DROP + metric (backpressure)                   │
│   └─ Middleware pipeline (parallel-safe stages chạy allSettled)               │
│   └─ Hot cache: LRU/TTL cho settings, auth, groupInfo, training-data          │
│   └─ Batched writers: rank counters, message-log (dirty-flag + interval)      │
│   └─ Outbound: Bottleneck limiter + Circuit breaker cho Zalo API              │
└──────┬───────────────────────────────┬────────────────────────────────────────┘
       │ worker_threads (piscina)      │ HTTP/socket tới service riêng
┌──────▼──────────────┐   ┌─────────────▼──────────────────────────────────┐
│ CPU WORKER POOL     │   │ MEDIA SERVICE (process riêng)                  │
│ nsfwjs classify     │   │ BullMQ queue: youtube-dl, ffmpeg convert,      │
│ canvas render       │   │ upload chunked (stream từ disk, không buffer   │
│ OCR/heavy transform │   │ heap), TTS concat                              │
└─────────────────────┘   │ concurrency cap 2-3 job/machine                │
                          └────────────────────────────────────────────────┘
State tier:
  • Config nhỏ (command/web/group settings): JSON + mtime-cache + atomic write
    (GIỮ NGUYÊN — hợp lý cho config, dashboard đang đọc trực tiếp)
  • Data lớn/nóng (rank, message log, cooldown, violations): SQLite (better-sqlite3,
    WAL) — hết race, hết rewrite-full-file, query /top O(log n)
  • Đa bot đa máy trong tương lai: Redis (cache + BullMQ + pubsub). Một máy
    vài bot thì SQLite + BullMQ (SQLite backend) là đủ, chưa cần Redis.
Logging: pino (async, sonic-boom, pino-roll rotate) — stdout/file NDJSON.
Observability: prom-client (event-loop lag, queue depth, API latency, drop count).
```

## 2.3 Design Patterns áp dụng cụ thể

| Pattern | Áp vào đâu |
|---|---|
| **Sharded Work Queue** (per-key serialization + global bound) | Inbound messages — phần quan trọng nhất |
| **Middleware/Pipeline** | Thay chuỗi serial ~20 stage; các check độc lập chạy `Promise.allSettled` |
| **Repository** | Interface `RankStore`/`SettingsStore`: hôm nay JSON, mai SQLite swap 1 chỗ |
| **Write-Behind Cache (batched flush)** | Rank counters, message log, training data |
| **Circuit Breaker + Token Bucket** | Outbound Zalo API (opossum + bottleneck — bottleneck đã có sẵn trong node_modules) |
| **Saga-lite (idempotent settlement)** | Game payout đã làm đúng ở `game-runtime.js` — nhân rộng sang fishing/caro |

---

# PHẦN 3 — KẾ HOẠC REFACTOR TỪNG BƯỚC (kèm code)

## Phase 0 — Đo trước khi cắt (nửa ngày)

Thêm event-loop lag monitor để có baseline:

```js
// src/utils/eventloop-monitor.js
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

export async function startLoopMonitor({ intervalMs = 10_000 } = {}) {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let lastMem = process.memoryUsage().heapUsed;
  while (true) {
    await sleep(intervalMs);
    h.disable();
    const mem = process.memoryUsage();
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      loopP99ms: h.percentile(99) / 1e6,
      loopMaxMs: h.max / 1e6,
      heapMb: +(mem.heapUsed / 1048576).toFixed(1),
      heapDeltaMb: +((mem.heapUsed - lastMem) / 1048576).toFixed(1),
      rssMb: +(mem.rss / 1048576).toFixed(0),
    }));
    h.enable(); lastMem = mem.heapUsed;
  }
}
```

Chạy vài giờ với tải thật: nếu `loopP99ms` thường xuyên > 50–100ms là đúng chẩn đoán sync-I/O bên dưới.

## Phase 1 — Giữ cho process không chết + không tràn (ROI cao nhất, 1–2 ngày)

### 1.1 Inbound Gate — sharded queue thay fire-and-forget

```js
// src/core/inbound-gate.js
import PQueue from "p-queue";

export function createInboundGate({
  shards = 16,          // 16 pipeline song song tối đa
  maxBacklog = 500,     // quá 500 task chờ => hệ thống quá tải, drop
  onDrop = null,
}) {
  const queues = Array.from({ length: shards }, () => new PQueue({ concurrency: 1 }));
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

  return {
    /** task nhận (threadId, fn) — cùng threadId chạy tuần tự, khác thread chạy song song */
    submit(threadId, fn, label = "") {
      const q = queues[hash(String(threadId)) % shards];
      if (q.size >= Math.ceil(maxBacklog / shards)) {
        onDrop?.({ threadId, label, backlog: q.size });
        return false;
      }
      q.add(fn).catch((e) => console.error(`[gate:${label}]`, e?.message || e));
      return true;
    },
    stats: () => ({ pending: queues.reduce((a, q) => a + q.size + q.pending, 0) }),
  };
}

// --- wiring trong src/index.js, thay listener.on("message", ...) ---
const gate = createInboundGate({ onDrop: (d) => logManagerBot(`[DROP] ${d.label} ${d.threadId}`) });
listener.on("message", (message) => {
  gate.submit(message.threadId, () => messagesUser(apiInstance, message), "msg");
});
listener.on("group_event", (ev) => gate.submit(ev.threadId, () => handleGroupEvent(apiInstance, ev), "grp"));
// undo/reaction tương tự
```

Kết quả: storm 200 nhóm → tối đa 16 pipeline chạy đồng thời, thứ tự trong từng nhóm được giữ, RAM phẳng, không còn 200×uploadAttachment cùng lúc. Đây là điểm dùng `p-queue` **đã có sẵn** trong package.json.

### 1.2 Sửa chính sách lỗi (đừng tự sát vì 1 frame)

```js
// index.js — THAY 4 handler hiện tại
process.on("unhandledRejection", (err) => {
  logManagerBot(`[REJECT] ${err?.message}`);
  terminalLog({ scope: "runtime", level: "error", title: "UnhandledRejection",
    lines: [err?.stack || String(err)] });          // LOG, KHÔNG exit
});

let fatalArmed = false;
process.on("uncaughtException", (err) => {
  // lỗi native/heap mới chết; lỗi JS thường thì log và sống tiếp
  const fatal = ["ERR_MEMORY_ALLOCATION_FAILED", "heap out of memory"].some(s =>
    String(err?.message).includes(s));
  logManagerBot(`[EXC${fatal ? "-FATAL" : ""}] ${err?.stack || err?.message}`);
  if (fatal && !fatalArmed) { fatalArmed = true; setTimeout(() => process.exit(1), 1000); }
});
```

```js
// listen.js:73 — đưa getHeader VÀO try (fix crash ngoài try hiện tại)
this.ws.onmessage = async (event) => {
  const { data } = event;
  if (!(data instanceof Buffer)) return;
  try {
    const [version, cmd, subCmd] = getHeader(data.subarray(0, 4));  // ← vào try
    // ... phần decode/parse giữ nguyên
  } catch (error) {
    logManagerBot(`[WS-DECODE] ${error.message}`);   // ← bỏ emit("error")
    return;                                          // bỏ frame hỏng, tiếp tục
  }
};
```

```js
// index.js — bắt "closed" + reconnect có backoff (hiện không ai nghe)
listener.on("closed", () => {
  logManagerBot("[WS] closed — reconnect sau 5s");
  setTimeout(() => startListenerWithRetry(apiInstance).catch(e =>
    logManagerBot(`[WS] reconnect fail: ${e.message}`)), 5000);
});
```

### 1.3 Outbound rate-limit (tránh 429/session flag)

```js
import Bottleneck from "bottleneck";
const sendLimiter = new Bottleneck({ maxConcurrent: 5, minTime: 250 });

const _sendMessage = api.sendMessage.bind(api);
api.sendMessage = (...args) => sendLimiter.schedule(() => _sendMessage(...args));
// làm tương tự sendMessage/sendVoice/sendVideo/uploadAttachment ngay sau login
```

## Phase 2 — Diệt sync I/O trên hot path (2–3 ngày)

### 2.1 Viết lại `rank-chat.js` thành Write-Behind Store (quan trọng nhất)

```js
// src/service-debug/info-service/rank-store.js
import fs from "fs";
import path from "path";
import { getActiveRuntimeContext } from "../../utils/io-json.js";
import { getProjectRoot } from "../../utils/env.js";

class RankStore {
  constructor() { this.data = null; this.dirtyGroups = new Set(); this.flushTimer = null; }

  #load() {
    if (this.data) return this.data;
    try {
      const raw = fs.readFileSync(this.#path(), "utf8");
      this.data = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (!this.data?.groups) this.data = { groups: {} };
    } catch { this.data = { groups: {} }; }
    this.#scheduleFlush();
    return this.data;
  }

  #path() {
    const ctx = getActiveRuntimeContext();
    const p = ctx.rankInfoPath || path.join(ctx.dataDir || "", "rank-info.json");
    return path.isAbsolute(p) ? p : path.resolve(getProjectRoot(), p);
  }

  /** O(1) trên memory — KHÔNG đụng đĩa */
  increment(groupId, userId, userName, nameGroup) {
    const data = this.#load();
    const g = data.groups[groupId] ??= { users: [] };
    if (nameGroup && g.nameGroup !== nameGroup) { g.nameGroup = nameGroup; }
    let u = g.users.find(x => x.UID === userId);
    if (!u) { u = { UserName: userName || "Thành viên", UID: userId, Rank: 0 }; g.users.push(u); }
    u.Rank++;
    if (userName) u.UserName = userName;
    this.dirtyGroups.add(groupId);
  }

  snapshot(threadId) {           // cho /top — đọc từ RAM
    return [...(this.#load().groups[threadId]?.users ?? [])]
      .filter(u => Number(u.Rank) > 0).sort((a, b) => b.Rank - a.Rank);
  }

  resetAll() { this.data = { groups: {} }; this.#flushNow(); }

  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { try { this.#flushNow(); } catch (e) { console.error(e); } }, 10_000);
    this.flushTimer.unref();
    process.once("SIGINT", () => this.#flushNow());
    process.once("SIGTERM", () => this.#flushNow());
  }

  #flushNow() {                                   // ghi 10s/lần thay vì 2 lần/message
    if (this.dirtyGroups.size === 0 || !this.data) return;
    const dest = this.#path();
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data));   // bỏ pretty-print: nhỏ hơn ~40%
    fs.renameSync(tmp, dest);
    this.dirtyGroups.clear();                            // mirror legacy ghi kèm ở đây nếu ctx.uid==="admin"
  }
}
export const rankStore = new RankStore();

// event-send-msg.js:379 đổi 1 dòng:
// updateUserRank(...)  →  rankStore.increment(groupId, senderId, senderName, nameGroup)
// handleRankCommand đổi readRankInfo() → rankStore.snapshot(threadId)
// midnight job gọi rankStore.resetAll()
```

Hiệu quả: từ **~6 syscall + megabytes stringify mỗi message → 0**, còn 1 write/10s.

### 2.2 Cache mtime cho các config nhỏ (áp cho `env.js`, `io-json.readWebConfig`, admin lists)

```js
// src/utils/cached-json.js
import fs from "fs";
const store = new Map();                       // path -> {mtimeMs, value, at}
const TTL = 5000;

export function readJsonCached(filePath) {
  let st; try { st = fs.statSync(filePath); } catch { return null; }
  const hit = store.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && Date.now() - hit.at < TTL) return hit.value;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    store.set(filePath, { mtimeMs: st.mtimeMs, value, at: Date.now() });
    return value;
  } catch { return null; }
}
```

StatSync rẻ hơn đọc+parse hàng chục lần; dashboard ghi file xong bot tự thấy trong ≤5s (giải luôn mâu thuẫn cache hai đầu hiện nay). Wrap `getBotInfoSync`, `readWebConfig`, `readAdmins*`, `loadTrainingData` bằng hàm này.

### 2.3 Logger async + rotate (thay mọi `appendFileSync`)

```bash
npm i pino pino-roll
```

```js
// src/utils/logger.js
import pino from "pino";
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: ["cookie", "*.cookie", "imei"],
}, pino.destination({ dest: "logs/app.ndjson", sync: false, minLength: 4096, mkdir: true }));

// io-json.js: logManagerBot/logMessageToFile giữ signature cũ, thân đổi thành:
logger.info({ type, data }, type === "message" ? "msg" : "mgr");
// authorization-log.js: bỏ mkdirSync-per-call (mkdir: true lo rồi), đổi appendFileSync → logger.warn/info
```

`sync:false` = ghi qua buffer nội bộ, không bao giờ chặn loop; thêm cron xoá file >50MB hoặc dùng `pino-roll` xoay theo dung lượng/ngày. Xoá luôn bug `\n` kép trong `logMessageToFile` hiện tại (input đã có `\n`, append thêm `\n\n`).

## Phase 3 — Chặn memory leak (1 ngày)

- `message-cache.js`: đổi object thành `new LRUCache({ max: 20_000, ttl: 24*3600e3 })` (lru-cache đã có trong deps) — bỏ luôn cron rewrite-full-file 5s; flush chỉ entries dirty.
- `link-platform-cache.js`: thêm TTL 7 ngày + max entries.
- `CooldownLedger.usage`: sau filter, `if (arr.length === 0) usage.delete(bucket)`.
- `image-buffer-cache.js`: thêm byte budget (ví dụ 64MB) — track tổng size khi set/delete.
- `groupInfoCache`: `max: 500, ttl: 30_000`.

## Phase 4 — Đưa CPU work ra khỏi main thread (2 ngày)

Dùng **piscina** cho 2 chỗ nặng nhất (pattern worker đã có sẵn trong repo qua `youtube-download-worker.js`):

```bash
npm i piscina
```

```js
// workers/nsfw-worker.js
let model;
export async function classify(buf) {
  model ??= await load();                      // nsfwjs load()
  const { loadImage, createCanvas } = await import("canvas");
  const img = await loadImage(buf);
  const cvs = createCanvas(img.width, img.height);
  cvs.getContext("2d").drawImage(img, 0, 0);
  const res = await model.classify(cvs);
  return res[0];
}
// anti-nude.js: thay model.classify(cvs) bằng:
// const result = await nsfwPool.run({ buf }, { name: "classify" })
```

Tương tự cho render ảnh welcome/kick (`events-group.js`). ffmpeg/youtube-dl vốn là process ngoài — chỉ cần bọc queue giới hạn 2–3 job đồng thời (PQueue).

## Phase 5 — SQLite cho dữ liệu nóng (2–3 ngày, làm sau khi 2 phase trên ổn)

```bash
npm i better-sqlite3
```

- Bảng `messages(thread_id, sender_id, ts, content_hash)` thay `message.json` 24h — query undo/anti-spam bằng index, ghi WAL bất đồng bộ.
- Bảng `rank(thread_id, uid, rank)` thay rank-info.json hẳn; `/top` = 1 indexed query.
- Bảng `violations` cho anti-spam/badword.
- Giữ JSON cho config/command/settings (dashboard đang đọc trực tiếp — không phá vỡ hợp đồng đó).

## Phase 6 — Tách media service + siết web API (khi muốn scale xa)

1. Đưa youtube-dl/ffmpeg/upload thành **service riêng** nhận việc qua BullMQ (backend SQLite hoặc Redis); bot chỉ `addJob()` + nhận callback qua webhook nội bộ. Upload đổi `readFile` → `fs.createReadStream` (fix heap spike `uploadAttachment.js:126`).
2. Web-server: bỏ trust `handshake.auth.isAdmin` → token thật (`Authorization: Bearer <env>`); bind mặc định `127.0.0.1`.
3. `spawnSync` trong CommandScanner → cache kết quả theo mtime node_modules, chạy nền lúc idle.

## Thứ tự khuyến nghị

| Giai đoạn | Công sức | Kết quả kỳ vọng |
|---|---|---|
| Phase 1 (gate + error policy) | ~1–2 ngày | Không chết vì frame lỗi; không tràn khi storm; hết 429 |
| Phase 2 (rank store + cached-json + pino) | ~2–3 ngày | Loop p99 giảm mạnh; disk op/message từ ~9 → ~0 |
| Phase 3 (LRU bounds) | ~1 ngày | Heap phẳng theo thời gian, hết leak |
| Phase 4 (worker pool) | ~2 ngày | Hết freeze khi classify/render |
| Phase 5–6 | ~1 tuần | Sạch race đa-writer, sẵn sàng đa bot/máy |

Phase 1 + 2 self-contained, không đụng 241 command, có thể áp dụng ngay.
