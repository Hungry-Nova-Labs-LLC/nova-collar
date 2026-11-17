import { createHash } from "node:crypto";
import { basename } from "node:path";
import { inlineNodeAssertionCommand } from "./node-verification-context.js";

// Leave room for the configured Tag backend's 1024-token thinking budget and a
// short answer, without reserving the implementation's full 8192 tokens.
export const CLOSEOUT_TOKENS = 1536;
export const ACTION_TEXT_LIMIT = 2400;
export const ACTION_RECOVERIES = 2;
export const TURN_ROUND_CEILING = 60; // Same finite step ceiling as Nova Tag.

function explicitReviewOnly(ask) {
  // An unqualified ban applies to the turn. A named target or an "outside ..."
  // qualifier is a scope restriction and must not erase the positive edit ask.
  return /^\s*(?:please\s+)?read[- ]only\b/i.test(ask)
    || /\b(?:stop|pause|cease)\s+(?:editing|writing|making changes)(?:\s+(?:code|files|anything))?(?=\s*(?:[.;,!?\n]|$|and\s+(?:(?:only|just)\s+)?(?:review|discuss|explain)))/i.test(ask)
    || /^\s*(?:(?:can|could|would|will)\s+(?:you|we)\s+)?(?:please\s+)?(?:(?:only|just)\s+(?:review|discuss|explain|plan)\b|(?:review|discussion|analysis)\s+only\b)/i.test(ask)
    || /\bwithout\s+(?:editing|changing|modifying|writing)(?:\s+(?:(?:any|the)\s+)?(?:files|code|anything))?(?=\s*(?:[.;,!?\n]|$))/i.test(ask)
    || /\b(?:do not|don't|never)\s+(?:edit|modify|change|write)\s+(?:(?:any|the)\s+)?(?:files|code|anything)(?=\s*(?:[.;,!?\n]|$))/i.test(ask);
}

/** Discussion/review is not authorization to change files. Verb positions,
 * rather than nouns such as "the proposed fix", establish a positive ask. */
export function implementationRequested(text) {
  const ask = String(text || "");
  if (explicitReviewOnly(ask)
    || /^\s*(?:let'?s|let us)\s+(?:talk|discuss|plan)\b/i.test(ask)
    || /^\s*(?:please\s+)?help\s+me\s+(?:understand|review|think|decide)\b/i.test(ask)
    || (/^\s*(?:(?:can|could|would|will)\s+(?:you|we)\s+)?(?:please\s+)?(?:(?:only|just)\s+)?(?:explain|discuss|review|compare|plan|suggest|recommend|describe)\b/i.test(ask)
      && !/\b(?:and|then)\s+(?:implement|fix|repair|modify|update|edit|add|create|write|build|refactor|replace|remove|patch)\b/i.test(ask))
    || /^\s*(?:how\b|why\b|what\b|should\s+(?:I|we)\b|would\s+(?:it|this)\b)/i.test(ask)) return false;
  return /(?:^|[\n,;.!?:]\s*|\b(?:and|then|you to|want to|need to|let'?s|let us)\s+|\b(?:can|could|would|will)\s+(?:you|we)\s+)(?:(?:please|also|now|actually)\s+)*(?:implement|fix|repair|modify|update|edit|add|create|write|build|refactor|replace|remove|patch)\b/i.test(ask.trim());
}

/** A positive run/output request needs execution receipts, not a source edit. */
export function executionRequested(text) {
  const ask = String(text || "");
  if (/^\s*(?:let'?s|let us)\s+(?:talk|discuss|plan)\b/i.test(ask)
    || /^\s*(?:please\s+)?help\s+me\s+(?:understand|review|think|decide)\b/i.test(ask)
    || (/^\s*(?:(?:can|could|would|will)\s+(?:you|we)\s+)?(?:please\s+)?(?:explain|discuss|review|compare|plan|suggest|recommend|describe)\b/i.test(ask)
      && !/\b(?:and|then)\s+(?:run|execute|test|verify|check)\b/i.test(ask))
    || /^\s*(?:how\b|why\b|what\b|should\s+(?:I|we)\b)/i.test(ask)
    || /\b(?:do not|don't|never)\s+(?:run|execute|test|verify|check)\s+(?:(?:any|the)\s+)?(?:code|files|programs|scripts|tests|commands|anything)(?=\s*(?:[.;,!?\n]|$))/i.test(ask)) return false;
  const directives = /(?:^|[\n,;.!?:]\s*|\b(?:and|then|you to|want to|need to|let'?s|let us)\s+|\b(?:can|could|would|will)\s+(?:you|we)\s+)(?:(?:please|also|now|actually)\s+)*(?:run|execute|test|verify|check)\b\s*([^\n;!?]*)/gi;
  for (const match of ask.trim().matchAll(directives)) {
    const target = match[1].trim();
    if (/\.(?:[cm]?js|py|sh|bash|tsx?|go|swift|rs)\b/i.test(target)
      || /^(?:(?:the|existing|project|declared|configured|all)\s+)*(?:tests?|test suite|checks?|suite)\b/i.test(target)
      || /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|build)\b|(?:cargo|go|swift|dotnet|make)\s+(?:test|check|build)\b|(?:pytest|jest|vitest|mocha|ctest)\b)/i.test(target)) return true;
  }
  return false;
}

/** Neutral guidance keeps the current task; only an explicit stage change
 * narrows or resumes edit work. Scoped negative file mentions are not stops. */
export function steeringEditStage(text) {
  const ask = String(text || "");
  if (implementationRequested(ask)) return "edit";
  if (executionRequested(ask)) return "execute";
  if (explicitReviewOnly(ask)) return "review";
  if (/\b(?:stop|pause|cease)\s+(?:running|executing|testing)(?:\s+(?:(?:the|any|all)\s+)?(?:tests|checks|scripts|programs|commands|code))?(?=\s*(?:[.;,!?\n]|$|and\s+(?:(?:only|just)\s+)?(?:review|discuss|explain)))/i.test(ask)
    || /\b(?:do not|don't|never)\s+(?:run|execute|test)\s+(?:(?:any|the)\s+)?(?:code|files|programs|scripts|tests|commands|anything)(?=\s*(?:[.;,!?\n]|$))/i.test(ask)) return "review";
  if (/\b(?:resume|continue)\s+(?:editing|implementing|the edits|the implementation)\b/i.test(ask)) return "edit";
  if (/(?:^|[,;:]\s*)(?:for now[,]?\s+)?(?:review\s+only|only\s+(?:review|discuss|explain|plan))\b/i.test(ask)) return "review";
  return null;
}

/** Classify execution, not inspection of a test log or source file. */
export function testExecutionCommand(command) {
  const text = String(command || "").trim();
  if (inlineNodeAssertionCommand(text)) return true;
  // A named ad-hoc check is also a test execution. Inspect only an actual
  // executable/script position, never echo/cat/grep text or compiler inputs.
  const namedCheck = (path) => /(?:^|[-_.])(?:tests?|checks?|verify|verification)(?=$|[-_.])/i.test(basename(path));
  // Do not interpret embedded program strings or here-document bodies as shell
  // invocations. Unknown shell syntax conservatively earns no added context.
  if (text.includes("<<")) return false;
  const segments = [], words = [];
  let quote = "", word = "", active = false;
  const flush = () => { if (active) words.push(word); word = ""; active = false; };
  const next = () => { flush(); if (words.length) segments.push(words.splice(0)); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quote !== "'") {
      if (++index >= text.length) return false;
      word += text[index]; active = true; continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && (char === "`" || (char === "$" && text[index + 1] === "("))) return false;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (char === "`" || (char === "$" && text[index + 1] === "(") || "(){}".includes(char)) return false;
    if (";&|\n".includes(char)) { next(); continue; }
    if (/\s/.test(char)) { flush(); continue; }
    word += char; active = true;
  }
  if (quote) return false;
  next();
  for (const [executable, ...args] of segments) {
    const name = basename(executable);
    if (/^(?:pytest|jest|vitest|mocha|ctest)$/i.test(name)) return true;
    if (/^(?:npm|pnpm|yarn|bun)$/i.test(name) && /^test(?=$|:)/i.test(args[args[0] === "run" ? 1 : 0] || "")) return true;
    if (/^(?:cargo|go|swift|dotnet|make)$/i.test(name) && args[0] === "test") return true;
    if (/^python(?:3(?:\.\d+)?)?$/.test(name) && args[0] === "-m" && /^(?:pytest|unittest)$/.test(args[1] || "")) return true;
    if (name === "node") {
      // Quoted shell words still pass real flags. Code payloads and a script's
      // own arguments, however, cannot impersonate Node's test-runner option.
      let script;
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (/^-(?:[ep]|-(?:eval|print)(?:=|$))/.test(arg)) { script = null; break; }
        if (arg === "--test") return true;
        if (arg === "--") { script = args[index + 1]; break; }
        if (/^(?:-r|-C|--(?:require|import|loader|experimental-loader|conditions|input-type|env-file|env-file-if-exists|title|inspect-port|test-name-pattern|test-reporter|test-reporter-destination))$/.test(arg)) { index++; continue; }
        if (arg.startsWith("-")) continue;
        script = arg; break;
      }
      if (script && (namedCheck(script) || /(?:^|[/\\])tests[/\\]/i.test(script))) return true;
      continue;
    }
    const script = args[0];
    if (/^(?:python(?:3(?:\.\d+)?)?|bash|sh|swift)$/.test(name) && script && !script.startsWith("-") && namedCheck(script)) return true;
    if (/[/\\]/.test(executable) && namedCheck(executable)) return true;
  }
  return false;
}

export function informationalProof(proof) {
  return Boolean(proof && (proof.skipped || proof.unavailable || ["skipped", "unavailable"].includes(proof.verification?.status)));
}

export function passedProof(proof) {
  return Boolean(proof?.ok === true && !informationalProof(proof)
    && (!proof.verification?.status || proof.verification.status === "passed"));
}

/** A fallback reports receipts, never infers that the entire task succeeded. */
export function observedImplementationResult(trail, owed = []) {
  if (owed.length) return `Incomplete. Still open: ${owed.slice(0, 6).join("; ")}`;
  const rows = Array.isArray(trail) ? trail : [];
  const files = [...new Set(rows.filter(row => row.wrote && row.filePath).map(row => basename(row.filePath)))].slice(0, 6);
  const checked = [...new Set(rows.filter(row => row.passed && !row.informational && row.verification?.status === "passed")
    .map(row => row.verification.phase || row.verification.requiredPhase).filter(Boolean))];
  const skipped = rows.some(row => row.informational);
  return [files.length ? `Saved ${files.join(", ")}.` : "No completed file write was recorded.",
    checked.length ? `Observed ${checked.join(", ")} verification passed.` : "Passing verification was not established.",
    skipped ? "Some checks were unavailable or skipped." : "", "Full task completion was not confirmed."].filter(Boolean).join(" ");
}

const phases = { syntax: 1, runtime: 2, test: 3, project: 4 };
const keyFor = row => createHash("sha256").update(`${row.kind || "file"}\0${row.path || ""}`).digest("hex");

/** Consume existing harness evidence only; reads, timestamps and prose earn no
 * extension. Raw paths/source/arguments are neither returned nor logged. */
export function createTurnProgress(initial = [], { ceiling = TURN_ROUND_CEILING, extension = 4 } = {}) {
  const previous = new Map();
  let serial = 0, granted = 0, revision = 0, lastRound = -Infinity, changed = false, verified = false;
  const observe = (rows, round, { baseline = false } = {}) => {
    let progressed = false, mutated = false;
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, 5000)) {
      if (!row?.path || typeof row.hash !== "string" || !row.hash) continue;
      const key = keyFor(row);
      const before = previous.get(key) || (Object.hasOwn(row, "initialHash")
        ? { hash: row.initialHash, status: "pending", phase: 0 } : null);
      const state = { hash: row.hash, status: row.status, phase: phases[row.phase || row.requiredPhase] || 0 };
      if (!baseline) {
        if (before && before.hash !== state.hash) { changed = true; mutated = true; progressed = true; }
        if (state.status === "passed" && state.phase > 0
          && (!before || before.hash !== state.hash || before.status !== "passed" || state.phase > before.phase)) {
          verified = true; progressed = true;
        }
      }
      previous.set(key, state);
    }
    if (mutated) revision++;
    if (progressed) { serial++; lastRound = round; }
    return progressed;
  };
  observe(initial, 0, { baseline: true });
  return {
    observe,
    get changed() { return changed; },
    get verified() { return verified; },
    get revision() { return revision; },
    extend(round, limit) {
      if (limit >= ceiling || serial <= granted || lastRound < round - extension) return limit;
      granted = serial;
      return Math.min(ceiling, limit + extension);
    },
  };
}
