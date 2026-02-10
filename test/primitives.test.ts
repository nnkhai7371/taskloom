/**
 * Primitives tests. All tests use only timers (setTimeout, setImmediate) and
 * in-process mocks—no real I/O or external services (per project conventions).
 */
import { describe, it, expect, vi } from "vitest";
import { sync, race, rush, branch, spawn, spawnScope, runInScope, type Task, type CancelReason } from "taskloom";

describe("sync (zero-friction run)", () => {
  it("zero-friction sync resolves when all run(work) tasks complete", async () => {
    const result = await sync(async ({ run }) => {
      const a = await run(async () => 1);
      const b = await run(async () => 2);
      return a + b;
    });
    expect(result).toBe(3);
  });

  it("zero-friction sync rejects on first failure and aborts scope (sibling tasks canceled via AbortSignal)", async () => {
    const err = new Error("one failed");
    let otherTask: Task<void> | undefined;
    await expect(
      sync(async ({ run }) => {
        run(async () => {
          throw err;
        });
        otherTask = run(
          async (signal) =>
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        await otherTask;
      }),
    ).rejects.toBe(err);
    expect(otherTask!.status).toBe("canceled");
    await expect(otherTask!).rejects.toMatchObject({ type: "scope-closed" });
  });

  it("onCancel on a task started via run(work) runs when scope is aborted (e.g. sibling fails)", async () => {
    const err = new Error("first fails");
    const order: string[] = [];
    await expect(
      sync(async ({ run }) => {
        run(async () => {
          throw err;
        });
        const sibling = run(
          async (signal) =>
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        sibling.onCancel(() => order.push("onCancel"));
        sibling.then(undefined, () => order.push("rejected"));
        await sibling;
      }),
    ).rejects.toBe(err);
    expect(order).toEqual(["onCancel", "rejected"]);
  });

  it("run(work) returns Task and sync waits for all such tasks", async () => {
    const results: number[] = [];
    await sync(async ({ run }) => {
      const t1 = run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 10;
      });
      const t2 = run(async () => 20);
      results.push(await t1, await t2);
    });
    expect(results).toEqual([10, 20]);
  });
});

describe("sync", () => {
  it("resolves when all tasks complete", async () => {
    const result = await sync(async ({ task }) => {
      const a = await task(async () => 1);
      const b = await task(async () => 2);
      return a + b;
    });
    expect(result).toBe(3);
  });

  it("rejects when one task fails and cancels others", async () => {
    const err = new Error("one failed");
    let otherTask: Task<void> | undefined;
    await expect(
      sync(async ({ task }) => {
        task(async () => {
          throw err;
        });
        otherTask = task(
          async (signal) =>
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        await otherTask;
      }),
    ).rejects.toBe(err);
    expect(otherTask!.status).toBe("canceled");
    await expect(otherTask!).rejects.toMatchObject({ type: "scope-closed" });
  });

  it("onCancel on sibling runs when one fails", async () => {
    const err = new Error("first fails");
    const order: string[] = [];
    await expect(
      sync(async ({ task }) => {
        task(async () => {
          throw err;
        });
        const sibling = task(
          async (signal) =>
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        sibling.onCancel(() => order.push("onCancel"));
        sibling.then(undefined, () => order.push("rejected"));
        await sibling;
      }),
    ).rejects.toBe(err);
    expect(order).toEqual(["onCancel", "rejected"]);
  });

  it("task(work) single-arg behaves as before (no name)", async () => {
    const result = await sync(async ({ task }) => {
      const a = await task(async () => 1);
      const b = await task(async () => 2);
      return a + b;
    });
    expect(result).toBe(3);
  });

  it("first failure in sync aborts scope, cancels other tasks, and sync rejects with that failure", async () => {
    const err = new Error("first failure");
    const tasks: Task<unknown>[] = [];
    await expect(
      sync(async ({ task }) => {
        task(async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw err;
        });
        for (let i = 0; i < 2; i++) {
          tasks.push(
            task(
              async (signal) =>
                new Promise<never>((_, reject) => {
                  signal.addEventListener("abort", () => reject(signal.reason), {
                    once: true,
                  });
                }),
            ),
          );
        }
        await Promise.all(tasks);
      }),
    ).rejects.toBe(err);
    for (const t of tasks) {
      expect(t.status).toBe("canceled");
    }
  });
});

describe("race (zero-friction run)", () => {
  it("resolves with first successful result using run()", async () => {
    const value = await race<number>(async ({ run }) => {
      run(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 1;
      });
      run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 2;
      });
    });
    expect(value).toBe(2);
  });
});

