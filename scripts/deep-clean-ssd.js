#!/usr/bin/env node
/**
 * Deep SSD Cleanup Tool (`scripts/deep-clean-ssd.js`) — Zero-Conflict 4-Tier Storage Edition
 *
 * Dọn dẹp triệt để rác trên SSD NHƯNG BẢO VỆ TUYỆT ĐỐI 100% dữ liệu các lệnh lưu trữ:
 * - TẦNG 1 (Bất tử): mybots.json, credentials/, group-settings.json, anti-config.json, reminders.json,
 *   scheduled-assets/, !learn (isTemporary: false), autoreply, whitelist, mute chưa hết hạn, video/, assets/resources/.
 * - TẦNG 2 (Cửa sổ thông minh):
 *   - !antiundo (message.json): giữ trọn vẹn 24 giờ gần nhất.
 *   - !locmem (*-days/YYYY-MM-DD.json): giữ trọn vẹn 35 ngày gần nhất, chỉ xóa ngày thứ 36+.
 *   - Chat tự học tạm (isTemporary: true): giữ 7 ngày & tối đa 300 câu/nhóm (bảo toàn 100% !learn).
 *   - cache-link.json: tỉa nhánh 3 tầng quá 7 ngày & giới hạn 2.000 link/nền tảng.
 * - TẦNG 3 (File tạm có khóa thuê bao TempFileLease):
 *   - Tôn trọng khóa đang chạy (isTempFileLeased) trên mọi tiến trình sống, không bao giờ xóa file đang tải/render.
 * - TẦNG 4 (Nhật ký xoay vòng cứng 10 MB):
 *   - Cắt gọn log routine & PM2 log trong .runtime/pm2/logs, giữ tối đa 1 bản sao lưu .runtime/backups.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { MYBOT_TEMP_PREFIXES, getDiskUsage } from "../src/runtime/disk-cleanup-service.js";
import { loadActiveCrossProcessLeases, isTempFileLeased } from "../src/utils/temp-lease-manager.js";
import { getConsecutiveCalendarDays, getVietnamDateKey } from "../src/service-debug/locmem/time-util.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");
const nowMs = Date.now();

// Bảo vệ chống lỗi write EIO trên Windows Server 2012 R2 conhost cũ
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

function safeLog(line = "") {
  try {
    process.stdout.write(`${line}\n`);
  } catch {}
}

const statsByCategory = {
  stateJunk: { label: "File trang thai & .tmp mo coi (qr-bootstrap >15m, reload, .cache)", files: 0, bytes: 0 },
  orphanInstances: { label: "Bot test mo coi & file di san cu (.sqlite, runtime-spool)", files: 0, bytes: 0 },
  locmemRetention: { label: "Phan vung !locmem qua han (>35 ngay, bao toan 35 ngay gan nhat)", files: 0, bytes: 0 },
  jsonCompaction: { label: "Toi uu JSON Tang 2 (message >24h, cache-link >7d, chat tam >7d)", files: 0, bytes: 0 },
  tempAndLogs: { label: "File tam khong co Lease (.runtime/temp) & Xoay vong Log", files: 0, bytes: 0 },
  oldBackups: { label: "Ban sao luu cu trung lap (.runtime/backups giu toi da 1 ban)", files: 0, bytes: 0 },
};

function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function getDirSizeAndCount(targetPath) {
  let bytes = 0;
  let files = 0;
  if (!fs.existsSync(targetPath)) return { bytes, files };
  try {
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) return { bytes: 0, files: 0 };
    if (st.isFile()) return { bytes: st.size, files: 1 };
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(targetPath)) {
        const sub = getDirSizeAndCount(path.join(targetPath, entry));
        bytes += sub.bytes;
        files += sub.files;
      }
    }
  } catch {}
  return { bytes, files };
}

function removeFileOrDir(targetPath, categoryKey) {
  if (!fs.existsSync(targetPath)) return;
  try {
    const info = getDirSizeAndCount(targetPath);
    if (info.files === 0 && info.bytes === 0 && !fs.existsSync(targetPath)) return;
    if (!dryRun) {
      const st = fs.lstatSync(targetPath);
      if (st.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
    }
    statsByCategory[categoryKey].files += Math.max(1, info.files);
    statsByCategory[categoryKey].bytes += info.bytes;
  } catch {}
}

function truncateFile(targetPath, categoryKey) {
  if (!fs.existsSync(targetPath)) return;
  try {
    const st = fs.statSync(targetPath);
    if (!st.isFile() || st.size === 0) return;
    if (!dryRun) {
      fs.truncateSync(targetPath, 0);
    }
    statsByCategory[categoryKey].files += 1;
    statsByCategory[categoryKey].bytes += st.size;
  } catch {}
}

function loadProtectedBotIds() {
  const protectedIds = new Set(["admin", "default"]);
  const mybotsPath = path.join(projectRoot, "mybot", "mybots.json");
  if (fs.existsSync(mybotsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mybotsPath, "utf8").replace(/^\uFEFF/, ""));
      for (const [key, val] of Object.entries(raw || {})) {
        protectedIds.add(String(key).trim());
        if (val && typeof val === "object") {
          if (val.uid) protectedIds.add(String(val.uid).trim());
          if (val.name) protectedIds.add(String(val.name).trim());
          if (val.globalUid) protectedIds.add(String(val.globalUid).trim());
        }
      }
    } catch {}
  }
  return protectedIds;
}

// 1. Dọn dẹp file trạng thái qr-bootstrap (>15 phút), reload (>60 giây), .tmp-* mồ côi
function cleanStateAndTempJunk() {
  const qrBootstrapDir = path.join(projectRoot, "mybot", "state", "qr-bootstrap");
  if (fs.existsSync(qrBootstrapDir)) {
    for (const f of fs.readdirSync(qrBootstrapDir)) {
      const full = path.join(qrBootstrapDir, f);
      try {
        const st = fs.statSync(full);
        if (nowMs - st.mtimeMs < 15 * 60_000) continue;
        removeFileOrDir(full, "stateJunk");
      } catch {}
    }
  }

  const reloadDir = path.join(projectRoot, "mybot", "state", "reload");
  if (fs.existsSync(reloadDir)) {
    for (const f of fs.readdirSync(reloadDir)) {
      const full = path.join(reloadDir, f);
      try {
        const st = fs.statSync(full);
        if (nowMs - st.mtimeMs < 60_000 && !f.includes(".tmp-")) continue;
        removeFileOrDir(full, "stateJunk");
      } catch {}
    }
  }

  const dirsWithTmp = [
    path.join(projectRoot, "mybot"),
    path.join(projectRoot, "mybot", "state"),
    path.join(projectRoot, "assets", "json-data"),
    path.join(projectRoot, "mybot", "json-data"),
  ];
  for (const d of dirsWithTmp) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.includes(".tmp-") || (f.startsWith(".tmp-") && f.endsWith(".tmp"))) {
        const full = path.join(d, f);
        try {
          if (nowMs - fs.statSync(full).mtimeMs > 5 * 60_000) {
            removeFileOrDir(full, "stateJunk");
          }
        } catch {}
      }
    }
  }

  for (const f of fs.readdirSync(projectRoot)) {
    if (f.startsWith(".tmp-qr-concurrency-")) {
      removeFileOrDir(path.join(projectRoot, f), "stateJunk");
    }
  }

  const cacheDir = path.join(projectRoot, ".cache");
  if (fs.existsSync(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir)) {
      if (/^qr_code-.*\.(png|jpg|webp)$/i.test(f)) {
        const full = path.join(cacheDir, f);
        try {
          if (nowMs - fs.statSync(full).mtimeMs > 15 * 60_000) {
            removeFileOrDir(full, "stateJunk");
          }
        } catch {}
      }
    }
  }

  const runtimeSubdirs = [
    path.join(projectRoot, ".runtime", "temp-scopes"),
    path.join(projectRoot, ".runtime", "gemini-web"),
    path.join(projectRoot, ".runtime", "admin-recovery", "sessions"),
  ];
  for (const sub of runtimeSubdirs) {
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub)) {
      const full = path.join(sub, f);
      try {
        if (sub.endsWith("sessions") && nowMs - fs.statSync(full).mtimeMs < 15 * 60_000) continue;
        removeFileOrDir(full, "stateJunk");
      } catch {}
    }
  }
}

// 2. Dọn Bot test mồ côi & di sản SQLite/Spool cũ không còn sử dụng
function cleanOrphanAndLegacyArtifacts(protectedIds) {
  const orphanFileDirs = [
    { dir: path.join(projectRoot, "mybot", "bots"), pattern: /^qr-bootstrap-.*\.json$/i },
    { dir: path.join(projectRoot, "mybot", "credentials"), pattern: /^qr-bootstrap-.*\.json$/i },
    { dir: path.join(projectRoot, "mybot", "settings"), pattern: /^groupSettings-qr-bootstrap-.*\.json$/i },
  ];

  for (const { dir, pattern } of orphanFileDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (pattern.test(f)) {
        const full = path.join(dir, f);
        try {
          if (nowMs - fs.statSync(full).mtimeMs > 15 * 60_000) {
            removeFileOrDir(full, "orphanInstances");
          }
        } catch {}
      }
    }
  }

  const testInstancePattern = /^(qr-bootstrap-.*|test[-_].*|--group|888999000|admin-test|bot-12345|bot-alpha|bot-beta|bot-shutdown-.*|bot-standalone-.*|bot999|child-bot-.*|child-healthy|child5|fleet-bot-.*|instance-bot|new-bot-uid-111|phase7-probe)$/i;
  const instancesDir = path.join(projectRoot, "mybot", "instances");
  if (fs.existsSync(instancesDir)) {
    for (const name of fs.readdirSync(instancesDir)) {
      if (protectedIds.has(name)) continue;
      if (testInstancePattern.test(name)) {
        removeFileOrDir(path.join(instancesDir, name), "orphanInstances");
      }
    }
  }

  // Xóa di sản runtime-spool và các file .sqlite cũ không còn dùng trong kiến trúc mới
  const spoolRoot = path.join(projectRoot, "mybot", "runtime-spool");
  if (fs.existsSync(spoolRoot)) {
    removeFileOrDir(spoolRoot, "orphanInstances");
  }

  const stateDir = path.join(projectRoot, "mybot", "state");
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir)) {
      if (/\.(sqlite|sqlite-wal|sqlite-shm)$/i.test(f) || /^(test-bot-.*\.json|bot-standalone-.*\.json)$/i.test(f)) {
        removeFileOrDir(path.join(stateDir, f), "orphanInstances");
      }
    }
  }

  if (fs.existsSync(instancesDir)) {
    for (const inst of fs.readdirSync(instancesDir)) {
      const dataDir = path.join(instancesDir, inst, "data");
      if (!fs.existsSync(dataDir)) continue;
      for (const f of fs.readdirSync(dataDir)) {
        if (/\.(sqlite|sqlite-wal|sqlite-shm)$/i.test(f) || /^(game-data\.json|database\.json|destiny-daily\.json)$/i.test(f)) {
          removeFileOrDir(path.join(dataDir, f), "orphanInstances");
        }
      }
    }
  }
}

// 3. Tỉa phân vùng ngày !locmem quá 35 ngày (giữ nguyên 35 ngày gần nhất)
function pruneLocmemPartitions() {
  const instancesDir = path.join(projectRoot, "mybot", "instances");
  if (!fs.existsSync(instancesDir)) return;

  const todayKey = getVietnamDateKey();
  const keepSet = new Set([todayKey, ...getConsecutiveCalendarDays(todayKey, 35)]);
  const dateRegex = /^(\d{4}-\d{2}-\d{2})\.json$/;

  for (const inst of fs.readdirSync(instancesDir)) {
    const dataDir = path.join(instancesDir, inst, "data");
    if (!fs.existsSync(dataDir)) continue;
    for (const sub of fs.readdirSync(dataDir)) {
      if (!sub.endsWith("-days")) continue;
      const storeDir = path.join(dataDir, sub);
      try {
        if (!fs.statSync(storeDir).isDirectory()) continue;
        for (const fileName of fs.readdirSync(storeDir)) {
          const m = dateRegex.exec(fileName);
          if (m && !keepSet.has(m[1])) {
            removeFileOrDir(path.join(storeDir, fileName), "locmemRetention");
          }
        }
      } catch {}
    }
  }
}

// 4. Tối ưu gọn JSON Tầng 2 (KHÔNG BAO GIỜ chạm dữ liệu Tầng 1 như !learn vĩnh viễn)
function compactTier2JsonFiles() {
  const compactWrite = (filePath, transformFn) => {
    if (!fs.existsSync(filePath)) return;
    try {
      const beforeSize = fs.statSync(filePath).size;
      if (beforeSize === 0) return;
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      const next = transformFn(parsed);
      const serialized = JSON.stringify(next);
      const afterSize = Buffer.byteLength(serialized, "utf8");
      if (afterSize < beforeSize) {
        if (!dryRun) {
          const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
          fs.writeFileSync(tmp, serialized, "utf8");
          fs.renameSync(tmp, filePath);
        }
        statsByCategory.jsonCompaction.files += 1;
        statsByCategory.jsonCompaction.bytes += beforeSize - afterSize;
      }
    } catch {}
  };

  // 4a. dashboard/observability/metrics.json
  compactWrite(path.join(projectRoot, "dashboard", "observability", "metrics.json"), (state) => {
    if (!state || typeof state !== "object") return state;
    const sampleCutoff = nowMs - 60 * 60 * 1000;
    const bucketCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
    return {
      samples: (Array.isArray(state.samples) ? state.samples : [])
        .filter((e) => new Date(e.timestamp).getTime() >= sampleCutoff)
        .slice(-240),
      minuteBuckets: (Array.isArray(state.minuteBuckets) ? state.minuteBuckets : []).filter(
        (e) => new Date(e.timestamp).getTime() >= bucketCutoff
      ),
      activities: (Array.isArray(state.activities) ? state.activities : [])
        .filter((e) => new Date(e.timestamp).getTime() >= bucketCutoff)
        .slice(-1000),
      warnings: Array.isArray(state.warnings) ? state.warnings : [],
    };
  });

  // 4b. cache-link.json (hỗ trợ đúng cấu trúc cây 3 tầng platform -> id -> quality)
  const metadataKeys = new Set(["title", "artist", "width", "height", "duration", "platform", "timestamp", "ts"]);
  compactWrite(path.join(projectRoot, "assets", "json-data", "cache-link.json"), (data) => {
    if (!data || typeof data !== "object") return data;
    const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
    for (const platform of Object.keys(data)) {
      const entries = data[platform];
      if (!entries || typeof entries !== "object") continue;
      for (const id of Object.keys(entries)) {
        const entry = entries[id];
        if (!entry || typeof entry !== "object") {
          delete entries[id];
          continue;
        }
        let subCount = 0;
        let hadSub = false;
        for (const [k, v] of Object.entries(entry)) {
          if (metadataKeys.has(k)) continue;
          if (v && typeof v === "object") {
            hadSub = true;
            const subTs = Number(v.timestamp || v.ts) || 0;
            if (!v.fileUrl || (subTs > 0 && subTs < cutoff)) {
              delete entry[k];
            } else {
              subCount += 1;
            }
          }
        }
        const topTs = Number(entry.timestamp || entry.ts) || 0;
        if (entry.fileUrl && topTs > 0 && topTs < cutoff) {
          if (subCount === 0) delete entries[id];
          else {
            delete entry.fileUrl;
            delete entry.timestamp;
          }
        } else if (!entry.fileUrl && (hadSub || subCount === 0) && subCount === 0) {
          delete entries[id];
        }
      }
      const rem = Object.keys(entries);
      if (rem.length > 2000) {
        for (const k of rem.slice(0, rem.length - 2000)) {
          delete entries[k];
        }
      }
    }
    return data;
  });

  // 4c. message.json (!antiundo giữ chuẩn 24 giờ gần nhất)
  const messageJsonFiles = [
    path.join(projectRoot, "logs", "message.json"),
    path.join(projectRoot, "logs", "admin", "message.json"),
  ];
  const instancesDir = path.join(projectRoot, "mybot", "instances");
  if (fs.existsSync(instancesDir)) {
    for (const inst of fs.readdirSync(instancesDir)) {
      messageJsonFiles.push(path.join(instancesDir, inst, "logs", "message.json"));
    }
  }
  const oneDayAgo = nowMs - 24 * 60 * 60 * 1000;
  for (const msgFile of messageJsonFiles) {
    compactWrite(msgFile, (diskData) => {
      if (!diskData || typeof diskData !== "object") return {};
      for (const k of Object.keys(diskData)) {
        if (diskData[k]?.timestamp && Number(diskData[k].timestamp) < oneDayAgo) {
          delete diskData[k];
        }
      }
      return diskData;
    });
  }

  // 4d. data-training.json (BẢO VỆ 100% isTemporary: false của !learn/!learnnow)
  const trainingFiles = [path.join(projectRoot, "assets", "json-data", "data-training.json")];
  if (fs.existsSync(instancesDir)) {
    for (const inst of fs.readdirSync(instancesDir)) {
      trainingFiles.push(path.join(instancesDir, inst, "data", "data-training.json"));
    }
  }
  const mybotJsonDir = path.join(projectRoot, "mybot", "json-data");
  if (fs.existsSync(mybotJsonDir)) {
    for (const f of fs.readdirSync(mybotJsonDir)) {
      if (f.startsWith("data_training-") && f.endsWith(".json")) {
        trainingFiles.push(path.join(mybotJsonDir, f));
      }
    }
  }
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  for (const tf of trainingFiles) {
    compactWrite(tf, (data) => {
      if (!data || typeof data !== "object") return data;
      for (const groupId of Object.keys(data)) {
        const listTrain = data[groupId]?.listTrain;
        if (!listTrain || typeof listTrain !== "object") continue;
        for (const q of Object.keys(listTrain)) {
          const raw = listTrain[q];
          const arr = Array.isArray(raw) ? raw : raw !== null && raw !== undefined ? [raw] : [];
          const permanent = arr.filter((it) => typeof it === "object" && it?.isTemporary === false);
          const temps = arr
            .filter((it) => typeof it === "string" || Boolean(it?.isTemporary))
            .filter((it) => {
              const ts = typeof it === "object" ? Number(it?.updatedAt || it?.createdAt || 0) : 0;
              return ts === 0 || ts >= sevenDaysAgo;
            })
            .slice(-Math.max(0, 20 - permanent.length));
          const merged = [...permanent, ...temps];
          if (merged.length === 0) delete listTrain[q];
          else listTrain[q] = merged;
        }
        const qKeys = Object.keys(listTrain);
        const tempOnly = qKeys.filter((q) => {
          const arr = Array.isArray(listTrain[q]) ? listTrain[q] : [listTrain[q]];
          return arr.every((it) => typeof it === "string" || Boolean(it?.isTemporary));
        });
        if (tempOnly.length > 300) {
          for (const q of tempOnly.slice(0, tempOnly.length - 300)) {
            delete listTrain[q];
          }
        }
      }
      return data;
    });
  }
}

// 5. Dọn Temp (tôn trọng TempFileLease) & cắt gọn Log routine / PM2 log
function cleanTempsAndRoutineLogs() {
  const leasedMap = loadActiveCrossProcessLeases({ projectRoot, now: nowMs });

  const tempDirs = [
    path.join(projectRoot, ".runtime", "temp"),
    path.join(projectRoot, "assets", "temp"),
    path.join(projectRoot, "temp"),
  ];
  const instancesDir = path.join(projectRoot, "mybot", "instances");
  if (fs.existsSync(instancesDir)) {
    for (const inst of fs.readdirSync(instancesDir)) {
      tempDirs.push(path.join(instancesDir, inst, "temp"));
    }
  }

  const walkSafeTemp = (dirPath) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.name === ".leases" || entry.name === ".gitkeep") continue;
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walkSafeTemp(full);
          if (!dryRun) {
            try {
              if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
            } catch {}
          }
        } else if (entry.isFile()) {
          if (isTempFileLeased(full, { projectRoot, now: nowMs, leasedMap })) continue;
          try {
            const st = fs.statSync(full);
            // Giữ các file cực mới vừa tạo < 5 phút ngay cả khi gọi thủ công để an toàn tuyệt đối
            if (nowMs - st.mtimeMs < 5 * 60_000) continue;
            removeFileOrDir(full, "tempAndLogs");
          } catch {}
        }
      }
    } catch {}
  };

  for (const td of tempDirs) {
    walkSafeTemp(td);
  }

  for (const f of fs.readdirSync(projectRoot)) {
    if (/^temp_\d+\.mp3$/i.test(f)) {
      removeFileOrDir(path.join(projectRoot, f), "tempAndLogs");
    }
  }

  // Dọn rác hệ thống cũ còn sót trong OS %TEMP% mang tiền tố MyBot/Puppeteer cũ (>30 phút)
  const sysTmp = os.tmpdir();
  if (fs.existsSync(sysTmp)) {
    try {
      const legacyPrefixes = [...MYBOT_TEMP_PREFIXES, "puppeteer_dev_"];
      for (const f of fs.readdirSync(sysTmp)) {
        if (legacyPrefixes.some((prefix) => f.startsWith(prefix))) {
          const full = path.join(sysTmp, f);
          try {
            if (nowMs - fs.statSync(full).mtimeMs >= 30 * 60_000) {
              removeFileOrDir(full, "tempAndLogs");
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Cắt gọn các file log routine trong logs/, mybot/instances/*/logs/, .runtime/pm2/logs/
  const walkAndTruncateLogs = (dirPath) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith("-backups") || entry.name === "backups") continue;
          walkAndTruncateLogs(full);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (lower.endsWith(".log") || lower === "message.txt") {
            truncateFile(full, "tempAndLogs");
          }
        }
      }
    } catch {}
  };

  walkAndTruncateLogs(path.join(projectRoot, "logs"));
  walkAndTruncateLogs(path.join(projectRoot, ".runtime", "pm2", "logs"));
  if (fs.existsSync(instancesDir)) {
    for (const inst of fs.readdirSync(instancesDir)) {
      walkAndTruncateLogs(path.join(instancesDir, inst, "logs"));
    }
  }
}

