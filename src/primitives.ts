/**
 * Concurrency primitives: sync, race, rush, branch, spawn.
 * Built on Task and Scope; all except spawn use scope.signal for cancellation.
 */

import { runTask, type Task } from "./task.js";
import {
  getCurrentScope,
  getCurrentScopeStorage,
  runInScope,
  runWithScopeStorage,
  warnOrphanTasksIfStrict,
  type Scope,
  type ScopeStorage,
} from "./scope.js";
import { pushScope, popScope, isTaskDebugEnabled, getCallerName } from "./debug.js";
import { createSleep, createTimeout, createRetry, type RetryOptions } from "./helpers.js";
import { strictModeWarn } from "./strict-mode.js";

export type { RetryOptions, RetryBackoff } from "./helpers.js";

/**
 * Context passed to primitive callbacks. Use `task(work)` or `task(name, work)` to start
 * tasks tied to the current scope; they are canceled when the scope closes.
 * Helpers: task.sleep(ms), task.timeout(ms, work), task.retry(fn, options).
 */
export type PrimitivesContext = {
  task: {
    <T>(work: (signal: AbortSignal) => Promise<T>): Task<T>;
    <T>(name: string, work: (signal: AbortSignal) => Promise<T>): Task<T>;
    sleep(ms: number): Promise<void>;
    timeout<T>(ms: number, work: () => Promise<T>): Promise<T>;
    retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>;
  };
  scope: Scope;
};

/**
 * Callback type for sync, race, rush, and branch. Receives `{ task, scope }`; return a
 * Promise that starts work via `task(work)` or `task(name, work)`.
 */
export type PrimitivesCallback<R = void> = (ctx: PrimitivesContext) => Promise<R>;

/**
 * Minimal context for zero-friction usage: only `run(work)` to start a task. No explicit
 * task/scope API; tasks are still scope-bound and canceled when the primitive's scope closes.
 */
export type ZeroFrictionSyncContext = {
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Task<T>;
};

/**
 * Callback type for zero-friction sync. Receives `{ run }` only; call `run(work)` to start
 * tasks without using task/scope explicitly.
 */
export type ZeroFrictionSyncCallback<R = void> = (ctx: ZeroFrictionSyncContext) => Promise<R>;

/** Attach a no-op rejection handler so unawaited task promises never cause unhandledRejection. */
function attachRejectionHandler<T>(t: Task<T>): Task<T> {
  t.then(undefined, () => {});
  return t;
}

function taskImpl<T>(
  scope: Scope,
  first: string | ((signal: AbortSignal) => Promise<T>),
  second?: (signal: AbortSignal) => Promise<T>,
): Task<T> {
  const work = typeof first === "string" ? second! : first;
  const name = typeof first === "string" ? first : undefined;
  return runTask(work, name == null ? { signal: scope.signal } : { signal: scope.signal, name });
}

function makeRun(scope: Scope, tasks: Task<unknown>[]): ZeroFrictionSyncContext["run"] {
  return <T>(work: (signal: AbortSignal) => Promise<T>): Task<T> => {
    const name = isTaskDebugEnabled() ? getCallerName(2) : undefined;
    const t =
      name != null && name !== ""
        ? taskImpl(scope, name, work)
        : taskImpl(scope, work);
    attachRejectionHandler(t);
    tasks.push(t);
    return t;
  };
}

function attachHelpersToTask(
  scope: Scope,
  taskFn: (
    first: string | ((signal: AbortSignal) => Promise<unknown>),
    second?: (signal: AbortSignal) => Promise<unknown>,
  ) => Task<unknown>,
): PrimitivesContext["task"] {
  const bound = Object.assign(taskFn, {
    sleep: createSleep(scope.signal),
    timeout: createTimeout(scope, scope.signal),
    retry: createRetry(scope.signal),
  });
  return bound as PrimitivesContext["task"];
}

/**
 * Returns { task, scope } where task(work) runs work with scope.signal.
 * Used by primitives that run inside runInScope.
 */
export function createContext(scope: Scope): PrimitivesContext {
  const taskFn = (
    first: string | ((signal: AbortSignal) => Promise<unknown>),
    second?: (signal: AbortSignal) => Promise<unknown>,
  ) => taskImpl(scope, first, second);
  return {
    task: attachHelpersToTask(scope, taskFn),
    scope,
  };
}

/**
 * Context passed to sync, race, rush, and branch. Has both `task`/`scope` (explicit API) and
 * `run` (zero-friction); use either to start tasks in the current scope.
 */
export type SyncContext = PrimitivesContext & ZeroFrictionSyncContext;

function createSyncContext(scope: Scope): { tasks: Task<unknown>[]; ctx: SyncContext } {
  const tasks: Task<unknown>[] = [];
  const taskFn = (
    first: string | ((signal: AbortSignal) => Promise<unknown>),
    second?: (signal: AbortSignal) => Promise<unknown>,
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
      run: makeRun(scope, tasks),
    },
  };
}

