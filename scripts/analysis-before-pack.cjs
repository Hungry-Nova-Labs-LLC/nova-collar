const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { Arch } = require('builder-util');
const { assertReleaseSource } = require('./release-source-preflight.cjs');
exports.default = async context => {
  assertPinnedSecurityDependencies(context.packager.projectDir);
  assertReleaseSource(context.packager.projectDir);
  execFileSync(process.execPath, [join(context.packager.projectDir, 'scripts/prepare-decision-runtime.mjs'),
    '--platform', context.electronPlatformName, '--arch', Arch[context.arch]],
  { cwd: context.packager.projectDir, stdio: 'inherit' });
  execFileSync(process.execPath, [join(context.packager.projectDir, 'scripts/prepare-analysis.mjs'),
    '--platform', context.electronPlatformName, '--arch', Arch[context.arch]],
  { cwd: context.packager.projectDir, stdio: 'inherit' });
};

// Refuse a stale local install after security lock updates. npm ci must finish
// before packaging; otherwise electron-builder could bundle old runtime deps.
function assertPinnedSecurityDependencies(root) {
  const fs = require('node:fs');
  const lock = JSON.parse(fs.readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const names = ['electron', '@hono/node-server', 'body-parser', 'fast-uri', 'hono', 'ip-address', 'qs', 'zod'];
  const selected = Object.entries(lock.packages || {}).filter(([name]) =>
    names.some(dependency => name === 'node_modules/' + dependency || name.endsWith('/node_modules/' + dependency)));
  if (!selected.some(([name]) => name === 'node_modules/electron')) throw new Error('The release lock must pin Electron.');
  const stale = [];
  for (const [name, expected] of selected) {
    let installed;
    try { installed = JSON.parse(fs.readFileSync(join(root, name, 'package.json'), 'utf8')).version; }
    catch { installed = 'missing'; }
    if (!expected.version || installed !== expected.version) stale.push(name + ': installed ' + installed + ', locked ' + expected.version);
  }
  if (stale.length) {
    const error = new Error('Stale security dependencies; run npm ci from the reviewed lock before building: ' + stale.join('; '));
    error.code = 'NOVA_STALE_SECURITY_DEPENDENCIES';
    throw error;
  }
  return { checked: selected.length, matchesReviewedLock: true };
}
exports.assertPinnedSecurityDependencies = assertPinnedSecurityDependencies;
