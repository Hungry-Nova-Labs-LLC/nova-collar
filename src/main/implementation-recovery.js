import {isAbsolute, relative, resolve, sep} from 'node:path';

function builtinWriter(tool) {
  if (tool?.type !== 'function' || tool.function?.name !== 'host_file_write') return false;
  const schema = tool.function.parameters;
  const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const stringField = value => only(value, ['type','description','title']) && value.type === 'string';
  // A custom validator may reject a target which a name-only choice accepts.
  // This optional recovery recognizes only the built-in unconstrained writer;
  // unknown constraints disable it, and no RegExp from a schema is evaluated.
  return only(schema, ['type','properties','required','description','title','additionalProperties'])
    && schema.type === 'object' && only(schema.properties, ['path','content'])
    && stringField(schema.properties.path) && stringField(schema.properties.content)
    && (!Object.hasOwn(schema,'additionalProperties') || schema.additionalProperties === true)
    && Array.isArray(schema.required) && schema.required.length === 2
    && schema.required.includes('path') && schema.required.includes('content');
}

/** A choice hint, not a dispatched operation or authority to write a path.
 * Candidate metadata is deliberately lazy: capability and local stage checks
 * happen before even reading a missingFiles getter, much less invoking it. */
export async function missingFileRecovery(options = {}) {
  if (!options || options.attempted || options.limited !== true || options.local !== true
    || options.editTask !== true || options.suspended || options.sourceRead !== true
    || typeof options.cwd !== 'string' || !isAbsolute(options.cwd)) return null;
  const offered = options.offered, permitted = options.permittedNames;
  if (!Array.isArray(offered) || !(permitted instanceof Set)
    || !Set.prototype.has.call(permitted,'host_file_write')) return null;
  const writers = offered.filter(tool => tool?.function?.name === 'host_file_write');
  if (writers.length !== 1 || !builtinWriter(writers[0])) return null;
  const root = resolve(options.cwd);
  let candidates;
  try {
    const missing = options.missingFiles;
    candidates = await (typeof missing === 'function' ? missing() : missing);
  } catch { return null; }
  if (!Array.isArray(candidates)) return null;
  const path = candidates.find(value => {
    if (typeof value !== 'string' || !isAbsolute(value)) return false;
    const rel = relative(root, resolve(value));
    return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
  });
  return path ? {tool:'host_file_write',path:resolve(path),cwd:root} : null;
}

/** Validate the completed named-choice response before ordinary tool dispatch.
 * A name hint cannot authorize a different target or a second buffered call. */
export function recoveryCallMatches(choice, calls, cwd) {
  try {
    if (!choice || typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== choice.cwd
      || !Array.isArray(calls) || calls.length !== 1) return false;
    const fn = calls[0]?.function;
    if (fn?.name !== choice.tool) return false;
    const args = JSON.parse(fn.arguments);
    return Boolean(args && !Array.isArray(args) && typeof args.path === 'string' && typeof args.content === 'string'
      && Object.keys(args).every(key => ['path','content'].includes(key))
      && resolve(cwd,args.path) === choice.path);
  } catch { return false; }
}
