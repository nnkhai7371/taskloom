/**
 * Nested primitives — running sync, race, rush, or branch inside another primitive.
 * Inner scope is a child of the outer scope; when the outer aborts, the inner is aborted too.
 * Import from package entry only.
 */
import { sync, race, rush } from "taskloom";

const delay = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

// Sync inside sync: outer waits for all inner work
const syncInSync = await sync(async ({ run }) => {
  const inner = await run(async () => {
    return await sync(async ({ run: r }) => {
      const a = r(() => delay(20, 1));
      const b = r(() => delay(10, 2));
      return (await a) + (await b);
    });
  });
  return inner;
});
console.log("sync inside sync:", syncInSync);
// sync inside sync: 3

// Race inside sync: outer resolves after inner race has settled
const raceInSync = await sync(async ({ run }) => {
  return await run(async () => {
    return await race(async ({ run: r }) => {
      r(() => delay(50, "slow"));
      r(() => delay(5, "fast"));
    });
  });
});
console.log("race inside sync:", raceInSync);
// race inside sync: fast

// Rush inside sync: outer waits for inner rush scope to fully settle
const order = [];
const rushInSync = await sync(async ({ run }) => {
  return await run(async () => {
    return await rush(async ({ run: r }) => {
      r(async () => {
        await delay(15);
        order.push("second");
        return 2;
      });
      r(async () => {
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
