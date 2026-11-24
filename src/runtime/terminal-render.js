/**
 * Terminal render utilities for the PM2 monitor display.
 * No external dependencies — pure ANSI escape codes.
 */

/**
 * Pad a string to a given width, truncating or padding as needed.
 */
export function pad(str, width, char = ' ', direction = 'right') {
  const s = String(str || '');
  const len = stripAnsi(s).length;
  if (len >= width) return truncate(s, width);
  const spaces = width - len;
  if (direction === 'left') return char.repeat(spaces) + s;
  return s + char.repeat(spaces);
}

/**
 * Truncate a string to maxWidth, appending '…' if cut.
 */
export function truncate(str, maxWidth) {
  const s = String(str || '');
  if (stripAnsi(s).length <= maxWidth) return s;
  // Strip ANSI then truncate and re-truncate visible chars
  const stripped = stripAnsi(s);
  const visible = stripped.slice(0, Math.max(0, maxWidth - 1));
  return visible + '…';
}

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Format milliseconds into human-readable uptime string.
 */
export function formatUptime(ms) {
  if (!ms || ms <= 0) return '0s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/**
 * Format bytes into MB string with 1 decimal.
 */
export function formatMemory(bytes) {
  if (!bytes || bytes <= 0) return '0MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

export function clearScreen() { return '\x1b[2J\x1b[H'; }
export function cursorHome() { return '\x1b[H'; }
export function hideCursor() { return '\x1b[?25l'; }
export function showCursor() { return '\x1b[?25h\x1b[0m'; }
