import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const common = ["decision-service", "decision-adviser", "decision-adviser-production", "decision-local-ipc", "decision-assets", "decision-local", "decision-runtime-build", "decision-setup-ui", "models", "model-catalog", "model-history", "terminal", "approvals", "conversation", "hnl-turn", "helper-context", "context", "context-info", "request-budget", "model-settings", "provider-capacity", "provider-usage", "provider-stream", "provider-message-shape", "agent-policy", "repair-rerun", "source-scope", "source-scope-production", "turn-budget", "turn-budget-production", "verification-opportunity", "verification-opportunity-production", "node-verification-context", "command-diagnostics", "submitted-python-context", "python-failure-context-production", "failed-command-handoff", "handoff-failure", "command-cwd-default", "assertion-repair-guidance", "handoff-format", "handoff-format-production", "requested-source-progress", "requested-source-witness", "scratch-after-source-progress", "possible-verification-helper", "possible-verification-helper-production", "runtime-reference", "runtime-reference-production", "compiler-evidence", "shell-verification", "file-edit", "focused-mutation-review", "focused-mutation-review-production", "thought-recovery", "test-exit-evidence", "current-closeout", "action-debt", "source-visibility", "authored-checks", "authored-receipts", "reported-helper-assertion", "reported-helper-assertion-production", "authored-receipts-production", "mutation-review", "source-preload", "source-preload-production", "new-path-probe", "scratch-draft-budget", "scratch-production", "scratch-run-recovery", "scratch-run-production", "scratch-draft-duration", "scratch-duration-production", "contract-review", "contract-review-production", "implementation-recovery", "implementation-recovery-production", "existing-edit-recovery", "focused-recovery-catalog", "focused-recovery-catalog-production", "existing-edit-recovery-production", "primary-response-budget", "modern-typescript", "recovery-continuation", "scratch-helper-clock", "turn-routing", "runtime-lazy", "session-history", "session-history-integration", "tool-catalog", "cli-control", "streaming", "processes", "dependencies", "channels", "main-profile", "verification", "harness-requirements", "harness-checks", "projects", "project-knowledge", "checkpoints", "recovery-points", "subagent", "analysis", "network", "ghidra-skill", "split", "goal", "laya-steer", "install", "first-launch", "first-launch-abuse", "security-redirects", "board", "crew", "materials", "serve", "voice", "console", "windows", "release", "release-privacy", "company-signing", "updater-config"];
const suites = process.platform === "win32" ? common : [...common, "engine"];
for (const suite of suites) {
  const home = mkdtempSync(join(tmpdir(), "nova-test-"));
  console.log(`\n=== ${suite} ===`);
  try {
    const result = spawnSync(process.execPath, [`scripts/test-${suite}.mjs`], {
      stdio: "inherit", env: { ...process.env, NOVAPUP_HOME: home }, timeout: 120_000,
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exitCode = 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
if (process.platform === "darwin") {
  const signing = spawnSync(process.execPath, ["scripts/test-mac-sign-filter.mjs"], { stdio: "inherit", timeout: 120_000 });
  if (signing.error) console.error(signing.error.message);
  if (signing.status !== 0) process.exitCode = 1;
  const result = spawnSync("python3", ["scripts/test-mac-archives.py"], { stdio: "inherit", timeout: 120_000 });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exitCode = 1;
}
