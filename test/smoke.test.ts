import { describe, it, expect } from "vitest";
import { runTask } from "taskloom";

describe("smoke", () => {
  it("exports runTask and await resolves", async () => {
    const task = runTask(async () => 42);
    await expect(task).resolves.toBe(42);
  });
});
