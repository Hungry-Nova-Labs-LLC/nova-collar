import {basename, isAbsolute, relative, resolve, sep} from "node:path";
import {authoredAssertionSource} from "./authored-checks.js";
import {pythonAssertionDriver} from "./assertion-source.js";

export const SCRATCH_DRAFT_CHARS = 4096;
export const SCRATCH_DRAFT_MS = 45_000;
export const SCRATCH_DURATION_MIN_CHARS = 1024;

function jsonString(text, start) {
  if (text[start] !== '"') return null;
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return {value, end:i + 1, complete:true};
    if (ch.charCodeAt(0) < 32) return null;
    if (ch !== "\\") { value += ch; continue; }
    if (++i >= text.length) return {value, end:text.length, complete:false};
    const escaped = text[i], codes = {'"':'"',"\\":"\\","/":"/",b:"\b",f:"\f",n:"\n",r:"\r",t:"\t"};
    if (Object.hasOwn(codes, escaped)) { value += codes[escaped]; continue; }
    if (escaped !== "u") return null;
    const hex = text.slice(i + 1, i + 5);
    if (!/^[0-9a-f]{0,4}$/i.test(hex)) return null;
    if (hex.length < 4) return {value, end:text.length, complete:false};
    value += String.fromCharCode(parseInt(hex, 16)); i += 4;
  }
  return {value, end:text.length, complete:false};
}

/** Parse only real top-level string argument values from a partial JSON object.
 * Nested fields and quoted code cannot impersonate path/content. Ambiguous,
 * invalid or incomplete metadata is never promoted into a budget decision.
 */
export function topLevelDraftStrings(raw) {
  const text = String(raw || ""), fields = {}, seen = new Set();
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] || "") && i < text.length) i++; };
  ws(); if (text[i++] !== "{") return null;
  while (i < text.length) {
    ws(); if (text[i] === "}") return {...fields, complete:true};
    const key = jsonString(text, i);
    if (!key?.complete || seen.has(key.value)) return null;
    seen.add(key.value); i = key.end; ws(); if (text[i++] !== ":") return null; ws();
    if (text[i] === '"') {
      const value = jsonString(text, i); if (!value) return null;
      if (key.value === "path" || key.value === "content") fields[key.value] = value.value;
      if (!value.complete) return key.value === "content" ? {...fields, complete:false} : null;
      i = value.end;
    } else {
      // Skip unknown complete values using balanced JSON containers/strings.
      const start = i, stack = [];
      while (i < text.length) {
        if (text[i] === '"') { const s = jsonString(text, i); if (!s?.complete) return null; i = s.end; continue; }
        if (text[i] === "{" || text[i] === "[") stack.push(text[i]);
        else if (text[i] === "}" || text[i] === "]") {
          if (!stack.length) break;
          const open = stack.pop(); if ((open === "{") !== (text[i] === "}")) return null;
        } else if (text[i] === "," && !stack.length) break;
        i++;
      }
      if (stack.length || i === text.length) return null;
      try { JSON.parse(text.slice(start, i)); } catch { return null; }
      if (key.value === "path" || key.value === "content") return null;
    }
    ws(); if (text[i] === "}") return {...fields, complete:true};
    if (text[i++] !== ",") return null;
  }
  return {...fields, complete:false};
}

function inside(root, path) {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith(".." + sep) && !isAbsolute(name);
}

/** Capability check only. An invented tool delta must not start local metadata
 * work before the ordinary dispatcher rejects it. Unknown schemas fail closed.
 */
export function scratchDraftWriterAvailable(tools, toolChoice) {
  if (!Array.isArray(tools)) return false;
  if (toolChoice != null && !["auto", "required"].includes(toolChoice)
    && (typeof toolChoice !== "object" || toolChoice.type !== "function"
      || toolChoice.function?.name !== "host_file_write")) return false;
  const writers = tools.filter(tool => tool?.function?.name === "host_file_write");
  if (writers.length !== 1) return false;
  const writer = writers[0], schema = writer.function?.parameters;
  // This optional optimization recognizes the built-in unconstrained writer.
  // Custom restrictions require a full validator, so disable rather than probe
  // a path which its declared enum/const/pattern/extra requirement may forbid.
  const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const stringField = value => only(value, ["type", "description", "title", "default", "examples"])
    && value.type === "string";
  return writer.type === "function" && only(schema, ["type", "properties", "required", "additionalProperties", "description", "title"])
    && schema.type === "object" && only(schema.properties, ["path", "content"])
    && stringField(schema.properties.path) && stringField(schema.properties.content)
    && (!Object.hasOwn(schema, "additionalProperties") || schema.additionalProperties === true)
    && Array.isArray(schema.required) && schema.required.length === 2
    && schema.required.includes("path") && schema.required.includes("content");
}

