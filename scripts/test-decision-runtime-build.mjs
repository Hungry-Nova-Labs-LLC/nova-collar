import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pins = require('../data/decision-runtime-upstream.json');
const { runtimeFile, verifyCurrentManifest, refreshSignedRuntime } = require('./decision-runtime-manifest.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-runtime-manifest-test-'));
  // Tiny synthetic bytes model the post-signing change. No native code executes.
  for (const file of pins.files) fs.writeFileSync(path.join(root, file.path), 'synthetic altered native bytes');
  const license = 'synthetic test notice';
  fs.mkdirSync(path.join(root, 'licenses'));
  fs.writeFileSync(path.join(root, 'licenses', 'test.txt'), license);
  const manifest = { schemaVersion: 1, platform: pins.platform, executable: pins.executable,
    version: pins.version, revision: pins.revision, upstream: { archiveSha256: pins.archive.sha256 },
    files: pins.files, upstreamFiles: pins.files,
    licenses: [{ path: 'licenses/test.txt', bytes: Buffer.byteLength(license), sha256: digest(license) }] };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}
test('signed byte refresh retains upstream provenance and detects later tampering', () => {
  const root = fixture();
  try {
    assert.throws(() => verifyCurrentManifest(root), /integrity/);
    const refreshed = refreshSignedRuntime(root);
    assert.equal(refreshed.hashPhase, 'application-signed');
    assert.deepEqual(refreshed.upstreamFiles, pins.files);
    assert.doesNotThrow(() => verifyCurrentManifest(root));
    fs.appendFileSync(path.join(root, pins.executable), 'unsealed modification');
    assert.throws(() => verifyCurrentManifest(root), /integrity/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('runtime entries reject traversal and symlinks', t => {
  const root = fixture();
  try {
    assert.throws(() => runtimeFile(root, '../outside'), /manifest path/);
    try { fs.symlinkSync(path.join(root, pins.executable), path.join(root, 'link')); }
    catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        t.diagnostic('Traversal checked; creating a symlink requires Windows developer/admin permission.'); return;
      }
      throw error;
    }
    assert.throws(() => runtimeFile(root, 'link'), /symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('post-sign refresh rejects invented or mismatched upstream provenance', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    manifest.upstreamFiles[0] = { ...manifest.upstreamFiles[0], sha256: '0'.repeat(64) };
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => refreshSignedRuntime(root), /provenance/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
