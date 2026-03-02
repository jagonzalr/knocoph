import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { explainImpact, resolveNode } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "explain_impact",
    {
      description:
        "Blast radius and dependency analysis. Given a symbol (by name or node_id), returns all transitive dependents and the dependency paths explaining each. Replaces the need for separate find_symbol + explain_impact calls.",
      inputSchema: z
        .object({
          node_id: z.string().min(1).optional(),
          name: z.string().min(1).optional(),
          kind: z
            .enum([
              "function",
              "class",
              "interface",
              "type_alias",
              "enum",
              "namespace",
              "method",
              "constructor",
              "arrow_function",
              "variable",
            ])
            .optional(),
          max_depth: z.number().int().min(1).max(10).default(5),
          include_paths: z.boolean().default(true),
        })
        .refine((data) => data.node_id || data.name, {
          message: "Either node_id or name must be provided.",
        }),
    },
    async (input) => {
      try {
        const node = resolveNode(db, input.node_id, input.name, input.kind);
        const result = explainImpact(
          db,
          node.id,
          input.max_depth,
          input.include_paths
        );
        const summary = `Affects ${result.affected_nodes.length} symbol(s) via ${result.paths.length} path(s) up to depth ${input.max_depth}.`;

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
