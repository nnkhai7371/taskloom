/**
 * race — first result wins; other tasks are canceled.
 * Import from package entry only.
 */
import { race } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const first = await race(async ({ run }) => {
  run(() => delay(200, "slow"));
  run(() => delay(30, "fast"));
});

console.log("race winner:", first);
// race winner: fast
