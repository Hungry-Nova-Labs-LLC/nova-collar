// Curated downloads and owner-selected GGUF imports. No renderer URLs or paths.
import { constants } from "node:fs";
import { lstat, open, readFile, rename, statfs, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { ROOT } from "./config.js";
import { atomicDecisionJSON, hashDecisionFile, privateDirectory, readDecisionJSON, regularFile } from "./decision-assets.js";
export { atomicDecisionJSON, privateDirectory, readDecisionJSON, regularFile, hashDecisionFile as hashLocalChatFile };

export const MAX_LOCAL_MODEL_BYTES = 32 * 1024 ** 3;
const RESERVE = 512 * 1024 ** 2, SHA = /^[a-f0-9]{64}$/;
const HOSTS = new Set(["huggingface.co", "us.aws.cdn.hf.co",
  "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);
export class LocalChatAssetError extends Error {
  constructor(code) { super(code); this.name = "LocalChatAssetError"; this.code = code; }
}
const fail = code => { throw new LocalChatAssetError(code); };
const stopped = signal => { if (signal?.aborted) fail("cancelled"); };
const text = (value, limit = 256) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const race = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(new LocalChatAssetError("cancelled"));
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
});

export function validateLocalChatAsset(asset) {
  if (!asset || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}\.gguf$/.test(asset.file || "") || !SHA.test(asset.sha256 || "")
    || !Number.isSafeInteger(asset.bytes) || asset.bytes < 24 || asset.bytes > MAX_LOCAL_MODEL_BYTES) fail("invalid-manifest");
  let url; try { url = new URL(asset.url); } catch { fail("invalid-manifest"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || basename(url.pathname) !== asset.file) fail("invalid-manifest");
  const pinnedHF = url.hostname === "huggingface.co" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/resolve\/[a-f0-9]{40}\/[A-Za-z0-9_.-]+\.gguf$/.test(url.pathname);
  const company = url.hostname === "github.com" && /^\/Hungry-Nova-Labs-LLC\/nova-collar\/releases\/download\/[^/]+\/[A-Za-z0-9_.-]+\.gguf$/.test(url.pathname);
  if (!pinnedHF && !company) fail("invalid-manifest");
  return asset;
}

export async function readLocalChatCatalog(root = ROOT) {
  const book = await readDecisionJSON(join(root, "data/local-chat-models.json"), 65536);
  if (book?.schemaVersion !== 1 || !Array.isArray(book.platforms) || book.platforms.some(value => !["darwin-arm64"].includes(value))
    || !Array.isArray(book.models) || !book.models.length || book.models.length > 16) fail("invalid-manifest");
  const ids = new Set();
  for (const model of book.models) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,95}$/.test(model?.id || "") || ids.has(model.id) || !text(model.label, 120)
      || !text(model.description, 500) || !text(model.license, 120) || !text(model.upstream, 300)
      || !/^[a-f0-9]{40}$/.test(model.revision || "") || !Number.isInteger(model.minMemoryGB) || model.minMemoryGB < 4 || model.minMemoryGB > 512
      || !Number.isInteger(model.contextTokens) || model.contextTokens < 2048 || model.contextTokens > 32768 || typeof model.tools !== "boolean") fail("invalid-manifest");
    validateLocalChatAsset(model.asset);
    if (new URL(model.asset.url).hostname === "huggingface.co" && !new URL(model.asset.url).pathname.includes(`/resolve/${model.revision}/`)) fail("invalid-manifest");
    ids.add(model.id);
  }
  return book;
}

export async function verifyLocalChatAsset(path, asset, { signal } = {}) {
  const stat = await regularFile(path); if (!stat || stat.size !== asset.bytes || stat.nlink !== 1) return false;
  const actual = await hashDecisionFile(path, { signal }); return actual.bytes === asset.bytes && actual.sha256 === asset.sha256;
}

