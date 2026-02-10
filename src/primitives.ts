/**
 * Concurrency primitives: sync, race, rush, branch, spawn.
 * Built on Task and Scope; all except spawn use scope.signal for cancellation.
 */

import { runTask, type CancelReason, type Task } from "./task.js";
import {
  getCurrentScope,
  getCurrentScopeStorage,
  runInScope,
  runWithScopeStorage,
  warnOrphanTasksIfStrict,
  type Scope,
  type ScopeStorage,
} from "./scope.js";
import { pushScope, popScope } from "./debug.js";
import {
  createSleep,
  createTimeout,
  createRetry,
  createLimiter,
  type RetryOptions,
  type LimiterOptions,
} from "./helpers.js";
import { isStrictModeEnabled, strictModeWarn } from "./strict-mode.js";

export type { RetryOptions, RetryBackoff, LimiterOptions } from "./helpers.js";
export { createLimiter } from "./helpers.js";

/** Options for task when using the form task(work, options). */
export type TaskOptions = { name?: string };

/**
 * Unwraps an array/tuple of Task types to the array of their resolved values.
 * Used for task.all() result type.
 */
export type UnwrapTasks<T extends readonly Task<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Task<infer U> ? Awaited<U> : never;
};

/**
 * Result shape of task.allSettled(): array of PromiseSettledResult for each task.
 */
export type SettledTasks<T extends readonly Task<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Task<infer U> ? PromiseSettledResult<Awaited<U>> : never;
};

/**
 * Context passed to primitive callbacks (sync, race, rush, branch, spawn). Use `task(work)`,
 * `task(name, work)`, or `task(work, { name })` to start tasks tied to the current scope; they are canceled when the scope closes.
 * Helpers: task.sleep(ms), task.timeout(ms, work), task.retry(fn, options), task.limit(concurrency, options?), task.all, task.race, task.allSettled.
 */
export type TaskloomContext = {
  task: {
    <T>(work: (signal: AbortSignal) => Promise<T>): Task<T>;
    <T>(name: string, work: (signal: AbortSignal) => Promise<T>): Task<T>;
    <T>(work: (signal: AbortSignal) => Promise<T>, options: TaskOptions): Task<T>;
    sleep(ms: number): Promise<void>;
    timeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
    retry<T>(fn: (signal: AbortSignal) => Promise<T>, options: RetryOptions): Promise<T>;
    /**
     * Returns a concurrency limiter that runs at most `concurrency` work functions at a time.
     * Usage: const limit = task.limit(3); await limit(async (signal) => { ... });
     * Work receives the scope's AbortSignal (e.g. for fetch). When the scope aborts, queued work is rejected if cancelQueuedOnAbort is true (default).
     * @param concurrency - Max concurrent runs (integer >= 1)
     * @param options - Optional: cancelQueuedOnAbort (default true) to reject queued work on scope abort
     */
    limit(concurrency: number, options?: Partial<LimiterOptions>): <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    all<T extends readonly Task<unknown>[]>(tasks: T): Promise<UnwrapTasks<T>>;
    race<T>(tasks: readonly Task<T>[]): Promise<T>;
    allSettled<T extends readonly Task<unknown>[]>(tasks: T): Promise<SettledTasks<T>>;
  };
  scope: Scope;
};

/**
 * Callback type for sync, race, rush, branch, and spawn. Receives TaskloomContext (`{ task, scope }`);
 * return a Promise that starts work via `task(work)` or `task(name, work)`.
 */
export type SyncCallback<R = void> = (ctx: TaskloomContext) => Promise<R>;

/** Attach a no-op rejection handler so unawaited task promises never cause unhandledRejection. */
function attachRejectionHandler<T>(t: Task<T>): Task<T> {
  t.then(undefined, () => {});
  return t;
}

function taskImpl<T>(
  scope: Scope,
  first: string | ((signal: AbortSignal) => Promise<T>),
  second?: (signal: AbortSignal) => Promise<T> | TaskOptions,
): Task<T> {
  let work: (signal: AbortSignal) => Promise<T>;
  let name: string | undefined;
  if (typeof first === "string") {
    work = second as (signal: AbortSignal) => Promise<T>;
    name = first;
  } else if (second && typeof second === "object" && "name" in second) {
    work = first;
    name = (second as TaskOptions).name;
  } else {
    work = first;
    name = undefined;
  }
  return runTask(work, name ? { signal: scope.signal, name } : { signal: scope.signal });
}

