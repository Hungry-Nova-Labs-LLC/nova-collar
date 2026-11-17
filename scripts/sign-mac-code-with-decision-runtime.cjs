'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const signMacCode = require('./sign-mac-code.cjs');
const { refreshSignedRuntime, verifyCurrentManifest } = require('./decision-runtime-manifest.cjs');
const { companySigningRequired, companySigningIdentity, verifyCompanySignature } = require('./notary.cjs');

module.exports = async function signWithDecisionRuntime(options) {
  // The existing signer handles privacy cleanup, native dependency ordering,
  // entitlements and the complete nested signing pass, including this runtime.
  await signMacCode(options);
  const runtime = path.join(options.app, 'Contents', 'Resources', 'decision-runtime');
  refreshSignedRuntime(runtime);
  const pinned = companySigningRequired();
  const identity = pinned ? companySigningIdentity().fingerprint : options.identity || '-';
  const args = ['--force', '--sign', identity,
    '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', '--generate-entitlement-der'];
  if (pinned) args.push('--timestamp');
  args.push(options.app);
  // Deliberately no --deep: nested runtime bytes must remain unchanged after
  // the manifest is hashed. Reseal only the outer application resource seal.
  execFileSync('/usr/bin/codesign', args, { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.app], { stdio: 'pipe' });
  verifyCurrentManifest(runtime);
  if (pinned) verifyCompanySignature(options.app);
};
