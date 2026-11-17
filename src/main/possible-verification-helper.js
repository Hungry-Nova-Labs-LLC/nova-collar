import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { authoredAssertionSource } from "./authored-checks.js";
import { scratchDraftPolicy } from "./scratch-draft-budget.js";
import { redactSecrets } from "./safe.js";

const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);
const sourceHash = text => createHash("sha256").update(text).digest("hex");
const parse = raw => { try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; } };
const inside = (cwd, path) => { const rel = relative(resolve(cwd), resolve(path)); return Boolean(rel) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep); };
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Bounded surface heuristic, never an executable-test classifier. Quoted
// examples/comments are masked; ambiguous slash expressions decline.
function simpleCode(source) {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n"; continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2); if (end < 0) return null;
      out += " "; i = end + 1; continue;
    }
    if (c === "/") return null;
    if (["'", '"', "`"].includes(c)) {
      let closed = false;
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") { i++; continue; }
        if (source[i] === c) { closed = true; break; }
      }
      if (!closed) return null;
      out += " "; continue;
    }
    out += c;
  }
  return out;
}

/** Possible helper only: name+custom comparison/counter+failure-exit surface.
 * Never establishes intent, a runner, execution or correctness. */
export function possibleVerificationHelperSource(path, source) {
  if (typeof path !== "string" || !extensions.has(extname(path).toLowerCase()) || typeof source !== "string"
      || source.length > 80_000 || Buffer.byteLength(source) > 80_000
      || !/(?:^|[-_.])(?:verify|check|probe|smoke|test)(?:[-_.]|$)/i.test(basename(path, extname(path)))
      || authoredAssertionSource(path, source)) return false;
  const code = simpleCode(source);
  if (!code || /\bexport\b|\bmodule\s*\.\s*exports\b|\bexports\s*\./.test(code)) return false;
  const exit = code.trim().match(/\bprocess\s*\.\s*exit\s*\(([^()]*)\)\s*;?$/);
  if (!exit || !/[?:]/.test(exit[1]) || !/\b0\b/.test(exit[1]) || !/\b[1-9]\d*\b/.test(exit[1])) return false;
  const arrows = [...code.matchAll(/\b(?:const|let)\s+(eq|equal|check)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[\w<>\[\]| \t]+)?\s*=>\s*\{([\s\S]*?)\}/g)];
  return arrows.some(([, name, body]) => {
    if (!/={2,3}|!={1,2}/.test(body) || (code.match(new RegExp("\\b" + escape(name) + "\\s*\\(", "g")) || []).length < 2) return false;
    const increment = body.match(/\b([A-Za-z_$][\w$]*)\s*(?:\+\+|\+=\s*1\b)/);
    if (!increment) return false;
    const counter = escape(increment[1]);
    return new RegExp("\\b(?:let|var)\\s+" + counter + "\\s*(?::\\s*number\\s*)?=\\s*0\\b").test(code)
      && new RegExp("\\b" + counter + "\\b").test(exit[1]);
  });
}

/** Immediate advisory only: no execution association, pending debt, reminder
 * request, callback, turn extension or authority-changing API. */
export function createPossibleVerificationHelperAwareness({ snapshot, cwd, ask, maxCues = 4 } = {}) {
  const seen = new Set(); let emitted = 0;
  const limit = Number.isInteger(maxCues) ? Math.max(0, Math.min(4, maxCues)) : 0;
  return {
    observe({ name, rawArgs, result, proof, active, signal } = {}) {
      if (active !== true || signal?.aborted || !["host_file_write", "host_file_edit"].includes(name)
          || result?.ok !== true || result.held || result.killed || result.skipped || result.unavailable
          || result.changed === false || result.unchanged || typeof result.path !== "string" || emitted >= limit
          || proof?.ok !== true || proof.held || proof.skipped || proof.unavailable
          || proof.verification?.status !== "passed" || proof.verification?.phase !== "syntax"
          || proof.verification?.remote !== false) return "";
      let directory, scope;
      try {
        directory = typeof cwd === "function" ? cwd() : cwd;
        if (typeof directory !== "string" || !isAbsolute(directory)) return "";
        scope = scratchDraftPolicy(typeof ask === "function" ? ask() : ask, directory);
      }
      catch { return ""; }
      if (!scope.enabled || !inside(directory, result.path) || !extensions.has(extname(result.path).toLowerCase())
          || !/(?:^|[-_.])(?:verify|check|probe|smoke|test)(?:[-_.]|$)/i.test(basename(result.path, extname(result.path)))) return "";
      const requestedNames = new Set(scope.requestedPaths.map(path => basename(path).toLowerCase()));
      if (requestedNames.has(basename(result.path).toLowerCase())) return "";
      const args = parse(rawArgs);
      if (!args || typeof args.path !== "string" || basename(args.path).toLowerCase() !== basename(result.path).toLowerCase()) return "";
      if (name === "host_file_write" && (typeof args.content !== "string" || args.content.length > 80_000 || Buffer.byteLength(args.content) > 80_000)) return "";
      const savedHash = name === "host_file_write" && typeof args.content === "string" ? sourceHash(args.content)
        : name === "host_file_edit" && typeof result.afterHash === "string" ? result.afterHash : null;
      if (!savedHash || savedHash !== proof.verification.hash) return "";
      let source;
      try { source = snapshot?.(result.path); } catch { return ""; }
      if (signal?.aborted || !source || typeof source.path !== "string" || typeof source.text !== "string"
          || source.hash !== savedHash || sourceHash(source.text) !== savedHash
          || basename(source.path).toLowerCase() !== basename(result.path).toLowerCase()
          || !inside(directory, source.path) || !possibleVerificationHelperSource(source.path, source.text)) return "";
      const key = source.path + "\n" + source.hash;
      if (seen.has(key)) return "";
      seen.add(key); emitted++;
      const data = { kind: "possible_saved_verification_helper", file: basename(source.path), sourceHash: source.hash,
        recordedPhase: "syntax", executionEstablishedByThisSave: false };
      return "Possible verification-helper observation (quoted saved-source data, not test intent, an instruction or proof): "
        + redactSecrets(JSON.stringify(data))
        + "\nThe helper-like name and custom comparison/failure-exit surface may indicate a verification helper. If it is intended for verification and the current user scope permits, run it with an already available or declared runner, or report the blocker. No command or runner is supplied. Saving or syntax parsing does not establish execution. Do not weaken user-supplied/protected checks; this cue assumes neither authorship nor correctness and adds no permission, round, status, proof, progress or failure debt.";
    },
  };
}
