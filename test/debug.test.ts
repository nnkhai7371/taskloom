/**
 * Task tree debug tests: debug off has no tree; debug on produces tree
 * with scope/task nodes, IDs, names; zero-cost when disabled.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sync,
  enableTaskDebug,
  subscribeTaskDebug,
  taskloomDebugger,
  type Logger,
} from "taskloom";
// Internal hook for tests only (not from barrel)
import { disableTaskDebug } from "../src/debug.js";

afterEach(() => {
  disableTaskDebug();
  vi.restoreAllMocks();
});

describe("when debug is disabled", () => {
  it("does not collect or emit a task tree", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sync(async ({ task }) => {
      await task(async () => 1);
      await task(async () => 2);
    });
    // No tree format (e.g. sync#1 or task#2) should be logged
    const treeLikeCalls = logSpy.mock.calls.filter(
      (args) =>
        args.length > 0 &&
        typeof args[0] === "string" &&
        (args[0].startsWith("sync#") ||
          args[0].startsWith("race#") ||
          args[0].includes("task#")),
    );
    expect(treeLikeCalls).toHaveLength(0);
  });
});

describe("when debug is enabled", () => {
  it("produces tree with scope and task nodes and distinct IDs", async () => {
    enableTaskDebug();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sync(async ({ task }) => {
      await task(async () => 1);
      await task(async () => 2);
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/sync#\d+/);
    expect(output).toMatch(/task#\d+/);
    // Two tasks
    const taskLines = output.split("\n").filter((line) => line.includes("task#"));
    expect(taskLines.length).toBeGreaterThanOrEqual(2);
  });

  it("includes optional task names in the tree", async () => {
    enableTaskDebug();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sync(async ({ task }) => {
      await task("fetchUser", async () => ({}));
      await task("fetchOrders", async () => ({}));
    });
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("fetchUser");
    expect(output).toContain("fetchOrders");
  });

  it("shows task status and timing when tasks complete", async () => {
    enableTaskDebug();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sync(async ({ task }) => {
      await task(async () => 42);
    });
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/completed/);
    expect(output).toMatch(/\d+ms/);
  });

  it("when enableTaskDebug() is enabled, task created via run(work) has inferred name in tree or error (best-effort)", async () => {
    enableTaskDebug();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sync(async ({ run }) => {
      run(async () => ({}));
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/sync#\d+/);
    expect(output).toMatch(/task#\d+/);
    // Zero-friction task may have inferred name or anonymous; tree must include the task
    const taskLines = output.split("\n").filter((line) => line.includes("task#"));
    expect(taskLines.length).toBeGreaterThanOrEqual(1);
  });
});

describe("zero-friction sync when debug not enabled", () => {
  it("no stack capture and zero-friction sync still works with no name", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await sync(async ({ run }) => {
      const a = await run(async () => 1);
      const b = await run(async () => 2);
      return a + b;
    });
    expect(result).toBe(3);
    const treeLikeCalls = logSpy.mock.calls.filter(
      (args) =>
        args.length > 0 &&
        typeof args[0] === "string" &&
        (args[0].startsWith("sync#") || args[0].includes("task#")),
    );
    expect(treeLikeCalls).toHaveLength(0);
  });
});

describe("enableTaskDebug public API", () => {
  it("is importable from taskloom barrel", () => {
    expect(typeof enableTaskDebug).toBe("function");
  });
});

describe("public API uses default instance", () => {
  it("enableTaskDebug() enables the default singleton and subscribe receives events", async () => {
    expect(taskloomDebugger.isEnabled()).toBe(false);
    enableTaskDebug();
    expect(taskloomDebugger.isEnabled()).toBe(true);
    const events: Array<{ kind: string }> = [];
    subscribeTaskDebug((e) => events.push({ kind: e.kind }));
    await sync(async ({ task }) => {
      await task(async () => 1);
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.kind)).toContain("scopeOpened");
    expect(events.map((e) => e.kind)).toContain("taskUpdated");
  });
});

describe("subscribeTaskDebug", () => {
  it("subscriber receives scopeOpened, scopeClosed, taskRegistered, taskUpdated in order", async () => {
    enableTaskDebug();
    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    subscribeTaskDebug((e) => {
      events.push({ ...e });
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sync(async ({ run }) => {
      run(async () => 1);
      run(async () => 2);
    });
    expect(events.length).toBeGreaterThanOrEqual(4);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("scopeOpened");
    expect(kinds).toContain("scopeClosed");
    expect(kinds).toContain("taskRegistered");
    expect(kinds).toContain("taskUpdated");
    const scopeOpenedIdx = kinds.indexOf("scopeOpened");
    const taskRegIdx = kinds.indexOf("taskRegistered");
    const taskUpdIdx = kinds.indexOf("taskUpdated");
    const scopeClosedIdx = kinds.indexOf("scopeClosed");
    expect(scopeOpenedIdx).toBeLessThan(taskRegIdx);
    expect(taskRegIdx).toBeLessThan(taskUpdIdx);
    expect(taskUpdIdx).toBeLessThan(scopeClosedIdx);
    logSpy.mockRestore();
  });

  it("after unsubscribe, subscriber receives no further events", async () => {
    enableTaskDebug();
    const events: Array<{ kind: string }> = [];
    const unsub = subscribeTaskDebug((e) => events.push({ kind: e.kind }));
    await sync(async ({ run }) => {
      run(async () => 1);
    });
    const countAfterFirst = events.length;
    expect(countAfterFirst).toBeGreaterThan(0);
    unsub();
    await sync(async ({ run }) => {
      run(async () => 2);
    });
    expect(events.length).toBe(countAfterFirst);
  });

  it("throwing subscriber is caught and other subscribers still receive events", async () => {
    enableTaskDebug();
    const received: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribeTaskDebug(() => {
      throw new Error("subscriber throw");
    });
    subscribeTaskDebug((e) => received.push(e.kind));
    await sync(async ({ run }) => {
      run(async () => 1);
    });
    expect(received).toContain("scopeOpened");
    expect(received).toContain("taskRegistered");
    expect(received).toContain("taskUpdated");
    expect(received).toContain("scopeClosed");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("enableTaskDebug(logger) routes output to logger", () => {
  it("lifecycle and default visualizer output go to logger.debug when logger supplied", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    enableTaskDebug(logger);
    await sync(async ({ task }) => {
      await task(async () => 1);
      await task(async () => 2);
    });
    expect(logger.debug).toHaveBeenCalled();
    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const treeOutput = debugCalls.find(
      (args: unknown[]) =>
        args.length > 0 &&
        typeof args[0] === "string" &&
        (args[0].startsWith("sync#") || args[0].includes("task#")),
    );
    expect(treeOutput).toBeDefined();
    expect(treeOutput![0]).toMatch(/sync#\d+/);
    expect(treeOutput![0]).toMatch(/task#\d+/);
  });

  it("when subscriber throws and logger was supplied, error is reported via logger.error not console", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    enableTaskDebug(logger);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribeTaskDebug(() => {
      throw new Error("subscriber throw");
    });
    await sync(async ({ run }) => {
      run(async () => 1);
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[taskloom] subscribeTaskDebug subscriber threw:",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
