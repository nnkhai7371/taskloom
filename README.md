# Taskloom

**Structured concurrency for Node.js and browser** - run parallel async work that cancels cleanly, leaves no orphan tasks, and behaves the way you expect.

- **Zero dependencies** · Node 22+ and browser · ESM only
- **Scopes and tasks** · First failure or first result cancels the rest; background work is scope-bound or explicitly detached
- **Built on `AbortSignal`** · Your async work can respect `signal.aborted` and exit early; cancellation can carry a reason

---

## Table of contents

- [Taskloom](#taskloom)
  - [Table of contents](#table-of-contents)
  - [Install](#install)
  - [Quick start](#quick-start)
  - [Why Taskloom?](#why-taskloom)
  - [Core concepts](#core-concepts)
  - [Primitives](#primitives)
    - [sync - "All must succeed; first failure cancels the rest"](#sync---all-must-succeed-first-failure-cancels-the-rest)
    - [race - "First result wins; cancel the rest"](#race---first-result-wins-cancel-the-rest)
    - [rush - "First result back, wait for all (no orphans)"](#rush---first-result-back-wait-for-all-no-orphans)
    - [branch - "Background work in a scope; cancel when scope closes"](#branch---background-work-in-a-scope-cancel-when-scope-closes)
    - [spawn - "Run callback in a scope; or fire-and-forget with spawn.task"](#spawn---run-callback-in-a-scope-or-fire-and-forget-with-spawntask)
    - [spawnScope - "Group fire-and-forget tasks under one scope"](#spawnscope---group-fire-and-forget-tasks-under-one-scope)
  - [Zero-friction API](#zero-friction-api)
  - [Task naming](#task-naming)
  - [Opinionated helpers](#opinionated-helpers)
  - [Cancellation and cleanup](#cancellation-and-cleanup)
  - [Low-level API](#low-level-api)
  - [Debug and observability](#debug-and-observability)
  - [Strict mode](#strict-mode)
  - [Strict cancellation](#strict-cancellation)
  - [API reference](#api-reference)
  - [Examples](#examples)
  - [Requirements](#requirements)
  - [Contributing](#contributing)

---

## Install

```bash
npm install taskloom
```

**Requirements:** Node.js **22+** or browser; ESM (`"type": "module"` or `.mjs`). No runtime dependencies. The package supports both Node and browser via the same entry; bundlers (Vite, webpack, etc.) can resolve it for browser builds.

---

## Quick start

Run two fetches in parallel; if one fails, the other is canceled and you get a single error.

```js
import { sync } from "taskloom";

const [user, posts] = await sync(async ({ task }) => {
  const u = task((signal) => fetch("/api/user", { signal }).then((r) => r.json()));
  const p = task((signal) => fetch("/api/posts", { signal }).then((r) => r.json()));
  return await task.all([u, p]);
});
```

---

## Why Taskloom?

| Problem | Taskloom solves it |
|--------|----------------------|
| **One failure in parallel work** | First failure aborts the scope → other tasks are canceled, not left running. |
| **Promise.race losers keep running** | `race()` aborts the scope → only the winner completes; you don't pay for work you ignore. |
| **"First result" but other work must finish** | `rush()` returns the first result, then the scope waits for all tasks so nothing is orphaned. |
| **Background work with no cleanup** | `branch()` and `spawn()` tie work to a scope or return a `Task` - clear boundaries, optional cancellation. |
| **Cancellation** | Built on `AbortSignal`; your async work can respect `signal.aborted` and exit early; `scope.abort(reason)` and `onCancel(reason)` pass a reason. |

---

## Core concepts

- **Scope** - Owns an `AbortController`. Tasks created with that scope’s `signal` are canceled when the scope is closed (e.g. when `runInScope` or a primitive exits). You can call `scope.abort(reason)` to cancel all tasks in the scope; the reason is available to `onCancel` handlers.
- **Task** - An async computation with a lifecycle: running → completed, failed, or canceled. It is **awaitable** (you can `await task`) but is not a Promise. It is created with `runTask(work, options)` or via primitives (`task(work)`, `task(name, work)`). Each task receives an `AbortSignal`; when that signal is aborted, the task transitions to canceled and any registered `onCancel` handlers run before the await rejects.
- **Structured concurrency** - Work runs inside scopes. When a scope closes (success or failure), all scope-bound tasks are canceled. No orphan tasks unless you explicitly use `spawn`, which is not scope-bound.

---

## Primitives

High-level functions that create a scope and run your callback with a way to start tasks. All primitives (except `spawn` / `spawnScope`) are scope-bound: when the primitive’s scope closes, every task started inside it is canceled.

### sync - "All must succeed; first failure cancels the rest"

Runs all tasks concurrently and resolves only when **every** task has completed successfully. If any task rejects, the scope is aborted and the others are canceled; `sync` rejects with the first failure.

**Before (plain promises):** One failure → others keep running; no cleanup.

```js
const [a, b] = await Promise.all([
  fetch("/api/a").then((r) => r.json()),
  fetch("/api/b").then((r) => r.json()),
]);
```

**After (Taskloom):** First failure aborts the scope and cancels the other tasks.

```js
import { sync } from "taskloom";

const [a, b] = await sync(async ({ task }) => {
  const t1 = task((signal) => fetch("/api/a", { signal }).then((r) => r.json()));
  const t2 = task((signal) => fetch("/api/b", { signal }).then((r) => r.json()));
  return await task.all([t1, t2]);
});
```

---

### race - "First result wins; cancel the rest"

Resolves or rejects with the **first** task to settle. As soon as one task settles, the scope is aborted so every other task is canceled. The callback **must start at least one task** (via `task(work)` or `task(name, work)`); otherwise `race` throws.

**Before:** `Promise.race` returns the first result, but the "losers" keep running.

**After:** First result wins; all other tasks are canceled.

```js
import { race } from "taskloom";

const first = await race(async ({ task }) => {
  task((signal) => fetch("/api/fast", { signal }).then((r) => r.json()));
  task((signal) => fetch("/api/slow", { signal }).then((r) => r.json()));
});
```

---

### rush - "First result back, wait for all (no orphans)"

Returns as soon as the **first** task settles, but the scope stays open until **every** started task has settled. Other tasks are **not** canceled; you get the first result and no orphan work. The callback **must start at least one task** (via `task(work)` or `task(name, work)`); otherwise `rush` throws.

```js
import { rush } from "taskloom";

const first = await rush(async ({ task }) => {
  task((signal) => fetch("/api/a", { signal }).then((r) => r.json()));
  task((signal) => fetch("/api/b", { signal }).then((r) => r.json()));
});
```

---

### branch - "Background work in a scope; cancel when scope closes"

Use **inside** `runInScope` (or inside another primitive). Starts tasks and **returns immediately**; the code after `branch(...)` runs in parallel with the branch body. When the **enclosing scope** completes (e.g. when the `runInScope` callback settles), the branch scope is closed and any still-running tasks started in the branch are canceled.

```js
import { branch, runInScope } from "taskloom";

await runInScope(async () => {
  branch(async ({ task }) => {
    task(() => fetch("/api/log"));
    task(() => sendAnalytics());
  });
  // Runs immediately, in parallel with branch tasks
  await doOtherWork();
});
// Scope closed → branch tasks are canceled if still running
```

---

### spawn - "Run callback in a scope; or fire-and-forget with spawn.task"

**`spawn(callback)`** runs the callback with a `TaskloomContext` (`{ task, scope }`) in a new scope. The scope is linked to the parent when called from inside `runInScope` or another primitive, so parent abort cancels the spawn. Returns a `Task<R>` for the callback result.

**`spawn.task(work)`** runs a single async work function **without** attaching it to the current scope. The call returns a `Task` immediately; the work runs independently. The task is **not** canceled when the caller’s scope closes. Callable from sync or async code.

```js
import { spawn } from "taskloom";

// Callback form: same shape as sync/race; scope linked to parent when in scope
const result = await spawn(async ({ task }) => {
  const a = await task(async () => 1);
  const b = await task(async () => 2);
  return a + b;
});
// result === 3

// Fire-and-forget: no scope linkage
const task = spawn.task(() => fetch("/api/notify").then((r) => r.json()));
// Optional: await task later, or let it run to completion on its own
```

---

### spawnScope - "Group fire-and-forget tasks under one scope"

Creates a scope for fire-and-forget work. The callback receives `TaskloomContext` (`{ task, scope }`); use `task(work)` to start tasks. Returns when the callback settles; does **not** wait for the spawned tasks.

```js
import { spawnScope } from "taskloom";

await spawnScope(async ({ task }) => {
  task(() => notifyServiceA());
  task(() => notifyServiceB());
});
// Callback has settled; spawned tasks continue independently
```

---

## Task naming

For logging and debugging you can name tasks:

- `task(work)` - one argument: the work function.
- `task(name, work)` - string name first, then work.
- `task(work, { name: "..." })` - work first, then options with optional `name`.

The name is used in errors, strict-cancellation warnings, and task-tree introspection when debug is enabled. Task behavior (lifecycle, cancellation, result) is unchanged; only observability differs.

---

## Task combinators

On the context `task` object you get Promise-like combinators for already-started tasks:

- **`task.all(tasks)`** - Resolves with an array of results in order when all tasks fulfill; rejects with the first rejection.
- **`task.race(tasks)`** - Resolves or rejects with the first settlement.
- **`task.allSettled(tasks)`** - Resolves with an array of settlement results (fulfilled/rejected) in order.

Use them when you have multiple `Task` values (e.g. from `task(work)`) and want to await them together or take the first result.

---

## Opinionated helpers

Inside primitives you get a `task` object that includes:

- **`task.sleep(ms)`** - Promise that resolves after `ms` ms, or rejects if the scope’s signal is aborted first. Scope-bound; no timer leak on cancel.
- **`task.timeout(ms, work)`** - Runs `work(signal)` with a time limit. The work function receives the scope's **AbortSignal** so you can pass it to `fetch` or other cancelable APIs. If the limit elapses first, the scope is aborted and the Promise rejects with a timeout error.
- **`task.retry(fn, options)`** - Invokes `fn(signal)` on each attempt; receives the scope's **AbortSignal**. On failure retries with configurable `retries` and `backoff` (`'fixed'` or `'exponential'`). If the scope is aborted, retry stops and the Promise rejects.

These are available wherever you receive `TaskloomContext` (e.g. inside `sync`, `race`, `rush`, `branch`, `spawn`). Options for `retry` are typed (e.g. `RetryOptions`, `RetryBackoff`) and exported from the package.

---

## Cancellation and cleanup

- **Scope:** `scope.abort(reason?: unknown)` aborts the scope’s signal so all tasks using that signal are canceled. The optional `reason` is available as `signal.reason` and is passed to `onCancel` handlers.
- **Task:** `task.onCancel(handler: (reason?: unknown) => void)` registers a handler that runs when the task is canceled (e.g. scope closed or primitive aborted). Handlers run before the task’s `await` rejects. If the task is already canceled when you register, the handler is invoked immediately with the cancellation reason. Use the reason to branch (e.g. timeout vs request-aborted).

Your async work receives an `AbortSignal`; check `signal.aborted` or use `signal.reason` and exit early to cooperate with cancellation.

---

## Low-level API

- **`runInScope(callback)`** - Creates a scope, invokes `callback(scope)`, and closes the scope when the callback settles (fulfill or reject). All tasks created with `scope.signal` are canceled when the scope closes.
- **`runTask(work, options?)`** - Creates and runs a Task from `work(signal) => Promise<T>`. Options: `{ signal?: AbortSignal, name?: string }`. When `signal` is provided (e.g. `scope.signal`), the task is canceled when that signal aborts. Returns an awaitable `Task<T>`.

Use these when you need explicit scope boundaries or to run a single task with a parent signal.

---

## Debug and observability

- **`enableTaskDebug()`** - Enables collection of the live scope and task tree for subsequent execution. When disabled, no extra allocation or work (zero cost in production). Process-wide; Node 22+ built-ins only.
- **`subscribeTaskDebug(callback)`** - Registers a subscriber for realtime debug events (scope opened/closed, task registered/updated). Returns an unsubscribe function. When debug is enabled, the callback is invoked synchronously with event payloads. Subscriber throws are caught and logged so they don’t break the core.

When debug is enabled, the task tree can show scope IDs, task IDs, optional names, and status. With a subscriber, you can build live visualizations or logs.

---

## Strict mode

- **`enableStrictMode(options?)`** - Opt-in strict concurrency checks. When enabled, the library **throws** `StrictModeError` when it detects:
  - **Unstructured async** - Async work started outside any Taskloom scope (e.g. not under `runInScope` or a primitive).
  - **Ignored cancellation** - A task is canceled but had no observable cancellation handling (e.g. no `onCancel`, signal not passed).
  - **Orphan tasks** - A scope exits while a task created under that scope is still running.
  - **Branch without parent** - `branch()` is used without a parent scope (e.g. not inside `runInScope` or another primitive).

When strict mode is off, no checks run and behavior is unchanged. Options (e.g. `StrictModeOptions`) can provide `onWarn(message)` to be called with the violation message before the throw (e.g. for logging or tests). Import `StrictModeError` from `"taskloom"` to catch or assert on it.

---

## Strict cancellation

- **`withStrictCancellation(callback, options?)`** - Runs the callback in a scope (same shape as `runInScope`). In **development** (e.g. `NODE_ENV !== 'production'`), after the scope is aborted, if any task started under that scope is still running after a configurable threshold (e.g. 2 seconds), the library emits a one-time warning per task (including task name and duration). In production, no checks and no extra overhead; behavior matches `runInScope`. Use to teach correct cancellation without changing production behavior.

---

## API reference

**Primitives:** `sync`, `race`, `rush`, `branch`, `spawn`, `spawnScope`

**Scope and task:** `runInScope`, `runTask`, `Scope`, `Task`, `TaskStatus`, `RunTaskOptions`

**Context and callback types:** `TaskloomContext`, `SyncCallback`, `TaskOptions`, `UnwrapTasks`, `SettledTasks`

**Debug:** `enableTaskDebug`, `subscribeTaskDebug`, `TaskDebugEvent`

**Strict:** `enableStrictMode`, `StrictModeError`, `StrictModeOptions`, `withStrictCancellation`, `StrictCancellationOptions`

**Helpers (types):** `RetryOptions`, `RetryBackoff`

All of the above are exported from the package entry; import from `"taskloom"` only. Internal helpers are not re-exported. Public symbols are documented with JSDoc at their declaration site so IDE tooltips show behavior and semantics.

---

## Examples

Runnable examples and a short get-started guide live in **[examples/](examples/)**. Prerequisites: Node 22+, no extra deps. After `npm run build`, run e.g.:

```bash
node examples/sync-basic.mjs
node examples/race-basic.mjs
node examples/debug-mode.mjs
```

From the repo root. See **examples/README.md** for the full list (sync, race, rush, branch, spawn, scope-cancel, nested-primitives, debug-mode, strict-mode).

---

## Requirements

- **Node.js 22+** or **browser** - the same package works in both; async context uses native `AsyncLocalStorage` in Node and an in-library ponyfill in the browser.
- **ESM** - package is `"type": "module"`; use `import` from `"taskloom"`.
- **Zero runtime dependencies** - only `devDependencies` for build and tests.

---

## Contributing

```bash
npm install
npm run build
npm run test
```

To remove build output: `npm run clean`.

Tests live under `test/` and are not published. The published package contains only the `dist/` output and package metadata.
