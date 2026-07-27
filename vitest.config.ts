import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Engine is deterministic; no real network. Fail fast if a test tries to
    // reach the Anthropic SDK (all tests inject a scripted LlmClient instead).
    globals: false,
  },
});
