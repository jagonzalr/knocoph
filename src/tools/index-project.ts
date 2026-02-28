import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";

import { indexProject } from "../indexer.js";
import { startWatcher } from "../watcher.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "index_project",
    {
      description:
        "Trigger a full or incremental index scan of a project. Persists configuration and starts the file watcher.",
      inputSchema: {
        root_dir: z.string().min(1),
        globs: z
          .array(z.string())
          .default(["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]),
        ignore: z
          .array(z.string())
          .default([
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/.git/**",
            "**/.knocoph/**",
          ]),
      },
    },
    async (input) => {
      try {
        const absoluteRoot = path.resolve(input.root_dir);
        const stats = indexProject(db, absoluteRoot, input.globs, input.ignore);

        db.prepare("INSERT OR REPLACE INTO meta VALUES ('root_dir', ?)").run(
          absoluteRoot
        );
        db.prepare("INSERT OR REPLACE INTO meta VALUES ('globs', ?)").run(
          JSON.stringify(input.globs)
        );
        db.prepare("INSERT OR REPLACE INTO meta VALUES ('ignore', ?)").run(
          JSON.stringify(input.ignore)
        );

        startWatcher(db, absoluteRoot, input.globs, input.ignore);

        const summary = `Indexed ${stats.files_scanned} file(s) in ${stats.duration_ms}ms: ${stats.files_updated} updated, ${stats.files_skipped} unchanged, ${stats.files_errored} error(s).`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { summary, ...stats, watcher_started: true },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message }) },
          ],
          isError: true,
        };
      }
    }
  );
}
