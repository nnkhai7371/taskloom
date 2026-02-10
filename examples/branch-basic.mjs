/**
 * branch — background work in a scope; canceled when scope closes.
 *
 * Pseudo structure:
 *   expression0
 *   branch:
 *     slow-expression
 *     mid-expression
 *     fast-expression
 *   expression1
 *
 * Branch returns immediately; expression1 runs in parallel with the branch body.
 * When the scope completes (after expression1), any still-running branch tasks are canceled.
 */
import { branch, runInScope } from "taskloom";

const delay = (ms, label) =>
  new Promise((resolve) => setTimeout(() => resolve(label), ms));

await runInScope(async () => {
  // expression0
  console.log("expression0");

  // branch: slow, mid, fast (run concurrently inside branch)
  branch(async ({ task }) => {
    task(() => delay(300, "slow"))
      .then((v) => console.log("  branch:", v))
      .catch((e) => console.log("  branch: slow canceled", e?.name ?? e));
    task(() => delay(150, "mid"))
      .then((v) => console.log("  branch:", v))
      .catch((e) => console.log("  branch: mid canceled", e?.name ?? e));
    task(() => delay(50, "fast"))
      .then((v) => console.log("  branch:", v))
      .catch((e) => console.log("  branch: fast canceled", e?.name ?? e));
  });

  // expression1 (runs immediately, in parallel with branch)
  console.log("expression1");
  await delay(80); // fast (50ms) completes; mid (150ms) and slow (300ms) are canceled
});
console.log("scope done");
