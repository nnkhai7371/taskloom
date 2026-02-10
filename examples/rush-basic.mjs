/**
 * rush — first result back, then scope waits for all (no orphans).
 * Import from package entry only.
 */
import { rush } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const first = await rush(async ({ task }) => {
  task(() => delay(100, "second"));
  task(() => delay(20, "first"));
});

console.log("rush first:", first);
// rush first: first
// (scope still waits for the other task before closing)
