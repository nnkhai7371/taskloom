/**
 * Nested primitives — running sync, race, rush, or branch inside another primitive.
 * Inner scope is a child of the outer scope; when the outer aborts, the inner is aborted too.
 * Import from package entry only.
 */
import { sync, race, rush } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

// Sync inside sync: outer waits for all inner work
const syncInSync = await sync(async ({ task }) => {
  const inner = await task(async () => {
    return await sync(async ({ task: t }) => {
      const a = t(() => delay(20, 1));
      const b = t(() => delay(10, 2));
      return await t.all([a, b]).then(([x, y]) => x + y);
    });
  });
  return inner;
});
console.log("sync inside sync:", syncInSync);
// sync inside sync: 3

// Race inside sync: outer resolves after inner race has settled
const raceInSync = await sync(async ({ task }) => {
  return await task(async () => {
    return await race(async ({ task: t }) => {
      t(() => delay(50, "slow"));
      t(() => delay(5, "fast"));
    });
  });
});
console.log("race inside sync:", raceInSync);
// race inside sync: fast

// Rush inside sync: outer waits for inner rush scope to fully settle
const order = [];
const rushInSync = await sync(async ({ task }) => {
  return await task(async () => {
    return await rush(async ({ task: t }) => {
      t(async () => {
        await delay(15);
        order.push("second");
        return 2;
      });
      t(async () => {
        await delay(5);
        order.push("first");
        return 1;
      });
    });
  });
});
console.log("rush inside sync:", rushInSync, "order:", order);
// rush inside sync: 1 order: [ 'first', 'second' ]

console.log("nested primitives done");
