import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { readUserFile, writeUserFile } from "./files.js";
import {
  censorPass,
  expectFromAsk,
  executionEvidence,
  isCodePath,
  isPagePath,
  isTestPath,
  isVerifierPath,
  probePath,
  readJobSpec,
  runJobSpec,
  runCommand,
  shellTargets,
  snapshotIfExists,
  unreadExisting,
  verifyPath,
  verifyCommand,
} from "./harness-check.js";
import { expandPath, getWorkdir } from "./workdir.js";
import { VerificationLedger, verificationSource } from "./verification-ledger.js";
import { inlineNodeCheckIdentity, nativeNodeTransportIdentity } from "./node-verification-context.js";
import { Checkpoint } from "./checkpoints.js";
import {createNewPathProbe} from "./new-path-probe.js";
import { ProjectObserver, projectRoot, projectChecks } from "./project-verification.js";
import { planFileEdit } from "./file-edit.js";
import { denySecretPath, redactSecrets } from "./safe.js";
import { recordVerifiedRepair } from "./project-memory.js";
import {createRequestedSourceProgress} from "./requested-source-progress.js";
import { boundedSourceSnapshot } from "./source-preload.js";

export {
  censorPass,
  CODE,
  expectFromAsk,
  inventedPrint,
  isCodePath,
  isPagePath,
  isTestPath,
  isTuiSource,
  isVerifierPath,
  isWindowSource,
  missExpect,
  probePath,
  readJobSpec,
  runCommand,
  runJobSpec,
  shellTargets,
  TUI,
  unreadExisting,
  verifyCommand,
  verifyPath,
} from "./harness-check.js";

const WRITE = new Set(["write_file", "host_file_write", "host_file_edit", "computer_write"]);
const READ = new Set(["read_file", "host_file_read", "computer_read"]);
const SHELL = new Set(["bash", "host_run"]);
const STACK = { python: "python", py: "python", javascript: "javascript", js: "javascript", node: "javascript", go: "go", golang: "go" };

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function stackOf(word) {
  return STACK[String(word || "").toLowerCase()] || "";
}

function proof(ok, path, blurb, detail) {
  return { name: "harness", pack: "host", ok, blurb, detail: detail || blurb, path };
}

