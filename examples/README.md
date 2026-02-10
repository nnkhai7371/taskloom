# Taskloom examples

Runnable examples for Taskloom’s structured concurrency primitives. No extra dependencies — Node 22+ and this repo only.

## Prerequisites

- **Node 22+**
- Clone the repo and install: `npm install`
- Build the package: `npm run build`

No additional npm dependencies are required to run the examples (they use the built Taskloom package and Node built-ins).

## How to run

From the **repo root**:

1. Build (if you haven’t): `npm run build`
2. Run an example: `node examples/<name>.mjs`  
   Example: `node examples/sync-basic.mjs`

Examples are `.mjs` and import `taskloom`, which resolves to the built `dist/` when run from the repo root.

## Example files → primitives

| File | Primitive | Description |
|------|-----------|-------------|
| `sync-basic.mjs` | `sync` | Run tasks in parallel; first failure cancels the rest. |
| `limit-batch.mjs` | `task.limit` | Cap concurrency for batch work (e.g. API calls); at most N at a time. |
| `race-basic.mjs` | `race` | First result wins; other tasks are canceled. |
| `rush-basic.mjs` | `rush` | First result returned; scope waits for all (no orphans). |
| `branch-basic.mjs` | `branch` | Background work in a scope; canceled when scope closes. |
| `spawn-basic.mjs` | `spawn.task` | Fire-and-forget that returns a `Task` handle (no scope linkage). |
| `scope-cancel.mjs` | `runInScope` / cancellation | Scope and cancellation (e.g. `onCancel`, `runInScope`). |
| `nested-primitives.mjs` | `sync`, `race`, `rush` (nested) | Running a primitive inside another; inner scope aborts when outer aborts. |
| `debug-mode.mjs` | `enableTaskDebug`, `subscribeTaskDebug` | Realtime task flow: prints each scope/task event as it happens; full tree when root scope closes. Run: `node examples/debug-mode.mjs`. |
| `strict-mode.mjs` | `enableStrictMode` | Opt-in warnings for unstructured async, orphans, etc.; optional `onWarn` to capture. |

All examples import only from the package entry (`taskloom`), not from internal paths.
