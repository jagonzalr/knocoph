import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { explainImpact } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "explain_impact",
    {
      description:
        "Blast radius analysis. If you change this symbol, what else might break? Returns all transitive callers and importers up to max_depth hops.",
      inputSchema: {
        node_id: z.string().min(1),
        max_depth: z.number().int().min(1).max(10).default(5),
      },
    },
    async (input) => {
      try {
        const affected_nodes = explainImpact(
          db,
          input.node_id,
          input.max_depth
        );
        const summary = `Affects ${affected_nodes.length} symbol(s) up to depth ${input.max_depth}.`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, affected_nodes }, null, 2),
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
