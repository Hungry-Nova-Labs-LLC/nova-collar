import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicDecisionJSON, downloadLocalChatAsset, importLocalGGUF, inspectGGUF, MAX_LOCAL_MODEL_BYTES, readLocalChatCatalog, validateLocalChatAsset } from "../src/main/local-model-assets.js";

const root = await mkdtemp(join(tmpdir(), "collar-local-model-assets-")); after(() => rm(root, { recursive: true, force: true }));
let sequence = 0; const folder = async () => { const path = join(root, String(++sequence)); await mkdir(path); return path; };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const string = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
function gguf({ architecture = "llama", name = "Synthetic chat fixture", split = 1, extra = Buffer.alloc(0) } = {}) {
  const pairs = [["general.architecture", 8, string(architecture)], ["general.name", 8, string(name)],
    ["tokenizer.chat_template", 8, string("{{ messages }}")], [`${architecture}.context_length`, 4, u32(8192)], ["split.count", 4, u32(split)]];
  const header = Buffer.concat([Buffer.from("GGUF"), u32(3), u64(1), u64(pairs.length), ...pairs.map(([key, type, value]) => Buffer.concat([string(key), u32(type), value])),
    string("fixture.weight"), u32(1), u64(1), u32(0), u64(0)]);
  return Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), Buffer.alloc(4), extra]);
}
const body = gguf();
const asset = { file: "fixture.gguf", url: "https://huggingface.co/fixture/chat-GGUF/resolve/" + "a".repeat(40) + "/fixture.gguf", bytes: body.length, sha256: sha(body) };
const response = (bytes = body, headers = {}, status = 200) => new Response(bytes, { status, headers: { "content-length": String(bytes.length), ...headers } });

