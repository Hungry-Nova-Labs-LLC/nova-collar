import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_HOME, ROOT } from "./config.js";
import { requestDecision } from "./decision-service.js";
import { atomicDecisionJSON, DecisionAssetError, downloadDecisionAsset, hashDecisionFile, privateDirectory, readDecisionAssets, readDecisionJSON, regularFile, verifyDecisionAsset } from "./decision-assets.js";

const abortError = () => Object.assign(new Error("Stopped."), { name: "AbortError" });
const stopCheck = signal => { if (signal?.aborted) throw abortError(); };
const safeError = error => error?.code === "download-not-published" ? "The free model download is not available yet. Try again later."
  : error?.code === "download-hash" ? "The model did not match its published checksum. Please retry the download."
  : error?.code === "unsupported" ? "The free local adviser is not available for this platform yet."
  : error?.code === "runtime-unavailable" ? "This app is missing a verified local adviser runtime. Install a complete Nova Collar build."
  : error?.code === "disk-space" ? "Free enough disk space for the model plus 256 MB, then retry."
  : error?.code === "download-timeout" ? "The download stopped making progress. Retry to resume it."
  : error?.code === "cancelled" || error?.name === "AbortError" ? "Local adviser setup was cancelled."
  : "The local adviser is unavailable. Retry setup or continue without it.";
const raise = code => { throw new DecisionAssetError(code); };
const bounded = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const contained = (root, path) => { const rel = relative(root, path); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortError()); };
  const timer = setTimeout(done, ms); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
});

/** Owns only the optional local adviser. No chat routes, native Laya, tool
 * authority or training services are started or changed. */
