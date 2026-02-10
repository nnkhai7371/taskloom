/**
 * Task – async computation with lifecycle, cancellation, and cleanup.
 * Awaitable but not a Promise; supports AbortSignal and onCancel.
 */

import { registerTask, updateTask } from "./debug.js";
import { hasCurrentScope, registerScopeTask } from "./scope.js";
import { isStrictModeEnabled, strictModeWarn } from "./strict-mode.js";

/**
 * Optional callbacks invoked at task lifecycle points. All callbacks are optional.
 * Used for observability (e.g. metrics, APM). Hook errors are swallowed and do not affect task outcome.
 * @see {@link RunTaskOptions.lifecycleHooks}
 */
export type TaskLifecycleHook = {
  /** Called once when the task begins running (before work runs). */
  onTaskStart?(task: Task): void;
  /** Called once when the task completes successfully. Duration is in milliseconds since task start. */
  onTaskComplete?(task: Task, duration: number): void;
  /** Called once when the task fails. Duration is in milliseconds since task start. */
  onTaskFail?(task: Task, error: unknown, duration: number): void;
  /** Called once when the task is canceled. Reason is the cancellation reason (e.g. AbortSignal.reason). */
  onTaskCancel?(task: Task, reason: unknown): void;
};

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

/**
 * Options for runTask: optional parent AbortSignal for cancellation, optional name for debug,
 * optional lifecycle hooks for observability.
 */
export type RunTaskOptions = {
  signal?: AbortSignal;
  name?: string;
  /** Optional lifecycle hooks (single or array). Invoked at task start, complete, fail, and cancel. */
  lifecycleHooks?: TaskLifecycleHook | TaskLifecycleHook[];
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
  const hooks: TaskLifecycleHook[] =
    options?.lifecycleHooks != null
      ? Array.isArray(options.lifecycleHooks)
        ? options.lifecycleHooks
        : [options.lifecycleHooks]
      : [];

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
  let startTime = 0;
  let taskObject!: Task<T>;

  function withName(reason: unknown): unknown {
    if (taskName != null && reason !== null && typeof reason === "object") {
      (reason as { taskName?: string }).taskName = taskName;
    }
    return reason;
  }

  function transitionToCanceled(reason: unknown): void {
    if (status !== "running") return;
    for (const h of hooks) {
      try {
        h.onTaskCancel?.(taskObject, reason);
      } catch {
        // Hook errors do not affect task outcome
      }
    }
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
    const duration = performance.now() - startTime;
    for (const h of hooks) {
      try {
        h.onTaskComplete?.(taskObject, duration);
      } catch {
        // Hook errors do not affect task outcome
      }
    }
    status = "completed";
    updateTask(debugTaskId, "completed");
    result = value;
    resolveThenable(value);
  }

  function transitionToFailed(reason: unknown): void {
    if (status !== "running") return;
    const duration = performance.now() - startTime;
    for (const h of hooks) {
      try {
        h.onTaskFail?.(taskObject, reason, duration);
      } catch {
        // Hook errors do not affect task outcome
      }
    }
    status = "failed";
    updateTask(debugTaskId, "failed");
    error = reason;
    rejectThenable(withName(reason));
  }

  signal.addEventListener("abort", () => {
    transitionToCanceled(signal.reason);
  });

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

  let workPromise: Promise<unknown> | undefined;
  if (options?.signal) {
    if (options.signal.aborted) {
      taskObject = makeTaskObject();
      workPromise = undefined;
      for (const h of hooks) {
        try {
          h.onTaskCancel?.(taskObject, options.signal.reason);
        } catch {
          // Hook errors do not affect task outcome
        }
      }
      transitionToCanceled(options.signal.reason);
      registerScopeTask(options?.signal, taskObject, workPromise);
      return taskObject;
    }
    const parentSignal = options.signal;
    parentSignal.addEventListener("abort", () => {
      controller.abort(parentSignal.reason);
    });
  }

  startTime = performance.now();
  taskObject = makeTaskObject();
  for (const h of hooks) {
    try {
      h.onTaskStart?.(taskObject);
    } catch {
      // Hook errors do not affect task outcome
    }
  }
  workPromise = work(signal).then(
    (value) => transitionToCompleted(value),
    (reason) => transitionToFailed(reason),
  );
  registerScopeTask(options?.signal, taskObject, workPromise);
  return taskObject;
}
