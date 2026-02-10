/**
 * Strict mode — enableStrictMode() throws StrictModeError when misuse is detected.
 * Use onWarn to capture the message before the throw. Import from package entry only.
 */
import { enableStrictMode, StrictModeError, runTask, runInScope } from "taskloom";

const captured = [];
enableStrictMode({
  onWarn(message) {
    captured.push(message);
    console.log("[strict]", message);
  },
});

// runTask outside any scope throws when strict mode is enabled.
try {
  runTask(async () => "done");
} catch (err) {
  if (err instanceof StrictModeError) {
    console.log("Caught StrictModeError:", err.message);
  }
}
console.log("captured:", captured.length);

// Correct usage: run inside a scope (no throw).
const value = await runInScope(async (scope) => {
  return await runTask(async () => "done", { signal: scope.signal });
});
console.log("task result:", value);
