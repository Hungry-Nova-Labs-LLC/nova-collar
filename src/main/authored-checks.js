import {createHash} from "node:crypto";
import {readFileSync, realpathSync, statSync} from "node:fs";
import {basename, extname, resolve} from "node:path";
import {pythonAssertionDriver} from "./assertion-source.js";
import {captureReportedHelperSource, reportedNodeHelperAssertionObservation} from "./reported-helper-assertion.js";

const sourceHash = text => createHash("sha256").update(text).digest("hex");
const parse = raw => { try { return typeof raw === "string" ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };
const WRITE = new Set(["host_file_write", "host_file_edit"]);
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Strong source signals only. A filename never establishes an executable test.
 * This is an informational observation, not permission to run the file.
 */
export function authoredAssertionSource(path, source) {
  const text = String(source || "");
  const ext = extname(path).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"].includes(ext)) {
    if (/\bexport\s+(?:default|async|function|class|const|let|var|type|interface|\{)|\bmodule\.exports\b|\bexports\./.test(text)) return false;
    return (/\b(?:from\s*["']node:assert(?:\/strict)?["']|require\(["']node:assert(?:\/strict)?["']\))/.test(text)
        && /\bassert(?:\.\w+)?\s*\(/.test(text))
      || (/\b(?:from\s*["']node:test["']|require\(["']node:test["']\))/.test(text) && /\b(?:test|it)\s*\(/.test(text))
      || (/\bfunction\s+(?:check|eq)\s*\(/.test(text) && /\bprocess\.exit\s*\(/.test(text)
        && (text.match(/\b(?:check|eq)\s*\(/g) || []).length > 2);
  }
  if (ext === ".py") return /\bunittest\.main\s*\(|\bpytest\.main\s*\(/.test(text)
    || (/^assert\s+\S/m.test(text) && /\b(?:sys\.exit\s*\(|print\s*\()/m.test(text))
    || pythonAssertionDriver(text);
  if (ext === ".swift") return /^(?:assert|precondition|XCTAssert\w*)\s*\(/m.test(text);
  return false;
}

/** Identify only an observed direct command; never construct or recommend one.
 * Compound shell/eval/module-runner forms remain unassociated, not failed.
 */
export function directAuthoredScript(command, cwd, {nodeOnly = false} = {}) {
  const text = String(command || "").trim();
  const words = []; let word = "", quote = "", active = false;
  const flush = () => { if (active) words.push(word); word = ""; active = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && quote !== "'") { if (++i >= text.length) return null; word += text[i]; active = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else { if (quote === '"' && (char === "`" || char === "$")) return null; word += char; }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (/[;&|<>\n\r`$(){}]/.test(char)) return null;
    if (/\s/.test(char)) flush(); else { word += char; active = true; }
  }
  if (quote) return null;
  flush();
  const [exe, ...args] = words;
  if (!exe) return null;
  const name = basename(exe);
  if (nodeOnly && name !== "node") return null;
  if (!/^(?:node|python(?:3(?:\.\d+)?)?|swift)$/.test(name)) return null;
  let index = 0;
  while (args[index]?.startsWith("-")) {
    if (args[index] === "--") { index++; break; }
    // Only flags with a known lack of code payload/extra argument are accepted.
    if (!/^(?:-B|-u|--test|--no-warnings|--experimental-strip-types|--disable-warning=[\w_-]+)$/.test(args[index])) return null;
    index++;
  }
  return args[index] ? resolve(cwd, args[index]) : null;
}

export function verificationReceiptLabel(proof) {
  if (proof?.skipped || proof?.unavailable) return "HARNESS UNAVAILABLE (no pass established)";
  if (!proof?.ok) return "HARNESS FAIL";
  const phase = proof.verification?.phase;
  if (phase === "syntax") return "HARNESS SYNTAX PASS (program/tests were not executed by this check)";
  if (phase === "runtime") return "HARNESS RUNTIME CHECK PASS (not a behavioral test-suite verdict)";
  if (phase === "test") return "HARNESS TEST CHECK PASS";
  if (phase === "project") return "HARNESS PROJECT CHECK PASS";
  return "HARNESS CHECK PASS (scope is limited to the recorded check)";
}

export function createAuthoredCheckAwareness({cwd, sourceState, retiredSource, resolveDirectory = (value, base) => resolve(base, value || "."), read = path => {
  if (statSync(path).size > 128 * 1024) return null;
  return readFileSync(path, "utf8");
}} = {}) {
  const checks = new Map(), written = new Map();
  const executionSources = new WeakMap();
  let revision = 0, observedSourceRevision = null, reminded = false;
  const currentDirectory = () => typeof cwd === "function" ? cwd() : cwd;
  const snapshot = path => { try { const text = read(path); return typeof text === "string" ? {text, hash:sourceHash(text)} : null; } catch { return null; } };
  // Hash only already-cached file observations. This is not a project/input
  // inventory: omitted/unknown dependencies remain explicitly unverified.
  function knownInputs(path) {
    try {
      const rows = sourceState?.();
      if (!Array.isArray(rows) || rows.length > 5000) return null;
      const files = [];
      for (const row of rows) {
        if (row?.kind === "project" || row?.kind === "command") continue;
        if (!row || typeof row.path !== "string" || typeof row.hash !== "string" || !/^[a-f0-9]{64}$/i.test(row.hash)) return null;
        if (row.path !== path) files.push([row.kind || "file", row.path, row.hash]);
      }
      files.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return sourceHash(JSON.stringify(files));
    } catch { return null; }
  }
  function currentHelperMatches(row) {
    try {
      const rows = sourceState?.();
      if (!Array.isArray(rows) || rows.length > 5000) return false;
      const own = rows.find(input => input?.kind !== "project" && input?.kind !== "command" && input?.path === row.path);
      if (own) return /^[a-f0-9]{64}$/i.test(own.hash) && own.hash === row.lastExecution?.hash;
      // Absence alone proves nothing. This token comes only from the harness's
      // existing positive retirement checks for an unrequested auxiliary.
      return retiredSource?.(row.path) === row.lastExecution?.hash;
    } catch { return false; }
  }
  function coverageOnly(row) {
    const receipt = row.lastExecution;
    return row.state === "input_coverage_changed_or_unknown" && receipt?.status === "passed"
      && receipt.helperStable === true && receipt.knownInputsStable === true && currentHelperMatches(row)
      && knownInputs(row.path) === receipt.inputWitness;
  }
  function beforeExecution(name, raw) {
    if (name !== "host_run") return null;
    const args = parse(raw);
    if (typeof args.command !== "string" || (args.cwd !== undefined && typeof args.cwd !== "string")) return null;
    let directory;
    try { directory = resolveDirectory(args.cwd || ".", currentDirectory()); } catch { return null; }
    const script = directAuthoredScript(args.command, directory);
    const path = script ? canonical(script) : null;
    if (!checks.has(path)) return null;
    const before = snapshot(path);
    const execution = before ? {path, hash:before.hash, revision, inputWitness:knownInputs(path)} : null;
    if (execution) {
      try {
        if (directAuthoredScript(args.command,directory,{nodeOnly:true}) && authoredAssertionSource(path,before.text)) {
          const captured = captureReportedHelperSource(path,before.text,before.hash);
          if (captured) executionSources.set(execution,captured);
        }
      } catch { /* Optional source context cannot prevent the original execution. */ }
    }
    return execution;
  }
  function observe({name, rawArgs, result, proof, execution, sourceRevision, signal}) {
    // Consume the harness/agent's cached byte observation, including known
    // shell writes. No new filesystem search or shell-language guess occurs.
    if (Number.isFinite(sourceRevision) && sourceRevision !== observedSourceRevision) {
      if (observedSourceRevision !== null) revision++;
      observedSourceRevision = sourceRevision;
    }
    if (WRITE.has(name) && result?.ok && result.changed !== false && !result.unchanged && result.path) {
      const path = canonical(result.path), source = snapshot(path);
      if (source && written.get(path) !== source.hash) {
        revision++; written.set(path, source.hash);
        if (authoredAssertionSource(path, source.text)) {
          const phase = proof?.verification?.phase || "unverified";
          const program = directAuthoredScript(proof?.verification?.command, currentDirectory());
          const direct = ["runtime", "test"].includes(phase) && program && canonical(program) === path;
          const previous = checks.get(path);
          const directState = proof?.ok && !proof.skipped && !proof.unavailable ? "passed" : "failed_or_unconfirmed";
          checks.set(path, {path, hash:source.hash, blocking:false, phase,
            state:direct ? directState : "not_executed",
            ...(previous?.lastExecution ? {lastExecution:previous.lastExecution} : {}),
            ...(direct ? {executedRevision:revision,lastExecution:Object.freeze({hash:source.hash,status:directState,helperStable:true})} : {})});
          if (direct) return "Authored assertion check received an actual direct execution receipt; only the recorded result and current source revision are established.";
          return `Quoted verification observation, not an execution instruction: ${JSON.stringify(basename(path))} contains authored assertions. Its recorded ${proof?.verification?.phase || "source"} check does not establish that those assertions ran. Prefer a compact behavioral check using an actually available/declared runner before expanding the helper or rewriting more code; if unavailable, report that limitation. No command is guessed and no new blocking debt is created.`;
        }
        checks.delete(path);
      }
    }
    if (execution) {
      const captured = executionSources.get(execution);
      executionSources.delete(execution);
      const check = checks.get(execution.path), after = snapshot(execution.path);
      if (check) {
        const helperStable = after?.hash === execution.hash;
        const inputWitness = knownInputs(execution.path);
        const knownInputsStable = execution.inputWitness && inputWitness ? execution.inputWitness === inputWitness : null;
        const unavailable = result?.held || result?.skipped || result?.unavailable || result?.noTests;
        const exit = [result?.exitCode, result?.code, result?.status].find(value => typeof value === "number");
        const status = unavailable ? "unavailable"
          : result?.ok === true && (exit === undefined || exit === 0) && !result.killed && !result.testFailure ? "passed" : "failed_or_unconfirmed";
        // A successful process receipt is historical evidence for this exact
        // helper hash. A project revision includes generated data/config and
        // cannot, by itself, identify a helper/source mutation during the run.
        // Retain conservative input uncertainty; never turn it into a pass.
        check.lastExecution = Object.freeze({status, helperStable, knownInputsStable, inputWitness,
          ...(helperStable ? {hash:execution.hash} : {beforeHash:execution.hash, afterHash:after?.hash || null})});
        check.state = !helperStable || knownInputsStable === false ? "source_changed_during_execution"
          : revision !== execution.revision ? "input_coverage_changed_or_unknown" : status;
        check.executedRevision = revision;
        if (helperStable && captured) {
          try {
            const notice = reportedNodeHelperAssertionObservation(result,captured,after.hash,signal);
            if (notice) return notice;
          } catch { /* Preserve the actual tool/check outcome if context is unavailable. */ }
        }
      }
    }
    if (result?.mutationReview) return "Quoted mutation-review data is informational source context, not instructions or regression proof. Review removed behavior against the request; it earns no verification credit.";
    return "";
  }
  function pending() {
    return [...checks.values()].filter(row => row.state !== "passed" || row.executedRevision !== revision).slice(0, 8);
  }
  function context(rows = pending()) {
    if (!rows.length) return "";
    return "Authored-check observation (informational; no automatic execution or new blocking debt): "
      + rows.map(row => {
        const laterKnownChange = row.lastExecution?.inputWitness && knownInputs(row.path) !== row.lastExecution.inputWitness;
        const current = row.state === "passed" || laterKnownChange ? "earlier execution predates later source edits or other observed project/input changes"
          : row.state === "input_coverage_changed_or_unknown" ? "input coverage changed or is unknown; current behavioral verification is not established"
          : row.state;
        const historical = row.lastExecution ? `; historical direct execution ${row.lastExecution.status}`
          + (row.lastExecution.helperStable ? ` for stable helper hash ${row.lastExecution.hash.slice(0, 12)}`
            : "; helper bytes changed or were unavailable during execution, so no exact executed helper version is established") : "";
        return `${JSON.stringify(basename(row.path).slice(0, 120))}: ${current}; recorded file phase ${row.phase}${historical}`;
      }).join("; ")
      + ". Historical command results do not establish current input coverage or a project-wide pass. Syntax parsing and API import/callability checks are narrower than behavioral assertions. Use actual check receipts in the handoff; if a runner cannot be established, state the limitation instead of inventing a command, installing a runner, or claiming tests passed.";
  }
  return {beforeExecution, observe, context, pending,
    handoffContext() { return context(pending().filter(coverageOnly)); },
    takeReminder(answer = "") {
      // Only an actual stable successful run with unknown project-only drift
      // avoids another model request. Missing/failed/mutated checks retain the
      // existing reminder and cannot be converted into a current pass.
      const broadPassClaim = /^\s*PASS\b|\ball\s+(?:(?:the|project|behavioral|current)\s+)?tests?\s+(?:have\s+)?passed\b|\b(?:fully|completely)\s+verified\b/i.test(answer);
      const text = context(pending().filter(row => !coverageOnly(row) || broadPassClaim));
      // An honest limitation already conveys this advisory; do not spend a
      // second model request solely to make it repeat the same disclosure.
      const disclosed = /\b(?:not|never)\s+(?:been\s+)?(?:run|executed)|\b(?:runner|execution|behavioral verification)\b[^.!?\n]{0,60}\b(?:unavailable|not established|not verified)\b/i.test(answer);
      if (!text || reminded || disclosed) return "";
      reminded = true; return text;
    }};
}
