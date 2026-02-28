import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { codebaseOverview } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "codebase_overview",
    {
      description:
        "Return a structural summary of the entire indexed codebase: file and node counts, kind distribution, most-called functions, most-imported files, and likely entry points. Call this first when orienting in an unfamiliar project.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = codebaseOverview(db);
        const summary = `Codebase has ${result.file_count} file(s), ${result.node_count} symbol(s), and ${result.edge_count} edge(s).`;
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
