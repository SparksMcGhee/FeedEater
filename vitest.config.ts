import { defineConfig } from "vitest/config";

// Single root config discovering *.test.ts across every workspace
// (apps/*, packages/*, modules/*). node_modules and VCS-ignored paths are
// excluded by default.
export default defineConfig({
  test: {
    environment: "node",
    include: ["{apps,packages,modules}/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  },
});
