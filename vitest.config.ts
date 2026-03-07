import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: [
        "src/file-cache.ts",
        "src/parser/*.ts",
        "src/queries.ts",
        "src/graph.ts",
        "src/indexer.ts",
      ],
      // Tool handlers, server.ts, watcher.ts, and index.ts are excluded.
      // They are thin glue code verified manually via MCP Inspector.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
