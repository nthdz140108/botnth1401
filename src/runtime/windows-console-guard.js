import os from "node:os";

const UNICODE_PUNCT_MAP = {
  "\u2014": "--", // —
  "\u2013": "-",  // –
  "\u2026": "...", // …
  "\u2192": "->", // →
  "\u2190": "<-", // ←
  "\u2714": "[OK]", // ✔
  "\u2713": "[OK]", // ✓
  "\u2716": "[X]", // ✖
  "\u2717": "[X]", // ✗
  "\u2022": "*",  // •
  "\u00b7": ".",  // ·
  "\u201c": '"',
  "\u201d": '"',
  "\u2018": "'",
  "\u2019": "'",
};

/**
 * Detects legacy Windows consoles (Windows 7 / 8 / Server 2008 R2 / Server 2012 / Server 2012 R2 = NT 6.x)
 * where `conhost.exe` v1 + Raster Fonts can throw `Error: write EIO` (errno -4070) when multi-byte UTF-8
 * sequences are written to console streams.
 */
export function isLegacyWindowsConsole({
  platform = process.platform,
  release = os.release(),
  env = process.env,
} = {}) {
  if (env?.MYBOT_ASCII_CONSOLE === "1") return true;
  if (env?.MYBOT_ASCII_CONSOLE === "0") return false;
  if (platform !== "win32") return false;
  return /^6\./.test(String(release || ""));
}

/**
 * Transliterates Vietnamese diacritics, box-drawing characters, and smart punctuation
 * into clean, readable 7-bit ASCII while preserving newlines, tabs, and ANSI CSI sequences.
 */
export function toAsciiSafeConsoleText(input) {
  if (typeof input !== "string" || input.length === 0) return String(input ?? "");
  let text = input
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  text = text.replace(/[\u2014\u2013\u2026\u2192\u2190\u2714\u2713\u2716\u2717\u2022\u00b7\u201c\u201d\u2018\u2019]/g, (ch) => UNICODE_PUNCT_MAP[ch] || "");
  text = text.replace(/[─━═]/g, "-");
  text = text.replace(/[│┃║]/g, "|");
  text = text.replace(/[┌┍┎┏╔╒╓╦┬┼┐┑┒┓╗╕╖└┕┖┗╚╘╙╩┴┘┙┚┛╝╛╜]/g, "+");
  text = text.replace(/[█▀▄▌▐]/g, "#");

  // Preserve TAB (\x09), LF (\x0A), CR (\x0D), ESC (\x1B), and printable ASCII (\x20-\x7E)
  return text.replace(/[^\x09\x0A\x0D\x1B\x20-\x7E]/g, "");
}

function guardSingleWritableStream(stream, { asciiSanitize = false } = {}) {
  if (!stream || typeof stream.write !== "function" || stream.__mybotConsoleGuarded) {
    return;
  }
  stream.__mybotConsoleGuarded = true;

  if (stream._writableState) {
    stream._writableState.autoDestroy = false;
    stream._writableState.emitClose = false;
  }

  if (typeof stream.on === "function") {
    stream.on("error", (err) => {
      const code = err?.code;
      if (code === "EIO" || code === "EPIPE" || code === "EINVAL" || code === "EBADF") {
        if (stream._writableState) {
          stream._writableState.errorEmitted = false;
          stream._writableState.errored = null;
          stream._writableState.destroyed = false;
        }
        return;
      }
    });
  }

  if (!asciiSanitize) {
    return;
  }

  const origWrite = stream.write.bind(stream);
  stream.write = function safeLegacyConsoleWrite(chunk, encoding, cb) {
    let safeChunk = chunk;
    try {
      if (typeof chunk === "string") {
        safeChunk = toAsciiSafeConsoleText(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        safeChunk = Buffer.from(toAsciiSafeConsoleText(chunk.toString("utf8")), "ascii");
      } else if (chunk instanceof Uint8Array) {
        safeChunk = Buffer.from(toAsciiSafeConsoleText(Buffer.from(chunk).toString("utf8")), "ascii");
      }
    } catch {
      // Keep original chunk on unexpected conversion failure
    }

    try {
      if (typeof encoding === "function") {
        return origWrite(safeChunk, encoding);
      }
      return origWrite(safeChunk, encoding, cb);
    } catch {
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      return false;
    }
  };
}

/**
 * Installs EIO/EPIPE crash protection on stdout/stderr (all platforms) and enables
 * automatic UTF-8 -> ASCII transliteration on legacy Windows Server 2012 R2 consoles.
 */
export function installWindowsConsoleSafety({
  stdout = process.stdout,
  stderr = process.stderr,
  forceAscii = undefined,
} = {}) {
  const asciiSanitize = typeof forceAscii === "boolean" ? forceAscii : isLegacyWindowsConsole();
  guardSingleWritableStream(stdout, { asciiSanitize });
  guardSingleWritableStream(stderr, { asciiSanitize });
  return { asciiSanitize };
}

export default installWindowsConsoleSafety;