describe("race", () => {
  it("resolves with first successful result", async () => {
    const value = await race<number>(async ({ task }) => {
      task(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 1;
      });
      task(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 2;
      });
    });
    expect(value).toBe(2);
  });

  it("rejects when first result is a failure", async () => {
    const err = new Error("first fails");
    await expect(
      race(async ({ task }) => {
        task(async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw err;
        });
        task(async () => new Promise<number>(() => {})); // never settles
      }),
    ).rejects.toBe(err);
  });

  it("cancels non-winning tasks; awaiting them rejects with scope-closed reason", async () => {
    let loser: Task<number> | undefined;
    const winner = await race<number>(async ({ task }) => {
      task(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      });
      loser = task(
        async (signal) =>
          new Promise<number>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );
    });
    expect(winner).toBe(42);
    expect(loser!.status).toBe("canceled");
    await expect(loser!).rejects.toMatchObject({ type: "scope-closed" });
  });

  it("first rejection in race rejects with that error and other tasks are canceled (scope aborted)", async () => {
    const err = new Error("first rejection");
    const others: Task<number>[] = [];
    await expect(
      race<number>(async ({ task }) => {
        task(async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw err;
        });
        others.push(
          task(
            async (signal) =>
              new Promise<number>(() => {
                signal.addEventListener("abort", () => {}, { once: true });
              }),
          ),
          task(
            async (signal) =>
              new Promise<number>(() => {
                signal.addEventListener("abort", () => {}, { once: true });
              }),
          ),
        );
      }),
    ).rejects.toBe(err);
    for (const t of others) {
      expect(t.status).toBe("canceled");
    }
  });

  it("throws when callback does not start any tasks", async () => {
    await expect(race(async () => {})).rejects.toThrow(
      "race: callback did not start any tasks",
    );
  });
});

describe("rush (zero-friction run)", () => {
  it("resolves with first result using run() and waits for rest", async () => {
    const order: number[] = [];
    const value = await rush<number>(async ({ run }) => {
      run(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        return 1;
      });
      run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(2);
        return 2;
      });
    });
    expect(value).toBe(2);
    expect(order).toEqual([2, 1]);
  });
});

describe("rush", () => {
  it("resolves with first result and waits for rest", async () => {
    const order: number[] = [];
    const value = await rush<number>(async ({ task }) => {
      task(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        return 1;
      });
      task(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(2);
        return 2;
      });
    });
    expect(value).toBe(2);
    expect(order).toEqual([2, 1]);
  });

  it("throws when callback does not start any tasks", async () => {
    await expect(rush(async () => {})).rejects.toThrow(
      "rush: callback did not start any tasks",
    );
  });

  it("does not cancel other tasks on first completion", async () => {
    let slowTask: Task<number> | undefined;
    const fast = await rush<number>(async ({ task }) => {
      task(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      });
      slowTask = task(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 100;
      });
    });
    expect(fast).toBe(42);
    expect(slowTask!.status).toBe("completed");
    expect(await slowTask!).toBe(100);
  });
});

