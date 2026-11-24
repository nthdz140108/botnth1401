const fs = require('fs');
const path = require('path');
const root = process.cwd();
const files = [
  'dashboard/public/index.html',
  'dashboard/public/js/app.js',
  'dashboard/public/js/socket-client.js',
  'dashboard/public/css/style.css',
  'dashboard/server.js',
  'dashboard/package.json',
];
const badPatterns = [
  /Ã./,
  /Â./,
  /â[\x80-\xBF]/,
  /á[»º]/,
  /�/,
  /&#xFFFD;/,
  /\\uFFFD/,
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/,
];
let failed = false;
for (const rel of files) {
  const p = path.join(root, rel);
  const buf = fs.readFileSync(p);
  const text = buf.toString('utf8');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    console.error(`BOM:${rel}`);
    failed = true;
  }
  if (badPatterns.some((pattern) => pattern.test(text))) {
    console.error(`BAD:${rel}`);
    failed = true;
  }
  const withoutQueryStrings = text.replace(/[^\s"'`<>]*\?[A-Za-z][^\s"'`<>]*/g, '');
  if (/\?[A-Za-zÀ-ỹ]/.test(withoutQueryStrings)) {
    console.error(`LOSSY_COPY:${rel}`);
    failed = true;
  }
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) {
    console.error(`ENCODING:${rel}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log('dashboard utf8 check passed');