test("curated catalog pins three sizes, immutable revisions, hashes and honest memory/context limits", async () => {
  const book = await readLocalChatCatalog(); assert.equal(book.models.length, 3);
  assert.deepEqual(book.models.map(m => m.minMemoryGB), [8, 16, 24]);
  assert(book.models[2].asset.bytes > 4 * 1024 ** 3); assert(book.models[2].asset.bytes < MAX_LOCAL_MODEL_BYTES);
  for (const model of book.models) assert.equal(validateLocalChatAsset(model.asset), model.asset);
  for (const patch of [{url:asset.url.replace("a".repeat(40), "main")}, {url:asset.url + "?token=secret"}, {url:asset.url.replace("huggingface.co", "127.0.0.1")}, {bytes:MAX_LOCAL_MODEL_BYTES + 1}, {file:"../fixture.gguf"}]) {
    assert.throws(() => validateLocalChatAsset({...asset,...patch}), {code:"invalid-manifest"});
  }
});
test("pinned HF download follows only approved CDN and never sends credentials; verified cache avoids the network", async () => {
  const directory = await folder(); let requests = 0;
  const fetchImpl = async (url, init) => {
    requests++; assert.equal(init.credentials, "omit"); assert.equal(init.headers.authorization, undefined); assert.equal(init.headers.cookie, undefined);
    return requests === 1 ? new Response(null, { status: 302, headers: {location:"https://us.aws.cdn.hf.co/public/model?signature=public"} }) : response();
  };
  const file = await downloadLocalChatAsset({asset,directory,fetchImpl}); assert.deepEqual(await readFile(file), body); assert.equal(requests, 2);
  await downloadLocalChatAsset({asset,directory,fetchImpl:() => assert.fail("verified cache must not download")});
  assert.deepEqual(await readdir(directory), [asset.file]);
});
test("cancel leaves resumable bytes and retry requests exactly the validated Range", async () => {
  const directory = await folder(), controller = new AbortController(); let pushed = false;
  await assert.rejects(downloadLocalChatAsset({asset,directory,signal:controller.signal,onProgress:p => {if(p.receivedBytes > 0)controller.abort();},
    fetchImpl:async () => new Response(new ReadableStream({pull(stream){if(!pushed){pushed=true;stream.enqueue(body.subarray(0,37));}}}),{headers:{"content-length":String(body.length)}})}), {code:"cancelled"});
  assert.equal((await stat(join(directory,asset.file + ".part"))).size,37);
  await downloadLocalChatAsset({asset,directory,fetchImpl:async(_url,init) => {assert.equal(init.headers.range,"bytes=37-");return response(body.subarray(37),{"content-range":`bytes 37-${body.length-1}/${body.length}`},206);}});
  assert.deepEqual(await readFile(join(directory,asset.file)),body);
});
test("ignored Range restarts safely; corrupt, excessive and wrong-offset responses cannot install", async () => {
  const directory = await folder(); await writeFile(join(directory,asset.file + ".part"),body.subarray(0,11));
  await atomicDecisionJSON(join(directory,asset.file + ".part.json"),{sha256:asset.sha256,bytes:asset.bytes,file:asset.file});
  await downloadLocalChatAsset({asset,directory,fetchImpl:async()=>response()});assert.deepEqual(await readFile(join(directory,asset.file)),body);
  for(const mode of ["hash","range","size"]){const directory=await folder();
    await assert.rejects(downloadLocalChatAsset({asset,directory,fetchImpl:async()=>mode==="hash"?response(Buffer.alloc(body.length,65)):mode==="range"?response(body,{"content-range":`bytes 1-${body.length}/${body.length}`},206):response(Buffer.concat([body,body]))}));
    assert(!await stat(join(directory,asset.file)).then(()=>true,()=>false));
  }
});
test("unapproved redirects, storage links and insufficient disk stop before unsafe writes or requests", async () => {
  for(const location of ["http://127.0.0.1/private","https://private.example/model","https://user:password@us.aws.cdn.hf.co/model"]){const directory=await folder();let calls=0;
    await assert.rejects(downloadLocalChatAsset({asset,directory,fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}}),{code:"download-redirect"});assert.equal(calls,1);
  }
  const directory=await folder(),outside=join(directory,"outside");await writeFile(outside,"preserved");await symlink(outside,join(directory,asset.file));
  await assert.rejects(downloadLocalChatAsset({asset,directory,fetchImpl:()=>assert.fail("no network")}),{code:"unsafe-storage"});assert.equal(await readFile(outside,"utf8"),"preserved");
  await assert.rejects(downloadLocalChatAsset({asset,directory:await folder(),statfsImpl:async()=>({bavail:0,bsize:4096}),fetchImpl:()=>assert.fail("no network")}),{code:"disk-space"});
});
test("both stalled headers and stalled body time out without hanging cancellation", async () => {
  for(const headers of [true,false]){const start=performance.now();
    await assert.rejects(downloadLocalChatAsset({asset,directory:await folder(),idleTimeoutMs:100,fetchImpl:async()=>headers?new Response(new ReadableStream({start(){}}),{headers:{"content-length":String(body.length)}}):new Promise(()=>{})}),{code:"download-timeout"});
    assert(performance.now()-start<1000);
  }
});
test("GGUF inspector accepts bounded chat metadata and rejects malformed, split, embedding and placeholder inputs", async () => {
  const directory=await folder(),file=join(directory,"model.gguf");await writeFile(file,body);
  assert.deepEqual(await inspectGGUF(file),{architecture:"llama",name:"Synthetic chat fixture",contextTokens:8192,chatTemplate:true,splitCount:1,tensorCount:1,bytes:body.length});
  for(const bad of [body.subarray(0,31),Buffer.concat([Buffer.from("BAD!"),body.subarray(4)]),gguf({architecture:"bert"}),gguf({split:2}),Buffer.concat([Buffer.from("GGUF"),u32(3),u64(1),u64(1),u64(0xffffffffffffffffn)])]){
    await writeFile(file,bad);await assert.rejects(inspectGGUF(file));
  }
  const sparse=join(directory,"placeholder.gguf");await writeFile(sparse,"");await truncate(sparse,64*1024**2);
  if((await stat(sparse)).blocks===0)await assert.rejects(inspectGGUF(sparse),{code:"model-not-local"});
});
test("import copies a chosen GGUF to private hash-addressed storage without modifying its original", async () => {
  const sourceDir=await folder(),directory=await folder(),source=join(sourceDir,"Chosen.gguf");await writeFile(source,body);const before=await stat(source);
  const imported=await importLocalGGUF({source,directory});assert.equal(imported.id,"import-"+sha(body));assert.equal(imported.file,sha(body)+".gguf");
  assert.deepEqual(await readFile(join(directory,imported.file)),body);assert.deepEqual(await readFile(source),body);
  const after=await stat(source);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ino,before.ino);assert.equal((await stat(join(directory,imported.file))).mode&0o777,0o600);
  const twice=await importLocalGGUF({source,directory});assert.equal(twice.id,imported.id);assert.deepEqual(await readdir(directory),[imported.file]);
});
test("import cancellation removes only its temporary copy and leaves original bytes intact; source symlinks are rejected", async () => {
  const sourceDir=await folder(),directory=await folder(),source=join(sourceDir,"Chosen.gguf"),large=gguf({extra:Buffer.alloc(1024*1024)});await writeFile(source,large);
  const controller=new AbortController();await assert.rejects(importLocalGGUF({source,directory,signal:controller.signal,onProgress:p=>{if(p.receivedBytes>0)controller.abort();}}),{code:"cancelled"});
  assert.deepEqual(await readdir(directory),[]);assert.equal(sha(await readFile(source)),sha(large));
  const link=join(sourceDir,"link.gguf");await symlink(source,link);await assert.rejects(importLocalGGUF({source:link,directory}),{code:"unsafe-storage"});
});
