import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getNeighbors } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "get_neighbors",
    {
      description:
        "Return one-hop neighbors of a known node. Shows what a symbol calls, what calls it, what it imports, and what it extends.",
      inputSchema: {
        node_id: z.string().min(1),
        direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
        relationship_types: z
          .array(
            z.enum([
              "IMPORTS",
              "EXPORTS",
              "CALLS",
              "EXTENDS",
              "IMPLEMENTS",
              "CONTAINS",
            ])
          )
          .optional(),
      },
    },
    async (input) => {
      try {
        const result = getNeighbors(
          db,
          input.node_id,
          input.direction,
          input.relationship_types
        );

        const outCount = result.edges.filter(
          (e) => e.source_id === input.node_id
        ).length;
        const inCount = result.edges.filter(
          (e) => e.target_id === input.node_id
        ).length;
        const summary = `Node has ${outCount} outgoing and ${inCount} incoming edge(s).`;

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