function attachHelpersToTask(
  scope: Scope,
  taskFn: (
    first: string | ((signal: AbortSignal) => Promise<unknown>),
    second?: (signal: AbortSignal) => Promise<unknown> | TaskOptions,
  ) => Task<unknown>,
): TaskloomContext["task"] {
  const bound = Object.assign(taskFn, {
    sleep: createSleep(scope.signal),
    timeout: createTimeout(scope, scope.signal),
    retry: createRetry(scope.signal),
    limit(concurrency: number, options?: Partial<LimiterOptions>) {
      return createLimiter(scope.signal, { concurrency, ...options });
    },
    all<T extends readonly Task<unknown>[]>(tasks: T): Promise<UnwrapTasks<T>> {
      return Promise.all(tasks) as Promise<UnwrapTasks<T>>;
    },
    race<T>(tasks: readonly Task<T>[]): Promise<T> {
      return Promise.race(tasks);
    },
    allSettled<T extends readonly Task<unknown>[]>(tasks: T): Promise<SettledTasks<T>> {
      return Promise.allSettled(tasks) as Promise<SettledTasks<T>>;
    },
  });
  return bound as TaskloomContext["task"];
}

/**
 * Returns { task, scope } where task(work) runs work with scope.signal.
 * Used by primitives that run inside runInScope.
 */
export function createContext(scope: Scope): TaskloomContext {
  const taskFn = (
    first: string | ((signal: AbortSignal) => Promise<unknown>),
    second?: (signal: AbortSignal) => Promise<unknown> | TaskOptions,
  ) => {
    const t = taskImpl(scope, first, second);
    attachRejectionHandler(t);
    return t;
  };
  return {
    task: attachHelpersToTask(scope, taskFn),
    scope,
  };
}

function createSyncContext(scope: Scope): { tasks: Task<unknown>[]; ctx: TaskloomContext } {
  const tasks: Task<unknown>[] = [];
  const taskFn = (
    first: string | ((signal: AbortSignal) => Promise<unknown>),
    second?: (signal: AbortSignal) => Promise<unknown> | TaskOptions,
  ) => {
    const t = taskImpl(scope, first, second);
    attachRejectionHandler(t);
    tasks.push(t);
    return t;
  };
  return {
    tasks,
    ctx: {
      task: attachHelpersToTask(scope, taskFn),
      scope,
    },
  };
}

/**
 * Runs all tasks started in the callback concurrently and waits for all to complete.
 * On first rejection or cancellation, the scope is aborted so remaining tasks are canceled and the error is rethrown.
 * Callback receives TaskloomContext (`{ task, scope }`); use `task(work)` or `task(name, work)` to start tasks.
 *
 * @example
 * const result = await sync(async ({ task }) => {
 *   const a = task(fetchA);
 *   const b = task(fetchB);
 *   return await Promise.all([a, b]);
 * });
 */
export function sync<R>(callback: SyncCallback<R>): Promise<R> {
  return runInScope(
    async (scope) => {
      pushScope("sync");
      try {
        const { tasks, ctx } = createSyncContext(scope);
        const resultPromise = callback(ctx);
        resultPromise.catch(() => {}); // avoid unhandled rejection when scope aborts before callback settles
        await Promise.all(tasks);
        return await resultPromise;
      } finally {
        popScope();
      }
    },
    getCurrentScope(),
  );
}

/**
 * Runs tasks from the callback concurrently. The first task to complete wins; the promise resolves or rejects with that result.
 * All other tasks are canceled when the first settles (scope is aborted).
 * Callback receives TaskloomContext (`{ task, scope }`); use `task(work)` or `task(name, work)` to start tasks.
 *
 * @example
 * const first = await race(async ({ task }) => {
 *   task(fetchA);
 *   task(fetchB);
 * });
 */
export function race<T>(callback: SyncCallback<unknown>): Promise<T> {
  return (async () => {
    pushScope("race");
    try {
      const controller = new AbortController();
      const scope: Scope = {
        signal: controller.signal,
        abort: (reason?: CancelReason | unknown) => controller.abort(reason),
      };
      const parentScope = getCurrentScope();
      if (parentScope) {
        parentScope.signal.addEventListener(
          "abort",
          () => controller.abort(parentScope.signal.reason),
          { once: true },
        );
      }
      const entries: ScopeStorage["entries"] = [];
      const parentStore = getCurrentScopeStorage();
      const store: ScopeStorage = {
        scope,
        entries,
        ...(parentStore?.deadlineMs && { deadlineMs: parentStore.deadlineMs }),
      };
      const { tasks, ctx } = createSyncContext(scope);
      return await runWithScopeStorage(store, async () => {
        await callback(ctx);
        if (tasks.length === 0) {
          throw new Error("race: callback did not start any tasks");
        }
        return Promise.race(tasks).then(
          (value) => {
            warnOrphanTasksIfStrict(entries);
            controller.abort({ type: "scope-closed" });
            tasks.forEach((t) => t.then(undefined, () => {}));
            return value as T;
          },
          (reason) => {
            warnOrphanTasksIfStrict(entries);
            controller.abort(reason);
            tasks.forEach((t) => t.then(undefined, () => {}));
            throw reason;
          },
        );
      });
    } finally {
      popScope();
    }
  })();
}

/**
 * Runs tasks from the callback concurrently. Returns as soon as the first task settles (resolve or reject).
 * Other tasks keep running in the scope; the scope waits for all to settle before closing.
 * Callback receives TaskloomContext (`{ task, scope }`); use `task(work)` or `task(name, work)` to start tasks.
 */
