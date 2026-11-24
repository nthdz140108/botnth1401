import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseIncrementalArgs } from './incremental-args.mjs';
import { buildPreview } from './patch-preview.mjs';
import { createPatchPackage } from './patch-package.mjs';
import { planRuntimeActions } from './runtime-actions.mjs';

export async function orchestrateIncremental({ args, repo, remote, onPreview = () => {} }) {
  const options = parseIncrementalArgs(args);
  if (options.mode === 'status') return remote.status();
  if (options.mode === 'bootstrap') throw new Error('Bootstrap must use the full installer');
  if (['rollback', 'recover'].includes(options.mode)) {
    const id = randomBytes(16).toString('hex');
    try { await remote.launch(options.mode, null, id); return await remote.wait(id); }
    catch (error) { throw new Error(`${error.message}. Check --status for request ${id}; the VPS worker may still be running.`); }
  }
  const status = await remote.status();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(status.current || '')) throw new Error('VPS has no initialized release baseline');
  const preview = buildPreview({ repo, base: options.base || status.current, target: options.target });
  if (preview.base !== status.current) throw new Error('Base commit mismatch with VPS');
  const result = { ...preview, totalBytes: preview.files.reduce((sum, file) => sum + (file.size || 0), 0), actions: planRuntimeActions(preview.files.map(file => file.path)) };
  if (options.mode === 'dry-run') return result;
  onPreview(result);
  if (!preview.files.length) return { status: 'no_changes', base: preview.base, target: preview.target };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-patch-'));
  try {
    const dir = path.join(tmp, 'package'); createPatchPackage({ repo, base: preview.base, target: preview.target, output: dir });
    const uploaded = await remote.upload(dir);
    const id = randomBytes(16).toString('hex');
    try { await remote.launch('apply', uploaded, id); return await remote.wait(id); }
    catch (error) { throw new Error(`${error.message}. Check --status for request ${id}; the VPS worker may still be running.`); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