describe("cancellation (scope abort)", () => {
  it("aborting scope cancels child tasks (AbortSignal aborted; awaiting yields cancellation error)", async () => {
    let childTask: Task<never> | undefined;
    await runInScope(async (scope) => {
      await branch(async ({ task }) => {
        childTask = task(
          async (sig) =>
            new Promise<never>((_, reject) => {
              sig.addEventListener("abort", () => reject(sig.reason), {
                once: true,
              });
            }),
        );
      });
    });
    expect(childTask!.status).toBe("canceled");
    await expect(childTask!).rejects.toMatchObject({ type: "scope-closed" });
  });

  it("onCancel is invoked when scope is aborted", async () => {
    const cleanupRan: string[] = [];
    let taskSettled: PromiseLike<void>;
    await runInScope(async () => {
      await branch(async ({ task }) => {
        const t = task(
          async (sig) =>
            new Promise<never>((_, reject) => {
              sig.addEventListener("abort", () => reject(sig.reason), {
                once: true,
              });
            }),
        );
        t.onCancel(() => cleanupRan.push("onCancel"));
        taskSettled = t.then(undefined, () => {});
      });
    });
    await taskSettled!;
    expect(cleanupRan).toEqual(["onCancel"]);
  });

  it("onCancel receives scope-closed variant when scope closes (e.g. race first settles)", async () => {
    let loserReason: CancelReason | undefined;
    const first = await race<string>(async ({ run }) => {
      run(async (signal) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }).onCancel((r) => {
        loserReason = r;
      });
      return await run(async () => "winner");
    });
    expect(first).toBe("winner");
    expect(loserReason).toMatchObject({ type: "scope-closed" });
  });
});

describe("branch (zero-friction run)", () => {
  it("returns before tasks complete when using run()", async () => {
    let completed = false;
    await branch(async ({ run }) => {
      const t = run(async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed = true;
      });
      t.then(undefined, () => {}); // scope close cancels; consume rejection
    });
    expect(completed).toBe(false);
  });
});

