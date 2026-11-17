# Autonomous completion development changes

Version `0.6.0-dev.20` addresses orchestration defects observed while running the
public agent on isolated coding projects. The private Collar build is still a
separate reference. No private profiles, routes, credentials or indexing corpus
are part of this source.

## Verification

Positive edit requests and preservation constraints are tracked separately.
Mentioning a file under “do not change” does not create an obligation to write it.
Requested module APIs use scoped import/callable/signature observations rather
than the presence of descriptive words in source. These observations establish
API presence, not arbitrary business behavior.

Python package checks preserve their package root and execution context. Swift
automatic checks parse source without pretending to link or run a library. Local
TypeScript syntax checking is distinguished from project type checking. Missing
tools, missing tests and unsupported checks remain explicit limitations.

A project without a declared executable test profile is reported as unavailable,
not as a passing test suite or an impossible failed task. That observation cannot
erase a previous genuine failure. Exit status, actual test outcomes, source
revisions and required verification strength still matter. General prose that
cannot be checked mechanically is advisory, not a literal-word completion test.

## Turn control

Focused edits use Nova Tag's exact replacement interface: each old-text block
must match uniquely, and every replacement is validated before a file is saved.
This lets a small change avoid generating the entire file again. Collar's read,
approval, source-change and verification controls still apply.

Duplicate calls use full canonical arguments. Truncated display text is never
the identity of an action. Verification can repeat after a real source revision;
repeating an unchanged failing call remains bounded.

Recent source changes and stronger verification evidence can extend a turn past
the initial small round allowance, up to a finite 60-round ceiling. Reading files,
changing timestamps and rewriting identical bytes do not earn progress.

Explicit review-only steering stops stale and subsequent edit batches, including
steering received through a question answer. Neutral follow-up guidance retains
the original task. Actual failure evidence and protected-file constraints remain
present when editing is paused.

An explicit run request needs an execution receipt without creating write debt.
When editing is prohibited, only the requested execution remains available and
ordinary command approval still applies.

## Avoidable latency

Implementation and function arguments retain the configured model budget. Edit
tasks cannot spend that entire budget dumping a proposed implementation as chat
prose without acting: visible prose is bounded and recovery is finite. Ordinary
review/explanation requests retain their normal response budget. Final closeout
has a smaller output reserve, leaving room for reasoning and a short handoff.
Fallback handoffs describe recorded writes/checks and limitations; they do not
invent full task success. Artificial repeat countdowns have been removed.

Short command diagnostics prefer the actual exception or failed-check summary
over incidental login-shell startup warnings. The full raw receipt is retained.
Known direct compiler commands are checked for structured compiler errors even
when a passive output filter masks the exit status. Mixed shell output has no
automatic compiler attribution; absence of an error is not proof of a build.

For a known selftest, an actual process failure remains verification debt even
when its summary format is unfamiliar. Missing test entry points and placeholder
profiles are unavailable checks, never passing tests. A shell that hides its
child's exit status cannot establish that status from silence alone.

Final closeout settles pending project checks before preparing its handoff,
including the turn-cap and provider-error paths. It does not keep a failure
message based on an obsolete pending-project snapshot.

If the reasoning-repetition guard fires, the main turn and forced closeout share
one recovery request with the same model and token settings. Partial tool calls
are discarded. A second guard produces an honest incomplete handoff from saved
receipts and open verification debt; it does not replay executed actions.

The eight-task development replay uses version `0.6.0-dev.3`. Version
`0.6.0-dev.4` receives a separate three-task follow-up for these corrections.
Results from those cohorts are kept separate; no full-eight v4 score is claimed.
Version `0.6.0-dev.5` receives a separate two-task reliability replay, using the
previously frozen transport-corrected primary grader. Six v5 cases are unmeasured;
no full-eight v5 score is claimed.

These changes reduce avoidable orchestration work. They do not increase the
model's underlying token generation speed or guarantee correct model-generated
code/tests. Live regression results are reported separately from deterministic
fixtures; earlier evaluation artifacts are preserved.


## Reliability follow-up

