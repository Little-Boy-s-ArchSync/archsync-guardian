import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/bin.ts",
        "src/demo.ts",
        "src/doctor.ts",
        "src/index.ts",
        "src/model-cli.ts",
        "src/test-helpers.ts"
      ],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90
      }
    }
  }
});