describe("branch", () => {
  // Branch is intended to be used inside runInScope (or sync/race/rush). With a parent scope,
  // branch returns immediately, the next expression runs in parallel, and branch tasks are
  // canceled when the enclosing scope completes. Without runInScope, branch scope closes
  // when the callback returns (dev warning is emitted).
  it("returns before tasks complete", async () => {
    let completed = false;
    await branch(async ({ task }) => {
      const t = task(async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed = true;
      });
      t.then(undefined, () => {}); // scope close cancels this task; consume rejection to avoid unhandled
    });
    expect(completed).toBe(false);
  });

  it("when parent scope closes, branch tasks are canceled and onCancel runs", async () => {
    const order: string[] = [];
    let taskSettled: PromiseLike<void>;
    await runInScope(async () => {
      await branch(async ({ task }) => {
        const t = task(
          async (sig) =>
            new Promise<never>((_, reject) => {
              sig.addEventListener("abort", () => reject(sig.reason), {
                once: true,
              });
            }),
        );
        t.onCancel(() => order.push("onCancel"));
        taskSettled = t.then(undefined, () => {
          order.push("rejected");
        });
      });
    });
    await taskSettled!;
    expect(order).toEqual(["onCancel", "rejected"]);
  });

  it("when continuation after branch completes first, branch tasks are canceled (AbortSignal aborted, onCancel runs)", async () => {
    const order: string[] = [];
    let branchTaskSettled: PromiseLike<void>;
    await runInScope(async () => {
      branch(async ({ task }) => {
        const t = task(
          async (sig) =>
            new Promise<never>((_, reject) => {
              sig.addEventListener("abort", () => reject(sig.reason), {
                once: true,
              });
            }),
        );
        t.onCancel(() => order.push("onCancel"));
        branchTaskSettled = t.then(undefined, () => {
          order.push("rejected");
        });
      });
      order.push("continuation");
      await new Promise((r) => setTimeout(r, 20));
    });
    await branchTaskSettled!;
    expect(order).toEqual(["continuation", "onCancel", "rejected"]);
  });

  it("branch returns immediately and next expression runs in parallel with branch body", async () => {
    const order: string[] = [];
    await runInScope(async () => {
      branch(async ({ task }) => {
        order.push("branch-started");
        const t = task(async () => {
          await new Promise((r) => setTimeout(r, 50));
          order.push("branch-task-done");
        });
        t.then(undefined, () => {}); // consume cancellation rejection
      });
      order.push("next-ran");
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(order).toEqual(["branch-started", "next-ran"]);
    expect(order).not.toContain("branch-task-done");
  });
});

describe("scope boundaries", () => {
  it("scope-bound tasks (e.g. sync/branch/runInScope) do not outlive scope when scope completes or is aborted", async () => {
    let childTask: Task<void> | undefined;
    await runInScope(async () => {
      await branch(async ({ task }) => {
        childTask = task(
          async (signal) =>
            new Promise<void>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        );
      });
    });
    expect(childTask!.status).toBe("canceled");
    await childTask!.then(undefined, () => {});
  });
});

describe("nested primitives", () => {
  describe("sync inside sync", () => {
    it("all inner and outer tasks complete (resolve after all work; no tasks left running)", async () => {
      const order: number[] = [];
      const result = await sync(async ({ task }) => {
        const innerResult = await task(async () => {
          return await sync(async ({ task: innerTask }) => {
            const a = innerTask(async () => {
              await new Promise((r) => setTimeout(r, 5));
              order.push(1);
              return 10;
            });
            const b = innerTask(async () => {
              order.push(2);
              return 20;
            });
            return (await a) + (await b);
          });
        });
        order.push(3);
        return innerResult;
      });
      expect(result).toBe(30);
      expect(order).toEqual([2, 1, 3]);
    });

    it("outer failure aborts inner sync (scope abort cancels inner tasks; outer sync rejects with first failure)", async () => {
      const err = new Error("outer task failed");
      let innerTask: Task<number> | undefined;
      await expect(
        sync(async ({ task }) => {
          task(async () => {
            await new Promise((r) => setTimeout(r, 2));
            throw err;
          });
          await task(async () => {
            return await sync(async ({ task: t }) => {
              innerTask = t(
                async (signal) =>
                  new Promise<number>((_, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  }),
              );
              await innerTask;
              return 0;
            });
          });
        }),
      ).rejects.toBe(err);
      await expect(innerTask!).rejects.toMatchObject({ type: "scope-closed" });
      expect(innerTask!.status).toBe("canceled");
    });
  });

  describe("race inside sync", () => {
    it("inner race completes then outer completes (outer sync resolves only after inner race has settled)", async () => {
      const order: string[] = [];
      const result = await sync(async ({ task }) => {
        return await task(async () => {
          const raceResult = await race<number>(async ({ task: t }) => {
            t(async () => {
              await new Promise((r) => setTimeout(r, 20));
              order.push("race-slow");
              return 1;
            });
            t(async () => {
              await new Promise((r) => setTimeout(r, 5));
              order.push("race-fast");
              return 2;
            });
          });
          order.push("after-race");
          return raceResult;
        });
      });
      expect(result).toBe(2);
      expect(order).toContain("race-fast");
      expect(order).toContain("after-race");
    });

    it("outer failure aborts inner race (inner race scope aborted; outer sync rejects with first failure)", async () => {
      const err = new Error("outer failed");
      const innerTasks: Task<number>[] = [];
      await expect(
        sync(async ({ task }) => {
          task(async () => {
            await new Promise((r) => setTimeout(r, 2));
            throw err;
          });
          await task(async () => {
            return await race<number>(async ({ task: t }) => {
              innerTasks.push(
                t(
                  async (signal) =>
                    new Promise<number>((_, reject) => {
                      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    }),
                ),
                t(
                  async (signal) =>
                    new Promise<number>((_, reject) => {
                      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    }),
                ),
              );
            });
          });
        }),
      ).rejects.toBe(err);
      for (const t of innerTasks) {
        await expect(t).rejects.toMatchObject({ type: "scope-closed" });
        expect(t.status).toBe("canceled");
      }
    });
  });

  describe("rush inside sync", () => {
    it("inner rush returns first result, outer waits for all (outer sync resolves after inner rush scope fully settled)", async () => {
      const order: number[] = [];
      const result = await sync(async ({ task }) => {
        return await task(async () => {
          const rushResult = await rush<number>(async ({ task: t }) => {
            t(async () => {
              await new Promise((r) => setTimeout(r, 15));
              order.push(1);
              return 10;
            });
            t(async () => {
              await new Promise((r) => setTimeout(r, 5));
              order.push(2);
              return 20;
            });
          });
          order.push(3);
          return rushResult;
        });
      });
      expect(result).toBe(20);
      expect(order).toEqual([2, 1, 3]);
    });

    it("outer failure aborts inner rush (inner scope aborted; outer sync rejects with first failure)", async () => {
      const err = new Error("outer failed");
      let innerTask: Task<number> | undefined;
      await expect(
        sync(async ({ task }) => {
          task(async () => {
            await new Promise((r) => setTimeout(r, 2));
            throw err;
          });
          await task(async () => {
            return await rush<number>(async ({ task: t }) => {
              innerTask = t(
                async (signal) =>
                  new Promise<number>((_, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  }),
              );
              await innerTask;
              return 0;
            });
          });
        }),
      ).rejects.toBe(err);
      await expect(innerTask!).rejects.toMatchObject({ type: "scope-closed" });
      expect(innerTask!.status).toBe("canceled");
    });
  });

  describe("branch inside sync", () => {
    it("outer sync waits for outer task which uses inner branch (inner branch tasks canceled when inner scope closes)", async () => {
      let branchTaskCompleted = false;
      let innerTask: Task<void> | undefined;
      await sync(async ({ task }) => {
        await task(async () => {
          await branch(async ({ task: t }) => {
            innerTask = t(async () => {
              await new Promise((r) => setTimeout(r, 100));
              branchTaskCompleted = true;
            });
            innerTask!.then(undefined, () => {});
          });
        });
      });
      expect(innerTask!.status).toBe("canceled");
      expect(branchTaskCompleted).toBe(false);
      await innerTask!.then(undefined, () => {});
    });

    it("outer failure aborts inner branch scope (inner branch tasks canceled via scope abort; outer sync rejects with first failure)", async () => {
      const err = new Error("outer failed");
      let innerBranchTask: Task<void> | undefined;
      await expect(
        sync(async ({ task }) => {
          task(async () => {
            await new Promise((r) => setTimeout(r, 2));
            throw err;
          });
          await task(async () => {
            await branch(async ({ task: t }) => {
              innerBranchTask = t(
                async (signal) =>
                  new Promise<never>((_, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  }),
              );
              innerBranchTask.then(undefined, () => {});
              await innerBranchTask;
            });
          });
        }),
      ).rejects.toBe(err);
      await expect(innerBranchTask!).rejects.toMatchObject({ type: "scope-closed" });
      expect(innerBranchTask!.status).toBe("canceled");
    });
  });
});

describe("spawnScope (zero-friction spawn)", () => {
  it("invokes callback with run(); each run(work) spawns a task", async () => {
    const results: number[] = [];
    await spawnScope(async ({ run }) => {
      const t1 = run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 10;
      });
      const t2 = run(async () => 20);
      results.push(await t1, await t2);
    });
    expect(results).toEqual([10, 20]);
  });

  it("returns when callback settles without awaiting spawned tasks", async () => {
    let callbackSettled = false;
    let taskCompleted = false;
    await spawnScope(async ({ run }) => {
      run(async () => {
        await new Promise((r) => setTimeout(r, 50));
        taskCompleted = true;
      });
      callbackSettled = true;
    });
    expect(callbackSettled).toBe(true);
    expect(taskCompleted).toBe(false);
  });
});