/**
 * Runs all tasks started in the callback concurrently and waits for all to complete.
 * On first rejection or cancellation, the scope is aborted so remaining tasks are canceled and the error is rethrown.
 * Callback receives `{ task, scope, run }`: use task/scope for explicit API, or `run(work)` for zero-friction.
 *
 * @example
 * // Before: Promise.all – no built-in cancellation on first failure
 * const [a, b] = await Promise.all([fetchA(), fetchB()]);
 *
 * @example
 * // After: sync – first failure aborts scope and cancels other tasks
 * const result = await sync(async ({ run }) => {
 *   run(fetchA());
 *   run(fetchB());
 * });
 */
export function sync<R>(callback: (ctx: SyncContext) => Promise<R>): Promise<R> {
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
 * Callback receives `{ task, scope, run }`: use task/scope or `run(work)` for zero-friction.
 *
 * @example
 * // Before: Promise.race – losers keep running; no automatic cleanup
 * const first = await Promise.race([fetchA(), fetchB()]);
 *
 * @example
 * // After: race – first result wins; other tasks are canceled
 * const first = await race(async ({ run }) => {
 *   run(fetchA());
 *   run(fetchB());
 * });
 */
export function race<T>(callback: (ctx: SyncContext) => Promise<unknown>): Promise<T> {
  return (async () => {
    pushScope("race");
    try {
      const controller = new AbortController();
      const scope: Scope = {
        signal: controller.signal,
        abort: (reason?: unknown) => controller.abort(reason),
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
        ...(parentStore?.deadlineMs != null && { deadlineMs: parentStore.deadlineMs }),
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
            controller.abort(undefined);
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
 * Callback receives `{ task, scope, run }`: use task/scope or `run(work)` for zero-friction.
 */
export function rush<T>(callback: (ctx: SyncContext) => Promise<unknown>): Promise<T> {
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
 * Starts work by invoking the callback with `{ task, scope, run }` and returns immediately (does not await the tasks).
 * All tasks started in the branch are scope-bound; the branch scope closes when the enclosing async context (parent scope) completes, so branch tasks are canceled then—or when the branch body completes, whichever comes first.
 * Callback receives `{ task, scope, run }`: use task/scope or `run(work)` for zero-friction.
 */
export function branch(callback: (ctx: SyncContext) => Promise<void>): Promise<void> {
  const parentScope = getCurrentScope();
  if (parentScope == null) {
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
    abort: (reason?: unknown) => controller.abort(reason),
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
    ...(parentStore?.deadlineMs != null && { deadlineMs: parentStore.deadlineMs }),
  };
  return runWithScopeStorage(store, () => {
    pushScope("branch");
    try {
      const { ctx } = createSyncContext(scope);
      callback(ctx).then(undefined, () => {}); // avoid unhandled rejection from branch body
      return Promise.resolve();
    } finally {
      popScope();
    }
  });
}

/**
 * Context for spawn and spawnScope. Use `run(work)` to start a task with no parent scope;
 * the task is not canceled when the caller's scope closes.
 */
export type SpawnContext = {
  run: <T>(work: (signal: AbortSignal) => Promise<T>) => Task<T>;
};

/**
 * Fire-and-forget: runs a single async work function with no parent scope or signal. The spawn expression completes
 * immediately: the call returns a Task in the same synchronous turn without awaiting the work. The next expression
 * after spawn runs immediately and concurrently with the spawned work, which continues independently until it completes.
 * Spawn is allowed outside async context (e.g. from sync code); no runInScope or async wrapper is required. The body
 * of spawn is a single async function call (one work function). The task is not canceled when the caller's scope closes.
 * Callers may optionally await the returned Task; they are not required to await it for correctness.
 */
export function spawn<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Task<T> {
  pushScope("spawn");
  try {
    return runTask(work, {});
  } finally {
    popScope();
  }
}

/**
 * Creates a scope for fire-and-forget work. Invokes the callback with `{ run }`; each `run(work)` spawns a task with no parent scope.
 * Returns when the callback settles; does not await the spawned tasks. Use when you want to group fire-and-forget tasks under one scope.
 */
export function spawnScope(
  callback: (ctx: SpawnContext) => void | Promise<void>,
): Promise<void> {
  return (async () => {
    pushScope("spawn");
    try {
      const run = <T>(work: (signal: AbortSignal) => Promise<T>): Task<T> => {
        const name = isTaskDebugEnabled() ? getCallerName(2) : undefined;
        return runTask(
          work,
          name != null && name !== "" ? { name } : {},
        );
      };
      await callback({ run });
    } finally {
      popScope();
    }
  })();
}
