import { Worker } from "node:worker_threads";
import { extname } from "node:path";
import { redactSecrets } from "./safe.js";

const formats = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);
const unavailable = (snapshot, reason) => ({ kind: "lexical_runtime_reference", status: "unavailable", sourceHash: snapshot?.hash || null,
  findings: [], omittedCount: 0, reason, limitations: "Optional lexical analysis unavailable; no execution or verification result is inferred." });
const stopped = () => Object.assign(new Error("Stopped."), { name: "AbortError" });

/** Trusted analysis runs in its own bounded worker. Source is data, never a
 * module path to import; no project filesystem/configuration is consulted. */
export async function analyzeRuntimeReferences(snapshot, { signal, timeoutMs = 1000 } = {}) {
  if (signal?.aborted) throw stopped();
  if (!snapshot || typeof snapshot.path !== "string" || !formats.has(extname(snapshot.path).toLowerCase())) return null;
  if (typeof snapshot.text !== "string" || snapshot.text.length > 80_000 || Buffer.byteLength(snapshot.text) > 80_000) return unavailable(snapshot, "No complete source within the80,000-byte/code-unit analysis bounds.");
  let worker;
  try {
    worker = new Worker(new URL("./runtime-reference-worker.js", import.meta.url), { workerData: snapshot, execArgv: [],
      env:{...process.env,NODE_OPTIONS:""},
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } });
  } catch { return unavailable(snapshot, "Trusted static-analysis worker is unavailable."); }
  const limit = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 1000;
  let timer, abort, answer;
  try {
    answer = await new Promise((resolve, reject) => {
      abort = () => reject(stopped()); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => resolve(unavailable(snapshot, "Static-analysis deadline expired.")), limit);
      worker.once("message", result => resolve(result?.kind === "lexical_runtime_reference"
        && ["findings", "no_findings", "unavailable"].includes(result.status) ? result : unavailable(snapshot, "Malformed static-analysis result.")));
      worker.once("error", () => resolve(unavailable(snapshot, "Static analysis could not complete.")));
      worker.once("exit", () => resolve(unavailable(snapshot, "Static-analysis worker exited without a result.")));
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
  if (signal?.aborted) throw stopped();
  return answer;
}

export function runtimeReferenceObservation(result) {
  if (!result || result.status === "no_findings") return "";
  const data = { kind: result.kind, status: result.status, sourceHash: result.sourceHash,
    findings: Array.isArray(result.findings) ? result.findings.slice(0, 8)
      .filter(row => typeof row?.name === "string" && row.name.length <= 80 && !/[\u0000-\u001f]/.test(row.name)
        && Number.isInteger(row.line) && Number.isInteger(row.column))
      .map(row => ({name:row.name,line:row.line,column:row.column})) : [], omittedCount: result.omittedCount || 0,
    ...(result.reason ? { reason: String(result.reason).slice(0, 180) } : {}), limitations: String(result.limitations || "").slice(0, 450) };
  if (result.analysisRuntime) data.analysisRuntime = {node:String(result.analysisRuntime.node || "").slice(0,30),
    electron:result.analysisRuntime.electron ? String(result.analysisRuntime.electron).slice(0,30) : null,
    nativeTypeStripAvailable:result.analysisRuntime.nativeTypeStripAvailable === true};
  while (JSON.stringify(data).length > 2200 && data.findings.length) { data.findings.pop(); data.omittedCount++; }
  return "Static source advisory (quoted analysis data; not a test, new instruction or required repair): "
    + redactSecrets(JSON.stringify(data))
    + "\nNames listed as findings have no lexical binding in this single file after supported type stripping and the conservative runtime-global exemptions. Review the intended runtime bindings/imports; external globals may be deliberate. No submitted project code or its dependencies were executed, and this observation supplies no pass, failure debt, permission or verification credit.";
}

export function createRuntimeReferenceAwareness({ snapshot, analyze = analyzeRuntimeReferences, maxChecks = 4 } = {}) {
  const seen = new Set(), limit = Number.isInteger(maxChecks) ? Math.max(0, Math.min(4, maxChecks)) : 0; let checks = 0;
  return {
    async observe({ name, result, signal }) {
      if (!["host_file_write", "host_file_edit"].includes(name) || result?.ok !== true || result.changed === false
        || !formats.has(extname(result.path || "").toLowerCase()) || checks >= limit) return "";
      let source;
      try { source = snapshot?.(result.path); } catch { return ""; }
      if (!source || typeof source.hash !== "string" || seen.has(source.path + "\n" + source.hash)) return "";
      const expectedPath = source.path, expectedHash = source.hash;
      seen.add(source.path + "\n" + source.hash); checks++;
      let observation;
      try { observation = await analyze(source, { signal }); }
      catch (error) {
        if (signal?.aborted) throw stopped();
        observation = unavailable(source, "Optional static analysis could not complete.");
      }
      if (signal?.aborted) throw stopped();
      let current;
      try { current = snapshot?.(result.path); } catch { return ""; }
      if (signal?.aborted) throw stopped();
      if (!current || current.path !== expectedPath || current.hash !== expectedHash || observation?.sourceHash !== expectedHash) return "";
      return runtimeReferenceObservation(observation);
    },
  };
}