Pending project observations are completion work for the harness. They no longer
force another model tool call just to reach the boundary where project checks
run. Actual failed or unverified checks, file obligations, protected paths and
ledger errors still block unsupported success. Declared checks settle before the
handoff and are not rerun after every partial edit.

Authored assertion files receive explicit observations about whether they have
actually executed. Syntax and import checks remain distinct from assertion
execution. These observations are informational; the agent never guesses a
command, installs a runner or creates mandatory runtime debt from a filename.
Observed source edits invalidate earlier execution observations.

Whole-file replacements include bounded, redacted excerpts of removed source
for preservation review. The excerpts are data, not instructions, a regression
verdict or verification credit. Generic coding guidance asks for compact early
behavior checks and preservation of both existing and new behavior.

Source reads report redacted-view offsets, full size and explicit continuation.
Result packing returns valid JSON with truthful omission metadata and retains
process status. Large configured contexts can receive larger source excerpts;
other local receipts remain bounded. This reduces unnecessary read requests
without changing the selected model, context window or output-token budget.


## Bounded completion recovery

Explicitly requested small source files can be read before the first model
request when the current role, tool schema, scope and edit stage permit it.
These are actual bounded read receipts, quoted as source data. They confer no
implementation or verification credit. Unavailable files use the ordinary tool
workflow. New optional filesystem probes run in read-only child processes with
bounded waiting; a timeout does not assert that the kernel operation stopped.

While the optional limits remain active, generation of a new, nonrequested
assertion driver has a separate 4096-character source budget. Requested application code and requested tests retain the model's
normal output budget. An unfinished oversized helper response is discarded in
full before any buffered tool runs, with at most one shared recovery request.
Python custom check drivers are recognized as authored checks; execution still
requires an actual observed process result.

After limited planning prose, one narrowly scoped recovery may request the
builtin writer for an explicitly requested missing file. It requires an observed
source read and current local edit authority. Its response must contain exactly
one write to that target before ordinary path, approval and verification checks.
Human steering cancels that recovery. A rejected response can return to the
ordinary bounded loop; exhausted limits or unresolved work produce an honest
incomplete handoff.

Changed-code closeout receives one fresh advisory review from the same selected
model. It uses bounded cached before/after source and actual receipts, no tools,
and no alternative provider. Findings can inform one ordinary replan; they are
neither proof nor new user authority. Review overhead is measured in the live
replay. The two-case v6 replay remains separate from every prior cohort.

Active public development now lives in a nonsynced local Projects checkout.
The original Documents checkout and earlier evaluation artifacts are preserved.
This storage change is a timing confound when comparing against older runs.


## Compact verification follow-up

The dev.6 two-case replay produced35/40 artifact points and no verified
completions. Its source checkpoint and complete results are preserved separately.

For one-off verification, coding guidance now asks for compact executable
assertions through an installed or declared runner before a large scratch file.
After the first eligible scratch-helper overflow, the existing single recovery
can select the currently offered local command runner. The model chooses the
command from the request and recorded evidence; the app supplies no command or
expected answer. That response must contain exactly one valid command in the
current workspace and still passes the ordinary scope and approval controls.
Unavailable or restricted runner schemas retain the conservative recovery path.
Normal output-token settings and requested implementation/test budgets remain
unchanged. Thought repetition and scratch overflow still share one recovery.

An interrupted handoff incorporates pending human scope and settles already
authorized project observations before reporting its current debt. Cleanup and
checkpoints await settlement, including Stop and genuine check failures. This
path makes no new model call and confers no passing verification from silence.
The dev.7 replay is another separate two-case informed regression, not a merged
or full-eight score.

The Electron regression also exposed a delayed terminal callback after window
teardown. Window notifications now check both native window and web-contents
liveness. The real app fixture sends native terminal output after closing its
window and fails visibly on asynchronous errors. Earlier failed shutdown attempts
are retained in the validation evidence.


## Verification pacing and catalog stability

Version `0.6.0-dev.7` still produced 35/40 points and no verified completions in its separate
two-case replay. Actual behavior checks executed, but erroneous selftest
expectations, a real formatter defect and the time limit prevented completion.
These results and their checkpoint are preserved without a best-of merge.

