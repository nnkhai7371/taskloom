import { describe, it, expect, vi } from "vitest";
import { runTask } from "taskloom";

describe("Task lifecycle", () => {
  it("moves to completed when work resolves", async () => {
    const task = runTask(async () => "ok");
    expect(task.status).toBe("running");
    const value = await task;
    expect(value).toBe("ok");
    expect(task.status).toBe("completed");
    expect(task.result).toBe("ok");
  });

  it("moves to failed when work rejects", async () => {
    const err = new Error("work failed");
    const task = runTask(async () => {
      throw err;
    });
    expect(task.status).toBe("running");
    await expect(task).rejects.toThrow("work failed");
    expect(task.status).toBe("failed");
    expect(task.error).toBe(err);
  });

  it("moves to canceled when signal aborts", async () => {
    const controller = new AbortController();
    const task = runTask(
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          setTimeout(resolve, 100);
        });
        return "done";
      },
      { signal: controller.signal },
    );
    expect(task.status).toBe("running");
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(task.status).toBe("canceled");
  });
});

describe("Task cancellation", () => {
  it("parent signal aborts → task is canceled and await rejects with cancellation error", async () => {
    const parent = new AbortController();
    const task = runTask(
      async (signal) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      { signal: parent.signal },
    );
    parent.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(task.status).toBe("canceled");
  });
});

describe("Task onCancel", () => {
  it("handler runs when task is canceled, before await rejects", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const task = runTask(
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 50);
        });
        return "done";
      },
      { signal: controller.signal },
    );
    task.onCancel(() => order.push("onCancel"));
    controller.abort();
    await task.then(
      () => {},
      () => order.push("rejected"),
    );
    expect(order).toEqual(["onCancel", "rejected"]);
  });

  it("handler runs when registered after task already canceled", () => {
    const parent = new AbortController();
    parent.abort();
    const task = runTask(async () => "ok", { signal: parent.signal });
    task.then(undefined, () => {}); // consume rejection so no unhandled rejection
    expect(task.status).toBe("canceled");
    const spy = vi.fn();
    task.onCancel(spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("onCancel handler receives cancellation reason when task is canceled", async () => {
    const controller = new AbortController();
    const reason = "timeout";
    let receivedReason: unknown;
    const task = runTask(
      async (signal) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      { signal: controller.signal },
    );
    task.onCancel((r) => {
      receivedReason = r;
    });
    controller.abort(reason);
    await task.then(undefined, () => {});
    expect(receivedReason).toBe(reason);
  });

  it("onCancel when already canceled passes stored reason to handler", () => {
    const parent = new AbortController();
    const reason = "user-navigation";
    parent.abort(reason);
    const task = runTask(async () => "ok", { signal: parent.signal });
    task.then(undefined, () => {}); // consume rejection
    expect(task.status).toBe("canceled");
    const spy = vi.fn();
    task.onCancel(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(reason);
  });
});

describe("Task await", () => {
  it("await task resolves to value when completed", async () => {
    const task = runTask(async () => 10);
    const value = await task;
    expect(value).toBe(10);
  });

  it("await task rejects with work error when failed", async () => {
    const err = new Error("fail");
    const task = runTask(async () => {
      throw err;
    });
    await expect(task).rejects.toBe(err);
  });

  it("await task rejects with cancel error when canceled", async () => {
    const controller = new AbortController();
    const task = runTask(
      async (signal) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
  });
});
