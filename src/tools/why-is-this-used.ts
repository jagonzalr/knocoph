import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { whyIsThisUsed } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "why_is_this_used",
    {
      description:
        "Reverse traversal formatted as path chains. Answers: why does this symbol exist? What depends on it?",
      inputSchema: {
        node_id: z.string().min(1),
        max_depth: z.number().int().min(1).max(5).default(3),
      },
    },
    async (input) => {
      try {
        const paths = whyIsThisUsed(db, input.node_id, input.max_depth);
        const summary = `Referenced by ${paths.length} path(s) up to depth ${input.max_depth}.`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, paths }, null, 2),
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