A named command recovery now retains the original ordered tool schemas. The
exactly-one-command/workspace response check and ordinary dispatch permissions
are unchanged. This avoids an unnecessary schema change during recovery;
reported cache and timing differences do not establish an isolated speed effect.

While the optional limits remain active, a single-call response positively
drafting a new unrequested assertion helper can reach a 45-second draft budget once its source reaches 1024
characters. Its response-local, per-call clock begins at the first eligible
path and nonempty source-content observation. Earlier reasoning, prose, queue
admission and HTTP headers do not start it. Unknown clocks, ambiguous targets
or unknown file metadata disable the optional duration rule. This check runs
on stream events, rather than an independent silence timer. A complete valid
JSON writer call within the character limit is not discarded solely for draft
duration; it still needs ordinary response, tool, path and approval validation.
Requested files and explicit test writing retain the configured output budget.
Multi-call responses do not receive this optional time rule, protecting buffered
requested work. While active, the existing 4096-character rule discards an oversized
helper response atomically, including complete calls. Both limits share the
existing single recovery; neither declares code incorrect. Stop and the hard
handoff boundary still discard unfinished responses.

Generic verification guidance asks for independently computed expectations and
consistency checks against input data or preserved behavior, rather than
hand-counted indices or arithmetic. No task-specific answers or grader outputs
are supplied to the live actor. This development replay remains two informed
regressions with the same model and deadlines, not an unseen evaluation.


## Reliable verification and bounded local turns

Failed-check feedback now asks for a real repair followed by the relevant
verification rerun. The original failed receipt remains open until a matching
clean execution resolves it. Unrelated successful commands do not clear it.

Recognized native Node eval and quoted-stdin assertion programs create real
failed-check obligations. Native module-loader failures include runtime-specific
context without changing source or installing a runner. A clean rerun may
resolve a prior transport-only failure when its working directory, executable,
flags and entire program match except for literal relative import `.ts` suffixes.
The prior command remains recorded as failed, linked to the passing replacement;
genuine assertion failures retain exact-command debt. Unsupported syntax earns
no inferred assertion evidence. TypeScript API import checks observe native
import/callability only, rather than behavioral or integration correctness.

Explicit positive `Scope:` file lists are parsed separately from preservation
sentences. Automatic reads still respect read bans and all existing tool, role,
stage, path and bounded-reader controls. An unknown restriction can allow quoted
user-declared path metadata only: no file lookup, existence claim, read receipt
or verification credit. Blanket and specific read bans suppress that hint too.
The benchmark's broad privacy restrictions still prevent automatic preloading.

Local implementation turns default to a ten-minute controller budget. At 435
seconds the controller prioritizes verification. Primary responses can finish
through the 585-second boundary; the final 15 seconds are reserved for handoff.
The 150-second verification window is an opportunity rather than an exclusive
reserved period for checks.
Trusted callers can supply `budgetMs` or `deadlineAt`; an explicit longer budget
overrides the default and the earliest supplied limit wins. The default applies
to local lead/terminal implementation work, including loopback custom providers,
rather than model size or task prose. Model, context and output settings stay
unchanged. Phase hints change priorities without granting new tool authority or
guessing verification commands.

A primary model response can finish within the verification window without a
restart at the priority transition. At the hard handoff boundary, an unfinished
buffered response is discarded before dispatch. No new model request or command
starts in the handoff reserve. Declared or recognized checks may use the reserved
verification window, while optional advisory reviews require sufficient work
time. Saved changes and actual failures remain in the incomplete handoff.
User Stop remains separate from controller expiry.

These timers cannot preempt synchronous filesystem operations, and existing
file-approval and question waits retain their normal cancellation policy. An
adapter that ignores cancellation may continue computing, although its late
response is discarded. No hard wall-time or live speed improvement is claimed
from synthetic tests. Version `0.6.0-dev.15` receives its own two-task replay;
prior results remain separate, and six dev15 tasks remain unmeasured.