export function scratchDraftPolicy(ask, cwd, initialFiles = new Map()) {
  const text = String(ask || "");
  // Over-exempt all explicitly mentioned paths, including protected/quoted
  // references. This guard is a generation budget, never a scope authority.
  const mentioned = [...text.matchAll(/(?:[a-z]:[\\/]|[\\/])?[\w@~.-]+(?:[\\/][\w@~.-]+)*\.(?:py|[cm]?js|[cm]?ts|tsx|swift|go|rs|sh|bash)\b/gi)].map(m => resolve(cwd, m[0]));
  const requestedTests = /\b(?:write|add|create|generate|implement|build|expand)\b[^.?!;\n]{0,100}\b(?:tests?|test\s+suites?|regression\s+suite|assertions?|(?:verification|validation)\s+(?:script|helper|suite|driver))\b/i.test(text);
  return {enabled:mentioned.length > 0 && !requestedTests, cwd, requestedPaths:[...new Set(mentioned)], maxChars:SCRATCH_DRAFT_CHARS, maxMs:SCRATCH_DRAFT_MS, minDurationChars:SCRATCH_DURATION_MIN_CHARS, initialFiles};
}

export function enforceScratchDraftBudget(calls, policy, {pathState, denyPath = () => false, sourceClocks, now = () => performance.now()} = {}) {
  if (!policy?.enabled) return;
  const limit = Number.isInteger(policy.maxChars) && policy.maxChars > 0 ? policy.maxChars : SCRATCH_DRAFT_CHARS;
  const root = resolve(policy.cwd);
  const requested = new Set((policy.requestedPaths || []).map(path => resolve(policy.cwd,path)));
  const requestedNames = new Set([...requested].map(path=>basename(path)));
  for (const [index, call] of calls) {
    const forget = () => sourceClocks instanceof Map && sourceClocks.delete(index);
    if ((call?.function?.name ?? call?.name) !== "host_file_write") { forget(); continue; }
    const args = topLevelDraftStrings(call?.function?.arguments ?? call?.arguments ?? call?.args);
    if (!args || typeof args.path !== "string" || typeof args.content !== "string" || !args.content.length) { forget(); continue; }
    const full = resolve(policy.cwd, args.path);
    if (!inside(resolve(policy.cwd), full) || denyPath(full)) { forget(); continue; }
    const path=full;
    // Basename exemption is deliberately conservative for canonical aliases;
    // ambiguous requested production paths must never acquire a scratch cap.
    if (!inside(root,path)||requested.has(path)||requestedNames.has(basename(path))) { forget(); continue; }
    const state=pathState || (name=>policy.initialFiles?.get(name));
    // Only explicit first-observed absence is eligible. This call never stats,
    // resolves symlinks, opens files or guesses unknown metadata on the SSE path.
    if(state(path)!==false) { forget(); continue; }
    const maxMs = Number.isFinite(policy.maxMs) && policy.maxMs > 0 ? policy.maxMs : SCRATCH_DRAFT_MS;
    const minChars = Number.isInteger(policy.minDurationChars) && policy.minDurationChars > 0 ? policy.minDurationChars : SCRATCH_DURATION_MIN_CHARS;
    let elapsed = null;
    if (sourceClocks instanceof Map && (call?.id === undefined || typeof call.id === "string")) {
      const id = call.id ?? "";
      let clock = sourceClocks.get(index);
      if (!clock || clock.path !== path || clock.id !== id) {
        clock = { path, id, startedAt: null, last: null, disabled: false };
        sourceClocks.set(index, clock);
      }
      if (!clock.disabled) {
        let current;
        try { current = now(); } catch { clock.disabled = true; }
        if (!Number.isFinite(current) || current < 0 || clock.last !== null && current < clock.last) clock.disabled = true;
        if (!clock.disabled) {
          clock.startedAt ??= current;
          clock.last = current;
          elapsed = current - clock.startedAt;
        }
      }
    } else forget(); // Unknown provider identity disables only optional timing.
    const charExceeded = args.content.length > limit;
    // Never abandon an already buffered requested write because a later helper
    // is slow. Mixed/ambiguous batches retain only the existing character cap.
    let completedCall = false;
    try {
      const fullArgs = JSON.parse(call?.function?.arguments ?? call?.arguments ?? call?.args);
      completedCall = fullArgs && !Array.isArray(fullArgs) && fullArgs.path === args.path && fullArgs.content === args.content;
    } catch { /* A partial source draft may still reach its optional duration budget. */ }
    const durationExceeded = !completedCall && calls.size === 1 && args.content.length >= minChars && elapsed !== null && elapsed >= maxMs;
    if (!charExceeded && !durationExceeded) continue;
    const completeDriver = authoredAssertionSource(path, args.content);
    const helperPurpose = /(?:^|[-_.])(?:tests?|checks?|verify|verification|smoke|probe)(?:$|[-_.])/i.test(basename(path));
    const partialDriver = path.endsWith(".py") && helperPurpose && pythonAssertionDriver(args.content, {prefix:true});
    if (!completeDriver && !partialDriver) continue;
    const reason = charExceeded ? "characters" : "duration";
    const budget = charExceeded ? `${limit}-character scratch budget`
      : `${maxMs}ms source-drafting budget after the first eligible source frame, including subsequent stream delays`;
    const error = new Error(`A new unrequested assertion helper exceeded the ${budget}. The entire unfinished response and all buffered tool calls were discarded; nothing from that response was dispatched.`);
    error.name = "ScratchDraftBudgetError";
    error.scratchDraft = {file:basename(path), reason, limitChars:limit, observedChars:args.content.length,
      limitMs:maxMs, minSourceChars:minChars, ...(elapsed !== null ? {elapsedSinceFirstEligibleSourceFrameMs:Math.floor(elapsed)} : {})};
    calls.clear();
    throw error;
  }
}

