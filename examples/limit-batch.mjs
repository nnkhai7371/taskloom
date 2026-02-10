/**
 * task.limit — cap concurrency for batch work (e.g. API calls).
 * At most N tasks run at once; scope abort rejects queued work.
 */
import { sync } from "taskloom";

// Simulate an API call that takes a bit of time
const fakeFetch = (id, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ id, data: `item-${id}` }), 50);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

const result = await sync(async ({ task }) => {
  const limit = task.limit(3); // at most 3 concurrent
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const promises = ids.map((id) =>
    limit((signal) => fakeFetch(id, signal)),
  );
  return await Promise.all(promises);
});

console.log("batch result:", result.map((r) => r.data).join(", "));
// batch result: item-1, item-2, item-3, item-4, item-5, item-6, item-7, item-8, item-9, item-10