async function fetchFile(url, options, fetchImpl) {
  for (let hop = 0; hop <= 5; hop++) {
    stopped(options.signal); const next = new URL(url);
    if (next.protocol !== "https:" || !HOSTS.has(next.hostname) || next.username || next.password || next.port || next.hash) fail("download-redirect");
    const response = await fetchImpl(next.href, { ...options, credentials: "omit", redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location"); await response.body?.cancel().catch(() => {});
    if (!location || hop === 5) fail("download-redirect"); url = new URL(location, next).href;
  }
  fail("download-redirect");
}

export async function downloadLocalChatAsset({ asset, directory, signal, onProgress, onStage, fetchImpl = globalThis.fetch, statfsImpl = statfs, idleTimeoutMs = 60000 } = {}) {
  validateLocalChatAsset(asset); stopped(signal);
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) fail("unsafe-storage");
  const final = join(directory, asset.file), part = final + ".part", meta = part + ".json";
  if (await regularFile(final)) await onStage?.("verifying");
  if (await verifyLocalChatAsset(final, asset, { signal })) { onProgress?.({ receivedBytes: asset.bytes, totalBytes: asset.bytes }); return final; }
  const finalStat = await lstat(final).catch(() => null), partStat = await lstat(part).catch(() => null);
  if ([finalStat, partStat].some(value => value && (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1))) fail("unsafe-storage");
  const identity = { sha256: asset.sha256, bytes: asset.bytes, file: asset.file };
  const previous = await readDecisionJSON(meta);
  let offset = previous && JSON.stringify(previous) === JSON.stringify(identity) && partStat && partStat.size <= asset.bytes ? partStat.size : 0;
  if (!offset) await unlink(part).catch(() => {});
  await atomicDecisionJSON(meta, identity);
  if (offset === asset.bytes) {
    await onStage?.("verifying");
    if (await verifyLocalChatAsset(part, asset, { signal })) { await rename(part, final); await unlink(meta).catch(() => {}); return final; }
    await unlink(part); offset = 0;
  }
  const disk = await statfsImpl(directory).catch(() => fail("disk-check-unavailable"));
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isFinite(available) || available < 0) fail("disk-check-unavailable");
  if (available < asset.bytes - offset + RESERVE) fail("disk-space");
  await onStage?.("downloading"); onProgress?.({ receivedBytes: offset, totalBytes: asset.bytes });
  const controller = new AbortController(), parent = signal;
  let response, handle, reader, timer, timedOut = false;
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(100, Math.min(120000, idleTimeoutMs))); };
  parent?.addEventListener("abort", abort, { once: true }); if (parent?.aborted) abort(); signal = controller.signal;
  try {
    touch(); response = await race(fetchFile(asset.url, { signal, headers: { "accept-encoding": "identity", ...(offset ? { range: `bytes=${offset}-` } : {}) } }, fetchImpl), signal);
    if (![200, 206].includes(response.status)) fail(response.status === 404 ? "download-not-published" : "download-http");
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== asset.bytes - 1 || Number(range[3]) !== asset.bytes) fail("download-range");
    } else offset = 0;
    const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") fail("download-encoding");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes - offset)) fail("download-size");
    handle = await open(part, constants.O_WRONLY | constants.O_CREAT | (offset ? 0 : constants.O_TRUNC) | (constants.O_NOFOLLOW || 0), 0o600);
    const opened = await handle.stat(); if (!opened.isFile() || opened.nlink !== 1 || opened.size !== offset) fail("unsafe-storage");
    reader = response.body?.getReader(); if (!reader) fail("download-empty");
    let received = offset, progressAt = 0;
    while (true) {
      stopped(signal); const chunk = await race(reader.read(), signal); if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || received + chunk.value.byteLength > asset.bytes) fail("download-size");
      if (!chunk.value.byteLength) continue;
      let written = 0;
      while (written < chunk.value.byteLength) { const result = await handle.write(chunk.value, written, chunk.value.byteLength - written, received + written); if (!result.bytesWritten) fail("download-write"); written += result.bytesWritten; }
      received += chunk.value.byteLength; touch();
      if (Date.now() - progressAt >= 100 || received === asset.bytes) { progressAt = Date.now(); onProgress?.({ receivedBytes: received, totalBytes: asset.bytes }); }
    }
    stopped(signal); await handle.sync(); await handle.close(); handle = null;
    if (received !== asset.bytes) fail("download-size");
    clearTimeout(timer); await onStage?.("verifying");
    if (!await verifyLocalChatAsset(part, asset, { signal })) { await unlink(part).catch(() => {}); fail("download-hash"); }
    stopped(signal); await rename(part, final); await unlink(meta).catch(() => {}); return final;
  } catch (error) {
    if (signal.aborted) fail(timedOut ? "download-timeout" : "cancelled");
    if (error?.code === "ENOSPC") fail("disk-space");
    if (error instanceof LocalChatAssetError) throw error;
    fail("download-unavailable");
  } finally {
    clearTimeout(timer); parent?.removeEventListener("abort", abort); await handle?.close().catch(() => {});
    void reader?.cancel().catch(() => {}); if (!reader) void response?.body?.cancel().catch(() => {});
  }
}