// 6. Dọn các bản Backup & Snapshot cũ trùng lặp (giữ tối đa 1 bản mới nhất)
function cleanOldBackups(protectedIds) {
  const pruneDirectoryKeepNewest = (dirPath, keepCount = 1) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      const entries = fs
        .readdirSync(dirPath)
        .map((name) => {
          const full = path.join(dirPath, name);
          try {
            const st = fs.statSync(full);
            return { name, full, mtimeMs: st.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const item of entries.slice(keepCount)) {
        removeFileOrDir(item.full, "oldBackups");
      }
    } catch {}
  };

  pruneDirectoryKeepNewest(path.join(projectRoot, ".runtime", "backups"), 1);
  pruneDirectoryKeepNewest(path.join(projectRoot, "logs", "dashboard-backups"), 1);
  pruneDirectoryKeepNewest(path.join(projectRoot, "assets", "data", "video-pool-snapshots"), 1);
  pruneDirectoryKeepNewest(path.join(projectRoot, "assets", "data", "video-pool-check", "reports"), 1);

  const profileBackupsDir = path.join(projectRoot, "logs", "profile-backups");
  if (fs.existsSync(profileBackupsDir)) {
    for (const botFolder of fs.readdirSync(profileBackupsDir)) {
      const fullBotFolder = path.join(profileBackupsDir, botFolder);
      if (!protectedIds.has(botFolder)) {
        removeFileOrDir(fullBotFolder, "oldBackups");
      } else {
        pruneDirectoryKeepNewest(fullBotFolder, 1);
      }
    }
  }
}

async function main() {
  safeLog("======================================================================");
  safeLog(
    dryRun
      ? "[DRY-RUN] QUET RAC SSD (CHE DO ZERO-CONFLICT BAO VE DU LIEU LENH)"
      : "[CLEANUP] DON DEP SSD THONG MINH (ZERO-CONFLICT 4-TIER STORAGE)"
  );
  safeLog("======================================================================");

  const diskBefore = await getDiskUsage(projectRoot);
  const protectedIds = loadProtectedBotIds();
  safeLog(`[PROTECT] Bao ve 100% ${protectedIds.size} dinh danh bot & toan bo du lieu Tang 1/Tang 2 con han`);

  cleanStateAndTempJunk();
  cleanOrphanAndLegacyArtifacts(protectedIds);
  pruneLocmemPartitions();
  compactTier2JsonFiles();
  cleanTempsAndRoutineLogs();
  cleanOldBackups(protectedIds);

  const diskAfter = await getDiskUsage(projectRoot);

  safeLog("");
  safeLog("[REPORT] BANG TONG KET DON DEP THEO HANG MUC:");
  safeLog("----------------------------------------------------------------------");
  let totalFiles = 0;
  let totalBytes = 0;
  for (const item of Object.values(statsByCategory)) {
    totalFiles += item.files;
    totalBytes += item.bytes;
    safeLog(
      `  * ${item.label.padEnd(64, " ")}: ${String(item.files).padStart(5, " ")} muc | ${formatBytes(item.bytes)}`
    );
  }
  safeLog("----------------------------------------------------------------------");
  safeLog(`[DONE] TONG CONG DA XU LY: ${totalFiles} file/thu muc - Giai phong: ${formatBytes(totalBytes)}`);
  if (diskBefore.total > 0 && diskAfter.total > 0) {
    safeLog(
      `[DISK] Dung luong trong SSD: ${formatBytes(diskBefore.free)} -> ${formatBytes(diskAfter.free)} (Dang dung: ${diskAfter.usedPercent}%)`
    );
  }
  safeLog("======================================================================");
}

main().catch((err) => {
  safeLog(`[ERROR] Loi khi chay don dep SSD: ${err?.message || err}`);
  process.exit(1);
});
