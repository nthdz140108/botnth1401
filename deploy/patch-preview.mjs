import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const allowed = /^(src\/|scripts\/|dashboard\/(?:src\/|index\.html$|package(?:-lock)?\.json$)|rust\/|deploy\/|\.github\/workflows\/|package(?:-lock)?\.json$|index\.js$|bot\.js$)/;
function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
}
function commit(repo, ref) {
  return git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
}
export function safePath(name) {
  const parts = name.split('/');
  return allowed.test(name) && parts.every(p => p && p !== '.' && p !== '..' && !/[\\:<>"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
function ignored(name) {
  return /^(?:docs\/|tests\/)/.test(name) || /(?:^|\/)README(?:\.[^/]*)?$/i.test(name) || /\.md$/i.test(name);
}
export function buildPreview({ repo, base, target }) {
  base = commit(repo, base); target = commit(repo, target);
  const targetPaths = git(repo, 'ls-tree', '-r', '-z', '--name-only', target).toString('utf8').split('\0').filter(Boolean);
  const names = new Map();
  for (const name of targetPaths.filter(name => allowed.test(name) && !ignored(name))) {
    if (!safePath(name) || name.includes('\ufffd')) throw new Error(`Path requires manual review: ${name}`);
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.toLowerCase();
      if (names.has(key) && names.get(key) !== prefix) throw new Error(`Case collision: ${prefix}`);
      names.set(key, prefix);
    }
  }
  const entries = git(repo, 'diff', '--no-renames', '--name-status', '-z', base, target, '--').toString('utf8').split('\0');
  const files = [];
  for (let i = 0; i < entries.length - 1; i += 2) {
    const code = entries[i], name = entries[i + 1];
    if (ignored(name)) continue;
    if (!safePath(name)) throw new Error(`Path requires manual review: ${name}`);
    if (!['A', 'M', 'D'].includes(code)) throw new Error(`Unsupported change ${code}: ${name}`);
    if (code === 'D') { files.push({ status: 'delete', path: name }); continue; }
    const tree = git(repo, 'ls-tree', '-z', target, '--', name).toString('utf8');
    const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(tree);
    if (!match || !['100644', '100755'].includes(match[1])) throw new Error(`Unsupported mode or symlink: ${name}`);
    const blob = git(repo, 'cat-file', 'blob', match[2]);
    files.push({ status: code === 'A' ? 'add' : 'modify', path: name, mode: match[1], size: blob.length, sha256: createHash('sha256').update(blob).digest('hex') });
  }
  return { base, target, files };
}
