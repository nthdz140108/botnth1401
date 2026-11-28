import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './json-state.js';

export function writePrivateJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.private-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function restoreRegistryJournal(journal, registryPath, root) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!registry || Array.isArray(registry) || typeof registry !== 'object') throw new Error('Invalid registry for recovery');
  for (const [key, before] of Object.entries(journal.before || {})) {
    if (before === null) delete registry[key]; else registry[key] = before;
  }
  // Restore data first; keep the pending journal until every write has succeeded.
  for (const [relative, before] of Object.entries(journal.files || {})) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid journal path');
    if (before === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.restore-${process.pid}`;
      try { fs.writeFileSync(temporary, Buffer.from(before, 'base64'), { mode: 0o600 }); fs.renameSync(temporary, file); }
      finally { fs.rmSync(temporary, { force: true }); }
    }
  }
  writeJsonAtomic(registryPath, registry);
}

// Caller holds the same registry lock used by every writer.
export function recoverRegistryJournals(root, registryPath) {
  const directory = path.join(root, 'mybot', 'state', 'transactions');
  if (!fs.existsSync(directory)) return [];
  const recovered = [];
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const file = path.join(directory, name);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.state === 'pending') { restoreRegistryJournal(journal, registryPath, root); recovered.push(journal.id); }
    else if (journal.state !== 'committed') throw new Error('Unknown transaction journal state');
    fs.unlinkSync(file);
  }
  return recovered;
}
