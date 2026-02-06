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
const syncResult = await sync(async ({ run }) => {
  const a = run(() => delay(MED, "a"));
  const b = run(() => delay(SLOW, "b"));
  return [await a, await b];
});
console.log("sync result:", syncResult);

// race
const raceResult = await race(async ({ run }) => {
  run(() => delay(SLOW, "slow"));
  run(() => delay(FAST, "fast"));
});
console.log("race result:", raceResult);

// rush
const rushResult = await rush(async ({ run }) => {
  run(() => delay(MED + 200, "second"));
  run(() => delay(FAST, "first"));
});
console.log("rush result:", rushResult);

// branch (task may be canceled when scope closes)
await branch(async ({ run }) => {
  const t = run(() => delay(SLOW * 2, "bg"));
  t.then(undefined, () => {});
});
console.log("branch done");

// spawn (own scope; not tied to a parent scope)
const task = spawn(() => delay(MED, "spawned"));
console.log("spawn result:", await task);
