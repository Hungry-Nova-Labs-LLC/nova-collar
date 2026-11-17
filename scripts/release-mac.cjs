// Resolve the approved signing policy once, then pin the same identity in every hook.
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { releasePreflight } = require('./notary.cjs');

function releaseMac({ env = process.env, exec = execFileSync, preflight = releasePreflight } = {}) {
  const identity = preflight({ env });
  const root = resolve(__dirname, '..');
  // electron-builder adds the certificate-type prefix itself.
  const selector = identity.commonName.replace(/^Developer ID Application: /, '');
  const childEnv = { ...env, HNL_MAC_PUBLIC_RELEASE: '1', CSC_NAME: selector };
  const options = { cwd: root, env: childEnv, stdio: 'inherit' };
  for (const script of ['vendor-xterm.js', 'build-mac-control.js']) {
    exec(process.execPath, [join(__dirname, script)], options);
  }
  exec(join(root, 'node_modules', '.bin', 'electron-builder'),
    ['--mac', 'dmg', 'zip', '--arm64', '--publish', 'never', `-c.mac.identity=${selector}`], options);
  exec(process.execPath, [join(__dirname, 'finalize-mac-release.cjs')], options);
}
module.exports = { releaseMac };
if (require.main === module) releaseMac();
