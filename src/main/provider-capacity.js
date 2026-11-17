// Adapted from Nova Tag (Hungry Nova Labs), Apache-2.0.
/** Capacity waiting is separate from model failure and never selects a model. */
const CAPACITY_CODES = new Set(["queue_timeout", "queue_full", "server_draining", "capacity_wait_exhausted",
  "rate_limit_exceeded", "rate_limit_error", "rate_limited", "too_many_requests", "concurrency_limit_exceeded"]);
const TERMINAL_CODES = new Set(["budget_exceeded", "insufficient_quota", "quota_exceeded", "spend_limit_exceeded",
  "billing_hard_limit_reached", "credit_balance_too_low", "credits_exhausted", "account_deactivated", "account_disabled",
  "invalid_api_key", "authentication_error", "permission_denied", "unauthorized", "forbidden"]);

export function isTerminalProviderError(error) {
  return TERMINAL_CODES.has(String(error?.code || "").toLowerCase()) || [401, 403].includes(error?.status);
}

export function isCapacityError(error) {
  if (isTerminalProviderError(error)) return false;
  const code = String(error?.code || "").toLowerCase();
  return CAPACITY_CODES.has(code) || (!code && error?.status === 429 && error?.retryable !== false);
}

export function waitForCapacity(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new DOMException("Aborted", "AbortError")); return; }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason || new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** One finite budget for capacity retries and observed admission waiting.
 * It bounds capacity retries, never aborts an admitted model's active prefill. */
export class CapacityWait {
  constructor(settings = {}, { now = Date.now, random = Math.random, sleep = waitForCapacity } = {}) {
    const cfg = settings.capacity || {};
    this.now = now; this.random = random; this.sleep = sleep;
    this.startedAt = now();
    this.deadline = this.startedAt + Math.max(1, Number(cfg.maxWaitMs) || 180000);
    this.baseDelayMs = Math.max(1, Number(cfg.baseDelayMs) || 2000);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(cfg.maxDelayMs) || 30000);
    this.attempts = 0;
  }

  exhausted(error) {
    return Object.assign(new Error("Generation capacity is still busy. Retry when capacity is available."), {
      code: "CAPACITY_WAIT_EXHAUSTED", status: error?.status || 429,
      retryable: true, retryAfterMs: error?.retryAfterMs || 0, cause: error,
    });
  }

  async run(task, { signal, onRetry } = {}) {
    let previous = this.lastCapacityError;
    for (;;) {
      signal?.throwIfAborted();
      if (previous && this.now() >= this.deadline) throw this.exhausted(previous);
      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let queueTimer, admittedAt, accounted = false;
      const finish = () => {
        clearTimeout(queueTimer);
        if (!accounted && admittedAt !== undefined) this.deadline += Math.max(0, this.now() - admittedAt);
        accounted = true;
      };
      const observe = (event) => {
        if (event.state === "admitted") {
          clearTimeout(queueTimer);
          admittedAt ??= this.now();
        } else if (event.state === "queued" && admittedAt === undefined && !queueTimer) {
          // Only an explicit queue observation permits a capacity cancellation.
          // Silence, keepalives and reasoning never start this timer.
          this.lastCapacityError = { code: "queue_timeout", status: 429 };
          const remaining = Math.max(0, this.deadline - this.now());
          queueTimer = setTimeout(() => controller.abort(this.exhausted({ code: "queue_timeout", status: 429 })), remaining);
        }
      };
      try { return await task(requestSignal, observe); }
      catch (error) {
        finish();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (signal?.aborted || !isCapacityError(error) || error.code === "CAPACITY_WAIT_EXHAUSTED") throw error;
        if (error.retryable === false) throw error;
        previous = this.lastCapacityError = error;
        const remaining = this.deadline - this.now();
        if (remaining <= 0) throw this.exhausted(error);
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(20, this.attempts++));
        const jittered = Math.ceil(exponential * (0.75 + Math.max(0, Math.min(1, this.random())) * 0.5));
        const delay = Math.min(remaining, Math.max(jittered, Number(error.retryAfterMs) || 0));
        onRetry?.({ code: error.code || "rate_limited", waitMs: delay, attempt: this.attempts });
        await this.sleep(delay, signal);
      } finally {
        // Active computation has its own deadline, independent of capacity.
        finish();
      }
    }
  }
}