/** Optional recovery accepts only the currently offered built-in local runner.
 * It selects no command and expands neither schema nor dispatcher authority. */
export function scratchRunRecoveryTool(tools, toolChoice) {
  if (!Array.isArray(tools) || (toolChoice != null && !["auto", "required"].includes(toolChoice))) return null;
  const runners = tools.filter(tool => tool?.function?.name === "host_run");
  if (runners.length !== 1 || runners[0].type !== "function") return null;
  const schema = runners[0].function.parameters;
  const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const stringField = value => only(value, ["type", "description", "title"]) && value.type === "string";
  if (!only(schema, ["type", "properties", "required", "additionalProperties", "description", "title"])
    || schema.type !== "object" || !only(schema.properties, ["command", "cwd", "timeoutMs", "paths"])
    || !stringField(schema.properties.command) || !Array.isArray(schema.required)
    || schema.required.length !== 1 || schema.required[0] !== "command"
    || (Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== true)) return null;
  const {cwd, timeoutMs, paths} = schema.properties;
  if (cwd !== undefined && !stringField(cwd)) return null;
  if (timeoutMs !== undefined && (!only(timeoutMs, ["type", "minimum", "maximum", "description", "title"])
    || timeoutMs.type !== "integer" || (timeoutMs.minimum !== undefined && timeoutMs.minimum !== 1)
    || (timeoutMs.maximum !== undefined && timeoutMs.maximum !== 90000))) return null;
  if (paths !== undefined && (!only(paths, ["type", "maxItems", "items", "description", "title"])
    || paths.type !== "array" || (paths.maxItems !== undefined && paths.maxItems !== 50)
    || (paths.items !== undefined && !stringField(paths.items)))) return null;
  return runners[0];
}

