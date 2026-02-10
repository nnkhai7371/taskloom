/**
 * Scope – owns an AbortController for its lifetime. Tasks created with
 * scope.signal are canceled when the scope is closed (e.g. when runInScope exits).
 */

import { storage, type AsyncContextStorage } from "./async-context.js";
import type { CancelReason, Task } from "./task.js";
import { isStrictModeEnabled, strictModeWarn } from "./strict-mode.js";

/**
 * Scope that owns an AbortController; tasks using scope.signal are canceled when the scope is closed.
 * Use {@link Scope.abort} to cancel all tasks in the scope; pass an optional reason for {@link Task.onCancel} handlers.
 */
export type Scope = {
  readonly signal: AbortSignal;
  /** Aborts the scope so all tasks using scope.signal are canceled. Optional reason is available as signal.reason and to onCancel handlers. Pass a {@link CancelReason} or custom value; when omitted, handlers receive a user-abort reason. */
  abort(reason?: CancelReason | unknown): void;
};

/** @internal */
export type ScopeTaskEntry = {
  task: Task<unknown>;
  workSettled: boolean;
};

/** @internal */
export type ScopeStorage = {
  scope: Scope;
  entries: ScopeTaskEntry[];
  /** Optional timeout deadline (absolute timestamp ms). When set, scope's remaining time is capped by this. */
  deadlineMs?: number;
  /** Used by withStrictCancellation: timer to warn if tasks ignore cancellation. Cleared when all work settles. */
  strictTimerId?: ReturnType<typeof setTimeout>;
  /** Used by withStrictCancellation: work promises so we can clear the timer when all settle. */
  pendingWorkPromises?: Promise<unknown>[];
};

const scopeStorage = storage as AsyncContextStorage<ScopeStorage>;

/**
 * Returns whether the current execution is inside an active Taskloom scope (runInScope or a primitive).
 * Used by strict mode to detect unstructured async.
 * @internal
 */
export function hasCurrentScope(): boolean {
  return !!scopeStorage.getStore();
}

/**
 * Returns the current scope when inside runInScope or a primitive, or undefined otherwise.
 * Used so nested primitives can chain their scope to the parent and abort when the parent aborts.
 * @internal
 */
export function getCurrentScope(): Scope | undefined {
  return scopeStorage.getStore()?.scope;
}

/**
 * Returns the current scope storage when inside runInScope or a primitive, or undefined otherwise.
 * Used by runWithTimeout and primitives to read/write deadline and forward to child scopes.
 * @internal
 */
export function getCurrentScopeStorage(): ScopeStorage | undefined {
  return scopeStorage.getStore();
}

/**
 * Returns the remaining time in ms until the current scope's deadline, or undefined if no deadline.
 * Used by runWithTimeout to cap requested timeout by parent budget.
 * @internal
 */
export function getScopeDeadlineRemainingMs(): number | undefined {
  const store = scopeStorage.getStore();
  if (!store?.deadlineMs) return undefined;
  return Math.max(0, store.deadlineMs - Date.now());
}

/**
 * When strict mode is on, warns for any task in entries that has not settled (completed, failed, or canceled).
 * @internal
 */
export function warnOrphanTasksIfStrict(entries: ScopeTaskEntry[]): void {
  if (!isStrictModeEnabled()) return;
  for (const entry of entries) {
    const status = entry.task.status;
    if (
      status !== "completed" &&
      status !== "failed" &&
      status !== "canceled"
    ) {
      const name = entry.task.name ?? "anonymous";
      strictModeWarn(
        `Strict mode: task "${name}" survived scope exit (orphan); task may still be running.`,
      );
    }
  }
}

/**
 * Registers a task (and optional work promise for strict-cancellation) when the task's signal matches the scope.
 * @internal
 */
export function registerScopeTask(
  signal: AbortSignal | undefined,
  task: Task<unknown>,
  workPromise?: Promise<unknown>,
): void {
  const store = scopeStorage.getStore();
  if (store && signal === store.scope.signal) {
    const entry: ScopeTaskEntry = { task, workSettled: false };
    store.entries.push(entry);
    if (workPromise) {
      store.pendingWorkPromises?.push(workPromise);
      workPromise.finally(() => {
        entry.workSettled = true;
      });
    }
  }
}

