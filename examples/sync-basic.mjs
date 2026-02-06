/**
 * sync — run tasks in parallel; first failure cancels the rest.
 * Import from package entry only.
 */
import { sync } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const result = await sync(async ({ run }) => {
  const a = run(() => delay(50, "a"));
  const b = run(() => delay(30, "b"));
  return [await a, await b];
});

console.log("sync result:", result);
// sync result: [ 'a', 'b' ]
