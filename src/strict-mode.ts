/**
 * Strict concurrency mode – opt-in warnings for unstructured async,
 * ignored cancellation, and tasks surviving scope exit.
 */

let strictModeEnabled = false;
let onWarnCallback: ((message: string) => void) | undefined;

/**
 * Options for {@link enableStrictMode}. When `onWarn` is provided, it is called
 * for each strict-mode warning instead of `console.warn`, so tests or loggers can capture warnings.
 */
export type StrictModeOptions = {
  /** When provided, called for each warning instead of `console.warn`. */
  onWarn?: (message: string) => void;
};

/**
 * Enables opt-in strict concurrency checks for the process. When enabled, the library
 * emits warnings for detectable misuse: async work started outside any scope (unstructured async),
 * tasks canceled without cancellation handling (e.g. no `onCancel`), and tasks still running
 * when their scope exits (orphans). When not enabled, no strict-mode checks run and behavior
 * is unchanged. Call once at startup or in tests; does not change runtime semantics beyond warnings.
 *
 * @param options - Optional. Use `onWarn` to capture warnings in tests or send to a logger instead of `console.warn`.
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
 * Emits a strict-mode warning: calls the configured onWarn callback if set, otherwise console.warn.
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
}