// Read the GGUF directory with bounded allocations. Imported metadata is data;
// it never selects a command, download, runtime flag, or executable.
export async function inspectGGUF(path, { signal } = {}) {
  stopped(signal);
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("invalid-gguf");
  // A cloud placeholder is not a local model. Opening one can block in the OS
  // while it silently downloads several GB, outside Nova's progress/cancel UI.
  if (before.size > 32 * 1024 ** 2 && before.blocks === 0) fail("model-not-local");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let position = 0, visited = 0;
  const MAX_HEADER = 32 * 1024 ** 2, MAX_STRING = 16 * 1024 ** 2;
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size < 32 || stat.size > MAX_LOCAL_MODEL_BYTES) fail("invalid-gguf");
    const header = Buffer.alloc(Math.min(stat.size, MAX_HEADER)); let loaded = 0;
    while (loaded < header.length) { stopped(signal); const read = await handle.read(header, loaded, header.length - loaded, loaded); if (!read.bytesRead) fail("invalid-gguf"); loaded += read.bytesRead; }
    const bytes = async count => {
      stopped(signal); if (!Number.isSafeInteger(count) || count < 0 || position + count > stat.size || position + count > MAX_HEADER) fail("invalid-gguf");
      const value = header.subarray(position, position + count); position += count; return value;
    };
    const u32 = async () => (await bytes(4)).readUInt32LE();
    const u64 = async () => { const n = (await bytes(8)).readBigUInt64LE(); if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid-gguf"); return Number(n); };
    const string = async keep => { const size = await u64(); if (size > MAX_STRING) fail("invalid-gguf"); const value = await bytes(size); return keep ? new TextDecoder("utf-8", { fatal: true }).decode(value) : ""; };
    const value = async (type, keep, depth = 0) => {
      if (++visited > 2_000_000 || depth > 4) fail("invalid-gguf");
      const sizes = [1, 1, 2, 2, 4, 4, 4, 1];
      if (type <= 7) {
        const b = await bytes(sizes[type]);
        if (!keep) return null;
        return type === 0 ? b.readUInt8() : type === 1 ? b.readInt8() : type === 2 ? b.readUInt16LE() : type === 3 ? b.readInt16LE() : type === 4 ? b.readUInt32LE() : type === 5 ? b.readInt32LE() : type === 6 ? b.readFloatLE() : b[0] !== 0;
      }
      if (type === 8) return string(keep);
      if (type === 9) { const item = await u32(), count = await u64(); if (count > 1_000_000 || item === 9 || item > 12) fail("invalid-gguf"); for (let i = 0; i < count; i++) await value(item, false, depth + 1); return null; }
      if (type === 10) return u64();
      if (type === 11) { const n = (await bytes(8)).readBigInt64LE(); return keep && n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : null; }
      if (type === 12) return (await bytes(8)).readDoubleLE();
      fail("invalid-gguf");
    };
    if ((await bytes(4)).toString("ascii") !== "GGUF" || ![2, 3].includes(await u32())) fail("invalid-gguf");
    const tensorCount = await u64(), count = await u64(); if (!tensorCount || tensorCount > 1_000_000 || count > 20000) fail("invalid-gguf");
    const metadata = new Map();
    for (let i = 0; i < count; i++) {
      const key = await string(true); if (key.length > 512 || metadata.has(key)) fail("invalid-gguf");
      const type = await u32(), keep = ["general.architecture", "general.name", "general.type", "general.alignment", "split.count", "tokenizer.chat_template"].includes(key) || /\.(context_length|pooling_type)$/.test(key);
      const parsed = await value(type, keep); metadata.set(key, keep ? parsed : null);
    }
    const architecture = metadata.get("general.architecture");
    if (!text(architecture, 80) || ["clip", "bert", "nomic-bert", "embeddinggemma", "t5encoder", "qwen3vlmoe-vision"].includes(architecture)
      || ["projector", "adapter", "imatrix"].includes(metadata.get("general.type")) || Number(metadata.get("split.count") || 1) > 1
      || Number(metadata.get(`${architecture}.pooling_type`) || 0) > 0 && !metadata.get("tokenizer.chat_template")) fail("unsupported-gguf");
    const tensorNames = new Set(); let largestOffset = 0;
    for (let i = 0; i < tensorCount; i++) {
      const name = await string(true), dimensions = await u32();
      if (!name || name.length > 1024 || tensorNames.has(name) || !dimensions || dimensions > 4) fail("invalid-gguf"); tensorNames.add(name);
      for (let dim = 0; dim < dimensions; dim++) if (!await u64()) fail("invalid-gguf");
      if (await u32() > 255) fail("unsupported-gguf");
      const offset = await u64(); largestOffset = Math.max(largestOffset, offset);
    }
    const alignment = metadata.get("general.alignment") ?? 32;
    if (!Number.isInteger(alignment) || alignment < 1 || alignment > 4096 || (alignment & (alignment - 1))) fail("invalid-gguf");
    const dataOffset = Math.ceil(position / alignment) * alignment;
    if (dataOffset + largestOffset >= stat.size) fail("invalid-gguf");
    const name = String(metadata.get("general.name") || architecture).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120);
    const context = metadata.get(`${architecture}.context_length`);
    return { architecture, name, contextTokens: Number.isSafeInteger(context) && context >= 2048 ? Math.min(context, 32768) : 8192,
      chatTemplate: typeof metadata.get("tokenizer.chat_template") === "string" && Boolean(metadata.get("tokenizer.chat_template").trim()), splitCount: 1, tensorCount, bytes: stat.size };
  } catch (error) { if (error instanceof LocalChatAssetError) throw error; fail(error?.code === "ENOENT" ? "model-missing" : "invalid-gguf"); }
  finally { await handle.close(); }
}

