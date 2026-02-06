/**
 * spawn — fire-and-forget: expression completes immediately; next expression runs right after.
 * Pattern: expression0 → spawn(expression1) → expression2 (expression2 does not wait for expression1).
 */
import { spawn } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

// expression0
console.log("expression0");

// spawn { expression1 } — returns immediately; expression1 runs in background
const task = spawn(async () => {
  await delay(80, "spawned");
  console.log("expression1 (spawned) done");
  return "spawned";
});

// expression2 — runs immediately after spawn, without waiting for expression1
console.log("expression2 (spawn returned; expression1 still running)");

const value = await task;
console.log("spawn result:", value);
// Typical output order: expression0 → expression2 → expression1 done → spawn result
