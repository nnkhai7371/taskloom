/**
 * Strict mode — enableStrictMode() warns about unstructured async, orphans, etc.
 * Use onWarn to capture warnings. Import from package entry only.
 */
import { enableStrictMode, spawn } from "taskloom";

const warnings = [];
enableStrictMode({
  onWarn(message) {
    warnings.push(message);
    console.log("[strict]", message);
  },
});

// Starting a task outside any scope (e.g. spawn at top level) triggers
// a strict-mode warning when strict mode is enabled.
const task = spawn(async () => {
  return "done";
});
const value = await task;
console.log("task result:", value);
console.log("warnings captured:", warnings.length);