/**
 * Runs the given function with the provided scope storage so that scope and task registration are visible to strict mode and registerScopeTask.
 * Used by primitives (e.g. race) that create their own scope without using runInScope.
 * @internal
 */
export function runWithScopeStorage<T>(
  store: ScopeStorage,
  fn: () => Promise<T>,
): Promise<T> {
  return scopeStorage.run(store, fn);
}

/**
 * Creates a Scope (internal: used by runInScope). The Scope holds the
 * controller's signal; runInScope owns calling controller.abort() on exit.
 */
function createScope(): { scope: Scope; controller: AbortController } {
  const controller = new AbortController();
  const scope: Scope = {
    signal: controller.signal,
    abort(reason?: CancelReason | unknown): void {
      controller.abort(
        reason ?? { type: "user-abort", signal: controller.signal },
      );
    },
  };
  return { scope, controller };
}

/**
 * Runs the given function inside a new scope. The scope owns an AbortController; closing the scope (when fn settles) aborts it,
 * which cancels all tasks that were created with scope.signal. Resolves or rejects with the function's result.
 * When parentScope is provided (e.g. when nesting primitives), the new scope is aborted when the parent is aborted.
 */
export async function runInScope<T>(
  fn: (scope: Scope) => Promise<T>,
  parentScope?: Scope,
): Promise<T> {
  const { scope, controller } = createScope();
  if (parentScope) {
    parentScope.signal.addEventListener(
      "abort",
      () => controller.abort(parentScope.signal.reason),
      { once: true },
    );
  }
  const entries: ScopeTaskEntry[] = [];
  const parentStore = scopeStorage.getStore();
  const store: ScopeStorage = {
    scope,
    entries,
    ...(parentStore?.deadlineMs && { deadlineMs: parentStore.deadlineMs }),
  };
  try {
    return await scopeStorage.run(store, async () => {
      return await fn(scope);
    });
  } finally {
    warnOrphanTasksIfStrict(entries);
    controller.abort({ type: "scope-closed" });
  }
}

/**
 * Options for {@link withStrictCancellation}.
 */
export type StrictCancellationOptions = {
  /** Milliseconds after scope abort before warning if a task has not settled. Default 2000. */
  warnAfterMs?: number;
};

const DEFAULT_WARN_AFTER_MS = 2000;

/**
 * Runs the given function inside a new scope (same as runInScope). In development only, observes tasks started under that scope
 * and warns if any task is still running longer than `warnAfterMs` after the scope is aborted. No-op in production.
 *
 * @param fn - Callback receiving the scope; start tasks with that scope's signal so they are observed.
 * @param options - Optional {@link StrictCancellationOptions} (e.g. `warnAfterMs`).
 * @returns The result of `fn`.
 */
export async function withStrictCancellation<T>(
  fn: (scope: Scope) => Promise<T>,
  options?: StrictCancellationOptions,
): Promise<T> {
  const { scope, controller } = createScope();
  const entries: ScopeTaskEntry[] = [];
  const pendingWorkPromises: Promise<unknown>[] = [];
  const warnAfterMs = options?.warnAfterMs ?? DEFAULT_WARN_AFTER_MS;
  const parentStore = scopeStorage.getStore();
  const store: ScopeStorage = {
    scope,
    entries,
    pendingWorkPromises,
    ...(parentStore?.deadlineMs && { deadlineMs: parentStore.deadlineMs }),
  };

  return await scopeStorage.run(store, async () => {
    try {
      return await fn(scope);
    } finally {
      controller.abort({ type: "scope-closed" });
      if (process.env.NODE_ENV !== "production") {
        const abortedAt = Date.now();
        const timerId = setTimeout(() => {
          for (const entry of entries) {
            if (!entry.workSettled) {
              const name = entry.task.name ?? "anonymous";
              const duration = ((Date.now() - abortedAt) / 1000).toFixed(1);
              console.warn(
                `Task ${name} ignored cancellation for ${duration}s`,
              );
            }
          }
        }, warnAfterMs);
        store.strictTimerId = timerId;
        Promise.allSettled(pendingWorkPromises).then(() => {
          clearTimeout(timerId);
          store.strictTimerId = undefined;
        });
      }
    }
  });
}