describe("spawn", () => {
  it("work runs", async () => {
    const t = spawn(async () => 1);
    expect(await t).toBe(1);
  });

  it("spawn expression completes immediately (returns before spawned work resolves)", async () => {
    let continuationRan = false;
    const t = spawn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 1;
    });
    continuationRan = true;
    expect(continuationRan).toBe(true);
    expect(await t).toBe(1);
  });

  it("next expression runs immediately after spawn (expression2 runs without waiting for work)", async () => {
    const order: string[] = [];
    const work = spawn(async () => {
      order.push("work-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("work-end");
      return 1;
    });
    order.push("after-spawn");
    await work;
    expect(order).toContain("after-spawn");
    expect(order).toContain("work-end");
    expect(order.indexOf("after-spawn")).toBeLessThan(order.indexOf("work-end"));
    expect(order).toEqual(["work-start", "after-spawn", "work-end"]);
  });

  it("spawn is allowed outside async context (sync call site)", () => {
    let spawnedDone = false;
    const t = spawn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      spawnedDone = true;
      return 2;
    });
    expect(t).toBeDefined();
    return t.then((v) => {
      expect(v).toBe(2);
      expect(spawnedDone).toBe(true);
    });
  });

  it("when caller scope closes, spawned work is NOT canceled", async () => {
    let spawnedDone = false;
    let spawnedTask: Task<number> | undefined;
    await runInScope(async () => {
      spawnedTask = spawn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        spawnedDone = true;
        return 1;
      });
    });
    await spawnedTask;
    expect(spawnedDone).toBe(true);
  });

  it("spawn is not scope-bound—spawned work is not canceled when caller scope closes and may complete after scope ends", async () => {
    let scopeClosed = false;
    let spawnedTask: Task<number> | undefined;
    await runInScope(async () => {
      spawnedTask = spawn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });
    });
    scopeClosed = true;
    const result = await spawnedTask!;
    expect(scopeClosed).toBe(true);
    expect(result).toBe(42);
  });
});

