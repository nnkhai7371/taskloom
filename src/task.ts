/**
 * Task – async computation with lifecycle, cancellation, and cleanup.
 * Awaitable but not a Promise; supports AbortSignal and onCancel.
 */

import { registerTask, updateTask } from "./debug.js";
import { hasCurrentScope, registerScopeTask } from "./scope.js";
import { isStrictModeEnabled, strictModeWarn } from "./strict-mode.js";

/**
 * Discriminated union for why a task was canceled. Handlers can narrow on `reason.type`.
 * The system sets one of these when it triggers cancellation; user-provided reasons may be passed through as-is.
 *
 * @see {@link Task.onCancel}
 */
export type CancelReason =
  | { type: "timeout"; ms: number }
  | { type: "user-abort"; signal: AbortSignal }
  | { type: "scope-closed" }
  | { type: "parent-canceled"; parent: Task<unknown> };

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
  /** Registers a handler to run when the task is canceled. The handler receives the cancellation reason (e.g. from scope.abort(reason)); when the system sets it, reason is a {@link CancelReason}. */
  onCancel(handler: (reason?: CancelReason) => void): void;
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
  /** When set and signal aborts, the cancellation reason is reported as parent-canceled with this task. Omit when the parent is a scope (not a task). */
  parentTask?: Task<unknown>;
};

function normalizeLifecycleHooks(
  hooksOpt?: TaskLifecycleHook | TaskLifecycleHook[],
): TaskLifecycleHook[] {
  if (!hooksOpt) return [];
  return Array.isArray(hooksOpt) ? hooksOpt : [hooksOpt];
}

function invokeHooks(hooks: TaskLifecycleHook[], fn: (h: TaskLifecycleHook) => void): void {
  for (const h of hooks) {
    try {
      fn(h);
    } catch {
      // Hook errors do not affect task outcome
    }
  }
}

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
  const hooks = normalizeLifecycleHooks(options?.lifecycleHooks);

  let status: TaskStatus = "running";
  let result: T | undefined;
  let error: unknown;
  const cancelHandlers: Array<(reason?: CancelReason) => void> = [];
  let resolveThenable!: (value: T) => void;
  let rejectThenable!: (reason: unknown) => void;
  const thenablePromise = new Promise<T>((resolve, reject) => {
    resolveThenable = resolve;
    rejectThenable = reject;
  });
  let startTime = 0;
  let taskObject!: Task<T>;

  function withName(reason: unknown): unknown {
    if (taskName && reason && typeof reason === "object") {
      (reason as { taskName?: string }).taskName = taskName;
    }
    return reason;
  }

  function transitionToCanceled(reason: unknown): void {
    if (status !== "running") return;
    invokeHooks(hooks, (h) => h.onTaskCancel?.(taskObject, reason));
    status = "canceled";
    updateTask(debugTaskId, "canceled");
    error = reason;
    if (isStrictModeEnabled() && cancelHandlers.length === 0) {
      strictModeWarn(
        `Strict mode: task "${taskName ?? "anonymous"}" was canceled but had no onCancel handler registered (ignored cancellation).`,
      );
    }
    for (const h of cancelHandlers) {
      try {
        h(reason as CancelReason | undefined);
      } catch {
        // Run remaining handlers; design: one throwing handler does not stop others
      }
    }
    rejectThenable(withName(reason));
  }

  function transitionToCompleted(value: T): void {
    if (status !== "running") return;
    const duration = performance.now() - startTime;
    invokeHooks(hooks, (h) => h.onTaskComplete?.(taskObject, duration));
    status = "completed";
    updateTask(debugTaskId, "completed");
    result = value;
    resolveThenable(value);
  }

  function transitionToFailed(reason: unknown): void {
    if (status !== "running") return;
    const duration = performance.now() - startTime;
    invokeHooks(hooks, (h) => h.onTaskFail?.(taskObject, reason, duration));
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
      onCancel(handler: (reason?: CancelReason) => void): void {
        if (status === "canceled") {
          try {
            handler(error as CancelReason | undefined);
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
  const parentSignal = options?.signal;
  if (parentSignal?.aborted) {
    taskObject = makeTaskObject();
    workPromise = undefined;
    const parentTask = options?.parentTask;
    const reason: CancelReason =
      parentTask 
        ? { type: "parent-canceled", parent: parentTask }
        : (parentSignal.reason as CancelReason);
    invokeHooks(hooks, (h) => h.onTaskCancel?.(taskObject, reason));
    transitionToCanceled(reason);
    registerScopeTask(parentSignal, taskObject, workPromise);
    return taskObject;
  }
  if (parentSignal) {
    const parentTask = options?.parentTask;
    parentSignal.addEventListener("abort", () => {
      const reason: CancelReason =
        parentTask 
          ? { type: "parent-canceled", parent: parentTask }
          : (parentSignal.reason as CancelReason);
      controller.abort(reason);
    });
  }

  startTime = performance.now();
  taskObject = makeTaskObject();
  invokeHooks(hooks, (h) => h.onTaskStart?.(taskObject));
  workPromise = work(signal).then(
    (value) => transitionToCompleted(value),
    (reason) => transitionToFailed(reason),
  );
  registerScopeTask(options?.signal, taskObject, workPromise);
  return taskObject;
}
