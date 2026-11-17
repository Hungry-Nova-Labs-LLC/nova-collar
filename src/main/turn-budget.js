// Caller deadlines are trusted API metadata, never inferred from user text or
// AbortSignal internals. Timers limit asynchronous work; synchronous filesystem
// calls can still delay the event loop and are not claimed to be preemptible.
const ownedErrors = new WeakSet();
export const DEFAULT_CODING_BUDGET_MS = 600_000;
// Model size is not evidence of a local endpoint. Honor the configured local
// route, or an actual loopback URL used by a custom compatible provider.
export function localBudgetTargets(targets) {
  return Array.isArray(targets) && targets.length > 0 && targets.every(target => {
    if (target?.local === true) return true;
    try {
      const url = new URL(target?.url);
      return ["http:", "https:"].includes(url.protocol)
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    } catch { return false; }
  });
}

export class TurnBudgetError extends Error {
  constructor(phase, reason = "phase_expired") {
    super("The turn's reserved " + phase + " time has ended.");
    this.name = "TurnBudgetError";
    this.phase = phase;
    this.reason = reason;
    ownedErrors.add(this);
  }
}
export const isTurnBudgetError = error => Boolean(error && ownedErrors.has(error));
const abortError = signal => {
  if (signal?.reason?.name === "AbortError") return signal.reason;
  const error = new Error("Stopped."); error.name = "AbortError"; return error;
};
const duration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function createTurnBudget({ budgetMs, deadlineAt, defaultEnabled = false,
  startedAt = performance.now(), wallStartedAt = Date.now(),
  now = () => performance.now() } = {}) {
  const explicit = budgetMs !== undefined || deadlineAt !== undefined;
  const enabled = explicit || defaultEnabled;
  let known = Number.isFinite(startedAt) && Number.isFinite(wallStartedAt);
  const limits = [];
  if (budgetMs !== undefined) { if (duration(budgetMs)) limits.push(budgetMs); else known = false; }
  if (deadlineAt !== undefined) {
    if (duration(deadlineAt)) limits.push(Math.max(0, deadlineAt - wallStartedAt)); else known = false;
  }
  if (!explicit && defaultEnabled) limits.push(DEFAULT_CODING_BUDGET_MS);
  const totalMs = limits.length ? Math.min(...limits) : 0;
  // Eight seconds before a hard deadline is already handoff time. For a full
  // ten-minute turn this leaves 435s implementation + 150s verification + 15s.
  const handoffMs = Math.min(15_000, totalMs);
  const verificationMs = Math.min(150_000, totalMs * 0.25, totalMs - handoffMs);
  const workEndMs = totalMs - handoffMs - verificationMs;
  const verificationEndMs = totalMs - handoffMs;
  let last = startedAt, disposed = false;
  const active = new Set();
  function snapshot() {
    if (!enabled) return { enabled: false, known: true, phase: "unlimited", elapsedMs: null, remainingMs: null, phaseRemainingMs: null };
    let value;
    try { value = now(); } catch { known = false; }
    if (!Number.isFinite(value) || value < last) known = false;
    if (Number.isFinite(value)) last = Math.max(last, value);
    if (!known || disposed) return { enabled: true, known: false, phase: "handoff", elapsedMs: null, remainingMs: null, phaseRemainingMs: 0 };
    const elapsedMs = Math.max(0, value - startedAt), remainingMs = Math.max(0, totalMs - elapsedMs);
    const phase = elapsedMs < workEndMs ? "work" : elapsedMs < verificationEndMs ? "verification" : "handoff";
    return { enabled: true, known: true, phase, elapsedMs, remainingMs,
      phaseRemainingMs: Math.max(0, (phase === "work" ? workEndMs : phase === "verification" ? verificationEndMs : totalMs) - elapsedMs),
      totalMs, workMs: workEndMs, verificationMs, handoffMs };
  }
  function admission({ optional = false } = {}) {
    const state = snapshot();
    if (!state.enabled) return state;
    if (state.phase === "handoff" || (optional && (state.phase !== "work" || state.phaseRemainingMs < 60_000))) {
      throw new TurnBudgetError(state.phase, state.known ? "reserved_handoff" : "clock_unavailable");
    }
    return state;
  }
  async function run(operation, { signal, optional = false, settle = false, verification = false } = {}) {
    if (signal?.aborted) throw abortError(signal);
    let state = admission({ optional });
    // A declared/recognized verification already admitted during implementation
    // may use its reserved check window rather than being killed at work-end.
    if (state.enabled && verification) state = { ...state, phase: "verification",
      phaseRemainingMs: Math.max(0, verificationEndMs - state.elapsedMs) };
    if (!state.enabled) return operation({ signal, timeoutMs: undefined });
    const controller = new AbortController();
    const stop = () => controller.abort(abortError(signal));
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const phaseEnd = state.elapsedMs + state.phaseRemainingMs;
    let timer;
    const expire = () => {
      const current = snapshot(), left = phaseEnd - current.elapsedMs;
      // setTimeout may wake early. Do not discard verification reserves merely
      // because a fractional millisecond was rounded down by the timer API.
      if (current.known && left > 0) {
        timer = setTimeout(expire, Math.max(1, Math.min(2_147_483_647, Math.ceil(left))));
      } else controller.abort(new TurnBudgetError(state.phase, current.known ? "phase_expired" : "clock_unavailable"));
    };
    const delay = Math.max(1, Math.min(2_147_483_647, Math.ceil(state.phaseRemainingMs)));
    timer = setTimeout(expire, delay);
    let rejectAbort;
    const cancelled = new Promise((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    // A command must finish its existing executor cleanup before its receipt is
    // recorded. Model responses may be discarded atomically on cancellation.
    const call = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation({ signal: controller.signal, timeoutMs: delay });
    });
    call.catch(() => {}); cancelled.catch(() => {});
    active.add(controller);
    try {
      const value = await (settle ? call : Promise.race([call, cancelled]));
      if (signal?.aborted) throw abortError(signal);
      if (!settle && controller.signal.aborted) throw controller.signal.reason;
      // Even if the event loop postponed a timer, a late buffered response is
      // never admitted or dispatched after its phase boundary.
      if (!settle) {
        const current = snapshot();
        if (!current.known || current.elapsedMs >= state.elapsedMs + state.phaseRemainingMs) throw new TurnBudgetError(state.phase);
      }
      return value;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer); active.delete(controller);
      signal?.removeEventListener("abort", stop);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
  return { snapshot, admission, run,
    optionalAvailable() { try { admission({ optional: true }); return true; } catch { return false; } },
    dispose() { disposed = true; for (const controller of active) controller.abort(new TurnBudgetError("handoff", "disposed")); active.clear(); } };
}

export function turnBudgetHint(state) {
  if (!state.enabled || state.phase === "handoff") return "";
  const seconds = Math.max(0, Math.floor(state.remainingMs / 1000));
  return `<turn_time_budget>\nController time observation: ${seconds}s remain; phase=${state.phase}. `
    + (state.phase === "verification" ? "Prioritize compact behavioral checks of the current saved changes, preservation of requested behavior, and an honest handoff. Avoid expanding scratch-helper authoring. " : "Reserve time for compact verification and the final handoff. ")
    + "This changes priority only, not the user's task, scope, tool permissions or approval requirements. Syntax/import proof alone is not a behavioral test. Do not invent or guess a test command. Report missing or failing verification accurately.\n</turn_time_budget>";
}
