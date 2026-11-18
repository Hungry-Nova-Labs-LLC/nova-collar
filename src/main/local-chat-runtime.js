import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ROOT } from "./config.js";
import { hashLocalChatFile, privateDirectory, readDecisionJSON, regularFile, verifyLocalChatAsset } from "./local-model-assets.js";
import { managedSettingsUrl } from "./local-chat-selection.js";

const abortError = () => Object.assign(new Error("Stopped."), { name: "AbortError" });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = signal => { if (signal?.aborted) throw abortError(); };
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortError()); };
  const timer = setTimeout(done, ms); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
});
const inside = (root, file) => { const part = relative(root, file); return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

/** One authenticated owned native head. Serialized leases cover complete SSE
 * responses; a stopped request unloads the process but retains the selection. */
export function createLocalChatRuntime({ home, runtimeRoot = ROOT.endsWith("app.asar") ? join(process.resourcesPath, "decision-runtime") : join(ROOT, "vendor/decision-runtime", `${process.platform}-${process.arch}`),
  platform = `${process.platform}-${process.arch}`, fetchImpl = globalThis.fetch, spawnImpl = spawn, openImpl = open, idleMs = 300000, startupMs = 120000, onStage = () => {} } = {}) {
  let child = null, closed = null, authFile = "", endpoint = "", token = "", alias = "", loaded = null, active = null, idleTimer, stopping, startupBarrier;
  const queue = []; let pumping = false;
  async function bundle(signal) {
    const manifest = await readDecisionJSON(join(runtimeRoot, "manifest.json"), 65536);
    if (manifest?.schemaVersion !== 1 || manifest.platform !== platform || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) fail("runtime-unavailable");
    const root = await realpath(runtimeRoot), names = new Set();
    for (const item of manifest.files) {
      check(signal);
      if (!item || typeof item.path !== "string" || item.path.length > 256 || item.path.includes("\\") || item.path.split("/").some(part => !part || [".", ".."].includes(part))
        || isAbsolute(item.path) || names.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes < 1) fail("runtime-unavailable");
      const file = resolve(root, item.path), stat = await regularFile(file); names.add(item.path);
      if (!inside(root, file) || await realpath(file) !== file || !stat || stat.size !== item.bytes || (await hashLocalChatFile(file, { signal })).sha256 !== item.sha256) fail("runtime-unavailable");
    }
    if (!names.has(manifest.executable)) fail("runtime-unavailable");
    return { root, executable: join(root, manifest.executable) };
  }
  async function stopHead(notify = false) {
    clearTimeout(idleTimer); if (stopping) return stopping;
    const proc = child, done = closed, secret = authFile, stoppedId = loaded?.id;
    child = null; closed = null; authFile = ""; endpoint = ""; token = ""; alias = ""; loaded = null;
    stopping = (async () => {
      if (proc) {
        const kill = signal => { try { if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal); else proc.kill(signal); } catch {} };
        kill("SIGTERM"); let timer;
        const exited = await Promise.race([done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]); clearTimeout(timer);
        if (!exited) { kill("SIGKILL"); await Promise.race([done, wait(1500)]); }
      }
      if (secret) await unlink(secret).catch(() => {});
      if (notify && stoppedId) await onStage("stopped", stoppedId);
    })().finally(() => { stopping = null; });
    return stopping;
  }
  async function stop() {
    for (const ticket of queue.splice(0)) { ticket.signal?.removeEventListener("abort", ticket.abort); ticket.reject(abortError()); }
    if (active) active.controller.abort(abortError());
    await startupBarrier;
    await stopHead();
  }
  async function port() { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const value = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return value; }
  async function start(model, signal) {
    check(signal); await stopping;
    if (child && loaded?.id === model.id && loaded?.asset.sha256 === model.asset.sha256 && loaded?.contextTokens === model.contextTokens) return;
    await stopHead(); check(signal); await onStage("verifying", model.id);
    if (!await verifyLocalChatAsset(model.path, model.asset, { signal })) fail("model-changed");
    const runtime = await bundle(signal); check(signal); const number = await port(); check(signal);
    const directory = await privateDirectory(home, "local-chat");
    const ownedAuthFile = join(directory, "runtime-auth-" + randomUUID()), ownedToken = randomUUID() + randomUUID();
    let started = false;
    try {
    const handle = await openImpl(ownedAuthFile, "wx", 0o600); try { await handle.writeFile(ownedToken + "\n"); } finally { await handle.close(); }
    check(signal);
    token = ownedToken; alias = "nova-chat-" + randomUUID(); endpoint = `http://127.0.0.1:${number}/v1`; authFile = ownedAuthFile;
    await onStage("starting", model.id); check(signal);
    const args = ["--model", model.path, "--host", "127.0.0.1", "--port", String(number), "--alias", alias, "--api-key-file", authFile,
      "--jinja", "--chat-template-kwargs", '{"enable_thinking":false}', "--gpu-layers", "999", "--parallel", "1", "--threads", "4", "--threads-batch", "4",
      "--ctx-size", String(model.contextTokens), "--batch-size", "512", "--ubatch-size", "512"];
    check(signal);
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "LANG", "LC_ALL"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const proc = spawnImpl(runtime.executable, args, { cwd: runtime.root, env: { ...env, LLAMA_LOG_COLORS: "0" }, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child = proc; const secret = authFile;
    closed = new Promise(resolve => { proc.once("error", resolve); proc.once("close", resolve); });
    closed.then(() => { void unlink(secret).catch(() => {}); if (child === proc) { const stoppedId = loaded?.id; child = null; loaded = null; endpoint = ""; token = ""; alias = ""; authFile = ""; if (stoppedId) void onStage("stopped", stoppedId); } });
    const until = performance.now() + Math.min(180000, Math.max(100, startupMs));
    while (performance.now() < until) {
      check(signal); if (child !== proc || proc.exitCode !== null || proc.signalCode) fail("runtime-unavailable");
      try {
        const linked = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(1500)]);
        const response = await fetchImpl(endpoint + "/models", { signal: linked, redirect: "error", headers: { authorization: `Bearer ${token}` } });
        const body = await response.text(); if (body.length > 32768) fail("runtime-unavailable");
        if (response.status === 200 && JSON.parse(body).data?.some(row => row.id === alias)) { loaded = model; await onStage("running", model.id); check(signal); started = true; return; }
      } catch (error) { if (signal?.aborted) throw error; }
      await wait(100, signal);
    }
    fail("runtime-unavailable");
    } finally { if (!started) await unlink(ownedAuthFile).catch(() => {}); }
  }
  async function pump() {
    if (pumping || active) return; pumping = true;
    try {
      const ticket = queue.shift(); if (!ticket) return;
      ticket.signal?.removeEventListener("abort", ticket.abort);
      if (ticket.signal?.aborted) { ticket.reject(abortError()); return; }
      const controller = new AbortController(), abort = () => { controller.abort(abortError()); void stopHead(); };
      active = { controller }; ticket.signal?.addEventListener("abort", abort, { once: true }); if (ticket.signal?.aborted) abort();
      try {
        clearTimeout(idleTimer);
        const starting = start(ticket.model, controller.signal), barrier = starting.catch(() => {}); startupBarrier = barrier;
        try { await starting; } finally { if (startupBarrier === barrier) startupBarrier = null; }
        check(controller.signal);
        let released = false;
        ticket.resolve({ target: { kind: "managed-chat", managedChatId: ticket.model.id, model: alias, url: endpoint, key: token, local: true,
          profileUrl: managedSettingsUrl(ticket.model.id), profileModel: ticket.model.id,
          managedMetadata: { context: ticket.model.contextTokens, output: 4096, tools: ticket.model.tools } },
          async release() {
            if (released) return; released = true; ticket.signal?.removeEventListener("abort", abort);
            if (controller.signal.aborted) await stopHead(); active = null;
            idleTimer = setTimeout(() => { if (!active && !queue.length) void stopHead(true); }, Math.max(50, idleMs)); idleTimer.unref?.();
            void pump();
          } });
      } catch (error) { ticket.signal?.removeEventListener("abort", abort); await stopHead(); active = null; ticket.reject(error); }
    } finally { pumping = false; if (!active && queue.length) void pump(); }
  }
  return {
    acquire(model, { signal } = {}) {
      check(signal);
      return new Promise((resolve, reject) => {
        const ticket = { model, signal, resolve, reject, abort: null };
        ticket.abort = () => { const index = queue.indexOf(ticket); if (index >= 0) queue.splice(index, 1); signal?.removeEventListener("abort", ticket.abort); reject(abortError()); };
        signal?.addEventListener("abort", ticket.abort, { once: true }); queue.push(ticket); void pump();
      });
    }, stop, loadedId: () => loaded?.id || "", busy: () => Boolean(active || queue.length || pumping),
  };
}
