# Coordinated local recovery

Owner chat turns now save a recovery boundary before dispatch and bind it to the finished turn's local file checkpoint, goal, inference history and dated verification state. This uses the existing local profile. It does not upload a conversation, add a hosted service, change a model or configure a provider's KV cache.

Open **Recovery** in the workspace header, or use the console:

```text
/recovery
/recover recovery-<id>
/recovery-operations
/recovery-ack <operation-id> <what you manually inspected>
```

Selecting a point restores the recorded local file changes since that boundary and opens a new chat branch. The original chat, append-only action archive and file journals remain available. It never submits the old request or starts a tool. A recovered branch keeps later tool IDs, exact arguments and recorded results in a bounded active context packet, so ordinary history clipping cannot silently hide possible external side effects. Later actual owner guidance, question answers and the current standing goal are carried forward too. App-generated model context is excluded from that human-guidance packet; oversize guidance blocks recovery rather than being silently dropped.

The Recovery window displays dated recorded checks, unfinished checks or **not verified**. A point with no failed checks is not automatically a tested working state. Restored branches require fresh verification; historical passes become pending obligations.

## Restore boundaries

The complete checkpoint range is preflighted before the first file write. Current bytes, modes, canonical paths, intermediate revisions, predecessor continuity, manifest checksums and stored object hashes must match. Every later recovery record must have its expected file journal present. Later owner edits, moved/symlinked paths, missing/corrupt backups, unfinished action receipts, incomplete capture or undeclared checkpoint journals stop coordinated recovery. Active leads, commands, scheduled work and paused input also block it. Each file replacement is atomic; a multi-file restore is not a filesystem transaction.

Before changing files, recovery persists an operation receipt. If it stops part way through, that prepared/partial/incomplete receipt blocks new model work and further recovery in the affected session or overlapping workspace. Its reverse journal includes only successfully committed recovery mutations, with the exact recovery-written after-state. Rejected/untouched paths and later owner edits never become authorized targets for undo. Inspect the current files and receipt, perform any required manual repair, then explicitly record an inspection note. Acknowledgement does not certify successful restoration, restore more files or rerun an action. It pins an audit warning and requires fresh checks.

Coverage is the existing file-tool and declared shell paths. Arbitrary undeclared shell writes, non-file side effects, databases, remote machines, services, emails and provider caches are outside rollback coverage. Shell receipts are preserved, but their output is not proof that every possible external effect is known. Inspect current external state before attempting work again. An interrupted tool outcome or a later receipt packet too large to carry safely blocks coordinated restore; file-only `/undo` retains its separate scope and current conversation.

A process crash before the file journal finishes can leave a started recovery record. It is retained as incomplete evidence and cannot be selected as a completed restore point. This feature does not promise crash-consistent rollback of unrecorded file changes.

## Storage limits

Recovery records are private, checksummed and atomically replaced with a durable write. Each record is at most 2 MiB; each restore covers at most 500 journals/files and a 100 MiB preflight budget. Active later receipt context is at most 12 KiB, with at most 20 KiB including inherited recovery warnings. Oversize state is explicitly unavailable, not silently truncated into a supposedly complete point.

Only the newest 100 completed coordinated point copies per chat are retained. Started/incomplete points are not pruned; original conversations, append-only history and content-addressed file journals are not deleted by this retention policy. A bounded metadata scan fails closed if incomplete records accumulate beyond the index limit.

## Validation

`node --test scripts/test-recovery-points.mjs scripts/test-checkpoints.mjs scripts/test-session-history-integration.mjs scripts/test-session-history.mjs scripts/test-conversation.mjs scripts/test-verification.mjs`

The recovery tests cover a production `runTurn` with a synthetic provider, multi-turn restoration of edits/additions/deletions, all-file preflight, conflicts and symlink changes, active ownership, unknown outcomes, corruption and missing coverage, an injected mid-restore conflict, durable dispatch blocking and explicit acknowledgement, bounded retention, original-history preservation and pinned action receipts. They perform no live inference or network calls. The workspace Electron fixture exercises inert point rendering, explicit restore, conflict reporting without automatic retry and new-branch rendering.