describe("optional task name", () => {
  it("task(name, work) associates name with task; name visible in rejection when task fails", async () => {
    await expect(
      sync(async ({ task }) => {
        try {
          await task("named-fail", async () => {
            throw new Error("oops");
          });
        } catch (e) {
          expect((e as { taskName?: string }).taskName).toBe("named-fail");
          throw e;
        }
      }),
    ).rejects.toMatchObject({ message: "oops" });
  });

  it("task(name, work) exposes taskName on cancel", async () => {
    let caught: unknown;
    await runInScope(async () => {
      await branch(async ({ task }) => {
        const t = task(
          "named-cancel",
          async (sig) =>
            new Promise<never>((_, reject) => {
              sig.addEventListener("abort", () => reject(sig.reason), {
                once: true,
              });
            }),
        );
        t.then(undefined, (reason) => {
          caught = reason;
        });
      });
    });
    expect((caught as { taskName?: string }).taskName).toBe("named-cancel");
  });
});

describe("primitives smoke (success paths)", () => {
  it("exercises sync, race, rush, branch, spawn success paths", async () => {
    await sync(async ({ task }) => {
      await task(async () => 1);
      await task(async () => 2);
    });

    const r = await race<number>(async ({ task }) => {
      task(async () => 10);
      task(async () => {
        await new Promise((x) => setTimeout(x, 5));
        return 20;
      });
    });
    expect(r).toBe(10);

    const rushVal = await rush<number>(async ({ task }) => {
      task(async () => {
        await new Promise((x) => setTimeout(x, 10));
        return 100;
      });
      task(async () => {
        await new Promise((x) => setTimeout(x, 2));
        return 200;
      });
    });
    expect(rushVal).toBe(200);

    await branch(async ({ task }) => {
      task(async () => 1);
      task(async () => 2);
    });

    const sp = spawn(async () => 42);
    expect(await sp).toBe(42);
  });
});

