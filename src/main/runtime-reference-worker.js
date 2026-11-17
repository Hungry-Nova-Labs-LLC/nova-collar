import { parentPort, workerData } from "node:worker_threads";

try {
  const { analyzeRuntimeReferenceSource } = await import("./runtime-reference-core.js");
  parentPort.postMessage(analyzeRuntimeReferenceSource(workerData));
} catch {
  parentPort.postMessage({ kind: "lexical_runtime_reference", status: "unavailable", sourceHash: workerData?.hash || null,
    findings: [], omittedCount: 0, reason: "Trusted static analyzer could not be loaded.",
    limitations: "No project source was executed; static analysis is unavailable and supplies no verification credit." });
}
