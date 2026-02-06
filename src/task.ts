/**
 * Task – async computation with lifecycle, cancellation, and cleanup.
 * Awaitable but not a Promise; supports AbortSignal and onCancel.
 */

import { registerTask, updateTask } from "./debug.js";
import { hasCurrentScope, registerScopeTask } from "./scope.js";
import { isStrictModeEnabled, strictModeWarn } from "./strict-mode.js";

/** Lifecycle state of a Task: created, running, completed, failed, or canceled. */
export type TaskStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/**
 * Awaitable async computation with status, result/error, and onCancel. Not a Promise; supports AbortSignal and cleanup.
 * Use {@link Task.onCancel} to run cleanup when the task is canceled; the handler receives the cancellation reason.
 */
export type Task<T = unknown> = {
  readonly status: TaskStatus;
  readonly result?: T;
  readonly error?: unknown;
  /** Optional name for debugging and strict-cancellation warnings. */
  readonly name?: string;
  /** Registers a handler to run when the task is canceled. The handler receives the cancellation reason (e.g. from scope.abort(reason)). */
  onCancel(handler: (reason?: unknown) => void): void;
} & PromiseLike<T>;

/** Options for runTask: optional parent AbortSignal for cancellation, optional name for debug. */
export type RunTaskOptions = {
  signal?: AbortSignal;
  name?: string;
};

/**
 * Creates and runs a Task from async work. The work receives the task's AbortSignal for cancellation.
 * Pass an optional parent signal in options; when it aborts, this task is canceled. Returns an awaitable Task.
 */
export function runTask<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options?: RunTaskOptions,
): Task<T> {
  if (
    isStrictModeEnabled() &&
    !options?.signal &&
    !hasCurrentScope()
  ) {
    strictModeWarn(
      "Strict mode: unstructured async – task started outside any Taskloom scope (e.g. not under runInScope or sync/race/rush/branch).",
    );
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const taskName = options?.name;
  const debugTaskId = registerTask(taskName);

  let status: TaskStatus = "running";
  let result: T | undefined;
  let error: unknown;
  const cancelHandlers: Array<(reason?: unknown) => void> = [];
  let resolveThenable!: (value: T) => void;
  let rejectThenable!: (reason: unknown) => void;
  const thenablePromise = new Promise<T>((resolve, reject) => {
    resolveThenable = resolve;
    rejectThenable = reject;
  });

  function withName(reason: unknown): unknown {
    if (taskName != null && reason !== null && typeof reason === "object") {
      (reason as { taskName?: string }).taskName = taskName;
    }
    return reason;
  }

  function transitionToCanceled(reason: unknown): void {
    if (status !== "running") return;
    status = "canceled";
    updateTask(debugTaskId, "canceled");
    error = reason;
    if (isStrictModeEnabled() && cancelHandlers.length === 0) {
      const name = taskName ?? "anonymous";
      strictModeWarn(
        `Strict mode: task "${name}" was canceled but had no onCancel handler registered (ignored cancellation).`,
      );
    }
    for (const h of cancelHandlers) {
      try {
        h(reason);
      } catch {
        // Run remaining handlers; design: one throwing handler does not stop others
      }
    }
    rejectThenable(withName(reason));
  }

  function transitionToCompleted(value: T): void {
    if (status !== "running") return;
    status = "completed";
    updateTask(debugTaskId, "completed");
    result = value;
    resolveThenable(value);
  }

  function transitionToFailed(reason: unknown): void {
    if (status !== "running") return;
    status = "failed";
    updateTask(debugTaskId, "failed");
    error = reason;
    rejectThenable(withName(reason));
  }

  signal.addEventListener("abort", () => {
    transitionToCanceled(signal.reason);
  });

  let workPromise: Promise<unknown> | undefined;
  if (options?.signal) {
    if (options.signal.aborted) {
      transitionToCanceled(options.signal.reason);
      workPromise = undefined;
      const obj = makeTaskObject();
      registerScopeTask(options?.signal, obj, workPromise);
      return obj;
    }
    const parentSignal = options.signal;
    parentSignal.addEventListener("abort", () => {
      controller.abort(parentSignal.reason);
    });
  }

  workPromise = work(signal).then(
    (value) => transitionToCompleted(value),
    (reason) => transitionToFailed(reason),
  );

  function makeTaskObject(): Task<T> {
    const taskObject: Task<T> = {
      get status() {
        return status;
      },
      get result() {
        return result;
      },
      get error() {
        return error;
      },
      get name() {
        return taskName;
      },
      onCancel(handler: (reason?: unknown) => void): void {
        if (status === "canceled") {
          try {
            handler(error);
          } catch {
            // Invoke handler once; ignore errors per onCancel semantics
          }
          return;
        }
        cancelHandlers.push(handler);
      },
      then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return thenablePromise.then(onFulfilled, onRejected) as PromiseLike<TResult1 | TResult2>;
      },
    };
    return taskObject;
  }

  const obj = makeTaskObject();
  registerScopeTask(options?.signal, obj, workPromise);
  return obj;
}
