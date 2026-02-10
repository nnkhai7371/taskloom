/**
 * Strict concurrency mode – opt-in checks that throw when misuse is detected:
 * unstructured async, ignored cancellation, and tasks surviving scope exit.
 */

let strictModeEnabled = false;
let onWarnCallback: ((message: string) => void) | undefined;

/**
 * Error thrown when strict mode is enabled and misuse is detected (unstructured async,
 * ignored cancellation, orphan tasks, or branch without parent scope).
 */
export class StrictModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictModeError";
    Object.setPrototypeOf(this, StrictModeError.prototype);
  }
}

/**
 * Options for {@link enableStrictMode}. When `onWarn` is provided, it is called
 * with the message before throwing, so tests or loggers can capture the violation.
 */
export type StrictModeOptions = {
  /** When provided, called with the violation message before the library throws. */
  onWarn?: (message: string) => void;
};

/**
 * Enables opt-in strict concurrency checks for the process. When enabled, the library
 * throws {@link StrictModeError} for detectable misuse: async work started outside any scope (unstructured async),
 * tasks canceled without cancellation handling (e.g. no `onCancel`), tasks still running
 * when their scope exits (orphans), or branch used without a parent scope. When not enabled,
 * no strict-mode checks run and behavior is unchanged. Call once at startup or in tests.
 *
 * @param options - Optional. Use `onWarn` to capture the violation message before the throw (e.g. for logging or tests).
 */
export function enableStrictMode(options?: StrictModeOptions): void {
  strictModeEnabled = true;
  onWarnCallback = options?.onWarn;
}

/** Internal use for tests only; not part of public API. */
export function disableStrictMode(): void {
  strictModeEnabled = false;
  onWarnCallback = undefined;
}

/**
 * Returns whether strict mode is currently enabled. Used by scope/task/primitive code to decide whether to run strict checks.
 * @internal
 */
export function isStrictModeEnabled(): boolean {
  return strictModeEnabled;
}

/**
 * When strict mode is on, calls onWarn (if set) then throws {@link StrictModeError} with the message.
 * No-op when strict mode is off. Used internally when misuse is detected.
 * @internal
 */
export function strictModeWarn(message: string): void {
  if (!strictModeEnabled) return;
  if (onWarnCallback) {
    onWarnCallback(message);
  } else {
    console.warn(message);
  }
  throw new StrictModeError(message);
}
