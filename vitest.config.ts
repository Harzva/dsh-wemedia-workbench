import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    // Transform the installed native UI atoms' CSS modules in Node tests.
    server: { deps: { inline: ["@deepseek-ai/dsh-client-ui-primitives"] } },
  },
});
