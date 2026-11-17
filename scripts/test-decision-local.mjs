import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecisionLocalManager } from "../src/main/decision-local.js";
const root = await mkdtemp(join(tmpdir(), "collar-decision-local-")); const managers = [];
after(async () => { for (const manager of managers) await manager.stop(); await rm(root, { recursive: true, force: true }); });
const sha = data => createHash("sha256").update(data).digest("hex"), body = Buffer.from("GGUF synthetic local model, never inference\n");
const server = `import http from 'node:http';import fs from 'node:fs';
const a=process.argv.slice(2),v=k=>a[a.indexOf(k)+1],key=fs.readFileSync(v('--api-key-file'),'utf8').trim(),alias=v('--alias'),mode=v('--fixture-mode');
if((fs.statSync(v('--api-key-file')).mode&511)!==384||v('--host')!=='127.0.0.1')process.exit(5);
const s=http.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+key){res.writeHead(401);res.end('{}');return;}
 if(req.url==='/v1/models'){if(mode==='startup-stall')return;res.end(JSON.stringify({data:[{id:alias}]}));return;}
 if(req.url!=='/v1/systemone'){res.writeHead(404);res.end('{}');return;}
 let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);if(b.model!==undefined||!b.questions.next_step){res.writeHead(400);res.end('{}');return;}
 if(mode==='request-stall'||b.state?.stall)return;const ids=Object.keys(b.questions.next_step.criteria),choice=mode==='wrong'?ids[1]:ids[0];
 res.end(JSON.stringify({answers:{next_step:{choice,confidence:1,probabilities:Object.fromEntries(ids.map(id=>[id,id===choice?1:0]))}}}));
});s.listen(Number(v('--port')),'127.0.0.1');`;
let sequence = 0;
async function fixture(mode = "normal", extra = {}) {
  const base = join(root, String(++sequence)), home = join(base, "profile"), runtimeRoot = join(base, "runtime");
  await mkdir(home, { recursive: true }); await mkdir(runtimeRoot);
  const executable = join(runtimeRoot, "fixture-server.mjs"); await writeFile(executable, server);
  await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, platform: "fixture-arm64", executable: "fixture-server.mjs", files: [{ path: "fixture-server.mjs", bytes: Buffer.byteLength(server), sha256: sha(server) }] }));
  const remote = { enabled: true, endpoint: "https://own.example/decisions", apiKeyEnv: "PRIVATE_OWNER_KEY", ownerField: "preserve" };
  await writeFile(join(home, "decision-adviser.json"), JSON.stringify(remote));
  const children = [], requests = [], events = [];
  const assets = { schemaVersion: 1, platforms: ["fixture-arm64"], model: { file: "fixture.gguf", url: "https://github.com/Hungry-Nova-Labs-LLC/nova-collar/releases/download/decision-models-1/fixture.gguf", bytes: body.length, sha256: sha(body), revision: "fixture" } };
  const manager = createDecisionLocalManager({ home, runtimeRoot, platform: "fixture-arm64", assets, idleMs: 100,
    fetchImpl: async (url, init) => { const u = new URL(url); requests.push({ host: u.hostname, path: u.pathname });
      if (u.hostname === "github.com") { assert.equal(init.headers.authorization, undefined); return new Response(body, { headers: { "content-length": String(body.length) } }); }
      assert.equal(u.hostname, "127.0.0.1"); return fetch(url, init); },
    spawnImpl: (_executable, args, options) => { assert(!args.includes("--api-key")); assert(args.includes("--api-key-file")); assert.equal(options.env.HNL_CHAT_KEY, undefined);
      const proc = spawn(process.execPath, [executable, ...args, "--fixture-mode", mode], options); children.push(proc); return proc; }, ...extra });
  managers.push(manager); manager.subscribe(event => events.push(event)); return { manager, home, remote, children, requests, events, assets, runtimeRoot };
}
const gone = proc => { try { process.kill(proc.pid, 0); return false; } catch { return true; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test("one-click verified install self-checks native typed route before enabling; owned loopback process idles and auth file disappears", async () => {
  const f = await fixture(); const before = await f.manager.status(); assert.equal(before.enabled, false); assert.equal(before.installed, false);
  const result = await f.manager.install(); assert.equal(result.stage, "ready"); assert.equal(result.enabled, true); assert.equal(result.installed, true); assert.equal(result.firstRunPrompted, true);
  const settings = JSON.parse(await readFile(join(f.home, "decision-adviser.json"), "utf8")); assert.equal(settings.ownerField, "preserve"); assert.equal(settings.endpoint, f.remote.endpoint); assert.equal(settings.provider, "local");
  assert.equal(f.children.length, 1); assert.equal(f.requests.filter(row => row.path === "/v1/systemone").length, 1);
  assert(f.events.some(row => row.stage === "verifying")); assert(f.events.some(row => row.stage === "checking"));
  assert(!JSON.stringify(f.events).includes(f.home)); await sleep(350); assert(gone(f.children[0]));
  assert(!(await readdir(join(f.home, "decision-local"))).some(name => name.startsWith("runtime-auth-")));
});
test("bad self-check preserves exact endpoint config; direct Enable cannot bypass it", async () => {
  const f = await fixture("wrong"); const result = await f.manager.install(); assert.equal(result.stage, "error"); assert.equal(result.enabled, false); assert.equal(result.installed, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "decision-adviser.json"), "utf8")), f.remote);
  const enabled = await f.manager.setEnabled(true); assert.equal(enabled.enabled, false); assert.equal(enabled.stage, "error");
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "decision-adviser.json"), "utf8")), f.remote); assert(f.children.every(gone));
});
test("cancel startup/self-check kills owned process, never enables, and manual Check shares cancellation lock", async () => {
  for (const mode of ["startup-stall", "request-stall"]) {
    const f = await fixture(mode); let cancel;
    f.manager.subscribe(event => { if (!cancel && event.stage === "starting") { cancel = true; setTimeout(() => void f.manager.cancel(), 100); } });
    const result = await f.manager.install(); assert.equal(result.stage, "cancelled"); assert.equal(result.enabled, false); assert(f.children.every(gone));
    assert.deepEqual(JSON.parse(await readFile(join(f.home, "decision-adviser.json"), "utf8")), f.remote);
    cancel = false; const checked = await f.manager.check(); assert.equal(checked.stage, "cancelled"); assert(f.children.every(gone));
  }
});
test("late cancellation after successful check/enable restores old remote settings and leaves verified model resumable", async () => {
  const f = await fixture(), controller = new AbortController(); let fired = false;
  f.manager.subscribe(event => { if (!fired && event.enabled && event.stage === "ready") { fired = true; controller.abort(); } });
  const result = await f.manager.install({ signal: controller.signal }); assert(fired); assert.equal(result.stage, "cancelled"); assert.equal(result.enabled, false); assert.equal(result.installed, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, "decision-adviser.json"), "utf8")), f.remote); assert(f.children.every(gone));
});
test("Stop aborts active inference and reaps it; concurrent inference cannot borrow or overlap that process", async () => {
  const f = await fixture(); assert.equal((await f.manager.install()).enabled, true);
  const controller = new AbortController(), actions = [{ id: "a", description: "a" }, { id: "b", description: "b" }];
  const pending = f.manager.request({ signal: controller.signal, state: { stall: true }, actions });
  while (f.requests.filter(row => row.path === "/v1/systemone").length < 2) await sleep(5);
  assert.equal((await f.manager.request({ state: "second", actions })).reason, "service-unavailable");
  await sleep(20); controller.abort(); const result = await pending;
  assert.equal(result.reason, "cancelled"); await f.manager.stop(); assert(f.children.every(gone));
  assert(!(await readdir(join(f.home, "decision-local"))).some(name => name.startsWith("runtime-auth-")));
});
test("quit arriving at the pre-spawn startup event prevents a late child from starting", async () => {
  const f = await fixture(); let stopping;
  f.manager.subscribe(event => { if (event.stage === "starting" && !stopping) stopping = f.manager.stop(); });
  const result = await f.manager.install(); await stopping;
  assert.equal(result.enabled, false); assert.equal(result.stage, "cancelled"); assert.equal(f.children.length, 0);
  assert(!(await readdir(join(f.home, "decision-local"))).some(name => name.startsWith("runtime-auth-")));
});
test("explicit disable aborts active advice, reaps immediately and prevents stale-turn requests from restarting it", async () => {
  const f = await fixture(); assert.equal((await f.manager.install()).enabled, true);
  const actions = [{ id: "a", description: "a" }, { id: "b", description: "b" }];
  const pending = f.manager.request({ state: { stall: true }, actions });
  while (f.requests.filter(row => row.path === "/v1/systemone").length < 2) await sleep(5);
  const disabled = await f.manager.setEnabled(false), result = await pending;
  assert.equal(disabled.enabled, false); assert.equal(result.ok, false); assert.equal(result.reason, "cancelled"); assert.equal(result.choice, undefined);
  assert(f.children.every(gone)); assert.equal(f.children.length, 1);
  assert.equal((await f.manager.request({ state: "old turn", actions })).ok, false); assert.equal(f.children.length, 1);
  assert.equal((await f.manager.status()).installed, true);
});
test("runtime hash mismatch or unsupported platform prevents network, spawn and enabling", async () => {
  const f = await fixture(); await writeFile(join(f.runtimeRoot, "fixture-server.mjs"), "tampered");
  const result = await f.manager.install(); assert.equal(result.stage, "error"); assert.equal(f.requests.length, 0); assert.equal(f.children.length, 0); assert.equal(result.enabled, false);
  const other = await fixture("normal", { platform: "unsupported-x64" }); const unsupported = await other.manager.install(); assert.equal(unsupported.supported, false); assert.equal(other.requests.length, 0);
});
