# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Breaking – Pre-1.0 API cleanup

This release unifies the API around `task` only, makes helpers cancellation-aware, adds Promise-like combinators, and aligns spawn with the same callback shape as sync/race. **Migration steps:**

1. **`run` removed**  
   Replace `run(work)` with `task(work)` (or `task(name, work)`).  
   - Before: `sync(async ({ run }) => { const a = run(fetchA); return await a; })`  
   - After: `sync(async ({ task }) => { const a = task(fetchA); return await a; })`

2. **Context type**  
   Callbacks receive only `TaskloomContext` (`{ task, scope }`). Types `ZeroFrictionSyncContext`, `ZeroFrictionSyncCallback`, and `SyncContext` are removed. Use `TaskloomContext` and `SyncCallback<R>` from the package entry.

3. **`task.timeout(ms, work)` and `task.retry(fn, options)`**  
   The work/fn is now called with the scope’s **AbortSignal** so you can pass it to `fetch` or other cancelable APIs.  
   - Before: `task.timeout(5000, async () => fetch(url))`  
   - After: `task.timeout(5000, async (signal) => fetch(url, { signal }))`  
   - Same for `task.retry(fn, options)`: `fn` is now `(signal: AbortSignal) => Promise<T>`.

4. **Spawn**  
   - **`spawn(work)`** is replaced by **`spawn.task(work)`** for the single fire-and-forget case (no scope linkage; returns immediately).  
   - **`spawn(callback)`** is the new overload: it runs the callback with `TaskloomContext` in a new scope (linked to parent when in scope) and returns a `Task<R>` for the callback result.  
   - **`spawnScope`** now passes `TaskloomContext` (`{ task, scope }`); use `task(work)` instead of `run(work)`.

5. **Task naming**  
   The options form is added: `task(work, { name: "..." })` in addition to `task(name, work)` and `task(work)`.

6. **Combinators**  
   Use `task.all(tasks)`, `task.race(tasks)`, and `task.allSettled(tasks)` on the context `task` object for already-started tasks. Types `UnwrapTasks` and `SettledTasks` are exported for result typing.

7. **Barrel exports**  
   The package no longer exports `run`, `PrimitivesContext`, `PrimitivesCallback`, `ZeroFrictionSyncContext`, `ZeroFrictionSyncCallback`, `SyncContext`, or `SpawnContext`. Use `TaskloomContext`, `SyncCallback`, `TaskOptions`, `UnwrapTasks`, and `SettledTasks` instead.
