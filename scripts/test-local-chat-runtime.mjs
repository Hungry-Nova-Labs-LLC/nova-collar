import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, seed, sha } from './local-chat-fixture.mjs';
import { createLocalChatRuntime } from '../src/main/local-chat-runtime.js';
const f = await fixture(), heads = [], events = [];
const runtimeRoot = join(f.home, 'fixture-runtime'); await mkdir(runtimeRoot);
const script = `const http=require('node:http'),fs=require('node:fs');const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],token=fs.readFileSync(get('--api-key-file'),'utf8').trim();http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:get('--alias')}]}));}).listen(Number(get('--port')),get('--host'));`;
await writeFile(join(runtimeRoot, 'fixture.cjs'), script);
await writeFile(join(runtimeRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'fixture', executable: 'fixture.cjs', files: [{ path: 'fixture.cjs', bytes: Buffer.byteLength(script), sha256: sha(script) }] }));
const runtime = createLocalChatRuntime({ home: f.home, runtimeRoot, platform: 'fixture', idleMs: 80, startupMs: 3000,
  onStage: (stage, id) => { events.push({ stage, id }); },
  spawnImpl(executable, args, options) {
    assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1'); assert.notEqual(args[args.indexOf('--port') + 1], '8081'); assert.ok(args.includes('--jinja')); assert.equal(args[args.indexOf('--gpu-layers') + 1], '999'); assert.ok(!Object.keys(options.env).some(key => /KEY|TOKEN|SECRET/.test(key)));
    const child = spawn(process.execPath, [executable, ...args], options); heads.push(child); return child;
  },
});
try {
  await seed(f); const model = { ...f.row, path: f.file };
  const first = await runtime.acquire(model); assert.equal(runtime.loadedId(), 'fixture'); assert.equal(first.target.profileModel, 'fixture'); assert.ok(first.target.profileUrl.endsWith('/fixture')); assert.notEqual(first.target.key, f.base.chatKey); assert.notEqual(first.target.model, f.row.id);
  const secrets = (await readdir(join(f.home, 'local-chat'))).filter(name => name.startsWith('runtime-auth-')); assert.equal(secrets.length, 1); assert.equal((await readFile(join(f.home, 'local-chat', secrets[0]), 'utf8')).trim(), first.target.key);
  const queued = new AbortController(), pending = runtime.acquire(model, { signal: queued.signal }); queued.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(runtime.loadedId(), 'fixture'); assert.equal(heads.length, 1);
  await first.release(); const second = await runtime.acquire(model); assert.equal(heads.length, 1); await second.release();
  await new Promise(resolve => setTimeout(resolve, 170)); assert.equal(runtime.loadedId(), ''); assert.ok(events.some(event => event.stage === 'stopped')); assert.ok(heads[0].exitCode !== null || heads[0].signalCode); assert.equal((await readdir(join(f.home, 'local-chat'))).filter(name => name.startsWith('runtime-auth-')).length, 0);
  const active = new AbortController(), third = await runtime.acquire(model, { signal: active.signal }); const secret = third.target.key; active.abort(); await runtime.stop(); await third.release(); assert.equal(runtime.loadedId(), ''); assert.ok(heads[1].exitCode !== null || heads[1].signalCode); assert.ok(!JSON.stringify(events).includes(secret));
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(async () => runtime.acquire(model, { signal: cancelled.signal }), { name: 'AbortError' }); assert.equal(heads.length, 2);
  await writeFile(f.file, Buffer.alloc(f.data.length)); await assert.rejects(runtime.acquire(model), error => error.code === 'model-changed'); assert.equal(heads.length, 2);
  await writeFile(f.file, f.data); await writeFile(join(runtimeRoot, 'fixture.cjs'), script + '\n'); await assert.rejects(runtime.acquire(model), error => error.code === 'runtime-unavailable'); assert.equal(heads.length, 2);
  await writeFile(join(runtimeRoot, 'fixture.cjs'), script);
  let entered, unblock; const reached = new Promise(resolve => { entered = resolve; });
  const startup = createLocalChatRuntime({ home: f.home, runtimeRoot, platform: 'fixture', onStage: async stage => { if (stage === 'starting') { entered(); await new Promise(resolve => { unblock = resolve; }); } }, spawnImpl() { throw new Error('Cancelled startup must never spawn'); } });
  const acquisition = startup.acquire(model); const rejected = assert.rejects(acquisition, { name: 'AbortError' }); await reached; let stopSettled = false; const cleanup = startup.stop().then(() => { stopSettled = true; }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(stopSettled, false); unblock(); await cleanup; await rejected;
  assert.equal((await readdir(join(f.home, 'local-chat'))).filter(name => name.startsWith('runtime-auth-')).length, 0);
  for (const phase of ['before-create', 'during-write']) {
    let entered, unblock; const reached = new Promise(resolve => { entered = resolve; });
    const pause = async () => { entered(); await new Promise(resolve => { unblock = resolve; }); };
    let spawned = 0;
    const interrupted = createLocalChatRuntime({ home: f.home, runtimeRoot, platform: 'fixture',
      openImpl: async (...args) => {
        if (phase === 'before-create') await pause();
        const handle = await open(...args);
        if (phase !== 'during-write') return handle;
        return { async writeFile(data) { await pause(); return handle.writeFile(data); }, close: () => handle.close() };
      }, spawnImpl() { spawned++; throw new Error('Aborted authentication setup must not spawn'); } });
    const parent = new AbortController(), pending = interrupted.acquire(model, { signal: parent.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await reached; parent.abort();
    // Let the former cleanup race finish before allowing the delayed create/write.
    await new Promise(resolve => setTimeout(resolve, 20)); unblock(); await rejected; await interrupted.stop();
    assert.equal(spawned, 0); assert.equal((await readdir(join(f.home, 'local-chat'))).filter(name => name.startsWith('runtime-auth-')).length, 0, phase);
  }
  console.log('local-chat-runtime: owned authenticated process, serialized leases, idle/abort cleanup and integrity passed');
} finally { await runtime.stop(); for (const child of heads) { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); } await f.cleanup(); }