## Provider-compatible controller context

The request boundary coalesces adjacent plain assistant text into one wire
message. This preserves the full text and quoted data while avoiding chat
templates that reject consecutive assistant prefills. It does not promote
observations to user or system instructions. Tool calls, tool results, reasoning,
multipart content and unknown fields remain exact ordering boundaries.

Separators are included before context budgeting, and the final serialized shape
is also the shape shown in the request snapshot. The durable conversation keeps
the original separate observations. The dev9 provider-shape failure remains a
separate preserved result; synthetic compatibility checks and a small native
request are distinct from the two complete coding-job replays.


Trusted agent requests also add a fixed, labeled app response cue after trailing
plain assistant observations on the wire. This asks for an answer to the existing
request under the latest human scope and permissions. The cue grants no new
authority and never enters the durable human conversation, steering or tool
execution. Direct client calls retain intentional assistant-prefill behavior.

The cue shares the current request's context-budget group with its real
instructions and tool receipts. Its full token cost is counted before pruning;
context shortening cannot keep only the cue while dropping that current group.
Optional source admission uses the same normalized request and cue cost.


## Moving from inspection to a saved edit

An implementation turn can make one early focused-edit recovery for an explicitly
requested existing source file after a complete model-visible read. The
controller grants one further ordinary context-turn opportunity; the last
initial round may select the edit immediately. The original eight-round starting
cap and real-progress extensions remain. This bridges read-only preparation into
one requested edit rather than increasing the allowance for repeated inspection.

Only the known focused-edit schemas qualify. Literal requested paths, complete
packed read receipts, current work directory, role, stage, read bans and cached
protected aliases are checked before a bounded read-only metadata probe. The
recovery request offers only the exact selected focused-editor schema and
requires exactly one matching structured edit before normal read-before-write,
stale-plan, CAS and approval checks. Ordinary requests restore the complete
currently permitted catalog in its original order. Human steering or Stop invalidates it. Compound jobs still owe the other
requested changes and verification. Preloaded receipts retain their validated
requested-path geometry across operating-system canonical aliases.

A validated named file-write or focused-edit recovery can use its normal
configured response allowance, including a preliminary prose preface. The
ordinary 2400-character prose limit remains for other implementation responses;
normal model output tokens and controller time limits are unchanged. A response
with no structured operation, multiple operations or a wrong target is discarded.
Prose is never converted into a file operation. This makes room for a real later
tool call; an interrupted older response does not prove one would have followed.


## Primary response continuity and modern TypeScript modules

Crossing the work-to-verification priority boundary does not cancel an admitted
primary response. This avoids discarding a partial tool call solely because
that boundary passed. Stop and the hard handoff boundary still discard unfinished
responses atomically. Optional advisory/Laya work retains its earlier cutoff.
The normal model/token configuration, action validation, approvals and verification
evidence rules remain unchanged. Long primary generation can consume the
verification window; this policy does not guarantee a passing check or faster run.

Modern TypeScript `.mts` and `.cts` files receive the same conservative source
recognition, authored-assertion observations and ordinary syntax policy as `.ts`.
Syntax inspection strips types without executing source, parsing `.mts` as an ES
module and `.cts` as CommonJS. Unsupported tools/syntax remain unavailable; this
is not type checking, a module resolver or a behavioral test. Existing explicitly
requested API inspection remains import/callability-only.

Literal requested modern TypeScript paths and basename aliases retain their
normal generation allowance. While the optional limits remain active, new
unrequested assertion helpers retain the existing drafting guards. An authored check is reported as unexecuted until an
actual matching execution is observed. The extension never schedules a runner or
creates speculative runtime/test debt. The prior helper's lack of execution was
observed, but its extension omission was not proved to be the cause.


## Continuing after a rejected implementation response

A named implementation recovery still accepts exactly one matching operation
on the selected requested file. A wrong tool, different target, malformed
arguments or multi-call batch is rejected in full before dispatch. That rejected
response earns no file change, verification evidence or progress credit. The
one-shot recovery stays consumed and its round remains counted. When the
ordinary round and time limits permit, the controller can continue from an
explicit not-executed observation using the current stage and permissions.
It does not replay rejected arguments or grant another named recovery. Human
steering, Stop, read-before-write, stale-source checks, protections and approvals
remain authoritative. Exhausted limits still produce an honest incomplete
handoff.

