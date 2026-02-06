/**
 * runInScope + cancellation — scope aborts when callback returns; task.onCancel runs on cancel.
 * Import from package entry only.
 */
import { runInScope, runTask } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const result = await runInScope(async (scope) => {
  const task = runTask(
    async (signal) => {
      await delay(20, "work");
      if (signal.aborted) return "aborted";
      return "done";
    },
    { signal: scope.signal },
  );
  task.onCancel((reason) => {
    console.log("task onCancel:", reason);
  });
  return await task;
});

console.log("runInScope result:", result);
// When scope closes (callback returns), scope aborts. If we had started
// a long-running task and returned early, that task would be canceled and onCancel would run.
