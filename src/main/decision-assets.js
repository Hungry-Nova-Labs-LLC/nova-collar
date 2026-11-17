import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, statfs, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ROOT } from "./config.js";

const SHA = /^[a-f0-9]{64}$/;
const HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);
export class DecisionAssetError extends Error {
  constructor(code) { super(code); this.name = "DecisionAssetError"; this.code = code; }
}
const fail = code => { throw new DecisionAssetError(code); };
const stopped = signal => { if (signal?.aborted) fail("cancelled"); };
const abortRace = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(new DecisionAssetError("cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
});
export async function regularFile(path) {
  try { const stat = await lstat(path); return stat.isFile() && !stat.isSymbolicLink() ? stat : null; } catch { return null; }
}
export async function privateDirectory(home, ...parts) {
  let dir = resolve(home); await mkdir(dir, { recursive: true, mode: 0o700 });
  const homeStat = await lstat(dir); if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) fail("unsafe-storage");
  for (const part of parts) {
    if (!/^[A-Za-z0-9_.-]+$/.test(part) || [".", ".."].includes(part)) fail("unsafe-storage");
    dir = join(dir, part); await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe-storage");
  }
  return dir;
}
export async function atomicDecisionJSON(path, value) {
  const temp = `${path}.${process.pid}.${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 12)}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600); await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); await handle.close(); handle = null;
    await rename(temp, path);
  } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
export async function readDecisionJSON(path, limit = 8192) {
  const stat = await regularFile(path); if (!stat || stat.size > limit) return null;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}
export function validateDecisionAsset(asset) {
  if (!asset || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(asset.file || "") || !SHA.test(asset.sha256 || "")
    || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 4 * 1024 ** 3) fail("invalid-manifest");
  let url; try { url = new URL(asset.url); } catch { fail("invalid-manifest"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith("/Hungry-Nova-Labs-LLC/nova-collar/releases/download/")) fail("invalid-manifest");
  return asset;
}
export async function readDecisionAssets(root = ROOT) {
  const value = await readDecisionJSON(join(root, "data", "decision-assets.json"));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.platforms)) fail("invalid-manifest");
  validateDecisionAsset(value.model); return value;
}
export async function hashDecisionFile(path, { signal, onBytes } = {}) {
  stopped(signal); const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const hash = createHash("sha256"); let bytes = 0;
  const stream = handle.createReadStream({ autoClose: false });
  const abort = () => stream.destroy(new DecisionAssetError("cancelled")); signal?.addEventListener("abort", abort, { once: true });
  try {
    if (!(await handle.stat()).isFile()) fail("unsafe-storage");
    for await (const chunk of stream) { stopped(signal); hash.update(chunk); bytes += chunk.length; onBytes?.(bytes); }
    stopped(signal); return { sha256: hash.digest("hex"), bytes };
  } finally { signal?.removeEventListener("abort", abort); stream.destroy(); await handle.close().catch(() => {}); }
}
export async function verifyDecisionAsset(path, asset, { signal } = {}) {
  const stat = await regularFile(path); if (!stat || stat.size !== asset.bytes) return false;
  const actual = await hashDecisionFile(path, { signal }); return actual.bytes === asset.bytes && actual.sha256 === asset.sha256;
}

async function fetchAsset(url, options, fetchImpl) {
  for (let count = 0; count <= 5; count++) {
    stopped(options.signal); const target = new URL(url);
    if (target.protocol !== "https:" || !HOSTS.has(target.hostname) || target.username || target.password) fail("download-redirect");
    const response = await fetchImpl(target.href, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location"); await response.body?.cancel().catch(() => {});
    if (!location) fail("download-redirect"); url = new URL(location, target).href;
  }
  fail("download-redirect");
}

/** One public, pinned regular file. Partial bytes survive cancellation; only a
 * complete exact hash is atomically promoted. There is no archive extraction. */
export async function downloadDecisionAsset({ asset, directory, signal, onProgress, onStage, fetchImpl = globalThis.fetch, idleTimeoutMs = 60000, statfsImpl = statfs } = {}) {
  validateDecisionAsset(asset); stopped(signal);
  const final = join(directory, asset.file), part = `${final}.part`, meta = `${part}.json`;
  if (await regularFile(final)) await onStage?.("verifying");
  if (await verifyDecisionAsset(final, asset, { signal })) { onProgress?.({ receivedBytes: asset.bytes, totalBytes: asset.bytes }); return final; }
  const existing = await lstat(final).catch(() => null); if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail("unsafe-storage");
  const identity = { sha256: asset.sha256, bytes: asset.bytes, file: asset.file };
  const previous = await readDecisionJSON(meta), partStat = await regularFile(part);
  const partExists = await lstat(part).catch(() => null);
  if (partExists && !partStat) fail("unsafe-storage");
  let offset = previous && JSON.stringify(previous) === JSON.stringify(identity) && partStat && partStat.size <= asset.bytes ? partStat.size : 0;
  if (!offset) await unlink(part).catch(() => {});
  await atomicDecisionJSON(meta, identity);
  if (offset === asset.bytes) {
    await onStage?.("verifying");
    if (await verifyDecisionAsset(part, asset, { signal })) { await rename(part, final); await unlink(meta).catch(() => {}); return final; }
    await unlink(part); offset = 0;
  }
  const disk = await statfsImpl(directory).catch(() => fail("disk-check-unavailable"));
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) fail("disk-check-unavailable");
  if (freeBytes < asset.bytes - offset + 256 * 1024 ** 2) fail("disk-space");
  stopped(signal); await onStage?.("downloading");
  onProgress?.({ receivedBytes: offset, totalBytes: asset.bytes });
  let response, handle, reader, idleTimer, timedOut = false;
  const controller = new AbortController(), parentSignal = signal;
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
  parentSignal?.addEventListener("abort", abort, { once: true }); if (parentSignal?.aborted) abort();
  signal = controller.signal;
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; abort(); }, Math.max(100, Math.min(120000, idleTimeoutMs))); };
  try {
    touch(); response = await abortRace(fetchAsset(asset.url, { signal, headers: { "accept-encoding": "identity", ...(offset ? { range: `bytes=${offset}-` } : {}) } }, fetchImpl), signal);
    if (response.status !== 200 && response.status !== 206) fail(response.status === 404 ? "download-not-published" : "download-http");
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      if (!range || Number(range[1]) !== offset || Number(range[3]) !== asset.bytes || Number(range[2]) !== asset.bytes - 1) fail("download-range");
    } else offset = 0; // Server ignored Range: this response safely replaces the partial.
    const encoding = response.headers.get("content-encoding"); if (encoding && encoding !== "identity") fail("download-encoding");
    const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes - offset)) fail("download-size");
    handle = await open(part, constants.O_WRONLY | constants.O_CREAT | (offset ? 0 : constants.O_TRUNC) | (constants.O_NOFOLLOW || 0), 0o600);
    const stat = await handle.stat(); if (!stat.isFile() || stat.size !== offset) fail("unsafe-storage");
    reader = response.body?.getReader(); if (!reader) fail("download-empty");
    let received = offset, lastProgress = 0;
    while (true) {
      stopped(signal); const chunk = await abortRace(reader.read(), signal); if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || received + chunk.value.byteLength > asset.bytes) fail("download-size");
      if (!chunk.value.byteLength) continue;
      let written = 0;
      while (written < chunk.value.byteLength) { const result = await handle.write(chunk.value, written, chunk.value.byteLength - written, received + written); if (!result.bytesWritten) fail("download-write"); written += result.bytesWritten; }
      received += chunk.value.byteLength;
      touch();
      if (Date.now() - lastProgress >= 100 || received === asset.bytes) { lastProgress = Date.now(); onProgress?.({ receivedBytes: received, totalBytes: asset.bytes }); }
    }
    stopped(signal); await handle.sync(); await handle.close(); handle = null;
    if (received !== asset.bytes) fail("download-size");
    clearTimeout(idleTimer); await onStage?.("verifying");
    if (!await verifyDecisionAsset(part, asset, { signal })) { await unlink(part).catch(() => {}); fail("download-hash"); }
    stopped(signal); await rename(part, final); await unlink(meta).catch(() => {}); return final;
  } catch (error) {
    if (signal?.aborted) fail(timedOut ? "download-timeout" : "cancelled");
    if (error?.code === "ENOSPC") fail("disk-space");
    if (error instanceof DecisionAssetError) throw error;
    fail("download-unavailable");
  } finally { clearTimeout(idleTimer); parentSignal?.removeEventListener("abort", abort); await handle?.close().catch(() => {}); void reader?.cancel().catch(() => {}); if (!reader) void response?.body?.cancel().catch(() => {}); }
}
