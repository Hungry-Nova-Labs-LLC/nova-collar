// Credentials stay in the local environment or Keychain. Public releases pin a
// verified identity; company is the default. An associated owner's legal identity
// requires a separate explicit local policy and remains visible in signatures.
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const COMPANY_LEGAL_ENTITY = 'Hungry Nova Labs LLC';
const normalizedEntity = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function signingEntityPolicy(env = process.env) {
  const policy = String(env.HNL_APPLE_SIGNING_POLICY || 'company').trim();
  const entity = String(env.HNL_APPLE_SIGNING_ENTITY || '').trim();
  if (!['company', 'associated-owner'].includes(policy)) {
    throw new Error('Unsupported Apple signing policy.');
  }
  if (policy === 'company') {
    if (entity && normalizedEntity(entity) !== normalizedEntity(COMPANY_LEGAL_ENTITY)) {
      throw new Error('The default company signing policy cannot select a different legal entity.');
    }
    return { policy, signingEntity: COMPANY_LEGAL_ENTITY };
  }
  if (!entity || entity.length > 240 || /[\x00-\x1f\x7f]/.test(entity) || !normalizedEntity(entity)) {
    throw new Error('Associated-owner signing requires HNL_APPLE_SIGNING_ENTITY with the explicitly approved legal entity.');
  }
  return { policy, signingEntity: entity };
}

