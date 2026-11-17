// A release source tree must be clean before dependencies or engines are packed.
// This gate inspects ignored/hidden first-party files too. It does not replace
// the independent content and final binary/archive review required for release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_ROOT_FILES = new Set(['.env.example', '.gitignore', 'LICENSE', 'NOTICE',
  'README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'spec-ui.js',
  'SECURITY.md', 'CONTRIBUTING.md', 'AUTHORS', 'CODE_OF_CONDUCT.md']);
const PUBLIC_DIRECTORIES = new Set(['.github', 'build', 'data', 'docs', 'materials', 'runtime', 'scripts', 'src']);
const GENERATED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build/icon.iconset',
  'src/renderer/vendor']);
const GENERATED_FILES = new Set(['bin/mac-control']);
const VENDOR_RENDERER_FILES = new Set(['xterm.js', 'addon-fit.js', 'xterm.css']);
const BINARY_ASSETS = new Set(['build/icon.png', 'build/icon.icns', 'build/icon.ico']);
const conflictCopy = name => / [0-9]+(?:\.[^/]*)?$|conflicted copy|\.icloud$/i.test(name);
const forbiddenFile = name => name === '.env' || name === '.DS_Store'
  || /\.(?:log|pcap|pcapng|cap|report\.json|pem|p8|p12|key|sqlite(?:3)?|db|bak[0-9]*|tui-backup)$/i.test(name);

function textFindings(relative, text) {
  const findings = [];
  const fixture = /^scripts\/(?:test-|fixtures\/)/.test(relative);
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|AKIA[A-Z0-9]{16})\b/.test(text)) {
    findings.push('credential-shaped content');
  }
  for (const value of text.match(/\bsk-[A-Za-z0-9_-]{20,}\b/g) || []) {
    if (!(fixture && /fixture|synthetic|test|fake/i.test(value))) findings.push('credential-shaped content');
  }
  if (!fixture && /\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)) findings.push('operator home path');
  if (!fixture && /https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(text)) findings.push('private infrastructure URL');
  if (!fixture && /\b(?:my\s+(?:wife|husband)|our\s+(?:dog|chickens|Dalmatian)|Hurricane\s+[A-Z])\b/.test(text)) findings.push('personal narrative');
  return [...new Set(findings)];
}

function inspectReleaseSource(projectDir) {
  const root = fs.realpathSync(projectDir), files = [], excluded = [], violations = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) { violations.push({path:relative, reason:'source symlink'}); return; }
    if (conflictCopy(path.basename(relative))) { violations.push({path:relative, reason:'conflict copy or cloud placeholder'}); return; }
    if (GENERATED_DIRECTORIES.has(relative) || GENERATED_FILES.has(relative) || path.basename(relative) === '__pycache__') {
      excluded.push(relative); return;
    }
    if (stat.isDirectory()) {
      if (!relative.includes('/') && !PUBLIC_DIRECTORIES.has(relative)) {
        // bin is build output; only the declared native helper is permitted.
        if (relative !== 'bin') { violations.push({path:relative, reason:'unexpected source directory'}); return; }
      }
      for (const name of fs.readdirSync(absolute).sort()) walk(relative ? `${relative}/${name}` : name);
      return;
    }
    if (!stat.isFile()) { violations.push({path:relative, reason:'unexpected source file type'}); return; }
    if (relative.startsWith('bin/')) { violations.push({path:relative, reason:'unexpected build output'}); return; }
    if (forbiddenFile(path.basename(relative)) || /\.pyc$/i.test(relative)) {
      violations.push({path:relative, reason:'private or generated file'}); return;
    }
    if (!relative.includes('/') && !PUBLIC_ROOT_FILES.has(relative)) {
      violations.push({path:relative, reason:'unexpected source file'}); return;
    }
    const bytes = fs.readFileSync(absolute);
    if (!BINARY_ASSETS.has(relative)) {
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) {
        violations.push({path:relative, reason:'unexpected binary in source'}); return;
      }
      for (const reason of textFindings(relative, text)) violations.push({path:relative, reason});
    }
    files.push({path:relative, bytes:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex'), mode:stat.mode & 0o777});
  }
  for (const name of fs.readdirSync(root).sort()) walk(name);
  // Generated renderer dependencies have an exact public-source recipe.
  const vendor = path.join(root, 'src/renderer/vendor');
  if (fs.existsSync(vendor) && !fs.lstatSync(vendor).isSymbolicLink()) {
    for (const name of fs.readdirSync(vendor)) {
      const file = path.join(vendor, name);
      if (!VENDOR_RENDERER_FILES.has(name) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
        violations.push({path:`src/renderer/vendor/${name}`, reason:'unexpected generated renderer asset'});
      }
    }
  }
  return {passed:violations.length === 0, files, excluded, violations};
}

function assertReleaseSource(projectDir) {
  const report = inspectReleaseSource(projectDir);
  if (!report.passed) {
    const error = new Error(`Release source privacy preflight failed (${report.violations.length} findings):\n`
      + report.violations.map(row => `${row.path}: ${row.reason}`).join('\n'));
    error.code = 'NOVA_RELEASE_SOURCE_PRIVACY'; error.report = report; throw error;
  }
  return report;
}
module.exports = {inspectReleaseSource, assertReleaseSource, textFindings, conflictCopy};
if (require.main === module) {
  try {
    const report = assertReleaseSource(process.argv[2] || path.resolve(__dirname, '..'));
    console.log(JSON.stringify({passed:true, reviewedSourceFiles:report.files.length, excludedGeneratedPaths:report.excluded.length}));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
