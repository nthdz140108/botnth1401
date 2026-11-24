import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const allowed = /^(src\/|scripts\/|dashboard\/(?:src\/|index\.html$|package(?:-lock)?\.json$)|rust\/|deploy\/|\.github\/workflows\/|package(?:-lock)?\.json$|index\.js$|bot\.js$)/;
function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
}
function runtimeData(name) {
  return /^src\/.*\.(?:json|jsonl|txt|db|sqlite|sqlite3)$/i.test(name) || /^src\/.*\/(?:data|data-send|data-sticker|removed-links)\//i.test(name);
}
function commit(repo, ref) {
  return git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
}
export function safePath(name) {
  const parts = name.split('/');
  return allowed.test(name) && !runtimeData(name) && !/(?:^|\/)migrations?\/.*\.sql$/i.test(name) && parts.every(p => p && p !== '.' && p !== '..' && !/[\\:<>"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
function ignored(name) {
  return name === 'DAY_LEN_VPS.bat' || /^(?:docs\/|tests\/)/.test(name) || /(?:^|\/)README(?:\.[^/]*)?$/i.test(name) || /\.md$/i.test(name);
}

function releaseBackedCatalog(repo, base, target, name) {
  const defaultsPath = 'src/utils/release-command-defaults.js';
  try {
    // Parse data, never execute target code on the deployment host.
    const source = git(repo, 'show', `${target}:${defaultsPath}`).toString('utf8').trim();
    const match = /^export default ([\s\S]+);$/.exec(source);
    if (!match) return false;
    const defaults = JSON.parse(match[1]);
    if (!Array.isArray(defaults)) return false;
    const previous = JSON.parse(git(repo, 'show', `${base}:${name}`).toString('utf8'));
    const next = JSON.parse(git(repo, 'show', `${target}:${name}`).toString('utf8'));
    const { commands: before, ...oldFields } = previous;
    const { commands: after, ...newFields } = next;
    if (!Array.isArray(before) || !Array.isArray(after) || !isDeepStrictEqual(oldFields, newFields)) return false;
    const oldNames = new Set(before.map(command => command.name));
    const newNames = new Set(after.map(command => command.name));
    if (oldNames.size !== before.length || newNames.size !== after.length) return false;
    const retained = after.filter(command => oldNames.has(command.name));
    if (!isDeepStrictEqual(before, retained)) {
      // Code-backed metadata can evolve between releases; never copy the
      // corresponding shared JSON or accept edits to unrelated/custom settings.
      if (!git(repo, 'ls-tree', base, '--', defaultsPath).length) return false;
      const oldSource = git(repo, 'show', `${base}:${defaultsPath}`).toString('utf8').trim();
      const oldMatch = /^export default ([\s\S]+);$/.exec(oldSource);
      const oldDefaults = oldMatch ? JSON.parse(oldMatch[1]) : [];
      if (!Array.isArray(oldDefaults) || retained.length !== before.length) return false;
      for (let index = 0; index < before.length; index++) {
        if (isDeepStrictEqual(before[index], retained[index])) continue;
        if (before[index].name !== retained[index].name
          || !oldDefaults.some(entry => isDeepStrictEqual(entry, before[index]))
          || !defaults.some(entry => isDeepStrictEqual(entry, retained[index]))) return false;
      }
    }
    const additions = after.filter(command => !oldNames.has(command.name));
    return additions.every(command => defaults.some(entry => isDeepStrictEqual(entry, command)));
  } catch {
    return false;
  }
}

export function buildPreview({ repo, base, target }) {
  base = commit(repo, base); target = commit(repo, target);
  const targetPaths = git(repo, 'ls-tree', '-r', '-z', '--name-only', target).toString('utf8').split('\0').filter(Boolean);
  const names = new Map();
  for (const name of targetPaths.filter(name => allowed.test(name) && !ignored(name) && !runtimeData(name) && !/(?:^|\/)migrations?\/.*\.sql$/i.test(name))) {
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
    if (['assets/json-data/command.json', 'mybot/defaultCommand.json'].includes(name) && code === 'M'
      && releaseBackedCatalog(repo, base, target, name)) continue;
    if (/(?:^|\/)migrations?\/.*\.sql$/i.test(name)) throw new Error(`Migration requires separate maintenance: ${name}`);
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