describe("task.sleep", () => {
  it("resolves after the given delay when not aborted", async () => {
    const start = Date.now();
    await sync(async ({ task }) => {
      await task.sleep(50);
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("rejects and clears timer when scope signal aborts mid-sleep", async () => {
    const { runInScope } = await import("taskloom");
    const { createContext } = await import("../src/primitives.js");
    await expect(
      runInScope(async (scope) => {
        const ctx = createContext(scope);
        setTimeout(() => scope.abort(), 50);
        return ctx.task.sleep(1000);
      }),
    ).rejects.toMatchObject({ type: "user-abort" });
  });

  it("rejects immediately when scope is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const scope = { signal: controller.signal, abort: () => controller.abort() };
    const { createContext } = await import("../src/primitives.js");
    const ctx = createContext(scope as import("taskloom").Scope);
    await expect(ctx.task.sleep(10)).rejects.toBe(controller.signal.reason);
  });
});

describe("task.timeout", () => {
  it("resolves with work result when work completes within limit", async () => {
    const result = await sync(async ({ task }) => {
      return await task.timeout(5000, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      });
    });
    expect(result).toBe(42);
  });

  it("rejects and aborts scope when time limit is exceeded", async () => {
    await expect(
      sync(async ({ task }) => {
        await task.timeout(50, async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 1;
        });
      }),
    ).rejects.toMatchObject({ message: /Timeout after 50 ms/, name: "TimeoutError" });
  });

  it("child tasks started inside timed work are canceled when timeout fires", async () => {
    let childTask: Task<void> | undefined;
    await expect(
      sync(async ({ task }) => {
        await task.timeout(100, async () => {
          childTask = task(
            async (signal) =>
              new Promise<never>((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          );
          await new Promise((r) => setTimeout(r, 500));
          return 1;
        });
      }),
    ).rejects.toMatchObject({ type: "timeout", ms: 100 });
    expect(childTask!.status).toBe("canceled");
  });

  it("onCancel receives timeout variant when task times out (reason.type === 'timeout', reason.ms)", async () => {
    let receivedReason: CancelReason | undefined;
    await expect(
      sync(async ({ task }) => {
        await task.timeout(80, async () => {
          const t = task(
            async (signal) =>
              new Promise<never>((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          );
          t.onCancel((r) => {
            receivedReason = r;
          });
          await new Promise((r) => setTimeout(r, 200));
          return 1;
        });
      }),
    ).rejects.toMatchObject({ type: "timeout", ms: 80 });
    expect(receivedReason).toBeDefined();
    expect(receivedReason).toMatchObject({ type: "timeout", ms: 80 });
  });

  it("nested task.timeout: inner requested 200ms is capped by parent remaining ~50ms and rejects on timeout", async () => {
    await expect(
      sync(async ({ task }) => {
        await task.timeout(100, async () => {
          await new Promise((r) => setTimeout(r, 50));
          await task.timeout(200, async () => {
            await new Promise((r) => setTimeout(r, 200));
            return 1;
          });
        });
      }),
    ).rejects.toMatchObject({ message: /Timeout after \d+ ms/, name: "TimeoutError" });
  });

  it("parent timeout(60): child task.timeout(30, work) gets full 30ms and resolves", async () => {
    const result = await sync(async ({ task }) => {
      return await task.timeout(60, async () => {
        return await task.timeout(30, async () => {
          await new Promise((r) => setTimeout(r, 10));
          return "ok";
        });
      });
    });
    expect(result).toBe("ok");
  });

  it("root scope (no timeout): task.timeout(ms, work) uses ms as-is, no capping", async () => {
    await expect(
      sync(async ({ task }) => {
        await task.timeout(80, async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 1;
        });
      }),
    ).rejects.toMatchObject({ message: "Timeout after 80 ms", name: "TimeoutError" });
  });
});

describe("task.retry", () => {
  it("resolves with result when fn succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await sync(async ({ task }) => task.retry(fn, { retries: 3, backoff: "exponential" }));
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resolves when fn succeeds on a later attempt", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("a")).mockRejectedValueOnce(new Error("b")).mockResolvedValue(100);
    const result = await sync(async ({ task }) =>
      task.retry(fn, { retries: 3, backoff: "fixed", initialDelayMs: 5 }),
    );
    expect(result).toBe(100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rejects when all attempts are exhausted", async () => {
    const err = new Error("always fails");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      sync(async ({ task }) => task.retry(fn, { retries: 2 })),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops and rejects on scope abort during retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const { runInScope } = await import("taskloom");
    const createContext = (await import("../src/primitives.js")).createContext;
    await expect(
      runInScope(async (scope) => {
        const ctx = createContext(scope);
        setTimeout(() => scope.abort(), 30);
        return ctx.task.retry(fn, { retries: 5, backoff: "exponential", initialDelayMs: 100 });
      }),
    ).rejects.toMatchObject({ type: "user-abort" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backoff behavior: exponential increases delay", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      delays.push(Date.now());
      if (delays.length < 3) throw new Error("retry");
      return 1;
    });
    const t0 = Date.now();
    await sync(async ({ task }) =>
      task.retry(fn, { retries: 3, backoff: "exponential", initialDelayMs: 30 }),
    );
    const elapsed = Date.now() - t0;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeGreaterThanOrEqual(30 + 60);
    const d1 = delays[1] - delays[0];
    const d2 = delays[2] - delays[1];
    expect(d1).toBeGreaterThanOrEqual(25);
    expect(d2).toBeGreaterThanOrEqual(55);
  });
});