The preserved dev12 replay scored 21/40 artifact points, with two incomplete
handoffs and zero verified completions. Weather stopped after a mismatching
recovery response; Markdown saved source but retained a wrapping defect and
never executed behavioral assertions. Its second helper was interrupted after
at most 11.628 seconds of tool streaming because the old timer included earlier
reasoning. These observations justify controller fixes; they do not establish
that an unfinished helper would have passed or that dev13 finishes either job.


## Context for submitted Python verification

A failed static, quoted Python stdin program can now receive a bounded excerpt
around the reported final traceback frame. The controller uses only the command
already submitted; it reads no source file and executes no new command. Dynamic
or ambiguous shell forms and uncertain line mappings receive no excerpt.
At most five neighboring lines are quoted with redaction and explicit truncation.

The excerpt is submitted program data, not an authoritative oracle. Conditional
guidance asks for independent expectations when the check was authored during
the task, while preserving user and protected checks and required coverage. A
compact reusable helper is suggested only where the current scope permits one.
Nothing is saved automatically and no runner or import is guessed. The original
failure, process status, permissions and verification debt remain unchanged.

The preserved dev13 replay scored 35/40 artifact points, with two incomplete
handoffs and zero verified completions. Weather passed all artifact checks but
ran out of time correcting erroneous self-check expectations; later checks were
unreached. Markdown repaired parser and wrapping defects but reached a missing
runtime binding in its consumer late in the run. These are two known regression
cases; neither the new diagnostics nor synthetic tests establish job completion.


## Early runtime-reference observations

After a successful eligible local source write, an optional bounded worker can
analyze the already-observed saved revision for unresolved runtime reads. Real
lexical scopes distinguish imports, parameters, closures and destructured locals.
Native TypeScript stripping is used only when available; type-only references
create no runtime bindings. Standard and platform globals are conservatively
exempted. An unresolved name can still be intentional or supplied by its host,
so findings are advisory observations, not a missing-import verdict.

The worker parses source without executing or importing project code, resolving
project dependencies or loading project configuration. Source size, findings,
checks per turn and worker time are bounded; cancellation remains authoritative.
Unsupported syntax, unavailable tools and exhausted analysis limits provide no
passing evidence. No import, argument, edit or verification command is guessed.

These observations add no verification debt, progress credit or pass, and do not
clear an existing failure. Actual source and consumer checks are still required.
The purpose is to surface binding questions before a late functional failure,
while preserving ordinary scope, stage, approvals and verification behavior.


## Verification drafting after observed implementation progress

The optional helper-draft limits remain available before implementation progress.
Once the app witnesses a successful authorized saved revision of an explicitly
requested existing code target, later verification helpers can use the normal
configured output and turn-time opportunity. The witness needs known original,
current and authorized-save hashes from existing caches, current positive scope,
and a non-helper, non-protected target in the same working directory. Unknown
metadata or creation baselines and helper-only changes do not qualify. Any human
steering conservatively removes this optimization for the turn. No file lookup
or new permission is inferred. Byte changes establish mutation, not correctness.

This exempts only optional 4096-character/45-second helper drafting limits. It
adds no output tokens, rounds, model calls, time, tool authority or verification
evidence. The normal 8192-token opportunity, hard585-second response cutoff, Stop,
approvals, source checks and actual failure debt remain. A larger helper may still
consume the remaining turn; a successful job or speed gain needs live evidence.

Failed-command summaries now retain the normalized exception cause rather than
selecting a success-looking stdout prefix. Raw process output and status remain
unchanged. Submitted-Python guidance first compares actual and expected values
with input data and the user contract; valid failures call for implementation
repair, and only demonstrated mistaken task-authored expectations can be changed
with a reason and preserved required coverage. User/protected checks remain
authoritative. No benchmark-specific values or fixes are supplied to the actor.

