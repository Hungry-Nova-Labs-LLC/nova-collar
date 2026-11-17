import { createHash } from "node:crypto";
import { extname } from "node:path";
import * as nodeModule from "node:module";
import { parse } from "acorn";
import { analyze } from "eslint-scope";

export const REFERENCE_SOURCE_LIMIT = 80_000;
const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
// Deliberately permissive runtime union: an advisory must not invent missing
// browser/Node bindings merely because the app has no project environment.
const globals = new Set((
  "undefined NaN Infinity globalThis Object Function Array String Number Boolean BigInt Symbol Math Date RegExp JSON Reflect Proxy " +
  "Map Set WeakMap WeakSet WeakRef FinalizationRegistry Promise ArrayBuffer SharedArrayBuffer DataView Atomics Intl " +
  "Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array " +
  "Error EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError parseInt parseFloat isNaN isFinite " +
  "decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval console Buffer process global require module exports __dirname __filename " +
  "setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask URL URLSearchParams TextEncoder TextDecoder " +
  "AbortController AbortSignal Event EventTarget CustomEvent fetch Headers Request Response FormData Blob File ReadableStream WritableStream " +
  "TransformStream WebSocket MessageChannel MessagePort performance crypto window document navigator location self Worker localStorage sessionStorage " +
  "atob btoa requestAnimationFrame cancelAnimationFrame HTMLElement Element Node Image Audio XMLHttpRequest structuredClone alert confirm prompt MutationObserver"
).split(/\s+/));
const limits = "Single-file lexical advisory only. No submitted project code/tests ran; project modules and dependency paths were not loaded or resolved. Runtime globals, generated bindings, module exports, reachability and values are not established. Absence of findings is not a passing check.";
const runtime = () => ({node:process.versions.node,electron:process.versions.electron || null,
  nativeTypeStripAvailable:typeof nodeModule.stripTypeScriptTypes === "function"});

export function unavailableReference(snapshot, reason) {
  return { kind: "lexical_runtime_reference", status: "unavailable", sourceHash: typeof snapshot?.hash === "string" ? snapshot.hash : null,
    findings: [], omittedCount: 0, reason: String(reason).slice(0, 180), limitations: limits, analysisRuntime:runtime() };
}

/** Parse strings only. Never load project configuration, evaluate source or
 * resolve/import its dependencies. Caller supplies the existing cached witness. */