/** A forced name is not permission for a different tool, batch or workspace. */
export function scratchRunRecoveryMatches(choice, calls, cwd) {
  try {
    if (!choice || !isAbsolute(choice.cwd) || !isAbsolute(cwd) || resolve(cwd) !== choice.cwd
      || !Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== "host_run") return false;
    const args = JSON.parse(calls[0].function.arguments);
    return Boolean(args && !Array.isArray(args) && typeof args.command === "string" && args.command.trim()
      && Object.keys(args).every(key => ["command", "cwd", "timeoutMs", "paths"].includes(key))
      && (args.cwd === undefined || (typeof args.cwd === "string" && resolve(cwd, args.cwd) === choice.cwd))
      && (args.timeoutMs === undefined || (Number.isInteger(args.timeoutMs) && args.timeoutMs >= 1 && args.timeoutMs <= 90000))
      && (args.paths === undefined || (Array.isArray(args.paths) && args.paths.length <= 50 && args.paths.every(path => typeof path === "string"))));
  } catch { return false; }
}

const guardError = error => ["ThoughtLoop", "ScratchDraftBudgetError"].includes(error?.name);

/** One shared guarded-response recovery. The request callback is the already
 * selected lane; this helper selects no provider, tools, permissions or runner.
 * Interrupted response content/calls are never added to the next request.
 */
export function createDraftRecovery({request, checkAbort, emit = () => {}, context = () => "", progress = () => {}}) {
  let recoveries = 0, stopReason = "";
  const note = error => {
    emit({type:"retract"});
    if (error.name === "ScratchDraftBudgetError") emit({type:"generation_guard",kind:"scratch_assertion_budget",
      attempt:recoveries + 1,discardedResponse:true,...error.scratchDraft});
  };
  const reason = error => error.name === "ScratchDraftBudgetError"
    ? "Incomplete. Unrequested verification-helper generation exceeded its scratch budget after the one permitted recovery. No calls from either interrupted response were dispatched and no further model request was made."
    : "Incomplete. The reasoning repetition guard interrupted a response after the one permitted recovery. No calls from either interrupted response were dispatched and no further model request was made.";
  return {
    get stopReason() { return stopReason; },
    get recoveryCount() { return recoveries; },
    async run(path, list, onText, opts) {
      try { return await request(path, list, onText, opts); }
      catch (error) {
        if (!guardError(error)) throw error;
        checkAbort(); note(error);
        if (recoveries >= 1) { stopReason = reason(error); return null; }
        recoveries++;
        const scratch = error.name === "ScratchDraftBudgetError";
        const runChoice = scratch ? opts.scratchRunRecovery : null;
        emit({type:"mood",mood:"think",text:scratch ? "switching to a compact check" : "continuing from recorded results"});
        const instruction = scratch
          ? "The unrequested assertion-helper draft exceeded its bounded scratch budget. The entire unfinished response and all buffered tool calls were discarded; nothing from it was saved or dispatched. Continue from completed receipts. Prefer a small actual behavioral check using an installed/declared runner; do not expand or replay the rejected helper. Do not invent a TypeScript runner, install dependencies, or claim a check ran. Requested production/test files retain their normal argument budget and ordinary permission gates. If a check cannot be established, give a concise honest Incomplete handoff with the remaining limits."
          : "The reasoning repetition guard interrupted the previous unfinished response. Its partial tool calls were discarded and were not dispatched. Continue from the completed tool receipts already recorded above. Do not replay a completed mutation. Choose a different concrete next step to resolve an outstanding check if the current tool mode permits it; otherwise give a concise honest handoff with unresolved checks. Do not claim completion without evidence.";
        const runInstruction = runChoice
          ? " In this one recovery response call only host_run once with a short actual check using an installed or declared runner already supported by the current project. Choose the command from the recorded source and receipts; no command has been supplied or executed for you. Do not create/replay another helper file, install dependencies, guess a runner, or claim a check passed. Ordinary scope, approval and verification gates still apply. If no supported check can run, give an honest incomplete handoff."
          : "";
        list.push({role:"user",content:instruction + runInstruction + "\n\n" + context()});
        progress(); checkAbort();
        const retryOptions = runChoice ? {...opts,
          toolChoice:{type:"function",function:{name:"host_run"}}, scratchDraftPolicy:undefined, noLaneFallback:true}
          : {...opts,noLaneFallback:true};
        try {
          const reply = await request(path, list, onText, retryOptions);
          return runChoice && reply ? {...reply,scratch_run_recovery:{cwd:runChoice.cwd}} : reply;
        }
        catch (retryError) {
          if (!guardError(retryError)) throw retryError;
          checkAbort(); note(retryError); stopReason = reason(retryError); return null;
        }
      }
    },
  };
}
