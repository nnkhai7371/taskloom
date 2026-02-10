/**
 * Taskloom – task-based structured concurrency for Node.js
 * @module
 */
export {
  runTask,
  type Task,
  type TaskStatus,
  type RunTaskOptions,
  type TaskLifecycleHook,
  type CancelReason,
} from "./task.js";
export {
  runInScope,
  withStrictCancellation,
  type Scope,
  type StrictCancellationOptions,
} from "./scope.js";
export {
  sync,
  race,
  rush,
  branch,
  spawn,
  spawnScope,
  type TaskloomContext,
  type SyncCallback,
  type TaskOptions,
  type UnwrapTasks,
  type SettledTasks,
  type RetryOptions,
  type RetryBackoff,
} from "./primitives.js";
export {
  enableTaskDebug,
  subscribeTaskDebug,
  TaskloomDebugger,
  taskloomDebugger,
  type Logger,
  type TaskDebugEvent,
  type ScopeType,
} from "./debug.js";
export {
  enableStrictMode,
  StrictModeError,
  type StrictModeOptions,
} from "./strict-mode.js";
