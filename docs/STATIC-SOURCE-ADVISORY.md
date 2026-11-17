# Optional lexical source advisory

After a successful local source write/edit, the controller may analyze the
complete body already held by the current harness. It never rereads the project,
loads its configuration, imports its modules, resolves its dependencies, executes
its code or chooses a test/import command. Failed/blocked/no-op edit receipts and
read-only, remote and bot stages do not authorize another source observation.

Acorn 8.19.0 (MIT) creates an ESTree syntax tree. eslint-scope 8.4.0
(BSD-2-Clause) resolves actual lexical scopes, parameters, imports and aliases.
The older scope version preserves the app's declared Node 22.12 minimum. Exact
versions, transitive versions and integrity values are pinned in the lockfile;
full notices are in `data/licenses/runtime-reference-libraries.txt`.

The optional worker accepts at most 80,000 UTF-8 bytes and 80,000 UTF-16 code
units. Only eight distinct read-reference names/locations are returned, with an
omission count; no source body or AST enters the observation. Four source revisions
at most are analyzed per turn, with duplicate path/hash observations suppressed.
The worker has a one-second analysis timer and a 64 MiB JavaScript heap limit;
Stop requests worker termination. Cleanup awaits termination. These are runtime
limits, not a guarantee against OS scheduling or trusted dependency-loading stalls.

Supported JS uses a bounded ES2024 syntax subset. CJS/CTS use CommonJS lexical
scope; the remaining supported formats use module scope. TS/MTS/CTS require the
worker's native `stripTypeScriptTypes` API in strip-only mode. Missing APIs,
transformation-only syntax, JSX, coordinate-changing stripping and dynamic
`eval`/`with` produce explicit unavailable observations. Node 22.12 does not have
that API; host Node evidence never substitutes for actual Electron capability.
Each analysis includes the worker's Node/Electron/strip-availability metadata.

The conservative standard/Node/browser global union suppresses ordinary runtime
bindings and direct safe `typeof` probes. A sole immediate call in the positive
branch of a literal `typeof name === "function"` check is also exempt. This is
not general control-flow analysis: later calls, callbacks, alternate branches
and preceding reassignment are not covered by that narrow exemption. Cached
path/hash identity and Stop are rechecked after analysis before a hint is attached.
Project ambient globals and generated
bindings may still be reported; unreachable code is not distinguished. Conversely,
an existing lexical binding may have the wrong value, a dead module path or a
missing export. This is no typecheck, resolver, behavioral test or complete
missing-binding proof. No findings is not a passing check. Findings are quoted
advice only and create no debt, progress, permission, required repair or success
claim. Existing failures and stronger checks remain authoritative.

Primary references:

- https://github.com/acornjs/acorn/blob/master/acorn/README.md
- https://eslint.org/docs/latest/extend/scope-manager-interface
- https://eslint.org/docs/latest/rules/no-undef
- https://nodejs.org/download/release/v22.14.0/docs/api/module.html#modulestriptypescripttypescode-options