const EDIT_WORD = /\b(?:add|adding|write|writing|create|creating|make|making|build|building|fix|fixing|patch|patching|edit|editing|update|updating|change|changing|rewrite|rewriting|implement|implementing|modify|modifying)\b/i;
const PROTECTED = /\b(?:do\s+not|don't|must\s+not|never|avoid|without)\s+(?:(?:ever|also|otherwise)\s+)?(?:add|write|create|make|build|fix|patch|edit|update|change|rewrite|implement|modify|touch|delete|replace|remove)\w*\b/i;
const NEGATIVE_REFERENCE = /\b(?:do\s+not|don't|must\s+not|never|avoid|without)\s+(?:(?:ever|also|otherwise)\s+)?(?:add|write|create|make|build|fix|patch|edit|update|change|rewrite|implement|modify|touch|delete|replace|remove|read|run|execute)\w*\b/i;
const KEPT = /\b(?:keep|leave|preserve|retain)\b.*\b(?:unchanged|untouched|unmodified|intact|alone|read-only|readonly|as[-\s]+is)\b/i;

function requestClauses(text) {
  return String(text || "").replace(/`/g, "").split(/\n|;|[.!?]\s+(?=[A-Z])|,\s*(?=(?:do\s+not|don't|never|keep|leave|preserve|retain|add|write|fix|patch|edit|update|change|create)\b)|\s+(?:but|whereas)\s+|\s+(?:and|while)\s+(?=(?:do\s+not|don't|never|keep|leave|preserve|retain|add|write|fix|patch|edit|update|change|create)\b)|\b(?=(?:except|excluding)\s+|without\s+(?:chang|edit|modif|rewrit|touch|replac))/i)
    .map((clause) => clause.trim()).filter(Boolean);
}

function fileMentions(text) {
  const out = [];
  for (const hit of String(text || "").matchAll(/(?:[a-z]:[\\/]|[\\/])?[\w@~.-]+(?:[\\/][\w@~.-]+)*\.[a-z0-9]{1,8}\b/gi)) {
    const path = hit[0].replace(/\\/g, "/").replace(/^\.\//, "");
    out.push({ path, index: hit.index });
  }
  return out;
}

function codeMentions(text) {
  return fileMentions(text).filter(({ path }) => isCodePath(path) && !isVerifierPath(path));
}

function withoutFileNames(text) {
  return String(text).replace(/(?:[a-z]:[\\/]|[\\/])?[\w@~.-]+(?:[\\/][\w@~.-]+)*\.[a-z0-9]{1,8}\b/gi, (value) => " ".repeat(value.length));
}

function protectedClause(clause) {
  clause = String(clause).replace(/^\s*(?:[-*]|\d+[.)])\s+/, "");
  return PROTECTED.test(clause) || KEPT.test(clause)
    || /\bno\s+(?:edits?|changes?|modifications?|rewrites?|writes?|deletions?)\b/i.test(clause)
    || /\b(?:remain|stay)\s+(?:unchanged|untouched|unmodified|read-only)\b/i.test(clause)
    || /^\s*(?:(?:protected|read-only|readonly)\s+(?:files?|paths?)\s*:|except\b|excluding\b)/i.test(clause)
    || (/^\s*(?:preserve|retain)\b/i.test(clause) && !EDIT_WORD.test(withoutFileNames(clause)));
}

/** References under a negative or preservation instruction are constraints,
 * not requests to edit each mentioned file. Keep clause polarity local. */
export function protectedCode(text) {
  return [...new Set(requestClauses(text).filter(protectedClause).flatMap((clause) => fileMentions(clause).map(({ path }) => path)))];
}

function sameRequestedPath(actual, requested) {
  const clean = (path) => String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const a = clean(actual), b = clean(requested);
  const matches = (left, right) => left === right || (!right.startsWith("/") && left.endsWith(`/${right}`));
  if (matches(a, b)) return true;
  if (!matches(a.toLowerCase(), b.toLowerCase())) return false;
  if (process.platform === "win32") return true;
  // POSIX names are case-sensitive unless the filesystem itself establishes
  // that these spellings resolve to the same file (e.g. a default macOS volume).
  const expected = b.startsWith("/") ? b : a.slice(0, a.length - b.length) + b;
  try { return realpathSync(expandPath(a)) === realpathSync(expandPath(expected)); }
  catch { return false; }
}

export function extractAsks(text) {
  const out = [];
  const add = (value) => {
    const item = String(value || "").replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
    if (item.length < 3 || item.length > 512 || (item.length > 72 && !moduleRequirement(item))) return;
    if (!out.some((row) => row.toLowerCase() === item.toLowerCase())) out.push(item);
  };
  const raw = String(text || "");
  for (const line of raw.split("\n")) {
    const hit = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.{3,512})$/);
    if (hit) for (const clause of requestClauses(hit[1])) {
      if (fileMentions(clause).length && (protectedClause(clause) || NEGATIVE_REFERENCE.test(clause))) continue;
      add(clause);
    }
  }
  for (const part of requestClauses(raw)) {
    const clause = part.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "");
    if (moduleRequirement(clause) && EDIT_WORD.test(withoutFileNames(clause)) && !protectedClause(clause) && !NEGATIVE_REFERENCE.test(clause)) add(clause);
  }
  for (const hit of raw.matchAll(/\b([a-z][a-z0-9.+#]{1,16})\s+not\s+([a-z][a-z0-9.+#]{1,16})\b/gi)) {
    const want = stackOf(hit[1]);
    const avoid = stackOf(hit[2]);
    if (want && avoid && want !== avoid) add(`${want} not ${avoid}`);
  }
  let prefer = "";
  for (const hit of raw.matchAll(/\b(?:use|prefer)\s+(?:the\s+)?(python|javascript|js|node|go|golang)\b/gi)) {
    const before = raw.slice(Math.max(0, hit.index - 16), hit.index).toLowerCase();
    if (/(?:do not|don't|not|no|never)\s+$/.test(before)) continue;
    prefer = stackOf(hit[1]);
    if (prefer) break;
  }
  const avoid = raw.match(/\b(?:do not|don't|not|instead of|no)\s+(?:use\s+)?(?:the\s+)?(go|golang|python|javascript|js)\b/i);
  const skip = stackOf(avoid?.[1]);
  if (prefer && skip && prefer !== skip) add(`${prefer} not ${skip}`);
  for (const hit of raw.matchAll(/\bno\s+(scroll|rewrite|tables?|bash)\b/gi)) add(`no ${hit[1].toLowerCase()}`);
  return out.slice(0, 6);
}

export function classifyAsk(ask) {
  const text = String(ask || "").toLowerCase();
  if (/\b(python|javascript|node|go|golang)\b/.test(text)) return "stack";
  if (/\b(compil|syntax|indent|parse)\b/.test(text)) return "compile";
  if (/\b(test|run|crash|traceback|execute|prints?)\b/.test(text)) return "run";
  return "soft";
}

const PRINT_FILLER = /^(the|all|out|each|every|some|any|its|them|this|that|these|those|numbers?|lines?|words?|text|something|nothing|one|two|three|and|with|from|what|whatever|only|exactly|literally|precisely|simply|just|always)$/i;

/** "check.js prints MIX_OK" stays required even when it sits past the short bullet list.
 *  "prints exactly nova-ok-42" skips the emphasis adverb and keeps the hyphenated literal. */
export function proofAsks(text) {
  const out = [];
  for (const clause of requestClauses(text)) {
    if (protectedClause(clause) || NEGATIVE_REFERENCE.test(clause)) continue;
    for (const hit of clause.matchAll(/((?:[a-z]:[\\/]|[\\/])?[\w@~.-]+(?:[\\/][\w@~.-]+)*\.(?:js|mjs|cjs|py|sh))\b[^\n]{0,100}?\bprints?\s+(?:(?:exactly|literally|precisely|simply|just|always)\s+)?([A-Za-z0-9][A-Za-z0-9_-]{2,40})\b/gi)) {
      if (PRINT_FILLER.test(hit[2])) continue;
      const item = `${hit[1].replace(/\\/g, "/").replace(/^\.\//, "")} prints ${hit[2]}`;
      if (!out.includes(item)) out.push(item);
    }
  }
  return out.slice(0, 3);
}

/** The reply says a write failed, and every write in the turn succeeded. */
export function wrongWriteBlame(answer, trail) {
  const said = String(answer || "");
  if (!/\b(write|wrote)\b/i.test(said) || !/\bfail/i.test(said)) return false;
  const writes = (trail || []).filter((row) => /file_write|write_file/.test(String(row.name || "")));
  return writes.length > 0 && writes.every((row) => row.ok !== false);
}

function moduleRequirement(ask) {
  const hit = String(ask || "").replace(/`/g, "").match(/((?:[a-z]:[\\/]|[\\/])?[\w@~.-]+(?:[\\/][\w@~.-]+)*\.[a-z0-9]{1,8})\s+(?:that\s+)?(?:exports?|exporting|exposes?|exposing)\s+(?:(?:async|class|function)\s+)*([A-Za-z_]\w*)(?=\s+with\b|\s*\(|\s*[.;]?$)(?:\s+with\s+(?:async\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\))?/i);
  if (!hit || !isCodePath(hit[1])) return null;
  return { path: hit[1], symbol: hit[2], method: hit[3], arguments: hit[4] || "" };
}

function apiDescriptor(requirement) {
  return { symbol: requirement.symbol, ...(requirement.method ? { method: requirement.method } : {}),
    variadicPositional: /(^|,)\s*\*\w+/.test(requirement.arguments),
    variadicKeyword: /\*\*\w+/.test(requirement.arguments) };
}

function printedRequirement(ask) {
  const hit = String(ask || "").match(/^(.+?)\s+prints\s+(\S+)$/i);
  return hit && isCodePath(hit[1]) ? { path: hit[1], token: hit[2] } : null;
}

function stackRequirement(ask) {
  const text = String(ask || "").trim().replace(/[.;]+$/, "");
  const bare = text.match(/^(python|py|javascript|js|node|go|golang)(?:\s+not\s+(python|py|javascript|js|node|go|golang))?$/i);
  const directive = text.match(/^(?:use|prefer|implement\s+(?:it\s+)?in|write\s+(?:it\s+)?in)\s+(?:the\s+)?(python|py|javascript|js|node|go|golang)\b(?:\s+(?:not|instead of)\s+(python|py|javascript|js|node|go|golang))?/i);
  const hit = bare || directive;
  return hit ? { want: stackOf(hit[1]), avoid: stackOf(hit[2]) } : null;
}

function fileRequirement(ask) {
  const paths = namedCode(ask);
  if (!paths.length) return null;
  const residual = withoutFileNames(ask).replace(new RegExp(EDIT_WORD.source, "gi"), "")
    .replace(/\b(?:please|only|and|the|file|files)\b/gi, "").replace(/[\s.,:;!?()[\]'"-]/g, "");
  return residual ? null : paths;
}

function machineRequirement(ask) {
  return Boolean(moduleRequirement(ask) || printedRequirement(ask) || stackRequirement(ask) || fileRequirement(ask));
}

export function coverAsk(ask, { paths = [], texts = [], runOut = "", runByPath, apiByPath } = {}) {
  const files = paths.map((path) => extname(path).toLowerCase());
  const stack = stackRequirement(ask);
  if (stack) {
    const extensions = { python: [".py"], javascript: [".js", ".mjs", ".cjs"], go: [".go"] };
    return files.some((ext) => extensions[stack.want]?.includes(ext))
      && !files.some((ext) => extensions[stack.avoid]?.includes(ext));
  }
  const printed = printedRequirement(ask);
  if (printed) {
    return paths.some((path) => sameRequestedPath(path, printed.path)
      && String(runByPath ? runByPath.get(path) || "" : runOut).includes(printed.token));
  }
  const api = moduleRequirement(ask);
  if (api) {
    const expected = apiDescriptor(api);
    return paths.some((path) => sameRequestedPath(path, api.path) && apiByPath?.get(path)?.some((checked) =>
      checked.symbol === expected.symbol && (!expected.method || checked.method === expected.method)
      && (!expected.variadicPositional || checked.variadicPositional) && (!expected.variadicKeyword || checked.variadicKeyword)));
  }
  const requiredFiles = fileRequirement(ask);
  if (requiredFiles) return requiredFiles.every((file) => paths.some((path) => sameRequestedPath(path, file)));
  // Source vocabulary cannot establish arbitrary behavior or UI quality.
  // Such requirements remain unverified/advisory instead of lexically passing
  // or blocking a genuine syntax/runtime/test result.
  return false;
}

export function patchVerdict(prior, next) {
  const oldText = String(prior || "");
  const newText = String(next || "");
  if (!oldText || oldText.length < 400) return { ok: true };
  if (newText.length > oldText.length * 2.2 && newText.length - oldText.length > 1200) {
    return { ok: false, error: "rewrite too large — patch the existing file" };
   }
  const oldLines = new Set(oldText.split("\n").map((line) => line.trim()).filter((line) => line.length > 8));
  const newLines = new Set(newText.split("\n").map((line) => line.trim()).filter((line) => line.length > 8));
  if (oldLines.size >= 20) {
    const kept = [...oldLines].filter((line) => newLines.has(line)).length;
    if (kept / oldLines.size < 0.25) return { ok: false, error: "rewrite too large — keep more of the original" };
   }
  return { ok: true };
}


/** Code files a write or fix ask names. A turn that never touched them cannot claim PASS. */
export function namedCode(text) {
  const out = [];
  for (const clause of requestClauses(text)) {
    const intent = withoutFileNames(clause);
    if (!EDIT_WORD.test(intent) || protectedClause(clause) || NEGATIVE_REFERENCE.test(clause)) continue;
    for (const { path, index } of codeMentions(clause)) {
      const before = intent.slice(0, index);
      const actions = [...before.matchAll(/\b(?:add|adding|write|writing|create|creating|make|making|build|building|fix|fixing|patch|patching|edit|editing|update|updating|change|changing|rewrite|rewriting|implement|implementing|modify|modifying|read|reading|inspect|review|run|running|execute|use|using|keep|leave|preserve|retain)\b/gi)];
      if (actions.length && !EDIT_WORD.test(actions.at(-1)[0])) continue;
      if (!out.includes(path)) out.push(path);
    }
  }
  return out.slice(0, 16);
}

function directProgram(command, cwd) {
  const text = String(command || "").trim();
  // Only a single direct invocation proves that this file, rather than a log,
  // inline string or masked pipeline stage, produced the observed output.
  if (/[\r\n;&|><`$(){}]/.test(text)) return null;
  const hit = text.match(/^(?:node(?:js)?|python(?:3(?:\.\d+)?)?|py|bash|sh)\s+(?:--\s+)?(?:'([^']+)'|"([^"]+)"|([^\s'"]+))(?:\s+.*)?$/i);
  const file = hit && (hit[1] || hit[2] || hit[3]);
  return file && !file.startsWith("-") && isCodePath(file) ? expandPath(file, cwd) : null;
}

const EXECUTION_DIRECTIVE = /^(?:(?:please|now|also|actually)\s+)*(?:(?:can|could|would|will)\s+you\s+|(?:let'?s|let us)\s+)?(?:(?:please|now|also|actually)\s+)*(?:run|execute|test|verify|check)\b\s*/i;
function executionClauses(text) {
  return requestClauses(text).map((clause) => clause.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))
    .filter((clause) => EXECUTION_DIRECTIVE.test(clause) && !protectedClause(clause) && !NEGATIVE_REFERENCE.test(clause));
}
function canonicalCheckCommand(command) {
  const text = String(command || "").trim();
  const test = text.match(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?test$/);
  return test ? `${test[1]} run test` : text;
}

function specNear(path) {
  const full = expandPath(path, getWorkdir());
  return readJobSpec(dirname(full)) || readJobSpec(getWorkdir());
}

export function createHarness({ signal, ask = "", requireEdits = true, requireExecution = requireEdits, remoteExec, localExec, approvalAware = false, sessionId = "", remoteTarget = "computer", trackProjects = false, onCheckpoint = () => {}, hasActiveWriters = () => false } = {}) {
  const wrote = new Set();
  const passed = new Set();
  const prior = new Map();
  const sources = new Map();
  const reviewSourcePaths = new Map();
  const reviewBaselines = new Map(); // At most four immutable, small prior-cache bodies.
  const writtenFiles = new Set();
  const requestedSourceSaves = new Map(); // Actual local save revision; no read/proof credit.
  const requestedSourceAliases = new Map(); // Reuse identities already computed by before().
  const runEvidence = new Map();
  const apiEvidence = new Map();
  const executionBefore = new Map();
  const shellBefore = new Map();
  const createdAuxiliary = new Map();
  const retiredAuxiliary = new Map(); // Private historical hashes from safe retirement only.
  const verificationCommands = new Map();
  const transportVerificationCommands = new Map();
  let executionScope = ask, executionScopeCwd = getWorkdir();
  const initialHashes = new Map();
  const protectedFiles = protectedCode(ask).map((path) => ({ path: expandPath(path, getWorkdir()), requested: path }))
    .map((file) => ({ ...file, initial: denySecretPath(file.path) ? null : verificationSource(file.path) }));
  const requestedSourceChanged = createRequestedSourceProgress({ ask, cwd: getWorkdir(),
    protectedPaths: protectedFiles.map(file => file.path), denyPath: denySecretPath });
  const asks = [...extractAsks(ask)];
  for (const item of proofAsks(ask)) {
    if (!asks.some((row) => row.toLowerCase() === item.toLowerCase())) asks.push(item);
  }
  const named = namedCode(ask);
  const covered = new Set();
  const extraDebt = [];
  const expect = expectFromAsk(ask);
  const unchecked = new Set();
  const clean = new Set();
  const broken = new Set();
  const ledger = sessionId ? new VerificationLedger(sessionId, getWorkdir()) : null;
  const projects = ledger && trackProjects ? new ProjectObserver(getWorkdir(), ledger) : null;
  let checkpoint = sessionId ? new Checkpoint(sessionId, getWorkdir()) : null;

  function pathKey(path) {
    const full = expandPath(path, getWorkdir());
    try { return realpathSync(full); } catch {
      try { return join(realpathSync(dirname(full)), basename(full)); } catch { return full; }
    }
  }

  function fixedRequirement(path) {
    return named.some((name) => sameRequestedPath(path, name))
      || executionClauses(ask).some((clause) => codeMentions(clause).some((item) => sameRequestedPath(path, item.path)))
      || asks.some((ask) => {
        const item = moduleRequirement(ask) || printedRequirement(ask);
        return item && sameRequestedPath(path, item.path);
      }) || protectedFiles.some((file) => sameRequestedPath(path, file.path));
  }

  function rememberReviewBaseline(path, hash, text) {
    if (reviewBaselines.has(path) || reviewBaselines.size >= 4 || !hash || typeof text !== "string"
      || (!isCodePath(path) && !isPagePath(path)) || denySecretPath(path)) return;
    if (Buffer.byteLength(text) > 8_000 || text.includes("\0") || Buffer.from(text).toString("utf8") !== text) return;
    if (verificationSource(path, text).hash === hash) reviewBaselines.set(path, { hash, text });
  }

  function rememberInitial(path, hash) {
    if (!initialHashes.has(path)) initialHashes.set(path, hash);
    const cached = prior.get(path);
    if (ledger) {
      const identity = ledger.identity(path);
      if (!initialHashes.has(identity.path)) initialHashes.set(identity.path, hash);
      rememberReviewBaseline(identity.path, initialHashes.get(identity.path), cached);
    } else rememberReviewBaseline(path, initialHashes.get(path), cached);
  }

  function shellKey(name, args) {
    return `${name}\0${args.command || ""}\0${expandPath(args.cwd || getWorkdir())}`;
  }

  // Inspect only paths already named, read, written or held in this ledger, plus
  // explicit shell output targets. Never parse arbitrary Python or scan a tree.
  // Every observation has a file and byte ceiling; omitted paths earn no proof.
  function prepareShell(name, args) {
    const cwd = args.cwd ? expandPath(args.cwd, getWorkdir()) : getWorkdir();
    const paths = [...named.map((path) => expandPath(path, getWorkdir())),
      ...prior.keys(), ...sources.keys(), ...wrote,
      ...[...(ledger?.entries.values() || [])].filter((row) => !row.remote && row.kind !== "project" && row.kind !== "command").map((row) => row.path),
      ...shellTargets(args.command, cwd), ...(Array.isArray(args.paths) ? args.paths.map((path) => expandPath(String(path), cwd)) : [])];
    const observed = new Map();
    let bytes = 0;
    for (const input of paths) {
      const original = expandPath(input, getWorkdir()), path = pathKey(original);
      if (observed.has(path) || !isCodePath(path) || isVerifierPath(path) || denySecretPath(path)) continue;
      if (observed.size >= 128) break;
      try {
        const stat = lstatSync(original);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024 || bytes + stat.size > 16 * 1024 * 1024) continue;
        bytes += stat.size;
        const source = verificationSource(path);
        if (source.covered) observed.set(path, { ...source, existed: true });
      } catch (error) {
        if (error.code === "ENOENT") observed.set(path, { hash: null, covered: false, existed: false });
      }
    }
    shellBefore.set(shellKey(name, args), observed);
    checkpoint?.track([...observed.keys()]);
  }

  function collectShellChanges(name, args, result) {
    const observed = shellBefore.get(shellKey(name, args));
    shellBefore.delete(shellKey(name, args));
    if (result?.held || result?.skipped || result?.unavailable) return [];
    if (!observed) {
      // Legacy after-only callers have no before/after proof. Preserve explicit
      // target debt without inventing a change or a successful source check.
      const cwd = args.cwd ? expandPath(args.cwd, getWorkdir()) : getWorkdir();
      for (const path of shellTargets(args.command, cwd)) if (verificationSource(path).covered) ledger?.changed(path);
      return [];
    }
    const changed = [];
    for (const [path, before] of observed) {
      const now = verificationSource(path);
      if (now.covered && now.hash !== before.hash) {
        rememberInitial(path, before.hash);
        if (!before.existed && !fixedRequirement(path)) createdAuxiliary.set(path, true);
        wrote.add(path); ledger?.changed(path);
        changed.push(path);
      } else if (!now.covered && before.covered && createdAuxiliary.has(path) && !fixedRequirement(path)) {
        // A removed, turn-created syntax-only auxiliary carries no continuing
        // file obligation. Prior failures and stronger evidence always survive.
        let missing = false;
        try { lstatSync(path); } catch (error) { missing = error.code === "ENOENT"; }
        const hasPath = (set) => [...set].some((alias) => pathKey(alias) === path);
        const safe = missing && (ledger ? ledger.retireAuxiliary(path, before.hash)
          : hasPath(clean) && !hasPath(broken) && !hasPath(unchecked));
        if (safe) {
          for (const set of [wrote, passed, clean, broken, unchecked, writtenFiles]) {
            for (const alias of set) if (pathKey(alias) === path) set.delete(alias);
          }
          for (const map of [sources, prior, runEvidence, apiEvidence]) {
            for (const alias of map.keys()) if (pathKey(alias) === path) map.delete(alias);
          }
          createdAuxiliary.delete(path);
          retiredAuxiliary.set(path, before.hash);
          if (retiredAuxiliary.size > 128) retiredAuxiliary.delete(retiredAuxiliary.keys().next().value);
        }
      }
    }
    return changed;
  }

  function recordCheck(path, check, phase, command, { remote = false, source, expectedHash } = {}) {
    if (!ledger) return;
    const previous = ledger.entries.get(ledger.identity(path, { remote, target: remoteTarget }).key);
    const before = previous?.failure || (previous?.status === "failed" ? previous : null);
    const after = ledger.checked(path, { ok: check.ok, skipped: check.skipped, unavailable: check.unavailable, phase, command, diagnostic: check.error || check.blurb, remote, target: remoteTarget, source, expectedHash });
    if (!remote) reviewSourcePaths.set(path, after.path); // Existing canonical check identity, no new lookup.
    if (after.status === "passed") {
      if (before && !remote) recordVerifiedRepair(dirname(after.path), { before, after, sessionId });
      delete after.failure; ledger.save();
    }
    return after;
  }

  const evidenceOn = (result, verification) => verification ? { ...result, verification: { ...verification } } : result;

  function tokensFor(path) {
    if (!requireExecution) return [];
    const out = [];
    for (const item of asks) {
      const printed = printedRequirement(item);
      if (printed && sameRequestedPath(path, printed.path)) out.push(printed.token);
    }
    return out;
  }

  function release() {
    for (const file of clean) passed.add(file);
    for (const file of wrote) {
      if (!broken.has(file) && !unchecked.has(file)) passed.add(file);
    }
  }

  function markAsks(extra = {}) {
    covered.clear();
    const current = ([path, evidence]) => evidence.hash === (evidence.diskPath ? verificationSource(evidence.diskPath).hash : verificationSource(path, sources.get(path)).hash);
    const runByPath = new Map([...runEvidence].filter(current).map(([path, evidence]) => [path, evidence.output]));
    const apiByPath = new Map([...apiEvidence].filter(current).map(([path, evidence]) => [path, evidence.apis]));
    const runOut = [...runByPath.values()].join("\n");
    for (const item of asks) {
      if (machineRequirement(item) && coverAsk(item, { paths: [...new Set([...wrote, ...sources.keys(), ...runByPath.keys()])], texts: [...sources.values()], runByPath, apiByPath, runOut, ...extra })) covered.add(item);
    }
  }

  function hardMiss() {
    return asks.filter((item) => (requireEdits || (requireExecution && printedRequirement(item))) && machineRequirement(item) && !covered.has(item));
  }

  function advisoryRequirements() {
    return requireEdits ? asks.filter((item) => !machineRequirement(item)).map((requirement) => ({ requirement, status: "unverified", blocking: false,
      reason: "Requires task-specific evidence or review; this harness has not automatically verified it." })) : [];
  }

  function outputTokens(path) {
    return requireExecution ? asks.map(printedRequirement).filter((item) => item && sameRequestedPath(path, item.path)).map((item) => item.token) : [];
  }

  function executionPath(name, args) {
    if (name !== "host_run" || !requireExecution) return null;
    const path = directProgram(args.command, args.cwd ? expandPath(args.cwd, getWorkdir()) : getWorkdir());
    return path && outputTokens(path).length ? path : null;
  }

  function observeExecution(name, args, raw) {
    const path = executionPath(name, args);
    if (!path || raw?.held || raw?.skipped || raw?.unavailable) return null;
    const result = executionEvidence(raw, { test: isTestPath(path) });
    const before = executionBefore.get(path);
    const source = verificationSource(before?.diskPath || path);
    const stable = Boolean(before?.covered && source.covered && before.hash === source.hash);
    const missing = outputTokens(path).filter((token) => !String(result.stdout || "").includes(token));
    const unavailable = result.ok && (!stable || (missing.length && result.stdout_truncated));
    const ok = result.ok === true && stable && !missing.length;
    const error = !result.ok ? result.error || result.stderr || "The program did not exit successfully."
      : !stable ? "The executed source version could not be verified or changed during execution."
      : missing.length && result.stdout_truncated ? "The captured output was truncated before the required output could be established."
      : missing.length ? `Expected output missing: ${missing.join(", ")}` : "";
    const check = { ok, path, command: String(args.command || ""), stdout: result.stdout || "", error,
      blurb: ok ? `runtime output verified ${path}` : `runtime output ${unavailable ? "unavailable" : "failed"} ${path}`,
      ...(unavailable ? { skipped: true, unavailable: true, blocking: true } : {}) };
    const verification = recordCheck(path, check, "runtime", check.command, { expectedHash: before?.hash });
    if (ok) {
      runEvidence.set(path, { hash: source.hash, diskPath: before.diskPath, output: check.stdout });
      clean.add(path); broken.delete(path); unchecked.delete(path);
    } else {
      runEvidence.delete(path); clean.delete(path);
      if (unavailable) unchecked.add(path); else broken.add(path);
    }
    markAsks();
    const open = hardMiss();
    const detail = [error, open.length ? `Still open: ${open.join("; ")}` : "", "Only the observed execution/output checks are established."].filter(Boolean).join("\n");
    return evidenceOn({ ...proof(ok && !open.length, path, check.blurb, detail), stdout: check.stdout.slice(0, 300),
      ...(unavailable ? { skipped: true, unavailable: true, blocking: true } : {}), advisories: advisoryRequirements() }, verification);
  }

  function allowsRequestedExecution(command, cwd = getWorkdir()) {
    if (!requireExecution) return false;
    const clauses = executionClauses(executionScope);
    if (!clauses.length) return false;
    const actualCwd = expandPath(cwd, getWorkdir()), program = directProgram(command, actualCwd);
    if (program) for (const clause of clauses) {
      const intent = withoutFileNames(clause);
      for (const { path, index } of codeMentions(clause)) {
        const actions = [...intent.slice(0, index).matchAll(/\b(?:run|execute|test|verify|check|read|inspect|review|write|edit|change)\b/gi)];
        if (!actions.length || !/^(?:run|execute|test|verify|check)$/i.test(actions.at(-1)[0])) continue;
        try {
          const requested = realpathSync(expandPath(path, executionScopeCwd)), actual = realpathSync(program);
          if (actual === requested && statSync(actual).isFile()) return true;
        } catch { /* A positively named script must actually exist. */ }
      }
    }
    const root = projectRoot(executionScopeCwd, { directory: true });
    if (!root || projectRoot(actualCwd, { directory: true }) !== root) return false;
    const profile = projectChecks(root);
    if (profile.error) return false;
    const actual = canonicalCheckCommand(command);
    if (!profile.commands.some((declared) => canonicalCheckCommand(declared) === actual)) return false;
    return clauses.some((clause) => {
      const body = clause.replace(EXECUTION_DIRECTIVE, "").trim().replace(/[.!]+$/, "");
      if (canonicalCheckCommand(body) === actual) return true;
      if (fileMentions(clause).length) return false;
      const generic = body.match(/^(?:(?:the|existing|project|declared|configured|all)\s+)*(tests?|test suite|checks?|suite)\b/i);
      if (!generic) return false;
      if (/^checks?$/i.test(generic[1])) return true;
      return /\b(?:test|pytest|unittest|jest|vitest|mocha|ctest)\b/i.test(command);
    });
  }

  function auditDisk() {
    // Mutating shell actions already require approval. Never roll back a human
    // edit noticed during an unrelated read-only command.
    if (approvalAware) return null;
    const seen = new Set();
    for (const [path, old] of prior) {
      const full = expandPath(path, getWorkdir());
      if (seen.has(full) || !old || old.length < 400) continue;
      seen.add(full);
      const now = readUserFile(full);
      if (!now?.ok || now.directory) continue;
      let current;
      try { current = readFileSync(full, "utf8"); } catch { continue; }
      const patch = patchVerdict(old, current);
      if (patch.ok) continue;
      const restored = writeUserFile(full, old);
      return proof(false, full, `rewrite blocked ${full}`, `${patch.error} (${restored.ok ? "shell write reverted" : `restore failed: ${restored.error}`})`);
    }
    return null;
  }

  async function finishCheck(path, text, exec, { explicit = false, deferAsks = false } = {}) {
    sources.set(path, text);
    const opts = exec ? { expand: false, exec, expect } : { exec: localExec, expect };
    const evidence = { remote: Boolean(exec), source: exec ? text : undefined, expectedHash: verificationSource(exec ? path : expandPath(path, getWorkdir()), exec ? text : undefined).hash };
    const compileCommand = verifyCommand(path, opts)?.command || "";
    const compile = await verifyPath(path, opts);
    if (!compile) {
      unchecked.add(path);
      extraDebt.push(`unverified ${path}`);
      ledger?.changed(path, { remote: Boolean(exec), target: remoteTarget, source: exec ? text : undefined });
      return proof(false, path, `unverified ${path}`, "no compile command for this file");
    }
    let verification = recordCheck(path, compile, "syntax", compile.command || compileCommand, evidence);
    unchecked.delete(path);
    if (!compile.ok) {
      if (compile.skipped) unchecked.add(compile.path);
      else broken.add(compile.path);
      clean.delete(compile.path);
      return evidenceOn({ ...proof(false, compile.path, compile.blurb, compile.error), held: compile.held,
        ...(compile.skipped ? { skipped: true, unavailable: compile.unavailable, blocking: true } : {}) }, verification);
    }
    // Source modules in an observed project are verified by its declared checks,
    // never launched as standalone applications merely because they were saved.
    const contracts = requireEdits ? asks.map(moduleRequirement).filter((item) => item && sameRequestedPath(path, item.path)) : [];
    let run = null;
    if (contracts.length) {
      const verified = [];
      for (const contract of contracts) {
        const api = apiDescriptor(contract);
        run = await probePath(path, text, { ...opts, expect: [...expect, ...tokensFor(path)], api });
        if (run?.ok && run.apiVerified) verified.push(api);
        if (!run?.ok) break;
      }
      apiEvidence.set(path, { hash: verificationSource(path, text).hash, apis: verified });
    } else if (!(!exec && projects && projectRoot(path) && !explicit && !["runtime", "test"].includes(verification?.requiredPhase))) {
      run = await probePath(path, text, { ...opts, expect: [...expect, ...tokensFor(path)] });
    }
    if (run) verification = recordCheck(path, run, isTestPath(path) ? "test" : "runtime", run.command || runCommand(path, text, opts)?.command || "", evidence);
    if (run && !run.skipped) runEvidence.set(path, { hash: verificationSource(path, text).hash, output: run.stdout || "" });
    markAsks();
    if (run && !run.ok) {
      if (run.skipped) unchecked.add(run.path);
      else broken.add(run.path);
      clean.delete(run.path);
      return evidenceOn({ ...proof(false, run.path, run.blurb, run.error), held: run.held,
        ...(run.skipped ? { skipped: true, unavailable: run.unavailable, blocking: true } : {}) }, verification);
    }
    clean.add(compile.path);
    broken.delete(compile.path);
    let jobNote = "";
    if (!exec) {
      const spec = specNear(path);
      if (spec) {
        const job = await runJobSpec(spec, { exec: localExec });
        if (job) verification = recordCheck(path, job, "project", spec.check, evidence);
        if (job && !job.ok) {
          broken.add(compile.path);
          clean.delete(compile.path);
          return evidenceOn({ ...proof(false, job.path, job.blurb, job.error), held: job.held }, verification);
        }
        jobNote = job?.blurb || "";
      }
    }
    const open = deferAsks ? [] : hardMiss();
    const advisories = advisoryRequirements();
    const blurb = [
      compile.blurb,
      run?.blurb,
      jobNote,
      open.length ? `asks open: ${open.join("; ")}` : (asks.some(machineRequirement) ? "machine-checkable asks covered" : ""),
      advisories.length ? `${advisories.length} prose requirement(s) remain unverified (advisory)` : "",
    ].filter(Boolean).join(" · ");
    if (open.length) return proof(false, compile.path, blurb, `Still open: ${open.join("; ")}`);
    if (ledger?.error) return proof(false, compile.path, "verification state unavailable", ledger.error);
    const identity = ledger?.identity(path, { remote: Boolean(exec), target: remoteTarget });
    const unresolved = ledger?.unresolved().find((entry) => entry.key === identity.key);
    if (unresolved) return proof(false, compile.path, `${unresolved.status} ${compile.path}`, unresolved.diagnostic);
    release();
    return evidenceOn({ ...proof(true, compile.path, blurb, blurb), advisories, stdout: String(run?.stdout || "").trim().slice(0, 300) }, verification);
  }

  function finishPage(path, text) {
    const body = String(text || "").trim();
    const ext = extname(path).toLowerCase();
    if (body.length < 20) {
      broken.add(path);
      recordCheck(path, { ok: false, error: "The page is too small to be the window." }, "syntax", "structural page inspection");
      return proof(false, path, "page empty", "The page is too small to be the window.");
    }
    if ((ext === ".html" || ext === ".htm") && !/<\w/.test(body)) {
      broken.add(path);
      recordCheck(path, { ok: false, error: "This is not HTML." }, "syntax", "structural page inspection");
      return proof(false, path, "not a page", "This is not HTML.");
    }
    sources.set(path, body);
    wrote.add(path);
    broken.delete(path);
    recordCheck(path, { ok: true, blurb: "Structural page inspection only; browser behavior was not tested." }, "syntax", "structural page inspection");
    markAsks();
    const open = hardMiss(), advisories = advisoryRequirements();
    const blurb = open.length ? `asks open: ${open.join("; ")}` : `page structural check ok${asks.some(machineRequirement) ? " · machine-checkable asks covered" : ""}${advisories.length ? " · prose requirements remain unverified (advisory)" : ""}`;
    if (open.length) return proof(false, path, blurb, `Still open: ${open.join("; ")}`);
    release();
    return { ...proof(true, path, blurb, blurb), advisories };
  }

  return {
    /** Cached aliases only; selection must not resolve or reread source files. */
    recoveryProtectedPaths() { return protectedFiles.map(file => file.path); },
    // No disk lookup: only an auxiliary positively retired by the existing
    // missing-file/hash/syntax/failure checks can supply this historical hash.
    retiredAuthoredSource(path) { return typeof path === "string" ? retiredAuxiliary.get(path) || null : null; },
    /** Only explicit positive requirements; this metadata is not write authority. */
    async recoveryFiles() {
      if (!requireEdits) return [];
      const root = expandPath(getWorkdir());
      // Resolve no paths synchronously for this optional recovery. A basename
      // collision with a protected spelling is conservatively ambiguous, so it
      // is excluded even when two directories could denote different files.
      const candidates = [...new Set(named.map(path => expandPath(path, getWorkdir())).filter(path => {
        if (!isCodePath(path) || isVerifierPath(path) || denySecretPath(path)
          || protectedFiles.some(file => basename(path).toLowerCase() === basename(file.path).toLowerCase() || sameRequestedPath(path, file.path))) return false;
        const rel = relative(root, path);
        return rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
      }))].slice(0, 4);
      if (!candidates.length) return [];
      const probe = createNewPathProbe({cwd:root,denyPath:denySecretPath,signal});
      try {
        for (const path of candidates) probe.state(path);
        await probe.settle();
        return candidates.filter(path => probe.state(path) === false);
      } finally { probe.close(); }
    },
    get asks() { return requireEdits ? asks : requireExecution ? asks.filter(printedRequirement) : []; },
    get advisories() { return advisoryRequirements(); },
    setRequireEdits(value) { requireEdits = requireExecution = Boolean(value); markAsks(); },
    setRequireExecution(value, scopeText) {
      requireExecution = Boolean(value);
      if (typeof scopeText === "string") { executionScope = scopeText; executionScopeCwd = getWorkdir(); }
      markAsks();
    },
    allowsRequestedExecution,
    context() {
      const advisories = advisoryRequirements();
      const context = advisories.length ? `<requirement_observations>\nThese remain user requirements, not optional suggestions. They need task-specific evidence or review. They are unverified by this harness, not automatically passed or failed.\n${JSON.stringify({ advisories }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</requirement_observations>` : "";
      return [ledger?.context(), context].filter(Boolean).join("\n");
    },
    async checkProjects() { return projects ? projects.check(localExec, { activeWriter: hasActiveWriters }) : []; },
    finish(reason = "finished") {
      if (!checkpoint) return null;
      const journal = checkpoint; checkpoint = null;
      try {
        const saved = journal.finish(reason);
        if (saved) onCheckpoint({ type: "checkpoint", id: saved.id, files: saved.changes.length, skipped: saved.skipped });
        return saved;
      } catch (error) {
        const failed = { type: "checkpoint", error: error.message, skipped: ["The checkpoint could not be saved."] };
        onCheckpoint(failed); return failed;
      }
    },
    /** Explicit verification of a restored local obligation; never runs on resume alone. */
    async verify(path) {
      const full = expandPath(path, getWorkdir());
      let text;
      try { text = readFileSync(full, "utf8"); }
      catch { return proof(false, full, `unverified ${full}`, "source is missing or unreadable"); }
      if (isPagePath(full)) return finishPage(full, text);
      return finishCheck(full, text, undefined, { explicit: true });
    },
    note(name, args, result, sourceOptions) {
      const text = result?.text ?? result?.content;
      if (READ.has(name) && result?.ok && text != null) {
        if (name === "computer_read") {
          if (result.path) prior.set(result.path, String(text));
          if (args?.path) prior.set(args.path, String(text));
        } else if (sourceOptions !== undefined) {
          // App preloads already hold a bounded exact raw FD snapshot. Never
          // reread disk here or turn the redacted receipt into a restore copy.
          const raw = boundedSourceSnapshot(result, sourceOptions);
          if (raw !== undefined) {
            if (result.path) prior.set(result.path, raw);
            if (args?.path) prior.set(args.path, raw);
          }
        } else {
          // Tool output is redacted and truncated; it must never become a restore copy.
          if (result.path) snapshotIfExists(result.path, prior);
          if (args?.path) snapshotIfExists(args.path, prior);
        }
      }
      if (!WRITE.has(name) || !result?.ok || !result.path) return;
      writtenFiles.add(result.path);
      if (isCodePath(result.path) || isPagePath(result.path)) wrote.add(result.path);
      if (isCodePath(result.path) || isPagePath(result.path)) ledger?.changed(result.path, { remote: name === "computer_write", target: remoteTarget, source: name === "computer_write" ? args?.content : undefined });
      if (typeof args?.content === "string") sources.set(result.path, args.content);
    },
    before(name, rawArgs) {
      const args = name === "host_file_edit" ? { ...parseArgs(rawArgs) } : parseArgs(rawArgs);
      if (name === "host_file_edit") {
        const plan = planFileEdit(args.path, args.edits);
        if (!plan.ok) return proof(false, typeof args.path === "string" ? args.path : "", "edit not applied", plan.error);
        const full = plan.path;
        if (!prior.has(full) && !prior.has(args.path)) return proof(false, full, "read first", "Read the current file before a focused edit.");
        args.content = plan.content;
      }
      projects?.prepare(name, { ...args, cwd: args.cwd || getWorkdir() });
      if (SHELL.has(name)) {
        prepareShell(name, args);
        const executed = executionPath(name, args);
        if (executed) {
          let diskPath = executed;
          try { diskPath = realpathSync(executed); } catch {}
          executionBefore.set(executed, { ...verificationSource(diskPath), diskPath });
        }
        if (Array.isArray(args.paths)) checkpoint?.track(args.paths.map((path) => expandPath(String(path), args.cwd ? expandPath(args.cwd) : getWorkdir())));
        for (const target of shellTargets(args.command)) snapshotIfExists(target, prior);
        return null;
      }
      if (!WRITE.has(name) || !args.path) return null;
      const full = expandPath(args.path, getWorkdir());
      const protectedFile = protectedFiles.find((file) => sameRequestedPath(full, file.path));
      if (protectedFile && (!protectedFile.initial?.covered || verificationSource(full, args.content || "").hash !== protectedFile.initial.hash)) {
        return proof(false, full, "protected file", `The request keeps ${protectedFile.requested} unchanged.`);
      }
      if (isVerifierPath(full) || isVerifierPath(args.path)) {
        return proof(false, full, "verifier edit — human review", "Do not expand the harness from a job. A human reviews verifier changes.");
      }
      if (name !== "computer_write" && unreadExisting(args.path, prior)) {
        return proof(false, full, "read first", "read the existing file before overwriting it");
      }
      if (!initialHashes.has(full)) {
        const cached = prior.get(full) ?? prior.get(args.path);
        if (cached !== undefined) initialHashes.set(full, verificationSource(full, cached).hash);
        else if (!existsSync(full)) initialHashes.set(full, null);
        let baselineKey = full;
        if (initialHashes.has(full) && ledger) {
          const identity = ledger.identity(name === "computer_write" ? args.path : full, { remote: name === "computer_write", target: remoteTarget });
          initialHashes.set(identity.path, initialHashes.get(full));
          if (name !== "computer_write") requestedSourceAliases.set(full, identity.path);
          baselineKey = identity.path;
        }
        if (name !== "computer_write") rememberReviewBaseline(baselineKey, initialHashes.get(full), cached);
      }
      if (name !== "computer_write" && !existsSync(full) && !fixedRequirement(full)
        && (!ledger || !ledger.entries.has(ledger.identity(full).key))) createdAuxiliary.set(pathKey(full), true);
      if (name !== "computer_write" && !denySecretPath(full)) checkpoint?.track([full]);
      if (!isCodePath(full) && !isCodePath(args.path) && !isPagePath(full) && !isPagePath(args.path)) return null;
      const patch = patchVerdict(prior.get(full) || prior.get(args.path), String(args.content || ""));
      if (!patch.ok && !approvalAware) return proof(false, full, `rewrite blocked ${full}`, patch.error);
      return null;
    },
    async after(name, rawArgs, result) {
      const args = name === "host_file_edit" ? { ...parseArgs(rawArgs) } : parseArgs(rawArgs);
      try {
      if (name === "host_file_edit" && result?.ok) {
        if (result.unchanged) return null;
        try { args.content = readFileSync(result.path, "utf8"); }
        catch { return proof(false, result.path, "edit unverified", "The edited file is no longer readable. No successful check is established."); }
      }
      this.note(name, args, result);
      if (SHELL.has(name)) {
        const changed = collectShellChanges(name, args, result);
        // Assertion failures need a clean exact-command rerun. A native loader
        // failure alone may also be superseded by a clean same-CWD check whose
        // only program change repairs a literal relative import's .ts suffix.
        const command = String(args.command || "").trim();
        const cwd = args.cwd ? expandPath(args.cwd, getWorkdir()) : getWorkdir();
        const commandKey = `${cwd}\0${command}`;
        if (result?.testFailure) {
          const transport = redactSecrets(command) === command && (!verificationCommands.has(commandKey) || transportVerificationCommands.has(commandKey))
            ? nativeNodeTransportIdentity(command,result) : null;
          if (transport) transportVerificationCommands.set(commandKey,transport); else transportVerificationCommands.delete(commandKey);
          verificationCommands.set(commandKey, `failed test verification: ${redactSecrets(command).slice(0, 300)}`);
          ledger?.commandChecked(cwd, command, result);
        } else if (result?.ok && !result.held && !result.skipped && !result.unavailable && !result.noTests) {
          const identity = redactSecrets(command) === command ? inlineNodeCheckIdentity(command) : null;
          if (identity) for (const [oldKey, oldIdentity] of transportVerificationCommands) {
            if (oldKey.startsWith(`${cwd}\0`) && oldIdentity === identity) {
              transportVerificationCommands.delete(oldKey); verificationCommands.delete(oldKey);
            }
          }
          verificationCommands.delete(commandKey);
          transportVerificationCommands.delete(commandKey);
          ledger?.commandChecked(cwd, command, result);
        }
        const execution = observeExecution(name, args, result);
        if (!result?.ok && !changed.length) return execution;
        if (result.approved) {
          // This exact command was reviewed. Keep its changes as the new baseline.
          for (const path of [...prior.keys()]) { prior.delete(path); snapshotIfExists(path, prior); }
        }
        const smash = auditDisk();
        if (smash) return smash;
        if (!changed.length) return execution;
        const checks = [];
        for (const file of changed) {
          checks.push(await finishCheck(file, readFileSync(file, "utf8"), undefined, { deferAsks: true }));
        }
        markAsks();
        const open = hardMiss();
        const failed = checks.find((check) => !check.ok);
        const selected = failed || checks.at(-1);
        return { ...selected, ok: result?.ok === true && !failed && !open.length,
          detail: [...checks.map((check) => check.detail || check.blurb), ...(!result?.ok ? ["The shell command failed; source checks do not establish command success."] : []), ...(open.length ? [`Still open: ${open.join("; ")}`] : [])].join("\n"),
          paths: changed };
      }
      const file = result?.path || args.path;
      if (!WRITE.has(name) || !result?.ok) return null;
      if (isPagePath(file)) return finishPage(file, String(args.content || sources.get(file) || ""));
      if (!isCodePath(file)) return null;
      if (isVerifierPath(file)) {
        return proof(false, file, "verifier edit — human review", "Do not expand the harness from a job. A human reviews verifier changes.");
      }
      if (name === "computer_write") {
        if (!remoteExec) {
          extraDebt.push("computer_write unverified");
          return proof(false, file, "remote write unverified", "No tools key to computer_exec a compile.");
        }
        return finishCheck(file, args.content || "", remoteExec);
      }
      const text = String(args.content || sources.get(file) || "");
      const patch = patchVerdict(prior.get(file), text);
      if (!patch.ok && !result.approved) {
        const old = prior.get(file);
        const restored = old != null ? writeUserFile(file, old) : null;
        return proof(false, file, `rewrite blocked ${file}`, `${patch.error}${restored && !restored.ok ? `; restore failed: ${restored.error}` : ""}`);
      }
      if (text) prior.set(file, text);
      const check = await finishCheck(file, text);
      if (["host_file_write", "host_file_edit"].includes(name) && !result.held && !result.skipped && !result.unavailable
        && !result.unchanged && !denySecretPath(file) && text.length <= 80_000 && Buffer.byteLength(text) <= 80_000) {
        requestedSourceSaves.set(file, verificationSource(file, text).hash); // Supplied text, no reread.
      }
      return check;
      } finally { projects?.observe(); }
    },
    block(reason) {
      const text = String(reason || "harness blocked").slice(0, 160);
      if (text && !extraDebt.includes(text)) extraDebt.push(text);
    },
    debt({ forAction = false } = {}) {
      projects?.observe();
      const touched = [...clean, ...passed, ...broken, ...unchecked];
      return [...new Set([
        ...[...broken],
        ...[...unchecked],
        ...(requireEdits ? named.filter((name) => !touched.some((path) => sameRequestedPath(path, name))).map((name) => `write and run ${name}`) : []),
        ...protectedFiles.filter((file) => file.initial && (() => { const now = verificationSource(file.path); return now.hash !== file.initial.hash || now.covered !== file.initial.covered; })())
          .map((file) => `protected file changed: ${file.requested}`),
        ...hardMiss().map((item) => `ask:${item}`),
        ...extraDebt,
        ...(!ledger ? verificationCommands.values() : []),
        ...(ledger?.debt({ forAction }) || []),
      ])];
    },
    actionDebt() { return this.debt({ forAction: true }); },
    /** Optional helper-draft budget stage, never verification or permission.
     * Only already-cached local save/body/ledger identities participate. */
    requestedSourceProgress() {
      if (!requireEdits || signal?.aborted) return false;
      const rows = new Map([...(ledger?.entries.values() || [])]
        .filter(row => !row.remote && row.kind !== "project" && row.kind !== "command").map(row => [row.path, row]));
      const snapshots = [];
      for (const [path, savedHash] of [...requestedSourceSaves].slice(-500)) {
        const full = expandPath(path, getWorkdir());
        const currentPath = reviewSourcePaths.get(path) || requestedSourceAliases.get(full) || full;
        const row = rows.get(currentPath) || rows.get(full) || rows.get(path);
        const text = sources.get(path) ?? sources.get(full);
        if (ledger && !row) continue;
        const initialKey = row?.path || currentPath;
        const initialHash = initialHashes.has(initialKey) ? initialHashes.get(initialKey)
          : initialHashes.has(full) ? initialHashes.get(full) : initialHashes.get(path);
        const currentHash = ledger ? row?.hash : (typeof text === "string" && text.length <= 80_000 && Buffer.byteLength(text) <= 80_000
          ? verificationSource(path, text).hash : null);
        snapshots.push({path:full,currentPath:row?.path || currentPath,initialHash,currentHash,savedHash,text,authorizedSave:true});
      }
      return requestedSourceChanged({cwd:getWorkdir(),snapshots,aliases:requestedSourceAliases});
    },
    /** Private exact cached-write input for an informational lexical advisory.
     * No filesystem lookup/reread, permission, obligation or check result. */
    referenceAdvisorySource(path) {
      if (typeof path !== "string") return null;
      const full = expandPath(path, getWorkdir());
      const key = sources.has(path) ? path : full;
      const text = sources.get(key);
      if (typeof text !== "string" || !writtenFiles.has(key) || text.length > 80_000 || Buffer.byteLength(text) > 80_000) return null;
      const canonical = reviewSourcePaths.get(key) || full;
      const row = ledger && [...ledger.entries.values()].find(row => row.kind !== "project" && row.kind !== "command"
        && !row.remote && [canonical,key,full].includes(row.path));
      const hash = verificationSource(key, text).hash; // Supplied body: no disk access.
      if (ledger && !row) return null;
      if (row && (row.remote || row.kind === "project" || row.kind === "command" || row.hash !== hash)) return null;
      return {path:row?.path || canonical,text,hash};
    },
    /** Private advisory input from this turn's existing caches only. This is
     * not a tool, filesystem reader, permission grant or verification verdict. */
    contractReviewSources() {
      const snapshots = [], omitted = [];
      let omittedCount = 0, chars = 0;
      const rows = new Map([...(ledger?.entries.values() || [])]
        .filter(row => !row.remote && row.kind !== "project" && row.kind !== "command").map(row => [row.path, row]));
      for (const [path, text] of sources) {
        if ((!isCodePath(path) && !isPagePath(path)) || typeof text !== "string") continue;
        const full = expandPath(path, getWorkdir()), row = rows.get(reviewSourcePaths.get(path)) || rows.get(full) || rows.get(path);
        const key = row?.path || full;
        const beforeKnown = initialHashes.has(key) || initialHashes.has(path);
        const beforeHash = initialHashes.has(key) ? initialHashes.get(key) : initialHashes.get(path);
        const large = text.length > 80_000 || Buffer.byteLength(text) > 80_000;
        const hash = large ? null : verificationSource(path, text).hash; // Supplied text: no file read.
        if (!large && beforeKnown && beforeHash === hash) continue;
        let reason = large ? "source snapshot exceeds review bound" : !beforeKnown ? "baseline hash unavailable" : !row || row.hash !== hash ? "cached source witness unavailable or stale"
          : snapshots.length >= 4 || chars + text.length > 160_000 ? "review source limit" : "";
        if (reason) { omittedCount++; if (omitted.length < 8) omitted.push({ path: key, reason }); continue; }
        const baseline = reviewBaselines.get(key) || reviewBaselines.get(full) || reviewBaselines.get(path);
        snapshots.push({ path: key, beforeHash, afterHash: hash, currentHash: row.hash, text,
          ...(baseline?.hash === beforeHash ? { beforeText: baseline.text }
            : { beforeOmission: beforeHash === null ? "new_file_no_previous_body" : "baseline_body_not_captured_or_exceeds_bound" }) });
        chars += text.length;
      }
      return { snapshots, omitted, omittedCount };
    },
    /** Cached evidence only: the agent compares hashes/status without scanning
     * disk or treating read-only project discovery as work completed. */
    progressState() {
      const rows = ledger ? [...ledger.entries.values()].slice(-500).map((row) => ({
        kind: row.kind || "file", path: row.path, hash: row.hash, status: row.status,
        requiredPhase: row.requiredPhase, phase: row.phase,
        ...(initialHashes.has(row.path) ? { initialHash: initialHashes.get(row.path) } : {}),
        ...(row.kind === "project" && projects?.roots.has(row.path) ? { revision: projects.roots.get(row.path).revision } : {}),
      })) : [...wrote].slice(-500).map((path) => ({ kind: "file", path,
        hash: sources.has(path) ? verificationSource(path, sources.get(path)).hash : null,
        status: broken.has(path) ? "failed" : unchecked.has(path) ? "unverified" : clean.has(path) || passed.has(path) ? "passed" : "pending",
        requiredPhase: "syntax",
        ...(initialHashes.has(path) ? { initialHash: initialHashes.get(path) } : {}),
      }));
      // A text/data edit is still a real source revision. It supplies no
      // compiler/runtime proof; only its cached before/after bytes can earn
      // progress. Read operations never enter this set.
      for (const path of [...writtenFiles].slice(-500)) {
        if (isCodePath(path) || isPagePath(path) || !sources.has(path)) continue;
        rows.push({ kind: "file", path, hash: verificationSource(path, sources.get(path)).hash, status: "unverified",
          ...(initialHashes.has(path) ? { initialHash: initialHashes.get(path) } : {}) });
      }
      return rows.slice(-500);
    },
  };
}

export function codeAsk(text) {
  return extractAsks(text).length > 0
    || expectFromAsk(text).length > 0
    || namedCode(text).length > 0
    || /\b(fix|bug|compile|indent|error|tui|python|script|function|rewrite|patch|code|program)\b/i.test(String(text || ""));
}
