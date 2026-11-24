#!/usr/bin/env node
/**
 * Audit text encoding across production source files.
 * Detects mojibake, invalid UTF-8, U+FFFD, double-encoded sequences,
 * lossy ?-replacement, and BOM.
 *
 * Usage: node scripts/audit-text-encoding.js
 * Exits with code 1 if any violations are found.
 *
 * The detection core (scanText) is exported so tests can exercise it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

export const EXCLUSIONS = new Set([
  "node_modules", ".git", ".cache", "logs", "temp", "video",
  "mybot", "assets/data", "dashboard/dist", "dashboard-ui-verification",
  ".codebase-memory", ".kilo", ".superpowers", "docs", "scripts",
]);

export const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".ttf", ".woff",
  ".woff2", ".mp3", ".mp4", ".zip", ".sql", ".db", ".sqlite", ".bin",
  ".pdf", ".dat", ".pyc", ".o", ".obj", ".exe", ".dll",
]);

/**
 * Runtime/instance data files that live inside src but are not static
 * production strings (group settings, per-group member data).
 */
export const RUNTIME_DATA_PATHS = new Set([
  "src/service-debug/anti-service/config-anti.json",
]);

/**
 * Lead bytes of a double-encoded UTF-8 stream re-decoded as Latin-1.
 * A Latin-1 uppercase letter in range \u00C0-\u00DE that is NOT a valid
 * standalone Vietnamese character is unambiguous mojibake when followed
 * by a continuation byte. Valid uppercase Vietnamese letters (Â, Ê, Ô, Ã
 * in words like "ĐÃ" or "HÃY") are followed by ASCII letters or word
 * boundaries, so a following Latin-1 continuation byte means mojibake.
 */
const DOUBLE_ENCODE_RE =
  /Ã[\u00A0-\u00FF\u2018\u2019\u201A\u0192\u2021\u2026\u2020\u2030\u0160\u2039\u0152\u017D]|Æ[\u00A0-\u00FF\u2020\u2021\u0160\u2039\u0152]|Ä[\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2020\u2021\u2026]|Ð[\u00A0-\u00FF]|Þ[\u00A0-\u00FF]|â€|â€™|â€œ|â€\x9D|â€š|âˆ'|âŸ¨|âŸ©/g;

/**
 * Double-encoded fragments that include full words — kept because the
 * lead/continuation regex above cannot see them through the split into
 * lowercase + extended characters (e.g. "Lá»‡nh" = L á » ‡ n h).
 * Each fragment is unambiguous mojibake.
 */
const DOUBLE_ENCODE_FRAGMENTS = [
  "á»‡",    // ệ
  "á»‹",    // ị
  "áº¡n",   // ạn
  "á»™",    // ộ
  "á»Ÿ",    // ở
  "á»“",    // ồ
  "á»—",    // ỗ
  "á»•",    // ổ
  "á»‰",    // ỉ
  "á»«",    // ừ
  "áº¿",    // ế
  "Æ°á»Ÿc", // ước
  "Æ°á»›",  // ướ
  "Æ¡n",    // ơn
  "Äƒng",   // ăng
  "Ä‘Æ°á»£c", // được
  "Ä‘Ã£",   // đã
  "Ä‘á»ƒ",  // để
  "Ä‘á»™",  // độ
  "Ä‘á»“ng", // đồng
  "Ã´ng",   // ông
];

/**
 * A "lossy ?" is a question mark that replaced a Vietnamese diacritic
 * mid-word (e.g. "L?i khi t?i video t? API"). To avoid flagging URL
 * query strings (`?key=value`) and regex quantifiers (`jpe?g`), we only
 * flag lines that carry at least two letter-preceded question marks and
 * do not look like URLs or regex literals.
 */
