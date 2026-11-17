import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicDecisionJSON, downloadDecisionAsset, privateDirectory } from "../src/main/decision-assets.js";
const root = await mkdtemp(join(tmpdir(), "collar-decision-assets-")); after(() => rm(root, { recursive: true, force: true }));
const body = Buffer.from("GGUF synthetic fixture model bytes, never a real model\n"), sha = value => createHash("sha256").update(value).digest("hex");
const asset = { file: "fixture.gguf", url: "https://github.com/Hungry-Nova-Labs-LLC/nova-collar/releases/download/decision-models-1/fixture.gguf", bytes: body.length, sha256: sha(body) };
let seq = 0; const folder = async () => { const dir = join(root, String(++seq)); await mkdir(dir); return dir; };
const response = (bytes = body, headers = {}, status = 200) => new Response(bytes, { status, headers: { "content-length": String(bytes.length), ...headers } });
test("pinned file installs atomically with no credentials and exact bytes; existing valid file makes no request", async () => {
  const directory = await folder(); let calls = 0;
  const fetchImpl = async (url, init) => { calls++; assert.equal(url, asset.url); assert.equal(init.redirect, "manual"); assert.equal(init.headers.authorization, undefined); return response(); };
  const file = await downloadDecisionAsset({ asset, directory, fetchImpl }); assert.deepEqual(await readFile(file), body);
  assert.deepEqual(await readdir(directory), [asset.file]); await downloadDecisionAsset({ asset, directory, fetchImpl }); assert.equal(calls, 1);
});
test("cancel preserves partial and exact Range resumes after byte validation", async () => {
  const directory = await folder(), controller = new AbortController(); let pushed = false;
  await assert.rejects(downloadDecisionAsset({ asset, directory, signal: controller.signal,
    onProgress: p => { if (p.receivedBytes > 0) controller.abort(); },
    fetchImpl: async () => new Response(new ReadableStream({ pull(stream) { if (!pushed) { pushed = true; stream.enqueue(body.subarray(0, 10)); } } }), { headers: { "content-length": String(body.length) } }) }), { code: "cancelled" });
  assert.equal((await readFile(join(directory, asset.file + ".part"))).length, 10);
  await downloadDecisionAsset({ asset, directory, fetchImpl: async (_url, init) => { assert.equal(init.headers.range, "bytes=10-"); return response(body.subarray(10), { "content-range": `bytes 10-${body.length - 1}/${body.length}` }, 206); } });
  assert.deepEqual(await readFile(join(directory, asset.file)), body);
});
test("Range ignored safely restarts; wrong hash, wrong range and excessive body never install", async () => {
  const directory = await folder(); await writeFile(join(directory, asset.file + ".part"), body.subarray(0, 4));
  await atomicDecisionJSON(join(directory, asset.file + ".part.json"), { sha256: asset.sha256, bytes: asset.bytes, file: asset.file });
  await downloadDecisionAsset({ asset, directory, fetchImpl: async () => response() }); assert.deepEqual(await readFile(join(directory, asset.file)), body);
  for (const mode of ["hash", "range", "size"]) {
    const directory = await folder();
    await assert.rejects(downloadDecisionAsset({ asset, directory, fetchImpl: async () => mode === "hash" ? response(Buffer.alloc(body.length, 65))
      : mode === "range" ? response(body, { "content-range": `bytes 1-${body.length}/${body.length}` }, 206) : response(Buffer.concat([body, body])) }));
    assert(!await readFile(join(directory, asset.file)).then(() => true, () => false));
  }
});
test("public CDN redirects permitted, other hosts rejected without following, errors remain bounded", async () => {
  const directory = await folder(); let calls = 0;
  await downloadDecisionAsset({ asset, directory, fetchImpl: async (url, init) => { calls++; assert.equal(init.headers.authorization, undefined); return calls === 1
    ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/owned/model?signature=opaque" } }) : response(); } }); assert.equal(calls, 2);
  const bad = await folder(); calls = 0;
  await assert.rejects(downloadDecisionAsset({ asset, directory: bad, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); } }), { code: "download-redirect" }); assert.equal(calls, 1);
});
test("storage symlinks are rejected and disk reserve checked before network", async () => {
  const directory = await folder(), target = join(directory, "outside"); await writeFile(target, "private"); await symlink(target, join(directory, asset.file));
  await assert.rejects(downloadDecisionAsset({ asset, directory, fetchImpl: () => assert.fail("no request") }), { code: "unsafe-storage" });
  assert.equal(await readFile(target, "utf8"), "private");
  const empty = await folder(); await assert.rejects(downloadDecisionAsset({ asset, directory: empty, statfsImpl: async () => ({ bavail: 0, bsize: 4096 }), fetchImpl: () => assert.fail("no request") }), { code: "disk-space" });
  const parent = await folder(); await symlink(directory, join(parent, "decision-local")); await assert.rejects(privateDirectory(parent, "decision-local"), { code: "unsafe-storage" });
});
test("stalled fetch and stalled body are bounded and cancellable even if injected fetch ignores signal", async () => {
  for (const headers of [false, true]) {
    const directory = await folder(), began = performance.now();
    await assert.rejects(downloadDecisionAsset({ asset, directory, idleTimeoutMs: 100, fetchImpl: async () => headers
      ? new Response(new ReadableStream({ start() {} }), { headers: { "content-length": String(body.length) } }) : new Promise(() => {}) }), { code: "download-timeout" });
    assert(performance.now() - began < 1000);
  }
});