function authArgs(env = process.env) {
  if (env.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_KEY_INDIVIDUAL === '1') {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID];
  }
  // Store app-specific passwords through notarytool's secure interactive prompt
  // in a local Keychain profile. Never put an Apple ID/password in child argv.
  return null;
}
function localPackOnly(env = process.env) {
  return env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' && env.HNL_MAC_PUBLIC_RELEASE !== '1';
}
function companySigningRequired(env = process.env) {
  return !localPackOnly(env) && Boolean(authArgs(env) || env.HNL_MAC_PUBLIC_RELEASE === '1'
    || env.HNL_APPLE_SIGNING_SHA1 || env.HNL_APPLE_TEAM_ID || env.HNL_APPLE_SIGNING_POLICY || env.HNL_APPLE_SIGNING_ENTITY);
}
function certificateFields(certificate) {
  const fields = Object.fromEntries(certificate.subject.split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  return { fingerprint: certificate.fingerprint.replaceAll(':', '').toUpperCase(),
    commonName: fields.CN || '', organization: fields.O || '', teamID: fields.OU || '' };
}
function assertCompanyCertificate(certificate, expected) {
  const fields = certificateFields(certificate);
  const entity = expected.signingEntity || COMPANY_LEGAL_ENTITY;
  if (fields.fingerprint !== expected.fingerprint || fields.teamID !== expected.teamID
    || normalizedEntity(fields.organization) !== normalizedEntity(entity)
    || !fields.commonName.startsWith('Developer ID Application: ')
    || normalizedEntity(fields.commonName.replace(/^Developer ID Application: /, '').replace(/\s*\([^)]*\)\s*$/, '')) !== normalizedEntity(entity)) {
    throw new Error('The pinned signing certificate must belong to the configured legal entity and team.');
  }
  return { ...fields, policy: expected.policy || 'company', signingEntity: entity };
}
function companySigningIdentity({ env = process.env, exec = execFileSync } = {}) {
  const policy = signingEntityPolicy(env);
  const fingerprint = String(env.HNL_APPLE_SIGNING_SHA1 || '').replaceAll(':', '').toUpperCase();
  const teamID = String(env.HNL_APPLE_TEAM_ID || '').trim();
  if (!/^[A-F0-9]{40}$/.test(fingerprint) || !/^[A-Z0-9]{10}$/.test(teamID)) {
    throw new Error('Set HNL_APPLE_SIGNING_SHA1 and HNL_APPLE_TEAM_ID to the verified release Developer ID identity.');
  }
  let identities, certificates;
  try {
    identities = exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    certificates = exec('/usr/bin/security', ['find-certificate', '-a', '-p'], { encoding: 'utf8' });
  } catch {
    throw new Error('The configured release signing identity is not available in the local Keychain.');
  }
  const valid = identities.split('\n').some(line => {
    const match = line.match(/\b([A-F0-9]{40})\s+"(Developer ID Application: [^"]+)"/i);
    return match && match[1].toUpperCase() === fingerprint;
  });
  if (!valid) throw new Error('The pinned Developer ID identity is not a valid local signing identity.');
  const blocks = certificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  for (const block of blocks) {
    const certificate = new X509Certificate(block);
    if (certificateFields(certificate).fingerprint === fingerprint) {
      return assertCompanyCertificate(certificate, { fingerprint, teamID, ...policy });
    }
  }
  throw new Error('The pinned release signing certificate was not found in the local Keychain.');
}
function releasePreflight({ env = process.env, exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('Build the Mac release on macOS.');
  if (!authArgs(env)) throw new Error('Mac release requires locally configured Apple notarization credentials.');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('A public Mac release requires pinned code signing.');
  const identity = companySigningIdentity({ env, exec });
  if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== identity.teamID) {
    throw new Error('Apple notarization credentials specify a different team from the pinned signing identity.');
  }
  return identity;
}
function companySigningOptions(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (!companySigningRequired(env)) return options;
  const identity = companySigningIdentity(dependencies);
  if (options.identity && ![identity.fingerprint, identity.commonName].includes(options.identity)) {
    throw new Error('The application signing identity differs from the pinned release identity.');
  }
  return { ...options, identity: identity.fingerprint, identityValidation: false };
}
function verifyCompanySignature(filePath, dependencies = {}) {
  const exec = dependencies.exec || execFileSync;
  const identity = companySigningIdentity(dependencies);
  const directory = mkdtempSync(join(tmpdir(), 'nova-company-signature-'));
  try {
    exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', filePath], { stdio: 'pipe' });
    const prefix = join(directory, 'certificate');
    exec('/usr/bin/codesign', ['-d', `--extract-certificates=${prefix}`, filePath], { stdio: 'pipe' });
    assertCompanyCertificate(new X509Certificate(readFileSync(prefix + '0')), identity);
  } catch {
    throw new Error('The release artifact does not have a valid signature from the pinned release identity.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return identity;
}
function developerIdApplication(dependencies) {
  return companySigningIdentity(dependencies).fingerprint;
}
function notarize(filePath, auth, { env = process.env, exec = execFileSync, preflight = releasePreflight } = {}) {
  const expected = authArgs(env);
  if (!expected || !Array.isArray(auth) || JSON.stringify(auth) !== JSON.stringify(expected)) {
    throw new Error('Use locally configured Keychain or App Store Connect API credentials for notarization.');
  }
  preflight({ env, exec });
  try {
    // Capture both streams: a failed tool's Error, argv, stdout or stderr may
    // contain credentials, email addresses, or private key paths. None escape.
    const output = exec('xcrun', ['notarytool', 'submit', filePath, ...expected, '--wait', '--output-format', 'json'],
      { stdio: 'pipe', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(output);
    if (result.status !== 'Accepted' || typeof result.id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.id)) {
      throw new Error('Unaccepted or unverifiable response.');
    }
    return { status: 'Accepted', id: result.id };
  } catch {
    // Deliberately attach no raw Error/cause, output, argv, or tool diagnostic.
    throw new Error('Apple notarization failed or was not accepted. No release may be published.');
  }
}
function staple(filePath) {
  execFileSync('xcrun', ['stapler', 'staple', filePath], { stdio: 'inherit' });
}
function signDmg(dmgPath) {
  const identity = companySigningIdentity();
  execFileSync('/usr/bin/codesign', ['--force', '--sign', identity.fingerprint, '--timestamp', dmgPath], { stdio: 'pipe' });
  verifyCompanySignature(dmgPath);
}
module.exports = { COMPANY_LEGAL_ENTITY, signingEntityPolicy, authArgs, localPackOnly, companySigningRequired,
  certificateFields, assertCompanyCertificate, companySigningIdentity, releasePreflight,
  companySigningOptions, verifyCompanySignature, developerIdApplication, notarize, staple, signDmg };
