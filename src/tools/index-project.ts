import * as fs from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";

import { indexProject } from "../indexer.js";
import type { PathAliases } from "../types.js";
import { startWatcher } from "../watcher.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "index_project",
    {
      description:
        "Trigger a full or incremental index scan of a project. Persists configuration and starts the file watcher. Reads tsconfig.json from root_dir automatically to resolve TypeScript path aliases (@scope/... imports). Override with tsconfig_path if your tsconfig is elsewhere.",
      inputSchema: {
        root_dir: z.string().min(1),
        tsconfig_path: z
          .string()
          .optional()
          .describe(
            "Path to tsconfig.json for resolving compilerOptions.paths aliases. Auto-detected from root_dir/tsconfig.json when omitted."
          ),
        globs: z
          .array(z.string())
          .default([
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx",
            "**/*.mjs",
            "**/*.cjs",
          ]),
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

        // Resolve the tsconfig to use: explicit override takes priority, then
        // auto-detect tsconfig.json at the project root.
        const tsconfigPath = input.tsconfig_path
          ? path.resolve(input.tsconfig_path)
          : fs.existsSync(path.join(absoluteRoot, "tsconfig.json"))
            ? path.join(absoluteRoot, "tsconfig.json")
            : undefined;

        // Build path alias map from tsconfig if one was found.
        let pathAliases: PathAliases | undefined;
        if (tsconfigPath) {
          if (!input.tsconfig_path) {
            console.error(
              `[knocoph] Auto-detected tsconfig at ${tsconfigPath}`
            );
          }
          const tsconfigDir = path.dirname(tsconfigPath);
          try {
            const raw = fs.readFileSync(tsconfigPath, "utf-8");
            // Strip line comments before JSON.parse for JSONC support.
            const stripped = raw.replace(/\/\/[^\n]*/g, "");
            const tsconfig = JSON.parse(stripped) as {
              compilerOptions?: {
                baseUrl?: string;
                paths?: Record<string, string[]>;
              };
            };
            const tsPaths = tsconfig.compilerOptions?.paths;
            if (tsPaths && Object.keys(tsPaths).length > 0) {
              const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";
              pathAliases = {
                baseDir: path.resolve(tsconfigDir, baseUrl),
                paths: tsPaths,
              };
            }
          } catch (e) {
            console.error(
              `[knocoph] Failed to parse tsconfig at ${tsconfigPath}: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }

        const stats = indexProject(
          db,
          absoluteRoot,
          input.globs,
          input.ignore,
          pathAliases
        );

        db.prepare("INSERT OR REPLACE INTO meta VALUES ('root_dir', ?)").run(
          absoluteRoot
        );
        db.prepare("INSERT OR REPLACE INTO meta VALUES ('globs', ?)").run(
          JSON.stringify(input.globs)
        );
        db.prepare("INSERT OR REPLACE INTO meta VALUES ('ignore', ?)").run(
          JSON.stringify(input.ignore)
        );
        db.prepare(
          "INSERT OR REPLACE INTO meta VALUES ('tsconfig_path', ?)"
        ).run(tsconfigPath ?? "");

        console.error(
          `[knocoph] Starting file watcher on ${absoluteRoot}...`,
          input.globs
        );

        startWatcher(db, absoluteRoot, input.globs, input.ignore, pathAliases);

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
