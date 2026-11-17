# Optional decision adviser

Nova Collar can ask a separate native `/decisions` service for one suggested next step after an actual failed local command in an active coding turn. This feature is disabled by default. It does not replace the existing local Laya models, select tools, execute actions, grant approvals, change the user's scope, or decide whether work is complete. The lead model and deterministic harness retain those responsibilities.

Create `decision-adviser.json` in the current Nova Collar profile to enable it. The installed app uses its normal owner profile; source previews use the existing profile-path rules. No existing environment file or routing settings are rewritten.

```json
{
  "enabled": true,
  "model": "laya",
  "endpoint": "http://127.0.0.1:8188/decisions",
  "timeoutMs": 30000,
  "maxPerTurn": 1
}
```

Use the exact native decision endpoint of a service on hardware you control. If `endpoint` is omitted, Nova Collar appends `/decisions` to the configured chat base URL. The configured chat key is reused only for the same URL origin. A different non-loopback origin requires HTTPS and an explicit `apiKeyEnv` setting naming an existing environment variable; its value is never placed in this JSON file. An explicit loopback service can be unauthenticated. Endpoint credentials, query strings and redirects are rejected. Invalid or missing settings leave the optional feature unavailable.

There is at most one adviser attempt per lead turn, with no retry or fallback. The existing turn budget can skip or cancel it; Stop cancels it. A timeout or unavailable service lets the lead continue. Helpers, phone/remote surfaces, held tools, and review-only work do not request this failure advice. A later mutation, a passing rerun of the same command, a workspace change, or actual owner guidance supersedes queued advice. Command receipts from a different working directory are excluded.

Only currently available next-step categories are offered: inspect source, repair check setup, repair code, retest, delegate when a helper is available, or escalate. Completion is not an adviser action. The lead receives a single explicitly untrusted user-role observation containing the selected category. Model scores, service identity, raw replies, and arbitrary instructions are not inserted. This observation does not invoke the human-steering path and provides no verification credit. A separate `decision_advice` event contains only bounded status, category, reason and timing metadata.

The request contains the actual current task, the failed command's bounded output, and excerpts of relevant source already observed during this turn. It never indexes a profile or corpus or reads additional source bodies. Source snapshots are limited to recognized project source files inside the current working directory; owner profiles, symlink aliases into profiles, secret/credential files and outside paths are excluded. Configured key/token values and common credential patterns are redacted before transmission. Oversized task/state is skipped rather than silently shortening the task. Excerpt omissions are marked.

Source hashes and the post-response freshness token describe cached native observations. They do not prove that another process has left the filesystem unchanged while advice is in flight, and no new filesystem verification is claimed. The existing harness still checks actual source revisions and required evidence. Keep the service on trusted owner-controlled infrastructure: any explicitly configured adviser receives the redacted task and quoted diagnostic/source excerpts.

Disable the feature by setting `enabled` to `false` or removing this settings file. No service or model is started by this integration.

Focused offline checks:

```sh
node --test scripts/test-decision-service.mjs scripts/test-decision-adviser.mjs scripts/test-decision-adviser-production.mjs
```

These checks use synthetic profiles and mocked model responses with real local tool execution and harness state. They require no live model, training job or production service.
