import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildPreview } from './patch-preview.mjs';

export function createPatchPackage({ repo, base, target, output }) {
  const preview = buildPreview({ repo, base, target });
  const manifest = { schema: 1, ...preview };
  try { fs.mkdirSync(output); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Package destination already exists: ${output}`);
    throw error;
  }
  try {
    fs.mkdirSync(path.join(output, 'files'));
    for (const file of manifest.files) {
      if (file.status === 'delete') continue;
      const bytes = execFileSync('git', ['cat-file', 'blob', `${manifest.target}:${file.path}`], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Blob verification failed: ${file.path}`);
      const dest = path.join(output, 'files', ...file.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
