# Nova Tag behavior in public Nova Collar

The user authorized Nova Tag as a source for this iteration. The archived
private Collar application remains a separate reference; its code and assets
are not included. The baseline is the existing public methodology branch at
`d129b9f`.

## Integrated behavior

- **Capacity and observed progress:** adapted from Tag's `src/agent/capacity.js`
  and OpenAI provider helpers. Retries stay on the selected model, honor
  Retry-After and share a finite wait budget. Stop cancels waiting. Quota,
  billing, authentication and partial-stream failures are not replayed as
  capacity errors. Queue positions come only from validated provider metadata.
  Admission does not establish that GPU generation has begun.
- **Explicit model settings:** follows Tag's per-model configuration boundary.
  An optional versioned `model-settings.json` in the current public profile
  scopes context, output, temperature and reasoning settings to one exact
  endpoint/model pair. No routes, credentials or preferred model ship in this
  source. Existing defaults remain when no matching profile is configured.
- **Reported usage:** requests provider usage and keeps validated counters
  separate from local token estimates. Missing provider counters stay missing.
- **Turn behavior:** the actual lead request receives Tag-inspired instructions
  for concise progress, continuing after steering, respecting review/discussion
  requests and using only tools actually offered by the application.
- **Exact local context recall:** inspired by Tag's session archive and
  `context_recall`. New turns append redacted user/assistant text and model
  tool receipts to a current-profile, current-chat archive before session
  trimming. Stable IDs and hashes allow bounded search/pagination. Other
  profiles, arbitrary files and private reasoning cannot be recalled. Legacy
  data already discarded before this feature cannot be recovered.

Archives are bounded (32 MiB per chat, 20,000 entries, 2 MiB per entry), with
hash-chain and committed-head checks. Corruption or writer conflicts fail
explicitly. A crashed writer lock requires controlled maintenance while all
writers are stopped; it is not silently removed. Existing JSON sessions remain
compatible. Optional model-only clipping does not replace the durable source.

The desktop shows an explicit archive warning when an append cannot be committed.
Chat can continue, but older context recall must not be assumed complete.

These features use local files and ordinary configured inference endpoints.
They do not index a document corpus or select an embedding provider.

## Desktop integration

The new workspace displays actual waiting, queue, admission, retry and token
activity states. It hides raw thought text, does not invent percentages and
runs its elapsed-time timer only while relevant activity is visible. Pending
questions, saved input and Stop/Continue retain priority.

The public analysis/network SDK is loaded only when those tools connect.
Ordinary file/chat startup does not import it. Actual analysis/network use
still requires the SDK and the existing platform/tool setup.

Task relevance guides initial tool disclosure. Execution checks the permitted
catalog, the schemas offered for that request, and normal approvals. A keyword
inside a negative constraint cannot independently veto a disclosed tool. Provider
streams consume a final line without a newline and require a terminal marker or
finish reason; a broken connection cannot turn partial output into success.

## Model-settings example

Create this file in the private application profile, not the repository:

```json
{
  "version": 1,
  "profiles": [{
    "url": "http://127.0.0.1:1234/v1",
    "model": "your-installed-model",
    "contextTokens": 131072,
    "outputTokens": 8192,
    "temperature": 0,
    "reasoning": true
  }]
}
```

The values must match the actual server's limits. An optional reasoningEffort
accepts low, medium, high, xhigh or max where the provider supports it. Profile
settings do not authorize another model, endpoint, fallback or remote provider.
Local context/output profile matching is verified. In this preview, a remote
catalog's context value takes precedence over a lower profile contextTokens;
using a profile to cap remote catalog context remains a follow-up.

## Scope of verification

Focused fixtures cover retry/cancellation/progress, model-budget matching,
provider counters, archive integrity/recall and lazy runtime connections.
Real Electron fixtures cover the main/preload/agent and desktop controls.
Live coding evaluations are separate from these deterministic harness tests;
a passing fixture is not a model-quality score.