export function rush<T>(callback: SyncCallback<unknown>): Promise<T> {
  return runInScope(
    async (scope) => {
      pushScope("rush");
      try {
        const { tasks, ctx } = createSyncContext(scope);
        await callback(ctx);
        if (tasks.length === 0) {
          throw new Error("rush: callback did not start any tasks");
        }
        try {
          return (await Promise.race(tasks)) as T;
        } finally {
          await Promise.allSettled(tasks);
        }
      } finally {
        popScope();
      }
    },
    getCurrentScope(),
  );
}

/**
 * Starts work by invoking the callback with TaskloomContext (`{ task, scope }`) and returns immediately (does not await the tasks).
 * All tasks started in the branch are scope-bound; the branch scope closes when the enclosing async context (parent scope) completes, so branch tasks are canceled then—or when the branch body completes, whichever comes first.
 */
export function branch(callback: SyncCallback<void>): Promise<void> {
  const parentScope = getCurrentScope();
  if (!parentScope) {
    // No parent: keep current behavior — scope closes when callback settles to avoid leaking.
    strictModeWarn(
      "taskloom/branch: branch() was called without a parent scope. For intended semantics (next expression runs in parallel; branch tasks canceled when enclosing context completes), use branch inside runInScope or another primitive.",
    );
    return runInScope(
      async (scope) => {
        pushScope("branch");
        try {
          const { ctx } = createSyncContext(scope);
          await callback(ctx);
        } finally {
          popScope();
        }
      },
    );
  }
  // Parent exists: branch scope closes when parent closes; do not await callback — return immediately.
  const controller = new AbortController();
  const scope: Scope = {
    signal: controller.signal,
    abort: (reason?: CancelReason | unknown) => controller.abort(reason),
  };
  parentScope.signal.addEventListener(
    "abort",
    () => {
      controller.abort(parentScope.signal.reason);
      warnOrphanTasksIfStrict(entries);
    },
    { once: true },
  );
  const entries: ScopeStorage["entries"] = [];
  const parentStore = getCurrentScopeStorage();
  const store: ScopeStorage = {
    scope,
    entries,
    ...(parentStore?.deadlineMs && { deadlineMs: parentStore.deadlineMs }),
  };
  return runWithScopeStorage(store, () => {
    pushScope("branch");
    try {
      const { ctx } = createSyncContext(scope);
      callback(ctx).then(undefined, (err) => {
        if (isStrictModeEnabled()) {
          strictModeWarn(`branch: callback threw error: ${err}`);
        }
      });
      return Promise.resolve();
    } finally {
      popScope();
    }
  });
}

/**
 * Runs the callback with a TaskloomContext in a new scope. The scope is linked to the parent signal when spawn
 * is called from within runInScope or another primitive, so parent abort cancels the spawn. When called with no
 * parent scope, the spawn scope has no parent signal. Returns a Task that resolves or rejects with the callback result.
 */
export function spawn<R>(callback: SyncCallback<R>): Task<R> {
  pushScope("spawn");
  try {
    const controller = new AbortController();
    const scope: Scope = {
      signal: controller.signal,
      abort: (reason?: CancelReason | unknown) => controller.abort(reason),
    };
    const parentScope = getCurrentScope();
    if (parentScope) {
      parentScope.signal.addEventListener(
        "abort",
        () => controller.abort(parentScope.signal.reason),
        { once: true },
      );
    }
    const entries: ScopeStorage["entries"] = [];
    const parentStore = getCurrentScopeStorage();
    const store: ScopeStorage = {
      scope,
      entries,
      ...(parentStore?.deadlineMs && { deadlineMs: parentStore.deadlineMs }),
    };
    const ctx = createContext(scope);
    return runTask(
      async (signal) => {
        const result = await runWithScopeStorage(store, () => callback(ctx));
        if (signal.aborted) throw signal.reason;
        return result;
      },
      { signal: scope.signal },
    );
  } finally {
    popScope();
  }
}

/**
 * Fire-and-forget: runs a single async work function with no parent scope or signal. Completes immediately:
 * returns a Task in the same synchronous turn without awaiting the work. The spawned work is not attached to the
 * current scope and is not canceled when the caller's scope closes. Allowed outside async context.
 */
spawn.task = function spawnTask<T>(work: (signal: AbortSignal) => Promise<T>): Task<T> {
  pushScope("spawn");
  try {
    return runTask(work, {});
  } finally {
    popScope();
  }
};

/**
 * Creates a scope for fire-and-forget work. Invokes the callback with TaskloomContext (`{ task, scope }`).
 * Returns when the callback settles; does not await tasks started via ctx.task. Use to group fire-and-forget tasks.
 */
export function spawnScope(callback: SyncCallback<void>): Promise<void> {
  return (async () => {
    pushScope("spawn");
    try {
      const controller = new AbortController();
      const scope: Scope = {
        signal: controller.signal,
        abort: (reason?: CancelReason | unknown) => controller.abort(reason),
      };
      const ctx = createContext(scope);
      await callback(ctx);
    } finally {
      popScope();
    }
  })();
}
