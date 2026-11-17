// Prepare the pinned optional decision runtime for an application build.
// Customers receive the signed runtime in the app; only the model is downloaded.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await fs.readFile(path.join(ROOT, 'data/decision-runtime-upstream.json'), 'utf8'));
const options = { platform: process.platform, arch: process.arch, archive: '' };
for (let n = 2; n < process.argv.length; n++) {
  const key = process.argv[n].replace(/^--/, '');
  if (!['platform', 'arch', 'archive'].includes(key) || !process.argv[n + 1]) throw new Error('Invalid decision runtime preparation argument.');
  options[key] = process.argv[++n];
}
if (`${options.platform}-${options.arch}` !== pins.platform) {
  console.log(JSON.stringify({ decisionRuntime: 'unsupported-platform', platform: options.platform, arch: options.arch }));
  process.exit(0);
}
const destination = path.join(ROOT, 'vendor', 'decision-runtime', pins.platform);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Runtime preparation requires regular files.');
  return stat;
}
async function matches(file, expected) {
  try {
    const stat = await regular(file);
    return stat.size === expected.bytes && digest(await fs.readFile(file)) === expected.sha256;
  } catch { return false; }
}
async function ready() {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    if (manifest.hashPhase !== 'development-upstream' || manifest.version !== pins.version
      || manifest.revision !== pins.revision || manifest.platform !== pins.platform
      || manifest.files.length !== pins.files.length || manifest.licenses.length !== pins.licenses.length) return false;
    if (JSON.stringify(manifest.files) !== JSON.stringify(pins.files)
      || JSON.stringify(manifest.upstreamFiles) !== JSON.stringify(pins.files)
      || JSON.stringify(manifest.licenses) !== JSON.stringify(pins.licenses.map(({ source, ...file }) => file))
      || manifest.upstream?.archiveSha256 !== pins.archive.sha256) return false;
    for (const item of [...pins.files, ...pins.licenses]) {
      if (!await matches(path.join(destination, item.path), item)) return false;
    }
    return true;
  } catch { return false; }
}
if (await ready()) {
  console.log(JSON.stringify({ decisionRuntime: 'ready', platform: pins.platform, version: pins.version }));
  process.exit(0);
}
const cache = path.join(tmpdir(), 'nova-collar-decision-runtime', pins.version);
await fs.mkdir(cache, { recursive: true });
const archive = options.archive ? path.resolve(options.archive) : path.join(cache, 'runtime.tar.gz');
if (!await matches(archive, pins.archive)) {
  if (options.archive) throw new Error('Provided runtime archive does not match pinned upstream bytes.');
  const temporary = archive + '.part-' + randomBytes(8).toString('hex');
  const response = await fetch(pins.archive.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error('Pinned runtime download failed.');
  let count = 0;
  try {
    await pipeline(response.body, new Transform({ transform(chunk, _encoding, done) {
      count += chunk.length;
      done(count > pins.archive.bytes ? new Error('Runtime download exceeds pinned byte count.') : null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!await matches(temporary, pins.archive)) throw new Error('Runtime archive integrity mismatch.');
    await fs.rename(temporary, archive);
  } finally { await fs.rm(temporary, { force: true }); }
}
const temporary = destination + '.pending-' + randomBytes(8).toString('hex');
await fs.mkdir(temporary, { recursive: true });
const extraction = String.raw`import json,pathlib,tarfile,sys,os
archive,out,encoded=sys.argv[1:]
spec=json.loads(encoded);root=pathlib.Path(out)
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers();lookup={m.name:m for m in members}
 if len(members)>200 or sum(m.size for m in members if m.isfile())>200*1024*1024:raise ValueError('Runtime archive bounds exceeded')
 for item in spec['files']:
  name=item['path']
  if '/' in name or name in ('.','..'):raise ValueError('Invalid fixed runtime filename')
  member=lookup.get(spec['prefix']+'/'+name);seen=set()
  while member is not None and member.issym():
   if member.name in seen or '/' in member.linkname or member.linkname in ('.','..'):raise ValueError('Invalid upstream runtime alias')
   seen.add(member.name);member=lookup.get(spec['prefix']+'/'+member.linkname)
  if member is None or not member.isfile() or member.size!=item['bytes']:raise ValueError('Missing bounded upstream regular runtime file')
  data=tar.extractfile(member).read()
  with open(root/name,'xb') as stream:stream.write(data)
  os.chmod(root/name,0o755)
`;
try {
  execFileSync('python3', ['-c', extraction, archive, temporary,
    JSON.stringify({ prefix: pins.archive.prefix, files: pins.files })], { stdio: 'pipe' });
  for (const file of pins.files) if (!await matches(path.join(temporary, file.path), file)) throw new Error('Materialized upstream runtime file integrity mismatch.');
  for (const file of pins.licenses) {
    const source = path.join(ROOT, file.source), target = path.join(temporary, file.path);
    if (!await matches(source, file)) throw new Error('Required original license integrity mismatch.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target); await fs.chmod(target, 0o644);
  }
  const manifest = { schemaVersion: 1, platform: pins.platform, version: pins.version,
    revision: pins.revision, executable: pins.executable, minimumMacOS: pins.minimumMacOS,
    hashPhase: 'development-upstream', files: pins.files,
    licenses: pins.licenses.map(({ source, ...file }) => file),
    upstream: { repository: 'https://github.com/ggml-org/llama.cpp', release: pins.version,
      revision: pins.revision, archiveURL: pins.archive.url, archiveBytes: pins.archive.bytes,
      archiveSha256: pins.archive.sha256, materialization: 'Required upstream aliases materialized as identical regular file bytes.' },
    upstreamFiles: pins.files };
  await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(temporary, destination);
  console.log(JSON.stringify({ decisionRuntime: 'prepared', platform: pins.platform, version: pins.version }));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