function isLossyQuestion(line) {
  // Skip URL lines and regex literals outright.
  if (/:\/\//.test(line) || /www\./.test(line) || /\.php\?|\.asp\?|\.html\?/i.test(line)) {
    return false;
  }
  // A mid-word '?' is preceded by a letter and followed by a letter
  // (not '=', not a digit, not a URL delimiter).
  const midWordQ = /[A-Za-zÀ-ỹ]\?[A-Za-zÀ-ỹ]/g;
  const matches = line.match(midWordQ) || [];
  if (matches.length >= 2) {
    return true;
  }
  // Single mid-word '?' is suspicious only if the line contains a clear
  // Vietnamese token (a Vietnamese diacritic elsewhere) or the '?'-word is
  // followed by a Vietnamese vowel cluster. Keep this narrow to avoid
  // false positives on English words like "check?ing".
  return false;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Scan a text buffer and return a list of violations:
 *   { line, col, type, detail? }
 * `type` is one of: INVALID_UTF8, BOM, U+FFFD, DOUBLE_ENCODE, LOSSY_?
 */
export function scanText(text) {
  const violations = [];
  if (text.charCodeAt(0) === 0xfeff) {
    violations.push({ line: 1, col: 1, type: "BOM" });
  }
  const clean = stripBom(text);
  const lines = clean.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.includes("\uFFFD")) {
      violations.push({
        line: lineNum,
        col: line.indexOf("\uFFFD") + 1,
        type: "U+FFFD",
      });
      continue;
    }

    const doubleMatch = DOUBLE_ENCODE_RE.exec(line);
    if (doubleMatch) {
      violations.push({
        line: lineNum,
        col: doubleMatch.index + 1,
        type: "DOUBLE_ENCODE",
        detail: doubleMatch[0],
      });
      continue;
    }

    for (const fragment of DOUBLE_ENCODE_FRAGMENTS) {
      const idx = line.indexOf(fragment);
      if (idx !== -1) {
        violations.push({
          line: lineNum,
          col: idx + 1,
          type: "DOUBLE_ENCODE",
          detail: fragment,
        });
        break;
      }
    }

    if (violations.length && violations[violations.length - 1].line === lineNum) {
      continue;
    }

    const lossyMatch = isLossyQuestion(line);
    if (lossyMatch) {
      violations.push({
        line: lineNum,
        col: line.search(/[A-Za-zÀ-ỹ]\?/),
        type: "LOSSY_?",
        detail: line.slice(0, 80),
      });
    }
  }
  return violations;
}

/**
 * Scan a raw buffer: detect invalid UTF-8 at byte level, then run scanText.
 */
export function scanBuffer(buf) {
  let text;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    text = decoder.decode(buf);
  } catch {
    return [{ line: 1, col: 1, type: "INVALID_UTF8" }];
  }
  return scanText(text);
}

function scanFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return scanBuffer(buf);
}

export function collectTargetFiles(rootDir) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUSIONS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (entry.name.endsWith(".bak") || entry.name.endsWith(".bak0") || entry.name.endsWith(".js0")) continue;
        const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        if (RUNTIME_DATA_PATHS.has(rel)) continue;
        files.push(fullPath);
      }
    }
  };
  walk(path.join(rootDir, "src"));
  walk(path.join(rootDir, "dashboard", "public"));
  const serverFile = path.join(rootDir, "dashboard", "server.js");
  if (fs.existsSync(serverFile)) files.push(serverFile);
  for (const f of ["bot.js", "index.js", "preflight-admin.js", "qr-login-admin.js", "eslint.config.js"]) {
    const fp = path.join(rootDir, f);
    if (fs.existsSync(fp)) files.push(fp);
  }
  return files;
}

function runAudit() {
  const results = [];
  for (const file of collectTargetFiles(root)) {
    const violations = scanFile(file);
    if (violations.length > 0) {
      results.push({ file, violations });
    }
  }

  let exitCode = 0;
  for (const { file, violations } of results) {
    const relPath = path.relative(root, file);
    for (const v of violations) {
      const detail = v.detail ? ` (${v.detail})` : "";
      console.log(`${relPath}:${v.line}:${v.col} ${v.type}${detail}`);
      exitCode = 1;
    }
  }

  if (exitCode === 0) {
    console.log("Audit passed: no encoding violations found.");
  } else {
    console.log(`\nFound encoding violations in ${results.length} file(s).`);
  }

  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAudit();
}