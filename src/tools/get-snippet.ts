import fs from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";

// Module-level LRU cache: file path -> lines array.
// Maps preserve insertion order — oldest entry is always at the front.
// Max 50 entries; evict oldest on overflow.
const fileCache = new Map<string, string[]>();
const MAX_CACHE_SIZE = 50;

function getFileLines(filePath: string): string[] {
  if (fileCache.has(filePath)) {
    const lines = fileCache.get(filePath)!;
    fileCache.delete(filePath); // remove from current position
    fileCache.set(filePath, lines); // re-insert at end (LRU promotion)
    return lines;
  }
  if (fileCache.size >= MAX_CACHE_SIZE) {
    fileCache.delete(fileCache.keys().next().value!); // evict oldest
  }
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  fileCache.set(filePath, lines);
  return lines;
}

// db is unused in get-snippet (pure filesystem read), but the register
// signature is uniform across all tool handlers.
export function register(server: McpServer, _db: Database.Database): void {
  server.registerTool(
    "get_snippet",
    {
      description:
        "Return exact source lines from a file. Use start_line and end_line from find_symbol to read a function body without loading the whole file.",
      inputSchema: {
        file_path: z.string().min(1),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1),
        padding: z.number().int().min(0).max(20).default(2),
      },
    },
    async (input) => {
      try {
        const lines = getFileLines(input.file_path);
        const actualStart = Math.max(0, input.start_line - 1 - input.padding);
        const actualEnd = Math.min(
          lines.length - 1,
          input.end_line - 1 + input.padding
        );
        const content = lines.slice(actualStart, actualEnd + 1).join("\n");

        // Convert back to 1-indexed for the response
        const responseStart = actualStart + 1;
        const responseEnd = actualEnd + 1;

        const summary = `Lines ${responseStart}–${responseEnd} of ${path.basename(input.file_path)}.`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary,
                  file_path: input.file_path,
                  start_line: responseStart,
                  end_line: responseEnd,
                  content,
                },
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
