import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safePath } from './patch-preview.mjs';

function regularFileWithoutLinks(root, parts) {
  let current = root;
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Invalid package directory');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Invalid payload path: ${parts.join('/')}`);
  }
  return current;
}
export function validatePatchPackage(root) {
  const manifestPath = regularFileWithoutLinks(root, ['manifest.json']);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.base) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.target) || !Array.isArray(manifest.files)) throw new Error('Invalid manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !safePath(file.path) || file.path.includes('\ufffd')) throw new Error('Invalid patch path');
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate patch path: ${file.path}`);
    seen.add(key);
    if (!['add', 'modify', 'delete'].includes(file.status)) throw new Error(`Invalid status: ${file.path}`);
    if (file.status === 'delete') continue;
    if (!['100644', '100755'].includes(file.mode) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid metadata: ${file.path}`);
    const filePath = regularFileWithoutLinks(root, ['files', ...file.path.split('/')]);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Hash mismatch: ${file.path}`);
  }
  return manifest;
}
