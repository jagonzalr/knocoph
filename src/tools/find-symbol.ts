import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { findSymbol } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "find_symbol",
    {
      description:
        "Locate a symbol by name in the code graph. Returns node id, file path, and line range. Always call this before opening files.",
      inputSchema: {
        name: z.string().min(1),
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
        exact: z.boolean().default(true),
      },
    },
    async (input) => {
      try {
        const nodes = findSymbol(db, input.name, input.kind, input.exact);
        const summary = `Found ${nodes.length} node(s) matching '${input.name}'.`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, nodes }, null, 2),
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
