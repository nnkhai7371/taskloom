import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      taskloom: path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    dir: "test",
    include: ["**/*.test.ts"],
  },
});