export function createDecisionLocalManager({ home = APP_HOME, root = ROOT, platform = `${process.platform}-${process.arch}`,
  runtimeRoot = ROOT.endsWith("app.asar") ? join(process.resourcesPath, "decision-runtime") : join(ROOT, "vendor", "decision-runtime", `${process.platform}-${process.arch}`),
  assets, fetchImpl = globalThis.fetch, spawnImpl = spawn, idleMs = 120000, startupMs = 45000 } = {}) {
  const listeners = new Set(); let stage = "not-installed", error = "", errorCode = "", progress = { receivedBytes: 0, totalBytes: 0, percent: 0 };
  let lifecycle = null, lifecyclePromise = null, child = null, childClosed = null, startPromise = null, endpoint = "", token = "", alias = "", idleTimer = null;
  let activeRequest = null, activeSettled = null, stopping = null, bundled = null, manifestPromise = null, authPath = "", disabledByUser = false;
  const paths = { local: join(home, "decision-local"), models: join(home, "decision-local", "models"), state: join(home, "decision-local", "state.json"),
    receipt: join(home, "decision-local", "model-receipt.json"), settings: join(home, "decision-adviser.json") };
  const manifest = () => manifestPromise ||= assets ? Promise.resolve(assets) : readDecisionAssets(root);
  async function config() { return await readDecisionJSON(paths.settings) || {}; }
  async function installed(book) {
    const receipt = await readDecisionJSON(paths.receipt), stat = await regularFile(join(paths.models, book.model.file));
    return Boolean(stat && stat.size === book.model.bytes && receipt?.sha256 === book.model.sha256 && receipt.bytes === book.model.bytes);
  }
  async function status() {
    let book; try { book = await manifest(); } catch { return { supported: false, reason: "invalid-manifest", stage: "error", installed: false, enabled: false, firstRunPrompted: false, progress: { ...progress }, error: "The local adviser manifest is unavailable." }; }
    const supported = book.platforms.includes(platform), settings = await config(), state = await readDecisionJSON(paths.state) || {};
    const present = await installed(book);
    return { supported, ...(!supported ? { reason: "unsupported-platform" } : {}), stage: present && stage === "not-installed" ? "ready" : stage,
      installed: present, enabled: settings.enabled === true && settings.provider === "local", firstRunPrompted: state.firstRunPrompted === true,
      progress: { ...progress, totalBytes: book.model.bytes, percent: Math.min(100, Math.max(0, Math.floor(progress.receivedBytes / book.model.bytes * 100))) }, ...(error ? { error, errorCode } : {}) };
  }
  async function emit() { const snapshot = { type: "decision-local", ...await status() }; for (const fn of listeners) { try { fn(snapshot); } catch {} } return snapshot; }
  async function setStage(value, failure = "", code = "") { stage = value; error = failure; errorCode = code; return emit(); }
  async function markPrompted() { await privateDirectory(home, "decision-local"); const previous = await readDecisionJSON(paths.state) || {}; await atomicDecisionJSON(paths.state, { ...previous, firstRunPrompted: true }); }
  async function setEnabled(enabled) {
    if (typeof enabled !== "boolean") raise("invalid-setting");
    const book = await manifest(); if (enabled && (!book.platforms.includes(platform) || !await installed(book))) raise("not-installed");
    await privateDirectory(home, "decision-local"); const previous = await config();
    // Do not change an existing endpoint provider merely by disabling local.
    if (enabled || previous.provider === "local") await atomicDecisionJSON(paths.settings, { ...previous, provider: "local", enabled, model: "laya", maxPerTurn: 1 });
    if (enabled) disabledByUser = false;
    await markPrompted(); return status();
  }
  const modelPath = async () => join(paths.models, (await manifest()).model.file);
  async function runtime(signal) {
    if (bundled) return bundled;
    const value = await readDecisionJSON(join(runtimeRoot, "manifest.json"), 65536);
    if (value?.schemaVersion !== 1 || value.platform !== platform || typeof value.executable !== "string" || !Array.isArray(value.files) || !value.files.length || value.files.length > 64) raise("runtime-unavailable");
    const base = await realpath(runtimeRoot).catch(() => ""); if (!base) raise("runtime-unavailable");
    const names = new Set();
    for (const file of value.files) {
      if (!file || typeof file.path !== "string" || file.path.length > 256 || file.path.includes("\\") || isAbsolute(file.path)
        || file.path.split("/").some(part => !part || [".", ".."].includes(part)) || names.has(file.path)
        || !/^[a-f0-9]{64}$/.test(file.sha256 || "") || !Number.isSafeInteger(file.bytes) || file.bytes < 1) raise("runtime-unavailable");
      names.add(file.path); const full = resolve(base, file.path);
      if (!contained(base, full) || await realpath(full).catch(() => "") !== full) raise("runtime-unavailable");
      const stat = await regularFile(full); if (!stat || stat.size !== file.bytes) raise("runtime-unavailable");
      const actual = await hashDecisionFile(full, { signal }); if (actual.sha256 !== file.sha256) raise("runtime-unavailable");
    }
    if (!names.has(value.executable)) raise("runtime-unavailable");
    bundled = { ...value, root: base, executable: resolve(base, value.executable) }; return bundled;
  }
  async function killRuntime() {
    clearTimeout(idleTimer); idleTimer = null;
    if (stopping) return stopping;
    const proc = child, closed = childClosed, secretFile = authPath; child = null; endpoint = ""; token = ""; alias = ""; startPromise = null; authPath = "";
    if (!proc) { if (secretFile) await unlink(secretFile).catch(() => {}); return; }
    stopping = (async () => {
      const kill = signal => { try { if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal); else proc.kill(signal); } catch {} };
      kill("SIGTERM"); let timer;
      const exited = await Promise.race([closed?.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]); clearTimeout(timer);
      if (!exited) { kill("SIGKILL"); await Promise.race([closed, wait(1500)]); }
    })().finally(async () => { if (secretFile) await unlink(secretFile).catch(() => {}); stopping = null; });
    return stopping;
  }
  function idle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!activeRequest && !lifecycle) void killRuntime(); }, bounded(idleMs, 50, 600000, 120000)); idleTimer.unref?.(); }
  async function getPort() {
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
  }
  async function localJSON(path, { signal } = {}) {
    const response = await fetchImpl(endpoint + path, { signal, headers: { authorization: `Bearer ${token}` }, redirect: "error" });
    if (response.status !== 200) raise("runtime-unavailable");
    const text = await response.text(); if (text.length > 32768) raise("runtime-unavailable"); return JSON.parse(text);
  }
  async function ensureStarted(signal) {
    stopCheck(signal); clearTimeout(idleTimer); await stopping;
    if (child && endpoint) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const book = await manifest(); if (!book.platforms.includes(platform)) raise("unsupported");
      if (!await installed(book) || !await verifyDecisionAsset(await modelPath(), book.model, { signal })) raise("not-installed");
      const bundle = await runtime(signal); stopCheck(signal); const port = await getPort(); stopCheck(signal);
      endpoint = `http://127.0.0.1:${port}`; token = randomUUID() + randomUUID(); alias = `nova-collar-d1-${randomUUID()}`;
      await privateDirectory(home, "decision-local"); authPath = join(paths.local, `runtime-auth-${randomUUID()}`);
      const auth = await open(authPath, "wx", 0o600); try { await auth.writeFile(token + "\n"); } finally { await auth.close(); }
      await setStage("starting"); stopCheck(signal);
      const args = ["--model", await modelPath(), "--alias", alias, "--host", "127.0.0.1", "--port", String(port), "--api-key-file", authPath,
        "--device", "none", "--gpu-layers", "0", "--threads", "4", "--threads-batch", "4", "--parallel", "1", "--ctx-size", "8192", "--batch-size", "8192", "--ubatch-size", "8192"];
      stopCheck(signal);
      const runtimeEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "LANG", "LC_ALL"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      const proc = spawnImpl(bundle.executable, args, { cwd: bundle.root, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
        env: { ...runtimeEnv, LLAMA_LOG_COLORS: "0" } });
      child = proc; childClosed = new Promise(resolve => { proc.once("close", resolve); proc.once("error", resolve); });
      const ownedAuth = authPath;
      childClosed.then(() => { void unlink(ownedAuth).catch(() => {}); if (child === proc) { child = null; endpoint = ""; token = ""; alias = ""; authPath = ""; } });
      const until = performance.now() + bounded(startupMs, 100, 120000, 45000);
      while (performance.now() < until) {
        stopCheck(signal); if (child !== proc || proc.exitCode !== null || proc.signalCode) raise("runtime-unavailable");
        try {
          const models = await localJSON("/v1/models", { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(800)]) });
          if (models.data?.some(row => row.id === alias)) return;
        } catch (error) { if (signal?.aborted) throw error; }
        await wait(100, signal);
      }
      raise("runtime-unavailable");
    })();
    try { await startPromise; } catch (error) { await killRuntime(); throw error; } finally { startPromise = null; }
  }
  async function decide(options = {}, setup = false) {
    if (activeRequest || !setup && disabledByUser) return { ok: false, reason: "service-unavailable", elapsedMs: 0 };
    const controller = new AbortController(), began = performance.now(), duration = bounded(options.timeoutMs, 100, 120000, 30000);
    const abort = () => controller.abort(options.signal?.reason || abortError()); options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), duration); activeRequest = controller;
    let settle, output; activeSettled = new Promise(resolve => { settle = resolve; });
    try {
      if (!setup) { const selected = await config(); if (disabledByUser || selected.provider !== "local" || selected.enabled !== true) raise("disabled"); }
      await ensureStarted(controller.signal); stopCheck(controller.signal);
      const result = await requestDecision({ ...options, model: alias, endpoint: endpoint + "/v1/systemone", apiKey: token,
        signal: controller.signal, timeoutMs: Math.max(100, duration - (performance.now() - began)),
        fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body); delete body.model;
          // Native typed decisions use the exact slot/probability contract.
          // Only remove the gateway routing field, never repair a decision.
          const response = await fetchImpl(url, { ...init, body: JSON.stringify(body) });
          return response;
        } });
      if (result.ok && stage === "starting") await setStage("ready");
      output = { ...result, elapsedMs: performance.now() - began }; return output;
    } catch (error) {
      output = { ok: false, reason: options.signal?.aborted || controller.signal.reason?.name === "AbortError" ? "cancelled" : controller.signal.aborted ? "timeout" : "service-unavailable", elapsedMs: performance.now() - began }; return output;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); activeRequest = null;
      if (controller.signal.aborted) await killRuntime(); else idle();
      if (controller.signal.aborted && output) { output.ok = false; output.reason = options.signal?.aborted || controller.signal.reason?.name === "AbortError" ? "cancelled" : "timeout"; delete output.choice; delete output.confidence; delete output.probabilities; }
      settle(); activeSettled = null;
    }
  }
  async function check({ signal } = {}) {
    await setStage("checking"); const result = await decide({ signal, timeoutMs: 60000,
      state: { receipt: "Nova Collar local adviser installation self-check. The word is READY." },
      actions: [{ id: "ready", description: "The supplied word is READY." }, { id: "other", description: "The supplied word is something else." }] }, true);
    if (!result.ok || result.choice !== "ready") raise(signal?.aborted ? "cancelled" : "self-check-failed");
    await setStage("ready"); return status();
  }
  async function install({ signal, onProgress } = {}) {
    if (lifecyclePromise) return lifecyclePromise;
    const controller = new AbortController(); lifecycle = controller;
    const abort = () => controller.abort(signal.reason || abortError()); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    let previousSettings = null, committedSettings = null;
    lifecyclePromise = (async () => {
      previousSettings = await config();
      await markPrompted(); const book = await manifest(); if (!book.platforms.includes(platform)) raise("unsupported");
      // Qualify the bundled runtime before spending the user's download.
      await runtime(controller.signal); stopCheck(controller.signal); await privateDirectory(home, "decision-local", "models");
      await setStage("downloading");
      await downloadDecisionAsset({ asset: book.model, directory: paths.models, signal: controller.signal, fetchImpl,
        onStage: value => setStage(value),
        onProgress(value) { progress = value; onProgress?.(value); void emit(); } });
      await setStage("verifying"); if (!await verifyDecisionAsset(await modelPath(), book.model, { signal: controller.signal })) raise("download-hash");
      await atomicDecisionJSON(paths.receipt, { schemaVersion: 1, file: book.model.file, bytes: book.model.bytes, sha256: book.model.sha256, revision: book.model.revision });
      await check({ signal: controller.signal }); stopCheck(controller.signal);
      committedSettings = { ...previousSettings, provider: "local", enabled: true, model: "laya", maxPerTurn: 1 };
      await setEnabled(true); stopCheck(controller.signal); await setStage("ready"); const snapshot = await status(); stopCheck(controller.signal); return snapshot;
    })().catch(async failure => {
      await killRuntime();
      if (controller.signal.aborted && committedSettings && JSON.stringify(await config()) === JSON.stringify(committedSettings)) await atomicDecisionJSON(paths.settings, previousSettings);
      const cancelled = controller.signal.aborted || failure?.name === "AbortError";
      await setStage(cancelled ? "cancelled" : "error", safeError(failure), cancelled ? "cancelled" : /^[a-z-]{1,40}$/.test(failure?.code || "") ? failure.code : "unavailable"); return status(); })
      .finally(() => { signal?.removeEventListener("abort", abort); lifecycle = null; lifecyclePromise = null; idle(); });
    return lifecyclePromise;
  }
  return {
    status, install,
    async setEnabled(value) {
      if (typeof value !== "boolean") raise("invalid-setting");
      if (!value) {
        disabledByUser = true; const settled = activeSettled;
        lifecycle?.abort(abortError()); activeRequest?.abort(abortError());
        await killRuntime(); await settled; await lifecyclePromise; return setEnabled(false);
      }
      if (lifecyclePromise || activeRequest) return status();
      const controller = new AbortController(); lifecycle = controller;
      let previousSettings, committedSettings;
      lifecyclePromise = (async () => {
        previousSettings = await config(); await markPrompted(); await check({ signal: controller.signal }); stopCheck(controller.signal);
        committedSettings = { ...previousSettings, provider: "local", enabled: true, model: "laya", maxPerTurn: 1 };
        await setEnabled(true); stopCheck(controller.signal); await setStage("ready"); const snapshot = await status(); stopCheck(controller.signal); return snapshot;
      })().catch(async failure => {
        await killRuntime();
        if (controller.signal.aborted && committedSettings && JSON.stringify(await config()) === JSON.stringify(committedSettings)) await atomicDecisionJSON(paths.settings, previousSettings);
        await setStage(controller.signal.aborted ? "cancelled" : "error", safeError(failure), controller.signal.aborted ? "cancelled" : "self-check-failed"); return status();
      }).finally(() => { lifecycle = null; lifecyclePromise = null; idle(); });
      return lifecyclePromise;
    }, request: decide,
    async check(options = {}) {
      if (lifecyclePromise || activeRequest) return status();
      const controller = new AbortController(); lifecycle = controller;
      const abort = () => controller.abort(abortError()); options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
      lifecyclePromise = (async () => { await markPrompted(); return check({ signal: controller.signal }); })().catch(async failure => {
        await killRuntime(); await setStage(controller.signal.aborted ? "cancelled" : "error", safeError(failure), controller.signal.aborted ? "cancelled" : "self-check-failed"); return status();
      }).finally(() => { options.signal?.removeEventListener("abort", abort); lifecycle = null; lifecyclePromise = null; idle(); });
      return lifecyclePromise;
    },
    async defer() { await markPrompted(); return status(); },
    async cancel() { lifecycle?.abort(abortError()); if (lifecyclePromise) await lifecyclePromise; return status(); },
    async stop() { const settled = activeSettled; lifecycle?.abort(abortError()); activeRequest?.abort(abortError()); await killRuntime(); await settled; await lifecyclePromise; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

let singleton;
const manager = () => singleton ||= createDecisionLocalManager();
export const decisionLocalStatus = () => manager().status();
export const decisionLocalInstall = options => manager().install(options);
export const decisionLocalCancel = () => manager().cancel();
export const decisionLocalSetEnabled = enabled => manager().setEnabled(enabled);
export const decisionLocalDefer = () => manager().defer();
export const decisionLocalCheck = options => manager().check(options);
export const stopDecisionLocal = () => manager().stop();
export const onDecisionLocalStatus = fn => manager().subscribe(fn);
export const requestLocalDecision = options => manager().request(options);
