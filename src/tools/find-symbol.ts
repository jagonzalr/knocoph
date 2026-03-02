import type Database from "better-sqlite3";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getFileLines } from "../file-cache.js";
import { findSymbol } from "../queries.js";

export function register(server: McpServer, db: Database.Database): void {
  server.registerTool(
    "find_symbol",
    {
      description:
        "Locate a symbol by name in the code graph. Returns node id, file path, line range, and optionally the source code. Always call this before opening files.",
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
        include_snippet: z.boolean().default(false),
        snippet_padding: z.number().int().min(0).max(20).default(2),
      },
    },
    async (input) => {
      try {
        const nodes = findSymbol(db, input.name, input.kind, input.exact);

        let result: unknown[];
        if (input.include_snippet) {
          result = nodes.map((node) => {
            try {
              const lines = getFileLines(node.file_path);
              const actualStart = Math.max(
                0,
                node.start_line - 1 - input.snippet_padding
              );
              const actualEnd = Math.min(
                lines.length - 1,
                node.end_line - 1 + input.snippet_padding
              );
              const content = lines
                .slice(actualStart, actualEnd + 1)
                .join("\n");
              return { ...node, content };
            } catch {
              // If file read fails, return node without content
              return { ...node, content: null };
            }
          });
        } else {
          result = nodes;
        }

        const summary = `Found ${nodes.length} node(s) matching '${input.name}'.`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, nodes: result }, null, 2),
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