The preserved dev14 replay scored18/40, with two supported incomplete handoffs
and zero verified completions. Weather retained real grid-shape/longitude bugs;
its helper draft was interrupted after source edits. Markdown retained parser
and whitespace defects, and its custom verification helper was not executed.
Those results remain separate from dev15 and do not establish improvement.


## Possible custom verification helpers

A narrow optional cue can now recognize some task-authored-looking custom
JavaScript/TypeScript comparison-counter drivers without treating them as tests.
It is emitted only after an actual local authorized save with a matching current
cached body and syntax-pass hash, for an unrequested helper-like filename.
User-mentioned/protected aliases, explicit requested tests, known strong authored
assertions, exported libraries, ambiguous surfaces and unsupported/stale/failed
metadata receive no duplicate cue. The heuristic is deliberately incomplete.

The immediate note is conditional: if the file is intended for verification and
the current user scope permits, run it with an already available or declared
runner, or report the blocker. It supplies no command, executes nothing and
associates no execution result. A save or syntax parse is not behavioral proof.
At most four cues are emitted per turn, once per saved hash. Strong test-intent
classification, failure debt, permissions, rounds and all verification evidence
remain unchanged. No cue does not establish that a file is not verification.

## Concise handoff and historical execution observations (dev.16)

After a witnessed change to an explicitly requested existing source file, an
optional app note exposes the existing 2400-character ordinary prose limit.
When the task is ready, it requests at most four short sentences covering saved
changes, checks actually observed and remaining limitations. Pending work keeps
using permitted tools. This is formatting guidance, not readiness or test proof;
the existing response limits, fallback, model settings and deadline remain.

An observed failed assertion can receive the same balanced repair guidance
across languages: independently compare the observed value, expectation, inputs
and user contract before choosing a repair. Valid checks require a source fix.
Only a demonstrably mistaken expectation authored during the current task may
be corrected, with a stated independent derivation and preserved coverage.
User and protected checks remain authoritative. No check is automatically edited,
no command is constructed, and no verification debt is cleared by the advice.

The preserved dev.15 replay scored 35/40 in 1170.476 seconds. Weather passed its
frozen checks and executed native assertions, but its final report was lost to
a late retry. Markdown's final local helper passed while external integration
checks still found a styling defect. Neither case achieved autonomous completion.
These observations do not establish a dev.16 result or a speed improvement.

Historical authored-check execution results are retained separately from current
input coverage. Project-fingerprint drift alone does not establish that helper
bytes changed during execution. A successful run can carry a local uncertainty
caveat without an extra model reply only when the helper hash and cached known
source witness still match. A missing temporary helper requires the harness's
positive safe-retirement hash, never absence alone. Unknown dependencies and
project-wide coverage remain unverified. Unexecuted, failed, changed or known-stale
checks, malformed witnesses and blanket pass claims retain the existing reminder.
This creates no passing project result or new verification authority.

Deterministic incomplete handoffs omit an earlier raw host-command failure only
after a later real available success with the same full canonical arguments and
effective working directory. Different commands, directories, unknown metadata
and harness-only failures remain visible. This changes only summary selection: all
raw receipts, verification debt, loop signatures and completion status remain.

## Current working-directory guidance (dev.17)

For commands in the current workspace, code-job guidance and the actual lean
`host_run` description say to omit the optional `cwd`. An intentional different
directory still uses its exact observed path and the existing approval flow.
This is preventive wording only: no path is corrected or redirected, and no
preapproval filesystem probe, schema restriction or authority is added.
The preserved dev.16 replay scored 27/40 in 712.943 seconds with zero autonomous
completions; both jobs stopped after outside-directory typos were correctly
denied. That early failure is not a speed improvement. A dev.17 live result has
not been established by the guidance or synthetic checks.

## Selected edit schema during bounded recovery (dev.18)

Only the already-admitted existing-file edit recovery request offers the exact
selected builtin editor schema. Its one response still must match the authorized
target and pass normal CAS, scope, role, approval and Stop checks. Missing, duplicate
or unknown editor schemas send no bounded request. The full ordinary catalog is
never mutated; normal planning restores its current ordered tools. Missing-file
write recovery is unchanged. No model settings, response budget, rounds, time or
verification credit are added.

