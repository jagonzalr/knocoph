import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { queryArchitecture } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "query_architecture",
    {
      description:
        "File-level view. What symbols a file defines and what cross-file relationships it participates in.",
      inputSchema: {
        file_path: z.string().min(1),
        include_internal_edges: z.boolean().default(false),
      },
    },
    async (input) => {
      try {
        const result = queryArchitecture(
          db,
          input.file_path,
          input.include_internal_edges
        );

        const summary = `Defines ${result.defined_symbols.length} symbol(s) with ${result.cross_file_edges.length} cross-file edge(s).`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, ...result }, null, 2),
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