export async function importLocalGGUF({ source, directory, signal, onProgress } = {}) {
  stopped(signal);
  if (typeof source !== "string" || !source.toLowerCase().endsWith(".gguf")) fail("invalid-gguf");
  const srcStat = await lstat(source).catch(() => null), dirStat = await lstat(directory).catch(() => null);
  if (!srcStat?.isFile() || srcStat.isSymbolicLink() || srcStat.nlink !== 1 || !dirStat?.isDirectory() || dirStat.isSymbolicLink()) fail("unsafe-storage");
  if (srcStat.size > MAX_LOCAL_MODEL_BYTES) fail("model-too-large");
  const metadata = await inspectGGUF(source, { signal });
  const disk = await statfs(directory).catch(() => fail("disk-check-unavailable"));
  if (Number(disk.bavail) * Number(disk.bsize) < srcStat.size + RESERVE) fail("disk-space");
  const temporary = join(directory, `.import-${randomUUID()}.gguf`);
  let input, output;
  try {
    input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); const opened = await input.stat();
    if (opened.dev !== srcStat.dev || opened.ino !== srcStat.ino || opened.size !== srcStat.size || opened.nlink !== 1 || !opened.isFile()) fail("unsafe-storage");
    output = await open(temporary, "wx", 0o600); const hash = createHash("sha256"); let received = 0, at = 0;
    const stream = input.createReadStream({ autoClose: false });
    const abort = () => stream.destroy(new LocalChatAssetError("cancelled")); signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream) {
        stopped(signal); if (received + chunk.length > srcStat.size) fail("model-changed");
        let written = 0; while (written < chunk.length) { const done = await output.write(chunk, written, chunk.length - written, received + written); if (!done.bytesWritten) fail("download-write"); written += done.bytesWritten; }
        hash.update(chunk); received += chunk.length;
        if (Date.now() - at >= 100 || received === srcStat.size) { at = Date.now(); onProgress?.({ receivedBytes: received, totalBytes: srcStat.size }); }
      }
    } finally { signal?.removeEventListener("abort", abort); }
    const after = await input.stat();
    if (received !== srcStat.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail("model-changed");
    await output.sync(); await output.close(); output = null; await input.close(); input = null;
    const copied = await inspectGGUF(temporary, { signal });
    if (JSON.stringify(copied) !== JSON.stringify(metadata)) fail("model-changed");
    const sha256 = hash.digest("hex"), file = sha256 + ".gguf", final = join(directory, file), asset = { bytes: received, sha256 };
    const present = await lstat(final).catch(() => null);
    if (present && (!present.isFile() || present.isSymbolicLink() || present.nlink !== 1)) fail("unsafe-storage");
    if (!await verifyLocalChatAsset(final, asset, { signal })) await rename(temporary, final);
    stopped(signal); return { id: "import-" + sha256, file, bytes: received, sha256, metadata, label: metadata.name || "Imported GGUF" };
  } catch (error) { if (error?.code === "ENOSPC") fail("disk-space"); if (error instanceof LocalChatAssetError) throw error; if (signal?.aborted) fail("cancelled"); fail("import-unavailable"); }
  finally { await output?.close().catch(() => {}); await input?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