The preserved dev.17 run scored 16/40 with zero autonomous completions. Its weather
turn returned a different read operation to a named edit request while all tools
were offered; that response was correctly rejected, and the unchanged round cap
ended the turn. The parsed response is known, but raw provider SSE was not retained,
so no provider/API defect is asserted. Request-shape fixtures establish client
behavior only; a live dev.18 completion or speed result remains to be measured.

## Focused-edit diagnostic parity (dev.19)

A successful changed focused edit can return the same bounded, redacted removed-
source review already used by whole-file writes. It uses cached plan bytes only,
after the authorized atomic commit. Previous source must meet the existing
80000-byte eligibility; the existing helper retains its separate character,
line, hunk and excerpt bounds. No excerpts are emitted for denied, held, stale,
unchanged, binary or oversized prior source. Optional diagnostic failures preserve
the committed success receipt. This is quoted source context, not a regression
verdict, new authority, verification debt or additional model request.

The preserved dev.18 replay scored 32/40 in 1170.489 seconds with zero autonomous
completions. Weather lost a legacy behavior that its 58 passing local checks missed.
Markdown passed all 20 frozen checks but retained an overstrict authored assertion.
Diagnostic parity alone does not establish a dev.19 result or speed improvement.

## Reported assertion helper source (dev.19)

A failed direct Node assertion in a strong current-turn authored helper can
include quoted source at its reported stack positions. Source is reused from
the existing pre-execution snapshot behind a private token, and quoted only
while the helper hash remains unchanged. No new file read or project resolution
is performed. The selected assertion cause and exact known helper path must
match; changed, truncated, unavailable, malformed or stopped observations decline
this optional context.

Capture is limited to 80000 UTF-8 bytes and code units. Whole source and helper
metadata are redacted before clipping; ambiguous line geometry declines. At most
two reported frames and five source lines of 240 characters fit an 1800-character
quoted observation. These are reported source positions, not an innermost-frame
verdict, authoritative expected result, automatic oracle correction, new permission
or passing proof. Optional capture/format failures preserve the original result
and debt. The original helper source was already available; this adds emphasis
near the failure rather than recovering otherwise inaccessible information.

## Bounded verification opportunity (dev.20)

The preserved dev.19 replay scored 22/40 in 952.211 seconds with zero autonomous
completions. Weather saved source changes, used its remaining rounds on reads,
and forced a tool-free closeout without running a behavioral command, despite
substantial time remaining. Markdown received the new assertion context and
identified a real whitespace defect, but did not repair it before the deadline.

After ordinary progress extensions are exhausted, a local implementation turn
can receive one separate allowance of at most two tool rounds. Eligibility
requires current cached byte changes to explicitly requested source, no open
action debt, no recorded model `host_run` at all, the original workspace and
permitted implementation stage, and at least 30 seconds before the existing
handoff boundary. Even a discovery or version command disables this conservative
fallback; it does not infer a command's verification intent. Unknown metadata,
unsupported schemas, unavailable time and human steering decline the allowance.
An explicit instruction to avoid execution also vetoes this optional allowance,
including requests that permit edits while forbidding tests or commands.

The first request offers exactly the current recognized `host_run` schema and
requires one current-workspace command. The model supplies the command; the
controller supplies no runner, expected values or project-specific answer.
Wrong-tool, multiple-call, malformed or stale responses are rejected before
dispatch. The next admitted round restores the ordinary current ordered catalog.
The allowance cannot be replenished by reads, new proof or further edits. Its
remaining admission is withdrawn if human steering invalidates the request.

This changes controller round scheduling, within the existing 60-round ceiling.
It retains the model profile, output budget, approvals, command cleanup, Stop,
585-second primary window and 600-second total development replay deadline.
The allowance itself grants no progress, passing evidence or task completion.
It cannot guarantee correct generated code or make the model generate faster;
live replay results remain separate from deterministic regression tests.
