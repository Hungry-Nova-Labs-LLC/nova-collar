'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function runtimeFile(root, relative) {
  if (typeof relative !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(relative)
    || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid decision runtime manifest path.');
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Decision runtime entries must not be symlinks.');
  }
  if (!fs.lstatSync(current).isFile()) throw new Error('Decision runtime entry is not a regular file.');
  return current;
}
function fileRecord(root, relative) {
  const file = runtimeFile(root, relative), bytes = fs.readFileSync(file);
  return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
}
function readManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(runtimeFile(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'darwin-arm64'
    || manifest.executable !== 'llama-server' || !Array.isArray(manifest.files)
    || manifest.files.length < 1 || manifest.files.length > 32) throw new Error('Invalid bundled decision runtime manifest.');
  const names = manifest.files.map(file => file.path);
  if (new Set(names).size !== names.length || !names.includes(manifest.executable)) throw new Error('Invalid runtime file inventory.');
  for (const name of names) runtimeFile(root, name);
  return manifest;
}
function verifyCurrentManifest(root) {
  const manifest = readManifest(root);
  for (const expected of [...manifest.files, ...(manifest.licenses || [])]) {
    const actual = fileRecord(root, expected.path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error('Bundled runtime file integrity mismatch.');
  }
  return manifest;
}
function refreshSignedRuntime(root) {
  const manifest = readManifest(root);
  const expected = require('../data/decision-runtime-upstream.json');
  if (!Array.isArray(manifest.upstreamFiles) || manifest.upstreamFiles.length !== manifest.files.length) {
    throw new Error('Original upstream runtime provenance is required.');
  }
  if (manifest.version !== expected.version || manifest.revision !== expected.revision
    || manifest.platform !== expected.platform || manifest.upstream?.archiveSha256 !== expected.archive.sha256
    || JSON.stringify(manifest.upstreamFiles) !== JSON.stringify(expected.files)
    || manifest.files.map(file => file.path).join('\n') !== expected.files.map(file => file.path).join('\n')) {
    throw new Error('Bundled runtime provenance differs from pinned original source assets.');
  }
  const next = { ...manifest, hashPhase: 'application-signed',
    files: manifest.files.map(file => fileRecord(root, file.path)),
    licenses: (manifest.licenses || []).map(file => fileRecord(root, file.path)) };
  // Only this non-code resource changes after the nested native signing pass.
  const file = path.join(root, 'manifest.json'), temporary = file + '.pending';
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  fs.renameSync(temporary, file);
  return verifyCurrentManifest(root);
}
module.exports = { runtimeFile, fileRecord, readManifest, verifyCurrentManifest, refreshSignedRuntime };
