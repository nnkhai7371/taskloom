/**
 * Debug mode — realtime task flow. enableTaskDebug() turns on the built-in in-place tree
 * visualizer (when stdout is a TTY): the tree updates live as scopes and tasks run.
 * Run: node examples/debug-mode.mjs (from repo root after npm run build).
 * Imports only from taskloom and Node built-ins.
 */
import { enableTaskDebug, sync, race, rush, branch, spawn } from "taskloom";

enableTaskDebug();

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

// Longer delays so the in-place tree updates are visible when run in a TTY.
const SLOW = 800;
const MED = 400;
const FAST = 200;

// sync
const syncResult = await sync(async ({ task }) => {
  const a = task(() => delay(MED, "a"));
  const b = task(() => delay(SLOW, "b"));
  return await task.all([a, b]);
});
console.log("sync result:", syncResult);

// race
const raceResult = await race(async ({ task }) => {
  task(() => delay(SLOW, "slow"));
  task(() => delay(FAST, "fast"));
});
console.log("race result:", raceResult);

// rush
const rushResult = await rush(async ({ task }) => {
  task(() => delay(MED + 200, "second"));
  task(() => delay(FAST, "first"));
});
console.log("rush result:", rushResult);

// branch (task may be canceled when scope closes)
await branch(async ({ task }) => {
  const t = task(() => delay(SLOW * 2, "bg"));
  t.then(undefined, () => {});
});
console.log("branch done");

// spawn.task (fire-and-forget; not tied to a parent scope)
const task = spawn.task(() => delay(MED, "spawned"));
console.log("spawn result:", await task);
