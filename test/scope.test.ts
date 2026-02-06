import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInScope, runTask, withStrictCancellation, type Task } from "taskloom";

describe("runInScope", () => {
  it("runs callback with scope and returns the callback result", async () => {
    const value = await runInScope(async (scope) => {
      expect(scope).toBeDefined();
      expect(scope.signal).toBeDefined();
      expect(scope.signal.aborted).toBe(false);
      return 42;
    });
    expect(value).toBe(42);
  });

  it("rejects when callback throws", async () => {
    const err = new Error("callback failed");
    await expect(
      runInScope(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});

describe("scope and child tasks", () => {
  it("exiting scope (callback returns) cancels child task created with scope.signal; assert task status canceled and await rejects with cancellation error", async () => {
    let childTask: Task<void>;
    await runInScope(async (scope) => {
      childTask = runTask(
        async (signal) => {
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        { signal: scope.signal },
      );
      return "done";
    });
    expect(childTask!.status).toBe("canceled");
    await expect(childTask!).rejects.toMatchObject({ name: "AbortError" });
  });

  it("failing scope (callback throws) cancels child task; assert task canceled and await rejects with cancellation error", async () => {
    const err = new Error("scope failed");
    let childTask: Task<void>;
    await expect(
      runInScope(async (scope) => {
        childTask = runTask(
          async (signal) => {
            await new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
          { signal: scope.signal },
        );
        throw err;
      }),
    ).rejects.toBe(err);
    expect(childTask!.status).toBe("canceled");
    await expect(childTask!).rejects.toMatchObject({ name: "AbortError" });
  });

  it("onCancel handler on a scope-child task is invoked when scope closes (success or failure)", async () => {
    const order: string[] = [];
    await runInScope(async (scope) => {
      const child = runTask(
        async (signal) => {
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        { signal: scope.signal },
      );
      child.onCancel(() => order.push("onCancel"));
      child.then(undefined, () => order.push("rejected"));
      return "ok";
    });
    expect(order).toEqual(["onCancel", "rejected"]);
  });

  it("onCancel handler on scope-child task is invoked when scope closes with failure", async () => {
    const order: string[] = [];
    const err = new Error("scope throw");
    await expect(
      runInScope(async (scope) => {
        const child = runTask(
          async (signal) => {
            await new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
          { signal: scope.signal },
        );
        child.onCancel(() => order.push("onCancel"));
        child.then(undefined, () => order.push("rejected"));
        throw err;
      }),
    ).rejects.toBe(err);
    expect(order).toEqual(["onCancel", "rejected"]);
  });

  it("scope.abort(reason) sets signal.reason and task sees it", async () => {
    const reason = "request-aborted";
    let seenReason: unknown;
    await runInScope(async (scope) => {
      const child = runTask(
        async (signal) => {
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        { signal: scope.signal },
      );
      child.onCancel((r) => {
        seenReason = r;
      });
      scope.abort(reason);
      await child.then(undefined, () => {});
    });
    expect(seenReason).toBe(reason);
  });

  it("runTask parent abort propagates reason to child onCancel", async () => {
    const parentReason = "timeout";
    const parent = new AbortController();
    let onCancelReason: unknown;
    const task = runTask(
      async (signal) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      { signal: parent.signal },
    );
    task.onCancel((reason) => {
      onCancelReason = reason;
    });
    parent.abort(parentReason);
    await task.then(undefined, () => {});
    expect(onCancelReason).toBe(parentReason);
  });
});

describe("withStrictCancellation", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("warns when task ignores cancellation past threshold (dev)", async () => {
    process.env.NODE_ENV = "development";
    await withStrictCancellation(
      async (scope) => {
        const t = runTask(
          async (signal) => {
            await new Promise<void>(() => {}); // never settles, ignores signal
          },
          { signal: scope.signal, name: "ignoresCancel" },
        );
        t.then(undefined, () => {}); // consume rejection when scope aborts
        scope.abort();
      },
      { warnAfterMs: 50 },
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/Task ignoresCancel ignored cancellation/);
  }, 10000);

  it("no warning when task settles in time", async () => {
    process.env.NODE_ENV = "development";
    await withStrictCancellation(async (scope) => {
      const task = runTask(
        async (signal) => {
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        { signal: scope.signal, name: "respectsCancel" },
      );
      scope.abort();
      await task.then(undefined, () => {});
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(warnSpy).not.toHaveBeenCalled();
  }, 5000);

  it("no warning or no-op in production", async () => {
    process.env.NODE_ENV = "production";
    await withStrictCancellation(
      async (scope) => {
        const t = runTask(
          async () => {
            await new Promise<void>(() => {}); // never settles
          },
          { signal: scope.signal, name: "ignoresCancel" },
        );
        t.then(undefined, () => {});
        scope.abort();
      },
      { warnAfterMs: 50 },
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(warnSpy).not.toHaveBeenCalled();
  }, 5000);

  it("warnAfterMs option is respected", async () => {
    process.env.NODE_ENV = "development";
    await withStrictCancellation(
      async (scope) => {
        const t = runTask(
          async () => {
            await new Promise<void>(() => {});
          },
          { signal: scope.signal, name: "slow" },
        );
        t.then(undefined, () => {});
        scope.abort();
      },
      { warnAfterMs: 200 },
    );
    expect(warnSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 100));
    expect(warnSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 150));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/Task slow ignored cancellation/);
  }, 10000);
});
