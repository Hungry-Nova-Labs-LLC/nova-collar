import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { sourceScopePlan } from "./source-preload.js";
import { createNewPathProbe } from "./new-path-probe.js";

const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const stringField = (value, minimum = false) => only(value, ["type", "description", "title", ...(minimum ? ["minLength"] : [])])
  && value.type === "string" && (!minimum || value.minLength === 1);
const required = (value, keys) => Array.isArray(value) && value.length === keys.length && keys.every(key => value.includes(key));
const code = path => /\.(?:py|[cm]?js|jsx|[cm]?ts|tsx|go|swift|sh|bash|html?|css)$/i.test(path);
const inside = (root, path) => { const rel = relative(root, path); return rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); };

export function builtinFocusedEditor(tool) {
  if (tool?.type !== "function" || tool.function?.name !== "host_file_edit") return false;
  const schema = tool.function.parameters, edits = schema?.properties?.edits, item = edits?.items;
  // Public windowToolDefs currently discloses the built-in array as type only.
  // Recognize that exact unconstrained form as well as the full pack schema;
  // unknown constraints still disable the optional choice. Dispatch is strict.
  const minimalArray = only(edits, ["type", "description", "title"]) && edits.type === "array";
  return Boolean(only(schema, ["type", "properties", "required", "description", "title", "additionalProperties"])
    && schema.type === "object" && only(schema.properties, ["path", "edits"])
    && (!Object.hasOwn(schema, "additionalProperties") || typeof schema.additionalProperties === "boolean")
    && stringField(schema.properties.path) && required(schema.required, ["path", "edits"])
    && (minimalArray || only(edits, ["type", "minItems", "maxItems", "items", "description", "title"])
    && edits.type === "array" && edits.minItems === 1 && edits.maxItems === 50
    && only(item, ["type", "properties", "required", "additionalProperties", "description", "title"])
    && item.type === "object" && item.additionalProperties === false && only(item.properties, ["oldText", "newText"])
    && stringField(item.properties.oldText, true) && stringField(item.properties.newText)
    && required(item.required, ["oldText", "newText"])));
}

/** Request-local schema selection only. The bridge/current-stage checks grant
 * no new authority, and the ordinary response matcher still binds the target.
 * Never mutate the ordinary catalog or substitute an unknown editor schema. */
export function existingEditRequestTools(choice, offered) {
  if (choice?.tool !== "host_file_edit" || !Array.isArray(offered)) return null;
  const selected = offered.filter(tool => tool?.function?.name === "host_file_edit");
  return selected.length === 1 && builtinFocusedEditor(selected[0]) ? [selected[0]] : null;
}

/** One purpose-specific bridge, not progress credit or a larger generic loop.
 * Selection consumes only real read receipts and cached verification metadata.
 * A bounded readonly metadata child rejects missing paths/symlink parents; all
 * source, CAS, protection and approval checks still run in ordinary dispatch.
 */
export function createExistingEditBridge({ ask, cwd, probeFactory = createNewPathProbe } = {}) {
  let attempted = false, disabled = false, firstReadRound = null;
  return {
    disable() { disabled = true; },
    async choose(options = {}) {
      if (attempted || disabled || options.local !== true || options.editTask !== true || options.suspended !== false
        || options.workPhase !== true || typeof cwd !== "string" || !isAbsolute(cwd)
        || options.cwd !== cwd || !Number.isInteger(options.round) || options.round < 1
        || !Number.isInteger(options.limit) || options.limit < 1 || options.round > options.limit
        || !(options.permittedNames instanceof Set) || !Set.prototype.has.call(options.permittedNames, "host_file_edit")
        || !Array.isArray(options.offered)) return null;
      const editors = options.offered.filter(tool => tool?.function?.name === "host_file_edit");
      if (editors.length !== 1 || !builtinFocusedEditor(editors[0])) return null;
      const plan = sourceScopePlan(ask);
      if (["blanket", "specific"].includes(plan.readRestriction)) return null;
      let observed;
      try { const getter = options.observations; observed = typeof getter === "function" ? getter() : getter; } catch { return null; }
      if (!observed || !Array.isArray(observed.reads)) return null;
      const root = resolve(cwd), declared = plan.paths.map(path => resolve(root, path));
      const denied = path => { try { return typeof options.denyPath !== "function" || options.denyPath(path); } catch { return true; } };
      const protectedNames = new Set((observed.protectedPaths || []).filter(path => typeof path === "string").map(path => basename(path).toLowerCase()));
      const paths = [...new Set(declared)].filter(path => inside(root, path) && code(path) && !denied(path) && !protectedNames.has(basename(path).toLowerCase()));
      const target = path => paths.includes(resolve(path || root));
      // An unrequested helper write is not a requested implementation. A real
      // target mutation attempt belongs to ordinary error repair, not this hint.
      if ((observed.mutations || []).some(target)) { disabled = true; return null; }
      const current = (observed.progress || []).filter(row => row?.path && target(row.path));
      if (current.some(row => typeof row.hash === "string" && Object.hasOwn(row, "initialHash") && row.hash !== row.initialHash)) {
        disabled = true; return null;
      }
      const proven = new Set(current.filter(row => row.status === "passed" && ["runtime", "test", "project"].includes(row.phase)).map(row => resolve(row.path)));
      const read = new Set(observed.reads.filter(row => row && row.complete === true && typeof row.path === "string" && Number.isFinite(row.bytes) && row.bytes > 0 && row.bytes <= 8 * 1024 * 1024).map(row => resolve(row.path)));
      const candidates = paths.filter(path => read.has(path) && !proven.has(path));
      if (!candidates.length) return null;
      firstReadRound ??= options.round - 1;
      // Permit one further ordinary model turn for context after the first
      // source read. Reserve the final ordinary round for the one eligible edit.
      if (options.round < firstReadRound + 2 && options.round < options.limit) return null;
      if (options.signal?.aborted) return null;
      attempted = true;
      let probe;
      try {
        probe = probeFactory({ cwd: root, signal: options.signal, denyPath: options.denyPath });
        for (const path of candidates.slice(0, 4)) probe.state(path);
        await probe.settle();
        if (options.signal?.aborted) return null;
        const path = candidates.slice(0, 4).find(path => probe.state(path) === true);
        if (!path) return null;
        return { tool: "host_file_edit", path, cwd: root };
      } catch { return null; } finally { probe?.close(); }
    },
  };
}

export function existingEditCallMatches(choice, calls, cwd) {
  try {
    if (!choice || choice.tool !== "host_file_edit" || cwd !== choice.cwd || !Array.isArray(calls) || calls.length !== 1) return false;
    const fn = calls[0]?.function, args = JSON.parse(fn?.arguments || "null");
    return Boolean(fn?.name === choice.tool && only(args, ["path", "edits"]) && typeof args.path === "string"
      && resolve(cwd, args.path) === choice.path && Array.isArray(args.edits) && args.edits.length > 0 && args.edits.length <= 50
      && args.edits.every(edit => only(edit, ["oldText", "newText"]) && typeof edit.oldText === "string" && edit.oldText.length > 0 && typeof edit.newText === "string"));
  } catch { return false; }
}
