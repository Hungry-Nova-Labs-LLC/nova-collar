import { freemem, totalmem } from "node:os";
import { readFile, statfs, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { APP_HOME, ROOT, loadBaseConfig, isLocalModel } from "./config.js";
import { atomicDecisionJSON, downloadLocalChatAsset, importLocalGGUF, inspectGGUF, privateDirectory, readDecisionJSON,
  readLocalChatCatalog, regularFile, verifyLocalChatAsset } from "./local-model-assets.js";
import { baseProviderStamp, clearLocalChatSelection, localChatId, readLocalChatSelection, writeLocalChatSelection } from "./local-chat-selection.js";
import { createLocalChatRuntime } from "./local-chat-runtime.js";

const GIB = 1024 ** 3;
const abortError = () => Object.assign(new Error("Stopped."), { name: "AbortError" });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = signal => { if (signal?.aborted) throw abortError(); };
const safeCode = error => error?.name === "AbortError" ? "cancelled" : new Set(["cancelled", "active-turn", "config-changed", "busy", "unsupported-platform", "model-active", "model-missing", "model-not-local", "model-changed", "model-too-large", "invalid-gguf", "unsupported-gguf", "missing-chat-template", "insufficient-memory", "insufficient-free-memory", "disk-space", "disk-check-unavailable", "download-timeout", "download-hash", "download-http", "download-range", "download-size", "download-unavailable", "download-redirect", "unsafe-storage", "runtime-unavailable", "chat-check-failed", "tool-check-failed", "check-timeout", "import-unavailable"]).has(error?.code) ? error.code : "unavailable";

/** Available memory includes reclaimable cache on supported Node runtimes.
 * Older runtimes retain the conservative OS-free fallback. Neither source is
 * a model-fit guarantee; both physical and available memory checks still apply. */
export function localChatMemory({ total = totalmem, free = freemem, available = () => process.availableMemory?.() } = {}) {
  const physical = total(); let usable;
  try { usable = available(); } catch {}
  if (!Number.isFinite(usable) || usable < 0) usable = free();
  if (!Number.isFinite(usable) || usable < 0) usable = 0;
  return { total: physical, free: Math.min(physical, usable) };
}

export function createLocalChatManager({ home = APP_HOME, root = ROOT, platform = `${process.platform}-${process.arch}`, fetchImpl = globalThis.fetch,
  canChange = () => true, readBaseConfig = loadBaseConfig, runtime, runtimeOptions = {}, catalog, completeImpl, memory = localChatMemory } = {}) {
  const listeners = new Set(), directory = join(home, "local-chat", "models"), inventory = join(home, "local-chat", "models.json");
  let bookPromise, operation = null, operationPromise = null, busyId = "", stage = "ready", errorCode = "", progress = { receivedBytes: 0, totalBytes: 0 }, stopping = false;
  let changingModel = false, operationStamp = "", previousSelection = null, committedId = "";
  const book = () => bookPromise ||= catalog ? Promise.resolve(catalog) : readLocalChatCatalog(root);
  const engine = runtime || createLocalChatRuntime({ home, fetchImpl, ...runtimeOptions, onStage: async (next, id) => { if (operation && !changingModel) return; stage = next; busyId = operation ? busyId : id; await emit(); } });
  async function records() {
    const stored = await readDecisionJSON(inventory, 262144); const rows = [];
    for (const row of stored?.schemaVersion === 1 && Array.isArray(stored.models) ? stored.models.slice(0, 64) : []) {
      if (!localChatId(row?.id) || typeof row.label !== "string" || row.label.length > 200 || !row.asset || basename(row.asset.file || "") !== row.asset.file
        || !/^[A-Za-z0-9_.-]+\.gguf$/.test(row.asset.file) || !/^[a-f0-9]{64}$/.test(row.asset.sha256 || "") || !Number.isSafeInteger(row.asset.bytes) || row.asset.bytes < 24
        || !Number.isInteger(row.contextTokens) || row.contextTokens < 512 || row.contextTokens > 32768 || typeof row.tools !== "boolean") continue;
      const stat = await regularFile(join(directory, row.asset.file));
      if (stat && stat.nlink === 1 && stat.size === row.asset.bytes && !rows.some(item => item.id === row.id)) rows.push(row);
    }
    return rows;
  }
  async function saveRecord(row) { const rows = await records(); await atomicDecisionJSON(inventory, { schemaVersion: 1, models: [...rows.filter(item => item.id !== row.id), row] }); }
  async function status() {
    const [catalog, saved] = await Promise.all([book(), records()]), base = readBaseConfig(), selected = readLocalChatSelection(home, base);
    const disk = await statfs(directory).catch(() => statfs(home).catch(() => null));
    const freeDiskBytes = disk ? Number(disk.bavail) * Number(disk.bsize) : null, memoryGB = Math.round(memory().total / GIB), freeMemoryGB = Math.round(memory().free / GIB * 10) / 10;
    const models = [...catalog.models, ...saved.filter(row => !catalog.models.some(model => model.id === row.id))].map(model => {
      const installed = saved.find(row => row.id === model.id), active = selected?.id === model.id;
      return { id: model.id, label: model.label, description: model.description || "A GGUF copied from a file you selected.", imported: model.imported === true,
        bytes: model.asset.bytes, minMemoryGB: model.minMemoryGB || 4, contextTokens: installed?.contextTokens || model.contextTokens,
        tools: installed?.tools ?? model.tools, installed: Boolean(installed), active, loaded: engine.loadedId() === model.id,
        canFitDisk: installed ? true : freeDiskBytes !== null && freeDiskBytes >= model.asset.bytes + 512 * 1024 ** 2,
        canFitMemory: memoryGB >= (model.minMemoryGB || 4), recommended: model.id === (memoryGB >= 24 ? "qwen35-9b-q4" : memoryGB >= 16 ? "qwen35-4b-q4" : "qwen35-2b-q4"),
        stage: busyId === model.id ? stage : installed ? engine.loadedId() === model.id ? "running" : "ready" : "not-installed",
        ...(busyId === model.id ? { progress: { ...progress }, ...(errorCode ? { errorCode } : {}) } : {}) };
    });
    return { supported: catalog.platforms.includes(platform), memoryGB, freeMemoryGB, freeDiskBytes, models, activeModelId: selected?.id || "",
      previousConnectionAvailable: isLocalModel(base.model) ? Boolean(base.localModel) : Boolean(base.chatUrl && (base.chatKey || base.toolsKey)), busyId: operation ? busyId : "", stage, progress: { ...progress }, ...(errorCode ? { errorCode } : {}) };
  }
  async function emit() { const snapshot = { type: "local-chat", ...await status() }; for (const listener of listeners) { try { listener(snapshot); } catch {} } return snapshot; }
  async function update(next, id = busyId) { stage = next; busyId = id; errorCode = ""; await emit(); }
  async function storage() { await privateDirectory(home, "local-chat", "models"); }
  async function model(id) { if (!localChatId(id)) fail("model-missing"); const row = (await records()).find(row => row.id === id); if (!row) fail("model-missing"); return { ...row, path: join(directory, row.asset.file) }; }
  async function guard() { if (!canChange()) fail("active-turn"); if (stopping) fail("cancelled"); }
  async function smoke(row, signal) {
    await update("checking", row.id);
    const controller = new AbortController(), abort = () => controller.abort(abortError());
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 180000);
    let lease;
    try {
      lease = await engine.acquire(row, { signal: controller.signal });
      const complete = completeImpl || (await import("./agent.js")).complete;
      const cfg = { ...readBaseConfig(), home }, target = { ...lease.target, managedLease: true };
      const response = await complete([{ role: "system", content: "Reply with READY only." }, { role: "user", content: "Check this local chat connection." }], cfg, null, controller.signal,
        { target, tools: [], temperature: 0, predict: 32, timeoutMs: 60000, quietTimeoutMs: 60000, capacity: false });
      if (!/\bREADY\b/i.test(response?.content || "") || response?.tool_calls?.length) fail("chat-check-failed");
      let tools = false;
      if (row.tools || row.imported) {
        const name = "nova_local_check", tool = { type: "function", function: { name, description: "A synthetic connection check. No action is executed.", parameters: { type: "object", properties: { value: { type: "string", enum: ["READY"] } }, required: ["value"], additionalProperties: false } } };
        let result;
        try {
          result = await complete([{ role: "system", content: "Call the supplied connection check with value READY. Do not write prose." }, { role: "user", content: "Check the tool protocol." }], cfg, null, controller.signal,
            { target: { ...target, managedMetadata: { ...target.managedMetadata, tools: true } }, tools: [tool], toolChoice: { type: "function", function: { name } }, temperature: 0, predict: 128, timeoutMs: 60000, quietTimeoutMs: 60000, capacity: false });
        } catch (error) { if (!row.imported || controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError" || ![400, 422].includes(error?.status)) throw error; }
        let value; try { value = JSON.parse(result?.tool_calls?.[0]?.function?.arguments || ""); } catch {}
        tools = result?.tool_calls?.length === 1 && result.tool_calls[0].function?.name === name && value?.value === "READY";
        if (!tools && !row.imported) fail("tool-check-failed");
      }
      check(controller.signal); return { tools };
    } catch (error) { if (controller.signal.aborted && !signal?.aborted) fail("check-timeout"); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); await lease?.release(); }
  }
  async function use(id, signal) {
    await guard(); check(signal);
    if (baseProviderStamp(home, readBaseConfig()) !== operationStamp) fail("config-changed");
    if (engine.busy()) fail("busy");
    const row = await model(id); await guard(); check(signal); if (engine.busy()) fail("busy"); changingModel = true;
    await engine.stop(); check(signal); await guard();
    if (memory().total < (row.minMemoryGB || 4) * GIB) fail("insufficient-memory");
    if (memory().free < row.asset.bytes + GIB) fail("insufficient-free-memory");
    const metadata = await inspectGGUF(row.path, { signal });
    if (!metadata.chatTemplate) fail("missing-chat-template");
    row.contextTokens = Math.min(row.contextTokens, metadata.contextTokens, 32768);
    const capability = await smoke(row, signal); row.tools = capability.tools;
    const { path: _path, ...savedRow } = row; await saveRecord(savedRow);
    await guard(); check(signal);
    if (baseProviderStamp(home, readBaseConfig()) !== operationStamp) fail("config-changed");
    writeLocalChatSelection(home, readBaseConfig(), { id: row.id, label: row.label, contextTokens: row.contextTokens, tools: row.tools });
    committedId = row.id;
    await update("running", row.id);
    const current = await status(); check(signal); return { ok: true, status: current };
  }
  async function run(id, action) {
    if (operationPromise) return { ok: false, errorCode: "busy", status: await status() };
    const controller = new AbortController(); operation = controller; busyId = id; errorCode = "";
    operationStamp = baseProviderStamp(home, readBaseConfig()); previousSelection = readLocalChatSelection(home, readBaseConfig()); committedId = "";
    operationPromise = (async () => {
      const catalog = await book(); if (!catalog.platforms.includes(platform)) fail("unsupported-platform");
      await storage(); return await action(controller.signal);
    })().catch(async error => {
      if (changingModel) await engine.stop();
      if (controller.signal.aborted && committedId && baseProviderStamp(home, readBaseConfig()) === operationStamp
        && readLocalChatSelection(home, readBaseConfig())?.id === committedId) {
        if (previousSelection) writeLocalChatSelection(home, readBaseConfig(), previousSelection); else clearLocalChatSelection(home);
      }
      stage = controller.signal.aborted ? "cancelled" : "error"; errorCode = controller.signal.aborted ? "cancelled" : safeCode(error); await emit();
      return { ok: false, errorCode, status: await status() };
    }).finally(async () => { operation = null; operationPromise = null; changingModel = false; await emit(); });
    return operationPromise;
  }
  return {
    status, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    install(id) { return run(id, async signal => {
      const row = (await book()).models.find(row => row.id === id); if (!row) fail("model-missing");
      if (memory().total < row.minMemoryGB * GIB) fail("insufficient-memory");
      await update("downloading", id);
      const path = await downloadLocalChatAsset({ asset: row.asset, directory, signal, fetchImpl, onStage: stage => update(stage, id), onProgress(value) { progress = value; void emit(); } });
      const metadata = await inspectGGUF(path, { signal });
      await saveRecord({ ...row, metadata, contextTokens: Math.min(row.contextTokens, metadata.contextTokens), imported: false });
      return use(id, signal);
    }); },
    import(source) { return run("import", async signal => {
      await guard(); await update("importing", "import");
      const imported = await importLocalGGUF({ source, directory, signal, onProgress(value) { progress = value; void emit(); } });
      const row = { id: imported.id, label: imported.label, asset: { file: imported.file, bytes: imported.bytes, sha256: imported.sha256 }, metadata: imported.metadata,
        contextTokens: imported.metadata.contextTokens, tools: false, minMemoryGB: 4, imported: true };
      await saveRecord(row); busyId = row.id; return use(row.id, signal);
    }); },
    use(id) { return run(id, signal => use(id, signal)); },
    async acquire(id, { signal } = {}) { if (changingModel || stopping) fail("busy"); return engine.acquire(await model(id), { signal }); },
    async cancel() { operation?.abort(abortError()); await operationPromise; return { ok: true, status: await status() }; },
    async stop() { await guard(); operation?.abort(abortError()); await engine.stop(); await operationPromise; await update("stopped"); return { ok: true, status: await status() }; },
    async shutdown() { stopping = true; operation?.abort(abortError()); await engine.stop(); await operationPromise; },
    async externalChange() {
      operation?.abort(abortError()); await operationPromise;
      if (!readLocalChatSelection(home, readBaseConfig())) { await engine.stop(); await update("ready"); }
    },
    remove(id) { return run(id, async signal => {
      await guard(); if (engine.busy()) fail("busy"); const row = await model(id); await guard(); check(signal);
      if (engine.loadedId() === id) fail("model-active");
      if (readLocalChatSelection(home, readBaseConfig())?.id === id) clearLocalChatSelection(home);
      const list = (await records()).filter(item => item.id !== id); await atomicDecisionJSON(inventory, { schemaVersion: 1, models: list });
      if (!list.some(item => item.asset.file === row.asset.file)) await unlink(row.path);
      await update("ready"); return { ok: true, status: await status() };
    }); },
    restore() { return run("", async signal => { await guard(); if (engine.busy()) fail("busy"); changingModel = true; check(signal); await engine.stop(); await guard(); clearLocalChatSelection(home); await update("ready"); return { ok: true, status: await status() }; }); },
    routingBusy: () => changingModel || engine.busy(),
  };
}

let singleton, guard = () => true;
const manager = () => singleton ||= createLocalChatManager({ canChange: () => guard() });
export const setLocalChatGuard = callback => { guard = callback; };
export const localChatStatus = () => manager().status();
export const localChatInstall = id => manager().install(id);
export const localChatImport = source => manager().import(source);
export const localChatUse = id => manager().use(id);
export const localChatStop = () => manager().stop();
export const localChatCancel = () => manager().cancel();
export const localChatRemove = id => manager().remove(id);
export const localChatRestorePrevious = () => manager().restore();
export const stopLocalChatRuntime = () => manager().shutdown();
export const onLocalChatStatus = callback => manager().subscribe(callback);
export const localChatRoutingBusy = () => singleton?.routingBusy() || false;
export const localChatExternalChange = () => manager().externalChange();
export async function acquireLocalChatTarget(target, { signal } = {}) { return manager().acquire(target.managedChatId, { signal }); }
export async function localChatLicense() { return { title: "Qwen3.5 · Apache License 2.0", text: (await readFile(join(ROOT, "data/licenses/Qwen3.5-APACHE-2.0.txt"), "utf8")).slice(0, 32768) }; }
