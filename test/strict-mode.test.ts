/**
 * Strict concurrency mode tests: off by default, throws when strict mode on and misuse detected;
 * same outcome with strict mode on when no misuse.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  enableStrictMode,
  StrictModeError,
  runTask,
  runInScope,
  sync,
} from "taskloom";
import { disableStrictMode } from "../src/strict-mode.js";

afterEach(() => {
  disableStrictMode();
  vi.restoreAllMocks();
});

describe("strict mode off by default", () => {
  it("does not emit warnings when runTask is used outside any scope", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const task = runTask(async () => 1);
    await task;
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not emit warnings when scope aborts a task with no onCancel", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runInScope(async (scope) => {
      const t = runTask(
        async (signal) => {
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        { signal: scope.signal },
      );
      t.then(undefined, () => {});
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not emit warnings when scope exits with tasks still running", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runInScope(async (scope) => {
      const t = runTask(
        async () => {
          await new Promise(() => {}); // never settles
        },
        { signal: scope.signal },
      );
      t.then(undefined, () => {});
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("after enableStrictMode()", () => {
  it("throws for unstructured async when runTask is called outside scope", () => {
    const warnings: string[] = [];
    enableStrictMode({ onWarn: (msg) => warnings.push(msg) });
    expect(() => runTask(async () => 1)).toThrow(StrictModeError);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unstructured async|outside any Taskloom scope/i);
  });

  it("throws when task is canceled with no onCancel registered", async () => {
    enableStrictMode();
    await expect(
      runInScope(async (scope) => {
        const t = runTask(
          async (signal) => {
            await new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
          { signal: scope.signal },
        );
        t.then(undefined, () => {}); // avoid unhandled rejection when scope aborts
      }),
    ).rejects.toThrow(StrictModeError);
  });

  it("throws when scope exits with tasks still running (orphan)", async () => {
    enableStrictMode();
    await expect(
      runInScope(async (scope) => {
        const t = runTask(
          async () => {
            await new Promise(() => {}); // never settles
          },
          { signal: scope.signal },
        );
        t.then(undefined, () => {}); // avoid unhandled rejection when scope aborts
      }),
    ).rejects.toThrow(StrictModeError);
  });

  it("calls onWarn before throwing when provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured: string[] = [];
    enableStrictMode({ onWarn: (msg) => captured.push(msg) });
    expect(() => runTask(async () => 1)).toThrow(StrictModeError);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("strict mode does not change runtime semantics", () => {
  it("sync result is identical with strict mode on vs off when no misuse", async () => {
    const resultOff = await sync(async ({ task }) => {
      const a = task(async () => 1);
      const b = task(async () => 2);
      return (await a) + (await b);
    });
    enableStrictMode({ onWarn: () => {} });
    const resultOn = await sync(async ({ task }) => {
      const a = task(async () => 1);
      const b = task(async () => 2);
      return (await a) + (await b);
    });
    disableStrictMode();
    expect(resultOff).toBe(3);
    expect(resultOn).toBe(3);
  });

  it("sync rejection is identical with strict mode on vs off", async () => {
    const err = new Error("fail");
    const promiseOff = sync(async ({ task }) => {
      task(async () => {
        throw err;
      });
      await new Promise(() => {});
    });
    disableStrictMode();
    enableStrictMode({ onWarn: () => {} });
    const promiseOn = sync(async ({ task }) => {
      task(async () => {
        throw err;
      });
      await new Promise(() => {});
    });
    await expect(promiseOff).rejects.toBe(err);
    await expect(promiseOn).rejects.toBe(err);
  });
});
