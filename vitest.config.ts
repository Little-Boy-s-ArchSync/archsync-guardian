import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A single worker keeps V8 branch-range accounting reproducible across
    // evidence generation and verification on all supported operating systems.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/bin.ts",
        "src/demo.ts",
        "src/index.ts",
        "src/reasoner/index.ts",
        "src/test-helpers.ts"
      ],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