export function analyzeRuntimeReferenceSource(snapshot, { stripTypes = nodeModule.stripTypeScriptTypes,
  parser = parse, scopeAnalyzer = analyze } = {}) {
  if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.text !== "string"
    || !/^[a-f0-9]{64}$/.test(snapshot.hash || "")) return unavailableReference(snapshot, "No complete cached source witness.");
  const ext = extname(snapshot.path).toLowerCase();
  if (!extensions.has(ext)) return unavailableReference(snapshot, "This source format is outside the static advisory subset.");
  const text = snapshot.text;
  if (text.length > REFERENCE_SOURCE_LIMIT || Buffer.byteLength(text) > REFERENCE_SOURCE_LIMIT) return unavailableReference(snapshot, "Cached source exceeds the static advisory bound.");
  if (createHash("sha256").update(text).digest("hex") !== snapshot.hash) return unavailableReference(snapshot, "Cached source hash does not match its witness.");
  let code = text;
  const typed = [".ts", ".mts", ".cts"].includes(ext);
  if (typed) {
    if (typeof stripTypes !== "function") return unavailableReference(snapshot, "Native TypeScript strip-only API is unavailable.");
    try { code = stripTypes(text, { mode: "strip" }); }
    catch { return unavailableReference(snapshot, "TypeScript syntax needs unsupported transformation or additional project context."); }
    if (typeof code !== "string") return unavailableReference(snapshot, "Native stripping did not return source text.");
    const before = text.split("\n"), after = code.split("\n");
    if (before.length !== after.length || before.some((line, i) => line.length !== after[i].length)) {
      return unavailableReference(snapshot, "Stripping changed source coordinates; no original-source location is inferred.");
    }
  }
  if (typeof parser !== "function" || typeof scopeAnalyzer !== "function") return unavailableReference(snapshot, "Trusted parser or scope analyzer is unavailable.");
  const commonjs = ext === ".cjs" || ext === ".cts";
  let ast, manager;
  const parents = new WeakMap();
  try {
    ast = parser(code, { ecmaVersion: 2024, sourceType: commonjs ? "script" : "module", ranges: true, locations: true,
      allowHashBang: true, ...(commonjs ? { allowReturnOutsideFunction: true } : {}) });
    // Dynamic lexical environments cannot support this bounded single-file hint.
    const pending = [ast];
    while (pending.length) {
      const node = pending.pop();
      if (node.type === "WithStatement" || (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "eval")) {
        return unavailableReference(snapshot, "Dynamic scope or eval prevents a reliable lexical advisory.");
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "range", "start", "end"].includes(key)) continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child.type === "string") { parents.set(child, node); pending.push(child); }
        }
      }
    }
    manager = scopeAnalyzer(ast, { ecmaVersion: 2024, sourceType: commonjs ? "script" : "module", nodejsScope: commonjs,
      optimistic: false, ignoreEval: false });
  } catch { return unavailableReference(snapshot, "Source syntax or scope is outside the supported static analysis subset."); }
  if (!manager?.globalScope || !Array.isArray(manager.globalScope.through)) return unavailableReference(snapshot, "Scope analyzer returned no complete root scope.");
  const guardedDirectCall = identifier => {
    const call = parents.get(identifier);
    if (call?.type !== "CallExpression" || call.callee !== identifier) return false;
    const statement = parents.get(call);
    if (!statement || !["ExpressionStatement","ReturnStatement"].includes(statement.type)
      || (statement.expression || statement.argument) !== call) return false;
    const block = parents.get(statement);
    const branch = block?.type === "BlockStatement" && block.body.length === 1 && block.body[0] === statement
      ? parents.get(block) : block;
    if (branch?.type !== "IfStatement" || branch.consequent !== (block?.type === "BlockStatement" ? block : statement)) return false;
    const condition = branch.test;
    if (condition?.type !== "BinaryExpression" || !["===","=="].includes(condition.operator)) return false;
    const [probe, literal] = condition.left?.type === "UnaryExpression" ? [condition.left,condition.right] : [condition.right,condition.left];
    return probe?.type === "UnaryExpression" && probe.operator === "typeof"
      && probe.argument?.type === "Identifier" && probe.argument.name === identifier.name
      && literal?.type === "Literal" && literal.value === "function";
  };
  const found = new Map();
  for (const reference of manager.globalScope.through) {
    const identifier = reference.identifier, name = identifier?.name, parent = identifier && parents.get(identifier);
    if (!reference.isRead?.() || typeof name !== "string" || name.length > 80 || globals.has(name)) continue;
    if (parent?.type === "UnaryExpression" && parent.operator === "typeof" && parent.argument === identifier) continue;
    // Only the sole immediate consequent call is exempt. No general control-flow
    // inference, nested callbacks, alternate branches or earlier writes qualify.
    if (guardedDirectCall(identifier)) continue;
    const line = identifier.loc?.start?.line, column = identifier.loc?.start?.column;
    if (!Number.isInteger(line) || !Number.isInteger(column)) continue;
    if (!found.has(name)) found.set(name, { name, line, column });
  }
  const all = [...found.values()].sort((a, b) => a.line - b.line || a.column - b.column);
  return { kind: "lexical_runtime_reference", status: all.length ? "findings" : "no_findings", sourceHash: snapshot.hash,
    findings: all.slice(0, 8), omittedCount: Math.max(0, all.length - 8), coordinateBasis: typed ? "verified-layout native stripped source" : "submitted JavaScript",
    limitations: limits, analysisRuntime:runtime() };
}
