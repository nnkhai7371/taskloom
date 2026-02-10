/**
 * Opinionated dev helpers: sleep, timeout, retry. Use only Node built-ins; respect AbortSignal and scope.
 */

import {
  getCurrentScopeStorage,
  getScopeDeadlineRemainingMs,
  runWithScopeStorage,
} from "./scope.js";

/**
 * Scope-bound delay: resolves after `ms` ms or rejects if the scope's signal aborts first.
 * Timer is cleared on abort to avoid leaks. Use with the current scope's AbortSignal.
 * @param ms - Delay in milliseconds
 * @param signal - AbortSignal (e.g. scope.signal); when aborted, the Promise rejects and the timer is cleared
 * @returns Promise that resolves after the delay or rejects with the signal's reason on abort
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = (): void => {
      clearTimeout(id);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * Factory for task.sleep: returns a function that sleeps for the given ms using the bound signal.
 * Bound to the current scope's signal so cancellation aborts the sleep.
 */
export function createSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms: number) => sleep(ms, signal);
}

/** Scope-like type for timeout: needs signal and abort so that expiry can cancel children. */
export type ScopeLike = { readonly signal: AbortSignal; abort(): void };

/**
 * Runs async work with a time limit. If work completes within the effective limit, returns its result.
 * If the limit elapses first, aborts the scope (canceling all scope-bound children) and rejects with a TimeoutError.
 * When the current scope has a deadline (timeout budget), the effective limit is min(ms, remainingMs).
 * When entering work, the scope storage's deadline is set to Date.now() + effectiveMs so nested task.timeout and primitives see the capped budget.
 * Timer is always cleared (on completion, timeout, or signal abort) to avoid leaking the sleep listener.
 * @param ms - Time limit in milliseconds
 * @param work - Async work to run
 * @param scope - Scope to abort on timeout (cancels children)
 * @param signal - AbortSignal for the timeout timer; when scope aborts, timer is cleared
 * @returns Promise with the work result, or rejects on timeout/abort
 */
export async function runWithTimeout<T>(
  ms: number,
  work: () => Promise<T>,
  scope: ScopeLike,
  signal: AbortSignal,
): Promise<T> {
  const remainingMs = getScopeDeadlineRemainingMs();
  const effectiveMs =
    remainingMs != null
      ? Math.min(ms, Math.max(0, remainingMs))
      : ms;

  const timeoutError = new Error(`Timeout after ${effectiveMs} ms`);
  (timeoutError as { name?: string }).name = "TimeoutError";

  let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      scope.abort();
      reject(timeoutError);
    }, effectiveMs);
  });

  const onAbort = (): void => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  };
  signal.addEventListener("abort", onAbort);

  const runWork = (): Promise<T> => {
    const store = getCurrentScopeStorage();
    if (store != null) {
      const deadlineMs = Date.now() + effectiveMs;
      return runWithScopeStorage({ ...store, deadlineMs }, work);
    }
    return work();
  };

  try {
    return await Promise.race([runWork(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Factory for task.timeout: returns a function that runs work with a time limit.
 * Bound to the current scope so that on expiry the scope is aborted and children are canceled.
 */
export function createTimeout(
  scope: ScopeLike,
  signal: AbortSignal,
): <T>(ms: number, work: () => Promise<T>) => Promise<T> {
  return <T>(ms: number, work: () => Promise<T>): Promise<T> =>
    runWithTimeout(ms, work, scope, signal);
}

/** Backoff strategy between retry attempts: fixed delay or exponential. */
export type RetryBackoff = "fixed" | "exponential";

/**
 * Options for task.retry. All attempts run in the same scope; scope abort stops retries and rejects.
 * @property retries - Number of retry attempts after the first failure (total attempts = 1 + retries)
 * @property backoff - 'fixed' (same delay each time) or 'exponential' (delay doubles each time)
 * @property initialDelayMs - Delay in ms before first retry; also base for fixed backoff (default 50)
 */
export type RetryOptions = {
  retries: number;
  backoff?: RetryBackoff;
  initialDelayMs?: number;
};

const DEFAULT_INITIAL_DELAY_MS = 50;

/**
 * Runs async work with retries. On failure, retries up to options.retries times with optional backoff between attempts.
 * Respects the scope's AbortSignal: if aborted during a delay or attempt, stops and rejects with the signal's reason.
 * @param fn - Async function to run (attempted until success or retries exhausted)
 * @param options - RetryOptions (retries, backoff, optional initialDelayMs)
 * @param signal - AbortSignal; when aborted, retry stops and rejects
 * @returns Promise with the first successful result, or rejects with last error / signal reason
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  signal: AbortSignal,
): Promise<T> {
  const { retries: maxRetries, backoff = "fixed", initialDelayMs = DEFAULT_INITIAL_DELAY_MS } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal.aborted) {
      throw signal.reason;
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === maxRetries) {
        throw e;
      }
      const delayMs =
        backoff === "exponential"
          ? initialDelayMs * Math.pow(2, attempt)
          : initialDelayMs;
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

/**
 * Factory for task.retry: returns a function that retries async work with the given options.
 * Bound to the current scope's signal so scope cancellation stops retries and rejects.
 */
export function createRetry(signal: AbortSignal): <T>(
  fn: () => Promise<T>,
  options: RetryOptions,
) => Promise<T> {
  return <T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> =>
    retry(fn, options, signal);
}
