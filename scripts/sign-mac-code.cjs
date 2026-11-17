// @electron/osx-sign considers every binary resource signable. Analysis bundles
// contain GIFs, JARs and fonts, so restrict its signing pass to actual native code
// and code bundles while keeping its nested-bundle ordering and verification.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const plist = require('plist');
const { cleanMacBuildMetadata } = require('./clean-mac-build-metadata.cjs');
const { companySigningRequired, companySigningOptions, verifyCompanySignature } = require('./notary.cjs');
const MAGIC = new Set(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']);

function createMachOFilter(describe = file => execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' })) {
  return file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const bytes = Buffer.alloc(8), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
    // Java class files share the universal Mach-O magic; file identifies them.
    return MAGIC.has(bytes.subarray(0,4).toString('hex')) && /\bMach-O\b/.test(describe(file));
  };
}
function additionalBundles(app) {
  const found = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name === 'Info.plist' && path.basename(directory) === 'Contents') {
        const root = path.dirname(directory);
        if (root !== app && !['.app','.framework'].includes(path.extname(root))) {
          const value = plist.parse(fs.readFileSync(file, 'utf8'));
          if (typeof value.CFBundleExecutable === 'string' && value.CFBundleExecutable) found.push(root);
        }
      }
    }
  }
  walk(app);
  return found;
}
function filteredSigningOptions(options, describe) {
  const app = path.resolve(options.app);
  const bundles = additionalBundles(app), bundleSet = new Set(bundles);
  const isMachO = createMachOFilter(describe), cache = new Map();
  const inheritedIgnore = options.ignore == null ? [] : Array.isArray(options.ignore) ? options.ignore : [options.ignore];
  function ignore(file) {
    file = path.resolve(file);
    if (inheritedIgnore.some(rule => typeof rule === 'function' ? rule(file) : file.match(rule))) return true;
    if (cache.has(file)) return cache.get(file);
    const relative = path.relative(app, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Signing target is outside the application.');
    let current = app;
    // osx-sign follows framework symlink directories. Sign physical paths once.
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) { cache.set(file, true); return true; }
    }
    const stat = fs.lstatSync(file);
    const allowed = stat.isDirectory()
      ? file === app || ['.app','.framework'].includes(path.extname(file)) || bundleSet.has(file)
      : isMachO(file);
    cache.set(file, !allowed);
    return !allowed;
  }
  return { ...options, app, ignore, binaries: [...new Set([...(options.binaries || []), ...bundles])] };
}
async function signMacCode(options) {
  const companyRelease = companySigningRequired();
  options = companySigningOptions(options);
  cleanMacBuildMetadata(options.app, { legacyResourceSignatures: companyRelease });
  const { signAsync } = require('@electron/osx-sign');
  await signAsync(filteredSigningOptions(options));
  if (companyRelease) verifyCompanySignature(options.app);
}
module.exports = signMacCode;
module.exports.filteredSigningOptions = filteredSigningOptions;
module.exports.createMachOFilter = createMachOFilter;
